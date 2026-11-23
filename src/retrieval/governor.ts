import { jaccard, tokenSet } from '../core/text.js';
import { budgetTokens, estimateTokens } from '../core/tokens.js';
import { cosineSimilarity, getOrComputeEmbedding } from '../core/vector.js';
import { buildInlineL1Overview } from '../core/viking.js';
import type { Db, MemoryRecord, VikingContextTier } from '../types.js';
import type { ScoredCandidate } from './fuse.js';
import { type RenderLineOptions, render, renderLine, wrapRenderedLines } from './render.js';

const TARGET_L1_MAX_CHARS = 220;

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
  const scaledVec = sameType && vecSim >= 0.58 ? 0.95 * vecSim : vecSim >= 0.8 ? 0.8 * vecSim : 0;
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
  temporalBrowse?: boolean;
  contradictionsSet?: Set<string>;
  now?: number;
}

export interface SelectedItem {
  memory: MemoryRecord;
  form: 'content' | 'summary';
  tier?: VikingContextTier;
  overview?: string;
  score: number;
  tokens: number;
}

export interface GovernResult {
  items: SelectedItem[];
  renderedBlock: string;
  totalTokens: number;
  droppedReasons: Record<string, string>;
}

interface CandidatePackState {
  cand: ScoredCandidate;
  vpt: number;
  tokens: Set<string>;
  vec: Float32Array | null;
  approxCode: string;
  l2Line?: string;
  l2Tokens?: number;
  l1Overview?: string | null;
  l1Line?: string;
  l1Tokens?: number;
  l0Line?: string;
  l0Tokens?: number;
}

function buildL1CandidateOverview(m: MemoryRecord): string | null {
  const sumLen = (m.summary || '').length;
  if (m.content.length <= sumLen + 40) return null;
  const targetL1Chars = Math.min(
    TARGET_L1_MAX_CHARS,
    Math.max(sumLen + 24, Math.floor(m.content.length * 0.58))
  );
  const overview = buildInlineL1Overview(m, targetL1Chars);
  if (overview.length < m.content.length - 15 && overview.length > sumLen + 12) {
    return overview;
  }
  return null;
}

function approxShortCode(id: string): string {
  const rawPart = id.startsWith('m_') ? id.slice(2) : id;
  return 'm_' + rawPart.slice(0, 4);
}

/**
 * Token 预算装箱并返回最终渲染块与丢弃原因 (§5.7)
 * - 复用 ScoredCandidate 预计算的 docTokens，避免重复分词
 * - 懒缓存单候选 L2/L1/L0 渲染行与 budgetTokens，将 MMR 循环内的 O(K²) 全量渲染优化为 O(K) 增量追踪
 * - Step 6 严格复核实测渲染块，先原地 L2 -> L1 -> L0 渐进降级，仍超限再弹出
 */
