import type {
  MemoryRecord,
  QueryPlan,
  ChannelName,
  StrategyConfig,
  MemoryType,
  HindsightNetwork,
} from '../types.js';
import type { Candidate, AssociativeNeighbor } from './channels.js';
import { tokenSet, buildStemmedTokenSet, isTokenMatch } from '../core/text.js';
import { classifyHindsightNetwork, computeNetworkIntentBonus } from '../core/hindsight.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export const DEFAULT_STRATEGY: StrategyConfig = {
  rrfK: 25,
  channelWeights: {
    lexical: 1.0,
    entity: 1.2,
    typed: 0.8,
    temporal: 0.8,
    preference: 0.6,
    vector: 1.0,
  },
  scoreWeights: {
    relevance: 0.50,
    confidence: 0.14,
    utility: 0.14,
    freshness: 0.08,
    consistency: 0.06,
    specificity: 0.03,
    importance: 0.05,
  },
  minRelevance: 0.15,
  dynamicBudgetTokens: 1600,
  maxItems: 6,
};

const GRAPH_ONLY_RELEVANCE_CAP = 0.55;

const HALF_LIFE: Record<MemoryType, number> = {
  episodic: 30,
  semantic: 365,
  procedural: 180,
  preference: 365,
  failure: 90,
  belief: 60,
  goal: 14,
  meta: 365,
};

export interface ScoredCandidate {
  memory: MemoryRecord;
  score: number;
  rawScore?: number;
  relevance: number;
  fusedRrf: number;
  network?: HindsightNetwork;
  graphExpanded?: boolean;
  synergyBoosted?: boolean;
  convergentSeeds?: number;
  docTokens?: Set<string>;
}

function finiteNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp01(v: unknown, fallback: number): number {
  const n = finiteNumber(v, fallback);
  return Math.max(0, Math.min(1, n));
}

function isExpiredOrInvalidated(m: MemoryRecord, now: number): boolean {
  if (m.invalidated_at !== null && m.invalidated_at !== undefined && Number.isFinite(m.invalidated_at)) {
    if (m.invalidated_at <= now) return true;
  }
  if (m.valid_to !== null && m.valid_to !== undefined && Number.isFinite(m.valid_to)) {
    if (m.valid_to < now) return true;
  }
  return false;
}

/**
 * SYNAPSE (Jan 2026) / SAGE / ACT-R 基础激活与艾宾浩斯频次强化衰减模型
 * 每次成功召回与正向反馈都会对有效半衰期产生对数延展效应 (Spaced Repetition / Rehearsal Boost)；
 * 同时扣减 fail_count，防止反复失败或被忽略的注入获得虚假复述奖励。
 */
export function computeActRBaseActivation(
  ageDays: number,
  halfLifeDays: number,
  useCount: number = 0,
  successCount: number = 0,
  freshnessMod: number = 1.0,
  failCount: number = 0
): number {
  const safeAge = Math.max(0, finiteNumber(ageDays, 0));
  const safeHalfLife = Math.max(1, finiteNumber(halfLifeDays, 365));
  const safeUse = Math.max(0, finiteNumber(useCount, 0));
  const safeSuccess = Math.max(0, finiteNumber(successCount, 0));
  const safeFail = Math.max(0, finiteNumber(failCount, 0));
  const safeMod = Math.max(0, finiteNumber(freshnessMod, 1.0));

  const effectiveUse = Math.max(0, safeUse - safeFail);
  const effectiveSuccess = Math.max(0, safeSuccess - safeFail * 0.5);
  const rehearsalBoost =
    1 + 0.35 * Math.log(1 + effectiveUse + 2 * effectiveSuccess);
  const effectiveHalfLife = safeHalfLife * rehearsalBoost;
  return Math.exp(-Math.LN2 * (safeAge / effectiveHalfLife)) * safeMod;
}

/**
 * 检查记忆时间是否落在目标区间内：
 * - temporalBrowse ("昨天发生了什么") 仅匹配区间内创建、更新或生效的记录，防止两年前的长期无过期事实误入
 */
