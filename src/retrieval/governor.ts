import type { MemoryRecord } from '../types.js';
import type { ScoredCandidate } from './fuse.js';
import { budgetTokens } from '../core/tokens.js';
import { render, type RenderItem } from './render.js';

export interface GovernOptions {
  budget: number;
  maxItems: number;
  alreadyInjected: Set<string>;
  strategyVersion?: number;
  layer?: 'dynamic' | 'stable';
}

export interface SelectedItem {
  memory: MemoryRecord;
  form: 'content' | 'summary';
  score: number;
  tokens: number;
}

/**
 * Token 预算装箱 (§5.7)
 */
export function govern(
  cands: ScoredCandidate[],
  opts: GovernOptions
): SelectedItem[] {
  if (!cands || cands.length === 0 || opts.budget <= 0 || opts.maxItems <= 0) {
    return [];
  }

  const strategyVersion = opts.strategyVersion ?? 1;
  const layer = opts.layer ?? 'dynamic';

  // 1. 去掉 alreadyInjected 中的 id@content_rev
  const filtered: ScoredCandidate[] = [];
  for (const c of cands) {
    const key = `${c.memory.id}@${c.memory.content_rev}`;
    if (!opts.alreadyInjected.has(key)) {
      filtered.push(c);
    }
  }

  if (filtered.length === 0) {
    return [];
  }

  // 2. 槽位冲突去重：同一个 (scope, slot_key) 只保留最新记录
  const slotMap = new Map<string, ScoredCandidate>();
  const noSlotList: ScoredCandidate[] = [];

  for (const c of filtered) {
    const m = c.memory;
    if (m.slot_key) {
      const slotScopeKey = `${m.scope}:${m.workspace_id || ''}:${m.session_id || ''}:${m.slot_key}`;
      const existing = slotMap.get(slotScopeKey);
      if (!existing) {
        slotMap.set(slotScopeKey, c);
      } else {
        const existingTime = existing.memory.valid_from ?? existing.memory.updated_at;
        const curTime = m.valid_from ?? m.updated_at;
        if (
          curTime > existingTime ||
          (curTime === existingTime && m.updated_at > existing.memory.updated_at) ||
          (curTime === existingTime && m.updated_at === existing.memory.updated_at && m.id > existing.memory.id)
        ) {
          slotMap.set(slotScopeKey, c);
        }
      }
    } else {
      noSlotList.push(c);
    }
  }

  const deSlotted = [...slotMap.values(), ...noSlotList];

  // 3. 正文哈希去重：hash 相同只保留最高分一条
  const hashMap = new Map<string, ScoredCandidate>();
  for (const c of deSlotted) {
    const h = c.memory.hash;
    const existing = hashMap.get(h);
    if (!existing || c.score > existing.score) {
      hashMap.set(h, c);
    }
  }

  const candidates = Array.from(hashMap.values());
  if (candidates.length === 0) return [];

  // 4. 计算 VPT (Value Per Token)
  const withVpt = candidates.map((c) => ({
    cand: c,
    vpt: c.score / Math.max(c.memory.token_cost, 30),
  }));

  // 按 score 降序找最高分的第一条
  withVpt.sort((a, b) => b.cand.score - a.cand.score);
  const first = withVpt[0];
  const rest = withVpt.slice(1);

  // 其余项按 vpt 从高到低排序
  rest.sort((a, b) => b.vpt - a.vpt);
  const queue = [first, ...rest];

  const selected: SelectedItem[] = [];

  function testBudget(items: RenderItem[]): number {
    const text = render(items, { strategyVersion, layer });
    return budgetTokens(text);
  }

  for (const item of queue) {
    if (selected.length >= opts.maxItems) break;

    const m = item.cand.memory;

    // 先尝试 content
    const tryContentItems: RenderItem[] = [
      ...selected.map((s) => ({ memory: s.memory, form: s.form })),
      { memory: m, form: 'content' },
    ];
    const tokensWithContent = testBudget(tryContentItems);

    if (tokensWithContent <= opts.budget) {
      selected.push({
        memory: m,
        form: 'content',
        score: item.cand.score,
        tokens: m.token_cost,
      });
      continue;
    }

    // 再尝试 summary
    const trySummaryItems: RenderItem[] = [
      ...selected.map((s) => ({ memory: s.memory, form: s.form })),
      { memory: m, form: 'summary' },
    ];
    const tokensWithSummary = testBudget(trySummaryItems);

    if (tokensWithSummary <= opts.budget) {
      selected.push({
        memory: m,
        form: 'summary',
        score: item.cand.score,
        tokens: m.summary_cost,
      });
    }
  }

  // 6. 最终验证与削减：确保完整实际渲染块严格 <= budget
  while (selected.length > 0) {
    const actualTokens = testBudget(selected.map((s) => ({ memory: s.memory, form: s.form })));
    if (actualTokens <= opts.budget) {
      break;
    }
    // 移除最后一项 (最低价值项)
    selected.pop();
  }

  return selected;
}