export function governWithResult(cands: ScoredCandidate[], opts: GovernOptions): GovernResult {
  const droppedReasons: Record<string, string> = {};

  if (!cands || cands.length === 0 || opts.budget <= 0 || opts.maxItems <= 0) {
    if (cands) {
      const reason = opts.budget <= 0 ? 'budget_zero' : 'max_items_zero';
      for (const c of cands) {
        droppedReasons[c.memory.id] = reason;
      }
    }
    return { items: [], renderedBlock: '', totalTokens: 0, droppedReasons };
  }

  const strategyVersion = opts.strategyVersion ?? 1;
  const layer = opts.layer ?? 'dynamic';

  // 1. 去掉 alreadyInjected 中的 id@content_rev
  const filtered: ScoredCandidate[] = [];
  for (const c of cands) {
    const key = `${c.memory.id}@${c.memory.content_rev}`;
    if (opts.alreadyInjected.has(key)) {
      droppedReasons[c.memory.id] = 'already_injected';
    } else {
      filtered.push(c);
    }
  }

  if (filtered.length === 0) {
    return { items: [], renderedBlock: '', totalTokens: 0, droppedReasons };
  }

  // 2. 槽位冲突去重：同一个 (scope, slot_key) 只保留最新记录（temporalBrowse 历史浏览模式下跳过折叠，保留历史 superseded 记录）
  let deSlotted: ScoredCandidate[];
  if (opts.temporalBrowse) {
    deSlotted = filtered;
  } else {
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
          const isNewer =
            curTime > existingTime ||
            (curTime === existingTime && m.updated_at > existing.memory.updated_at) ||
            (curTime === existingTime &&
              m.updated_at === existing.memory.updated_at &&
              m.id > existing.memory.id);
          if (isNewer) {
            droppedReasons[existing.memory.id] = 'slot_superseded';
            slotMap.set(slotScopeKey, c);
          } else {
            droppedReasons[m.id] = 'slot_superseded';
          }
        }
      } else {
        noSlotList.push(c);
      }
    }

    deSlotted = [...slotMap.values(), ...noSlotList];
  }

  // 3. 正文哈希去重：hash 相同只保留最高分一条
  const hashMap = new Map<string, ScoredCandidate>();
  for (const c of deSlotted) {
    const h = c.memory.hash;
    const existing = hashMap.get(h);
    if (!existing) {
      hashMap.set(h, c);
    } else if ((c.rawScore ?? c.score) > (existing.rawScore ?? existing.score)) {
      droppedReasons[existing.memory.id] = 'duplicate_hash';
      hashMap.set(h, c);
    } else {
      droppedReasons[c.memory.id] = 'duplicate_hash';
    }
  }

  const candidates = Array.from(hashMap.values());
  if (candidates.length === 0) {
    return { items: [], renderedBlock: '', totalTokens: 0, droppedReasons };
  }

  // 4. 计算 VPT 与混合词法/向量特征（直接复用 fuse.ts 预计算的 docTokens；仅在多候选 MMR 时读取向量）
  const needVectors = candidates.length > 1;
  const withVpt: CandidatePackState[] = candidates.map((c) => ({
    cand: c,
    vpt: c.score / Math.max(c.memory.token_cost, 30),
    tokens: c.docTokens ?? tokenSet(`${c.memory.content} ${c.memory.summary}`),
    vec: needVectors ? getOrComputeEmbedding(c.memory, opts.db) : null,
    approxCode: approxShortCode(c.memory.id),
  }));

  // 按未截断 rawScore 降序找最高分的第一条锚点记忆
  withVpt.sort(
    (a, b) =>
      (b.cand.rawScore ?? b.cand.score) - (a.cand.rawScore ?? a.cand.score) ||
      a.cand.memory.id.localeCompare(b.cand.memory.id)
  );
  const first = withVpt[0];
  const remaining = withVpt.slice(1);

  const selected: SelectedItem[] = [];
  const selectedLines: string[] = [];
  const selectedFeatures: Array<{ tokens: Set<string>; vec: Float32Array | null; type: string }> =
    [];

  // 预计算空包裹层预算开销，结合行级懒缓存实现 O(K) 增量预算评估
  const wrapperBudget = budgetTokens(wrapRenderedLines([''], strategyVersion, layer));
  let runningLineTokens = 0;

  function getLineOpts(memId: string): RenderLineOptions {
    return {
      disputed: opts.contradictionsSet?.has(memId),
      now: opts.now,
    };
  }

  function getL2LineAndTokens(item: CandidatePackState): { line: string; tokens: number } {
    if (item.l2Line === undefined || item.l2Tokens === undefined) {
      const m = item.cand.memory;
      item.l2Line = renderLine(
        { memory: m, form: 'content', tier: 'L2' },
        item.approxCode,
        getLineOpts(m.id)
      );
      item.l2Tokens = budgetTokens(item.l2Line);
    }
    return { line: item.l2Line, tokens: item.l2Tokens };
  }

  function getL1LineAndTokens(
    item: CandidatePackState
  ): { overview: string; line: string; tokens: number } | null {
    if (item.l1Overview === undefined) {
      item.l1Overview = buildL1CandidateOverview(item.cand.memory);
    }
    if (!item.l1Overview) return null;
    if (item.l1Line === undefined || item.l1Tokens === undefined) {
      const m = item.cand.memory;
      item.l1Line = renderLine(
        { memory: m, form: 'summary', tier: 'L1', overview: item.l1Overview },
        item.approxCode,
        getLineOpts(m.id)
      );
      item.l1Tokens = budgetTokens(item.l1Line);
    }
    return { overview: item.l1Overview, line: item.l1Line, tokens: item.l1Tokens };
  }

  function getL0LineAndTokens(item: CandidatePackState): { line: string; tokens: number } {
    if (item.l0Line === undefined || item.l0Tokens === undefined) {
      const m = item.cand.memory;
      item.l0Line = renderLine(
        { memory: m, form: 'summary', tier: 'L0' },
        item.approxCode,
        getLineOpts(m.id)
      );
      item.l0Tokens = budgetTokens(item.l0Line);
    }
    return { line: item.l0Line, tokens: item.l0Tokens };
  }

  /**
   * 增量预算判断：
   * - 快速放行：wrapperBudget + runningLineTokens + lineTokens <= budget（数学上严格保证拼接后 <= budget）
   * - 快速拒绝：超出保守上界且超出边界松弛余量，O(1) 直接拒绝
   * - 窄边界精确复核：仅在临界区间拼接已缓存行字符串校验精确 budgetTokens，零重复 renderLine/redact
   */
  function canFitCandidateLine(line: string, lineTokens: number): boolean {
    const conservativeTotal = wrapperBudget + runningLineTokens + lineTokens;
    if (conservativeTotal <= opts.budget) {
      return true;
    }
    const slackBound = (selectedLines.length + 2) * 4;
    if (conservativeTotal > opts.budget + slackBound) {
      return false;
    }
    const candidateBlock = wrapRenderedLines([...selectedLines, line], strategyVersion, layer);
    return budgetTokens(candidateBlock) <= opts.budget;
  }

  function tryPackCandidate(item: CandidatePackState): boolean {
    if (selected.length >= opts.maxItems) {
      droppedReasons[item.cand.memory.id] = 'max_items';
      return false;
    }
    const m = item.cand.memory;

    // 1. 先尝试 OpenViking L2 (完整 content)
    const l2 = getL2LineAndTokens(item);
    if (canFitCandidateLine(l2.line, l2.tokens)) {
      selected.push({
        memory: m,
        form: 'content',
        tier: 'L2',
        score: item.cand.score,
        tokens: m.token_cost,
      });
      selectedLines.push(l2.line);
      runningLineTokens += l2.tokens;
      selectedFeatures.push({ tokens: item.tokens, vec: item.vec, type: m.type });
      return true;
    }

    // 2. 再尝试 OpenViking L1 (中层结构化 Overview，上限 220 字符)
    const l1 = getL1LineAndTokens(item);
    if (l1 && canFitCandidateLine(l1.line, l1.tokens)) {
      selected.push({
        memory: m,
        form: 'summary',
        tier: 'L1',
        overview: l1.overview,
        score: item.cand.score,
        tokens: Math.max(m.summary_cost, estimateTokens(l1.overview)),
      });
      selectedLines.push(l1.line);
      runningLineTokens += l1.tokens;
      selectedFeatures.push({ tokens: item.tokens, vec: item.vec, type: m.type });
      return true;
    }

    // 3. 回退至 OpenViking L0 (一句话超简 Abstract / summary)
    const l0 = getL0LineAndTokens(item);
    if (canFitCandidateLine(l0.line, l0.tokens)) {
      selected.push({
        memory: m,
        form: 'summary',
        tier: 'L0',
        score: item.cand.score,
        tokens: m.summary_cost,
      });
      selectedLines.push(l0.line);
      runningLineTokens += l0.tokens;
      selectedFeatures.push({ tokens: item.tokens, vec: item.vec, type: m.type });
      return true;
    }

    droppedReasons[m.id] = 'budget_exceeded';
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

  for (const leftover of remaining) {
    droppedReasons[leftover.cand.memory.id] = 'max_items';
  }

  // 6. 最终验证与削减：携带真实 opts.db 渲染一次复核，超限时严格按 L2 -> L1 -> L0 降级后再 pop()
  let renderedBlock = '';
  let totalTokens = 0;

  while (selected.length > 0) {
    renderedBlock = render(
      selected.map((s) => ({
        memory: s.memory,
        form: s.form,
        tier: s.tier,
        overview: s.overview,
      })),
      {
        strategyVersion,
        layer,
        db: opts.db,
        scopeCtx: opts.scopeCtx,
        contradictionsSet: opts.contradictionsSet,
        now: opts.now,
      }
    );
    totalTokens = budgetTokens(renderedBlock);
    if (totalTokens <= opts.budget) {
      break;
    }

    const last = selected[selected.length - 1];
    if (last.tier === 'L2' || (last.form === 'content' && !last.tier)) {
      const l1Overview = buildL1CandidateOverview(last.memory);
      if (l1Overview) {
        last.form = 'summary';
        last.tier = 'L1';
        last.overview = l1Overview;
        last.tokens = Math.max(last.memory.summary_cost, estimateTokens(l1Overview));
        continue;
      }
      last.form = 'summary';
      last.tier = 'L0';
      last.overview = undefined;
      last.tokens = last.memory.summary_cost;
      continue;
    }

    if (last.tier === 'L1') {
      last.form = 'summary';
      last.tier = 'L0';
      last.overview = undefined;
      last.tokens = last.memory.summary_cost;
      continue;
    }

    const popped = selected.pop()!;
    droppedReasons[popped.memory.id] = 'budget_exceeded';
  }

  if (selected.length === 0) {
    renderedBlock = '';
    totalTokens = 0;
  }

  return {
    items: selected,
    renderedBlock,
    totalTokens,
    droppedReasons,
  };
}

/**
 * Token 预算装箱 (§5.7) — 保留既有返回 SelectedItem[] 签名以完全兼容既有调用方
 */
export function govern(cands: ScoredCandidate[], opts: GovernOptions): SelectedItem[] {
  return governWithResult(cands, opts).items;
}