function isMemoryInTimeRange(
  m: MemoryRecord,
  range: { from: number; to: number },
  temporalBrowse: boolean = false
): boolean {
  if (m.created_at >= range.from && m.created_at <= range.to) {
    return true;
  }
  if (temporalBrowse) {
    if (m.updated_at >= range.from && m.updated_at <= range.to) {
      return true;
    }
    if (
      m.valid_from !== null &&
      m.valid_from !== undefined &&
      m.valid_from >= range.from &&
      m.valid_from <= range.to
    ) {
      return true;
    }
    return false;
  }
  if (m.valid_from !== null && m.valid_from !== undefined && m.valid_from <= range.to) {
    if (m.valid_to === null || m.valid_to === undefined || m.valid_to >= range.from) {
      return true;
    }
  }
  return false;
}

/**
 * 融合与打分 (§5.6 + SYNAPSE Fan-Effect & ACT-R Base-Level Activation)
 */
export function fuseCandidates(
  plan: QueryPlan,
  channelResults: Record<ChannelName, Candidate[]>,
  memoriesMap: Map<string, MemoryRecord>,
  memoryEntitiesMap: Map<string, Set<string>>,
  contradictionsSet: Set<string>,
  strategy: StrategyConfig = DEFAULT_STRATEGY,
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now(),
  associativeNeighbors: AssociativeNeighbor[] = []
): ScoredCandidate[] {
  const safeNow = finiteNumber(now, Date.now());
  const safeRrfK = Math.max(1, finiteNumber(strategy?.rrfK, DEFAULT_STRATEGY.rrfK));
  const safeMinRelevance = clamp01(strategy?.minRelevance, DEFAULT_STRATEGY.minRelevance);

  // 预计算并缓存候选词元与词干集合，避免 Gate A / Graph 扩展 / Governor 重复 tokenSet 与 stemToken
  const docTokensCache = new Map<string, Set<string>>();
  const docStemsCache = new Map<string, Set<string>>();

  const getDocTokensAndStems = (
    mem: MemoryRecord
  ): { tokens: Set<string>; stems: Set<string> } => {
    let tokens = docTokensCache.get(mem.id);
    let stems = docStemsCache.get(mem.id);
    if (!tokens || !stems) {
      tokens = tokenSet(`${mem.content} ${mem.summary}`);
      stems = buildStemmedTokenSet(tokens);
      docTokensCache.set(mem.id, tokens);
      docStemsCache.set(mem.id, stems);
    }
    return { tokens, stems };
  };

  // 1. 汇总所有召回的 ID 与各通道排名
  const memoryChannels = new Map<string, Map<ChannelName, number>>();
  const candidateSimilarities = new Map<string, number>();

  for (const [chName, candidates] of Object.entries(channelResults) as [ChannelName, Candidate[]][]) {
    if (!Array.isArray(candidates)) continue;
    for (const c of candidates) {
      let chMap = memoryChannels.get(c.id);
      if (!chMap) {
        chMap = new Map();
        memoryChannels.set(c.id, chMap);
      }
      if (!chMap.has(chName)) {
        chMap.set(chName, Math.max(1, finiteNumber(c.rank, 1)));
      }
      if (typeof c.similarity === 'number' && Number.isFinite(c.similarity)) {
        candidateSimilarities.set(c.id, c.similarity);
      }
    }
  }

  // 2. 第一步：绝对相关性硬门槛 (先过滤，再做 RRF)
  const gatedMemoryIds: string[] = [];

  for (const id of memoryChannels.keys()) {
    const mem = memoriesMap.get(id);
    if (!mem) continue;

    // 排除状态：非 active/frozen，除非 temporalBrowse 允许的 superseded
    if (mem.status !== 'active' && mem.status !== 'frozen') {
      if (!(plan.temporalBrowse && mem.status === 'superseded')) {
        continue;
      }
    }
    // meta 永不注入
    if (mem.type === 'meta') {
      continue;
    }
    // 非历史浏览模式下，排除已过期 (valid_to < now) 或已失效 (invalidated_at <= now) 的记忆
    if (!plan.temporalBrowse && isExpiredOrInvalidated(mem, safeNow)) {
      continue;
    }

    // 门槛条件判定
    let passedGate = false;

    // 条件 A: 词汇覆盖率 (coverage >= minLexicalCoverage 且满足命中词数，使用预计算词干集加速形态匹配)
    if (plan.contentTokens.length > 0) {
      const { tokens: memTokens, stems: memStems } = getDocTokensAndStems(mem);
      let matchedCount = 0;
      for (const ct of plan.contentTokens) {
        if (isTokenMatch(ct, memTokens, memStems)) {
          matchedCount++;
        }
      }
      const coverage = matchedCount / Math.max(1, plan.contentTokens.length);
      if (plan.contentTokens.length === 1) {
        if (matchedCount >= 1 && coverage >= cfg.minLexicalCoverage) {
          passedGate = true;
        }
      } else {
        if (matchedCount >= 2 && coverage >= cfg.minLexicalCoverage) {
          passedGate = true;
        }
      }
    }

    // 条件 B: 用户查询本身的某个完整实体精确命中 (contextEntities 不算)
    if (!passedGate && plan.entities.length > 0) {
      const memEnts = memoryEntitiesMap.get(id);
      if (memEnts) {
        for (const ent of plan.entities) {
          if (memEnts.has(ent.toLowerCase().trim())) {
            passedGate = true;
            break;
          }
        }
      }
      if (!passedGate) {
        const lowerContent = mem.content.toLowerCase();
        for (const ent of plan.entities) {
          const lowerEnt = ent.toLowerCase().trim();
          if (lowerEnt.length >= 2 && lowerContent.includes(lowerEnt)) {
            passedGate = true;
            break;
          }
        }
      }
    }

    // 条件 C: 向量相似度 >= minVectorSimilarity
    if (!passedGate) {
      const sim = candidateSimilarities.get(id);
      if (sim !== undefined && sim >= cfg.minVectorSimilarity) {
        passedGate = true;
      }
    }

    // 条件 D: 明确的 temporalBrowse 且时间命中
    if (!passedGate && plan.temporalBrowse && plan.timeRange) {
      if (isMemoryInTimeRange(mem, plan.timeRange, true)) {
        passedGate = true;
      }
    }

    // 条件 E: preferenceBrowse 且 type === preference
    if (!passedGate && plan.preferenceBrowse && mem.type === 'preference') {
      passedGate = true;
    }

    if (passedGate) {
      gatedMemoryIds.push(id);
    }
  }

  if (gatedMemoryIds.length === 0) {
    return [];
  }

  // 2.5 HippoRAG 2 (ICML 2025) 多源 PPR 能量汇聚 + SYNAPSE 扇出衰减关联扩展与关系协同检测
  const initialGatedSet = new Set(gatedMemoryIds);
  const gatedSet = new Set(gatedMemoryIds);
  const graphExpandedIds = new Set<string>();
  const graphOnlyIds = new Set<string>();
  const graphBonusRrf = new Map<string, number>();
  const synergySet = new Set<string>();
  const synergyWeightMap = new Map<string, number>();
  const seedSetByNeighbor = new Map<string, Set<string>>();

  const recordSeedConvergence = (targetId: string, seedId: string) => {
    let s = seedSetByNeighbor.get(targetId);
    if (!s) {
      s = new Set();
      seedSetByNeighbor.set(targetId, s);
    }
    s.add(seedId);
  };

  if (
    associativeNeighbors.length > 0 &&
    (plan.contentTokens.length > 0 || plan.entities.length > 0)
  ) {
    // 预统计非初始门槛邻居的多种子汇聚度，避免首条边因未知后续汇聚种子而被提前丢弃
    const pendingSeedConvergence = new Map<string, Set<string>>();
    for (const edge of associativeNeighbors) {
      if (!initialGatedSet.has(edge.seedId)) continue;
      if (initialGatedSet.has(edge.neighborId)) continue;
      if (contradictionsSet.has(edge.neighborId)) continue;
      const nMem = memoriesMap.get(edge.neighborId);
      if (!nMem) continue;
      if (nMem.status !== 'active' && nMem.status !== 'frozen') continue;
      if (nMem.type === 'meta') continue;
      if (!plan.temporalBrowse && isExpiredOrInvalidated(nMem, safeNow)) continue;

      let seeds = pendingSeedConvergence.get(edge.neighborId);
      if (!seeds) {
        seeds = new Set();
        pendingSeedConvergence.set(edge.neighborId, seeds);
      }
      seeds.add(edge.seedId);
    }

    const neighborOverlapCache = new Map<string, boolean>();
    const hasDirectQueryAnchor = (neighborId: string, nMem: MemoryRecord): boolean => {
      const cached = neighborOverlapCache.get(neighborId);
      if (cached !== undefined) return cached;

      const { tokens: nTokens, stems: nStems } = getDocTokensAndStems(nMem);
      let hasOverlap = false;
      for (const ct of plan.contentTokens) {
        if (isTokenMatch(ct, nTokens, nStems)) {
          hasOverlap = true;
          break;
        }
      }
      if (!hasOverlap && plan.entities.length > 0) {
        const nEnts = memoryEntitiesMap.get(neighborId);
        const lowerContent = nMem.content.toLowerCase();
        for (const ent of plan.entities) {
          const lowerEnt = ent.toLowerCase().trim();
          if (nEnts?.has(lowerEnt) || (lowerEnt.length >= 2 && lowerContent.includes(lowerEnt))) {
            hasOverlap = true;
            break;
          }
        }
      }
      neighborOverlapCache.set(neighborId, hasOverlap);
      return hasOverlap;
    };

    for (const edge of associativeNeighbors) {
      if (!initialGatedSet.has(edge.seedId)) continue;
      if (contradictionsSet.has(edge.neighborId)) continue;

      const fanWeight = clamp01(edge.activationWeight, 1.0);
      const safeSeedRank = Math.max(1, finiteNumber(edge.seedRank, 1));
      const hopPenalty = edge.hop === 2 ? 2 : 0;

      if (initialGatedSet.has(edge.neighborId)) {
        // 两条通过硬门槛的候选之间存在 related / derived_from 关系 -> 触发 SYNAPSE 扇出调制协同增益
        synergySet.add(edge.seedId);
        synergySet.add(edge.neighborId);
        synergyWeightMap.set(
          edge.seedId,
          Math.max(synergyWeightMap.get(edge.seedId) || 0, fanWeight)
        );
        synergyWeightMap.set(
          edge.neighborId,
          Math.max(synergyWeightMap.get(edge.neighborId) || 0, fanWeight)
        );
        recordSeedConvergence(edge.neighborId, edge.seedId);
        const rrfContrib = (0.65 * fanWeight) / (safeRrfK + safeSeedRank + 2 + hopPenalty);
        graphBonusRrf.set(
          edge.neighborId,
          (graphBonusRrf.get(edge.neighborId) || 0) + rrfContrib
        );
        continue;
      }

      // 不再按 seedRank > 4 歧视实体/向量种子
      const nMem = memoriesMap.get(edge.neighborId);
      if (!nMem) continue;
      if (nMem.status !== 'active' && nMem.status !== 'frozen') continue;
      if (nMem.type === 'meta') continue;
      if (!plan.temporalBrowse && isExpiredOrInvalidated(nMem, safeNow)) continue;

      const hasTokenOverlap = hasDirectQueryAnchor(edge.neighborId, nMem);
      const convergentCount = pendingSeedConvergence.get(edge.neighborId)?.size ?? 0;
      const isStrongConvergent = convergentCount >= 2;
      const isStrongDerived =
        edge.rel === 'derived_from' && (edge.hop ?? 1) === 1 && fanWeight >= 0.6;
      const isStrongEntityBridge =
        Boolean(edge.bridgeEntity) &&
        (edge.hop ?? 1) === 1 &&
        (edge.seedDegree ?? 99) <= 5 &&
        fanWeight >= 0.55;

      if (hasTokenOverlap || isStrongConvergent || isStrongDerived || isStrongEntityBridge) {
        if (!gatedSet.has(edge.neighborId)) {
          gatedSet.add(edge.neighborId);
          gatedMemoryIds.push(edge.neighborId);
        }
        graphExpandedIds.add(edge.neighborId);
        if (!hasTokenOverlap) {
          graphOnlyIds.add(edge.neighborId);
        }
        synergySet.add(edge.seedId);
        synergySet.add(edge.neighborId);
        synergyWeightMap.set(
          edge.seedId,
          Math.max(synergyWeightMap.get(edge.seedId) || 0, fanWeight)
        );
        synergyWeightMap.set(
          edge.neighborId,
          Math.max(synergyWeightMap.get(edge.neighborId) || 0, fanWeight)
        );
        recordSeedConvergence(edge.neighborId, edge.seedId);

        const rrfContrib = (0.65 * fanWeight) / (safeRrfK + safeSeedRank + 2 + hopPenalty);
        // HippoRAG 2 PPR 多种子激活能量累加 (Multi-Seed Spreading Activation Accumulation)
        graphBonusRrf.set(
          edge.neighborId,
          (graphBonusRrf.get(edge.neighborId) || 0) + rrfContrib
        );
      }
    }
  }

  // 3. 第二步：加权 RRF 融合
  // fused(m) = Σ_c W[c] / (K + rank_c(m))
  const fusedMap = new Map<string, number>();
  let maxFused = 0;

  for (const id of gatedMemoryIds) {
    const chMap = memoryChannels.get(id);
    let fused = finiteNumber(graphBonusRrf.get(id), 0);
    if (chMap) {
      for (const [chName, rank] of chMap.entries()) {
        const weight = Math.max(
          0,
          finiteNumber(
            strategy?.channelWeights?.[chName],
            DEFAULT_STRATEGY.channelWeights[chName] ?? 1.0
          )
        );
        const safeRank = Math.max(1, finiteNumber(rank, 1));
        fused += weight / (safeRrfK + safeRank);
      }
    }
    if (!Number.isFinite(fused) || fused < 0) fused = 0;
    fusedMap.set(id, fused);
    if (fused > maxFused) {
      maxFused = fused;
    }
  }

  // 4. 第三步：综合打分（尊重外部自定义 strategy.scoreWeights 并对 NaN/Infinity 防御）
  const scoredList: ScoredCandidate[] = [];
  const weights = strategy?.scoreWeights ?? DEFAULT_STRATEGY.scoreWeights;
  const wRelevance = Math.max(0, finiteNumber(weights.relevance, DEFAULT_STRATEGY.scoreWeights.relevance));
  const wConfidence = Math.max(0, finiteNumber(weights.confidence, DEFAULT_STRATEGY.scoreWeights.confidence));
  const wUtility = Math.max(0, finiteNumber(weights.utility, DEFAULT_STRATEGY.scoreWeights.utility));
  const wFreshness = Math.max(0, finiteNumber(weights.freshness, DEFAULT_STRATEGY.scoreWeights.freshness));
  const wConsistency = Math.max(0, finiteNumber(weights.consistency, DEFAULT_STRATEGY.scoreWeights.consistency));
  const wSpecificity = Math.max(0, finiteNumber(weights.specificity, DEFAULT_STRATEGY.scoreWeights.specificity));
  const wImportance =
    weights.importance === undefined ? 0 : Math.max(0, finiteNumber(weights.importance, 0));

  for (const id of gatedMemoryIds) {
    const mem = memoriesMap.get(id);
    if (!mem) continue;

    const fused = fusedMap.get(id) || 0;
    let relevance = maxFused > 0 ? fused / maxFused : 0;
    if (!Number.isFinite(relevance)) relevance = 0;

    // 纯图谱扩散无直接词法/实体锚点的邻居封顶 relevance，防止越权压过直接命中记忆
    if (graphOnlyIds.has(id)) {
      relevance = Math.min(relevance, GRAPH_ONLY_RELEVANCE_CAP);
    }

    // 5. 第四步初筛：相对排名过滤 (relevance < minRelevance 丢弃)
    if (relevance < safeMinRelevance) {
      continue;
    }

    // freshness (Zep 时序失效区间惩罚 + SYNAPSE/ACT-R 艾宾浩斯频次强化模型，含 fail_count 扣减)
    const lastTouch = finiteNumber(mem.last_used_at, finiteNumber(mem.updated_at, safeNow));
    const ageDays = Math.max(0, (safeNow - lastTouch) / 86400000);
    const hl = HALF_LIFE[mem.type] || 365;
    let freshnessMod = 1.0;
    if (
      mem.invalidated_at !== null &&
      mem.invalidated_at !== undefined &&
      Number.isFinite(mem.invalidated_at) &&
      safeNow >= mem.invalidated_at
    ) {
      freshnessMod = 0.1;
    } else if (
      mem.valid_to !== null &&
      mem.valid_to !== undefined &&
      Number.isFinite(mem.valid_to) &&
      safeNow > mem.valid_to
    ) {
      freshnessMod = 0.2;
    }
    const freshness = computeActRBaseActivation(
      ageDays,
      hl,
      mem.use_count ?? 0,
      mem.success_count ?? 0,
      freshnessMod,
      mem.fail_count ?? 0
    );

    // consistency (若存在 active/frozen 的矛盾项，降至 0.3，否则 1.0)
    const consistency = contradictionsSet.has(id) ? 0.3 : 1.0;

    // specificity
    const entCount = (memoryEntitiesMap.get(id) || new Set()).size;
    const specificity = Math.min(1, 0.4 + 0.2 * Math.min(entCount, 3));

    // importance (Stanford Generative Agents 1-10 因子，防御 NaN)
    const safeImportance = Math.max(1, Math.min(10, finiteNumber(mem.importance, 5)));
    const importanceScore = safeImportance / 10.0;

    // confidence / utility 防御 NaN
    const safeConfidence = clamp01(mem.confidence, 0.5);
    const safeUtility = clamp01(mem.utility, 0.5);

    // Relational Synergy Boost (SYNAPSE 扇出注意力调制协同增益 + HippoRAG 2 多源汇聚增益)
    const isSynergy = synergySet.has(id) && !contradictionsSet.has(id);
    const synFan = clamp01(synergyWeightMap.get(id), 1.0);
    const convergentSeeds = seedSetByNeighbor.get(id)?.size ?? 0;
    const multiSeedBonus = convergentSeeds >= 2 ? Math.min(0.03, 0.012 * (convergentSeeds - 1)) : 0;
    const synergyBonus = (isSynergy ? 0.02 + 0.015 * synFan : 0) + multiSeedBonus;

    // Hindsight 四层认知网络意图对齐增益 (World / Experience / Observation / Opinion)
    const network = classifyHindsightNetwork(mem.type, mem.slot_key);
    const networkBonus = computeNetworkIntentBonus(network, plan.intents);

    const rawScore =
      wRelevance * relevance +
      wConfidence * safeConfidence +
      wUtility * safeUtility +
      wFreshness * freshness +
      wConsistency * consistency +
      wSpecificity * specificity +
      wImportance * importanceScore +
      synergyBonus +
      networkBonus;

    const safeRawScore = Number.isFinite(rawScore) ? rawScore : 0;
    const score = Math.max(0, Math.min(1.0, safeRawScore));

    scoredList.push({
      memory: mem,
      score,
      rawScore: safeRawScore,
      relevance,
      fusedRrf: fused,
      network,
      graphExpanded: graphExpandedIds.has(id),
      synergyBoosted: isSynergy,
      ...(convergentSeeds > 0 ? { convergentSeeds } : {}),
      ...(docTokensCache.has(id) ? { docTokens: docTokensCache.get(id) } : {}),
    });
  }

  // 按未截断 rawScore 降序排列，并附带严格确定性破平规则
  scoredList.sort(
    (a, b) =>
      (b.rawScore ?? b.score) - (a.rawScore ?? a.score) ||
      b.relevance - a.relevance ||
      b.fusedRrf - a.fusedRrf ||
      finiteNumber(b.memory.updated_at, 0) - finiteNumber(a.memory.updated_at, 0) ||
      a.memory.id.localeCompare(b.memory.id)
  );

  return scoredList;
}
