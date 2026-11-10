import type { Db, MemoryRecord } from '../types.js';
import type { ScoredCandidate } from './fuse.js';
import { budgetTokens } from '../core/tokens.js';
import { tokenSet, jaccard } from '../core/text.js';
import { cosineSimilarity, getOrComputeEmbedding } from '../core/vector.js';
import { render, type RenderItem } from './render.js';

/**
 * 混合词法-语义重叠算子 (Hybrid Lexical-Vector Overlap)
 * 融合词汇 Jaccard 与 128D 本地特征哈希余弦相似度，识别双语/同义改写冗余记忆，同时保护正交多跳事实召回
 */
export function computeHybridOverlap(
  aTokens: Set<string>,
  bTokens: Set<string>,
  aVec?: Float32Array | null,
  bVec?: Float32Array | null,
  sameType: boolean = false
): number {
  const lexSim = jaccard(aTokens, bTokens);
  if (!aVec || !bVec) return lexSim;
  const vecSim = Math.max(0, cosineSimilarity(aVec, bVec));
  const scaledVec =
    sameType && vecSim >= 0.58 ? 0.95 * vecSim : vecSim >= 0.8 ? 0.8 * vecSim : 0;
  return Math.max(lexSim, scaledVec);
}

/**
 * LightMem (2025) / Submodular MMR 边际信息增益算子 (Maximal Marginal Relevance over Value-Per-Token)
 * 对与已选集合存在高词汇重叠 (>= threshold) 的近似冗余候选施加次模边际折损，最大化注入上下文的信息熵密度
 */
export function computeMmrMarginalScore(
  baseVpt: number,
  maxOverlap: number,
  lambda: number = 0.65,
  threshold: number = 0.58
): number {
  if (maxOverlap < threshold) {
    return baseVpt;
  }
  const penaltyFactor = Math.max(0.15, 1 - lambda * maxOverlap);
  return baseVpt * penaltyFactor;
}

export interface GovernOptions {
  budget: number;
  maxItems: number;
  alreadyInjected: Set<string>;
  strategyVersion?: number;
  layer?: 'dynamic' | 'stable';
  db?: Db;
  scopeCtx?: { workspaceId: string; sessionId?: string };
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

  // 4. 计算 VPT (Value Per Token) 与混合词法/128D向量特征 (用于 LightMem Hybrid Submodular MMR 边际去重)
  const withVpt = candidates.map((c) => ({
    cand: c,
    vpt: c.score / Math.max(c.memory.token_cost, 30),
    tokens: tokenSet(`${c.memory.content} ${c.memory.summary}`),
    vec: getOrComputeEmbedding(c.memory),
  }));

  // 按 score 降序找最高分的第一条锚点记忆
  withVpt.sort((a, b) => b.cand.score - a.cand.score);
  const first = withVpt[0];
  const remaining = withVpt.slice(1);

  const selected: SelectedItem[] = [];
  const selectedFeatures: Array<{ tokens: Set<string>; vec: Float32Array | null; type: string }> = [];

  function testBudget(items: RenderItem[]): number {
    // 候选迭代评估阶段无需逐次走完整数据库短码范围查询；短码长度微小变化 (至多2字节)
    // 对 token 预算计数影响极小，且在第 6 步收尾阶段会携带 opts.db 进行最终严格复核
    const text = render(items, {
      strategyVersion,
      layer,
    });
    return budgetTokens(text);
  }

  function tryPackCandidate(item: (typeof withVpt)[0]): boolean {
    if (selected.length >= opts.maxItems) return false;
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
      selectedFeatures.push({ tokens: item.tokens, vec: item.vec, type: m.type });
      return true;
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
      selectedFeatures.push({ tokens: item.tokens, vec: item.vec, type: m.type });
      return true;
    }
    return false;
  }

  // 先装入最高分锚点项
  tryPackCandidate(first);

  // 其余项按 LightMem Hybrid Submodular MMR-VPT 贪心迭代选择
  while (remaining.length > 0 && selected.length < opts.maxItems) {
    let bestIdx = 0;
    let bestMmrVpt = -1;

    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      let maxOverlap = 0;
      for (const selFeat of selectedFeatures) {
        const sim = computeHybridOverlap(
          item.tokens,
          selFeat.tokens,
          item.vec,
          selFeat.vec,
          item.cand.memory.type === selFeat.type
        );
        if (sim > maxOverlap) {
          maxOverlap = sim;
        }
      }
      const mmrVpt = computeMmrMarginalScore(item.vpt, maxOverlap);
      if (mmrVpt > bestMmrVpt) {
        bestMmrVpt = mmrVpt;
        bestIdx = i;
      }
    }

    const [nextItem] = remaining.splice(bestIdx, 1);
    tryPackCandidate(nextItem);
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
