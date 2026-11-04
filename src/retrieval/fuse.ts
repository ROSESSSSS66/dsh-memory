import type {
  MemoryRecord,
  QueryPlan,
  ChannelName,
  StrategyConfig,
  MemoryType,
} from '../types.js';
import type { Candidate } from './channels.js';
import { tokenSet } from '../core/text.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export const DEFAULT_STRATEGY: StrategyConfig = {
  rrfK: 60,
  channelWeights: {
    lexical: 1.0,
    entity: 1.2,
    typed: 0.8,
    temporal: 0.8,
    preference: 0.6,
    vector: 1.0,
  },
  scoreWeights: {
    relevance: 0.3,
    confidence: 0.2,
    utility: 0.2,
    freshness: 0.1,
    consistency: 0.1,
    specificity: 0.1,
  },
  minRelevance: 0.15,
  dynamicBudgetTokens: 1600,
  maxItems: 6,
};

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
  relevance: number;
  fusedRrf: number;
}

/**
 * 检查时间是否与范围重叠
 */
function isMemoryInTimeRange(m: MemoryRecord, range: { from: number; to: number }): boolean {
  if (m.created_at >= range.from && m.created_at <= range.to) {
    return true;
  }
  if (m.valid_from !== null && m.valid_from !== undefined && m.valid_from <= range.to) {
    if (m.valid_to === null || m.valid_to === undefined || m.valid_to >= range.from) {
      return true;
    }
  }
  return false;
}

/**
 * 融合与打分 (§5.6)
 */
export function fuseCandidates(
  plan: QueryPlan,
  channelResults: Record<ChannelName, Candidate[]>,
  memoriesMap: Map<string, MemoryRecord>,
  memoryEntitiesMap: Map<string, Set<string>>,
  contradictionsSet: Set<string>,
  strategy: StrategyConfig = DEFAULT_STRATEGY,
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now()
): ScoredCandidate[] {
  // 1. 汇总所有召回的 ID 与各通道排名
  const memoryChannels = new Map<string, Map<ChannelName, number>>();
  const candidateSimilarities = new Map<string, number>();

  for (const [chName, candidates] of Object.entries(channelResults) as [ChannelName, Candidate[]][]) {
    for (const c of candidates) {
      let chMap = memoryChannels.get(c.id);
      if (!chMap) {
        chMap = new Map();
        memoryChannels.set(c.id, chMap);
      }
      if (!chMap.has(chName)) {
        chMap.set(chName, c.rank);
      }
      if (c.similarity !== undefined) {
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

    // 门槛条件判定
    let passedGate = false;

    // 条件 A: 词汇覆盖率 (coverage >= minLexicalCoverage 且满足命中词数)
    if (plan.contentTokens.length > 0) {
      const memTokens = tokenSet(`${mem.content} ${mem.summary}`);
      let matchedCount = 0;
      for (const ct of plan.contentTokens) {
        if (memTokens.has(ct)) {
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

    // 条件 C: 向量缓存相似度 >= minVectorSimilarity
    if (!passedGate) {
      const sim = candidateSimilarities.get(id);
      if (sim !== undefined && sim >= cfg.minVectorSimilarity) {
        passedGate = true;
      }
    }

    // 条件 D: 明确的 temporalBrowse 且时间命中
    if (!passedGate && plan.temporalBrowse && plan.timeRange) {
      if (isMemoryInTimeRange(mem, plan.timeRange)) {
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

  // 3. 第二步：加权 RRF 融合
  // fused(m) = Σ_c W[c] / (K + rank_c(m))
  const fusedMap = new Map<string, number>();
  let maxFused = 0;

  for (const id of gatedMemoryIds) {
    const chMap = memoryChannels.get(id);
    let fused = 0;
    if (chMap) {
      for (const [chName, rank] of chMap.entries()) {
        const weight = strategy.channelWeights[chName] ?? 1.0;
        fused += weight / (strategy.rrfK + rank);
      }
    }
    fusedMap.set(id, fused);
    if (fused > maxFused) {
      maxFused = fused;
    }
  }

  // 4. 第三步：综合打分
  const scoredList: ScoredCandidate[] = [];
  const weights = strategy.scoreWeights;

  for (const id of gatedMemoryIds) {
    const mem = memoriesMap.get(id)!;
    const fused = fusedMap.get(id) || 0;
    const relevance = maxFused > 0 ? fused / maxFused : 0;

    // 5. 第四步初筛：相对排名过滤 (relevance < minRelevance 丢弃)
    if (relevance < strategy.minRelevance) {
      continue;
    }

    // freshness
    const ageDays = Math.max(0, (now - (mem.last_used_at ?? mem.updated_at)) / 86400000);
    const hl = HALF_LIFE[mem.type] || 365;
    const freshness = Math.exp(-Math.LN2 * (ageDays / hl));

    // consistency (若存在 active/frozen 的矛盾项，降至 0.3，否则 1.0)
    const consistency = contradictionsSet.has(id) ? 0.3 : 1.0;

    // specificity
    const entCount = (memoryEntitiesMap.get(id) || new Set()).size;
    const specificity = Math.min(1, 0.4 + 0.2 * Math.min(entCount, 3));

    const score =
      weights.relevance * relevance +
      weights.confidence * mem.confidence +
      weights.utility * mem.utility +
      weights.freshness * freshness +
      weights.consistency * consistency +
      weights.specificity * specificity;

    scoredList.push({
      memory: mem,
      score,
      relevance,
      fusedRrf: fused,
    });
  }

  // 按 score 降序排列
  scoredList.sort((a, b) => b.score - a.score);

  return scoredList;
}
