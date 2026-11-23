import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  type EmbedQueryOptions,
  embedQueryWithFallback,
  isRemoteEmbeddingEnabled,
} from '../core/embedding-client.js';
import { scopeFilterSQL } from '../core/scope.js';
import { getActiveStrategy, validateAndClampStrategy } from '../evolution/strategy.js';
import {
  type Db,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type QueryPlan,
  type StrategyConfig,
} from '../types.js';
import { buildVectorQueryText, expandGraphNeighbors, runAllChannels } from './channels.js';
import { DEFAULT_STRATEGY, fuseCandidates } from './fuse.js';
import { governWithResult, type SelectedItem } from './governor.js';

export interface RecallContext {
  workspaceId: string;
  sessionId?: string;
  budget?: number;
  alreadyInjected?: Set<string>;
  strategy?: StrategyConfig;
  strategyVersion?: number;
  now?: number;
  cfg?: PluginConfig;
  onlineBudgetMs?: number;
  queryVec?: Float32Array;
}

export type RecallOptions = RecallContext;

export interface RecallResult {
  items: SelectedItem[];
  block: string;
  latencyMs: number;
  strategyVersion?: number;
  candidatesCount?: number;
  matchedChannels?: Record<string, string[]>;
}

/**
 * 只读安全获取当前生效策略：当只读库尚未写入 strategies 表时优雅回退内存默认策略
 */
function resolveActiveStrategy(
  db: Db,
  cfg: PluginConfig
): { version: number; config: StrategyConfig } {
  try {
    return getActiveStrategy(db, cfg);
  } catch {
    return {
      version: 1,
      config: validateAndClampStrategy(DEFAULT_STRATEGY, cfg),
    };
  }
}

/**
 * 检索协调主入口 (§5.4 - §5.7) — 纯同步零网络调用，直接利用本地全量向量矩阵与 FTS5
 */
export function recall(db: Db, plan: QueryPlan, ctx: RecallContext): RecallResult {
  const t0 = Date.now();
  const cfg = ctx.cfg || DEFAULTS;
  const now = ctx.now ?? Date.now();
  const activeStrat = ctx.strategy
    ? { version: ctx.strategyVersion ?? 1, config: ctx.strategy }
    : resolveActiveStrategy(db, cfg);
  const strategy = activeStrat.config;
  const strategyVersion = ctx.strategyVersion ?? activeStrat.version;
  const onlineBudget = ctx.onlineBudgetMs ?? cfg.onlineBudgetMs;
  const alreadyInjected = ctx.alreadyInjected || new Set<string>();

  // 1. 运行召回通道
  const channelResults = runAllChannels(
    db,
    plan,
    {
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      cfg,
      precomputedQueryVec: ctx.queryVec,
    },
    {
      onlineBudgetMs: onlineBudget,
      t0,
    }
  );

  // 2. 收集所有候选 ID
  const allIds = new Set<string>();
  const matchedChannels: Record<string, string[]> = {};
  for (const [chName, cands] of Object.entries(channelResults)) {
    for (const c of cands) {
      allIds.add(c.id);
      const list = matchedChannels[c.id] || [];
      if (!list.includes(chName)) list.push(chName);
      matchedChannels[c.id] = list;
    }
  }

  if (allIds.size === 0) {
    return {
      items: [],
      block: '',
      latencyMs: Date.now() - t0,
      strategyVersion,
      candidatesCount: 0,
      matchedChannels: {},
    };
  }

  // 2.5 GraphRAG 拓扑关联候选发现：轮询交错合并 lexical / entity / vector 高排种子，防止单一通道饿死其余通道
  const topSeedIds: string[] = [];
  const seenSeeds = new Set<string>();
  const pushSeed = (id?: string) => {
    if (id && !seenSeeds.has(id) && topSeedIds.length < 8) {
      seenSeeds.add(id);
      topSeedIds.push(id);
    }
  };
  for (let i = 0; i < 4 && topSeedIds.length < 8; i++) {
    pushSeed(channelResults.lexical[i]?.id);
    pushSeed(channelResults.entity[i]?.id);
    pushSeed(channelResults.vector[i]?.id);
  }

  const associativeNeighbors =
    Date.now() - t0 <= onlineBudget
      ? expandGraphNeighbors(
          db,
          topSeedIds,
          { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, cfg },
          12
        )
      : [];
  for (const edge of associativeNeighbors) {
    allIds.add(edge.neighborId);
  }

  // 3. 批量从数据库加载记忆（通过 hydrateMemoryRow 正确反序列化 origin_kinds）、实体与作用域隔离矛盾关系
  const idList = Array.from(allIds);
  const placeholders = idList.map(() => '?').join(', ');

  const memRows = db.all<MemoryRow>(`SELECT * FROM memories WHERE id IN (${placeholders})`, idList);
  const memoriesMap = new Map<string, MemoryRecord>();
  for (const rawRow of memRows) {
    const hydrated = hydrateMemoryRow(rawRow);
    memoriesMap.set(hydrated.id, hydrated);
  }

  const entRows = db.all<{ memory_id: string; entity: string }>(
    `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
    idList
  );
  const memoryEntitiesMap = new Map<string, Set<string>>();
  for (const row of entRows) {
    let s = memoryEntitiesMap.get(row.memory_id);
    if (!s) {
      s = new Set();
      memoryEntitiesMap.set(row.memory_id, s);
    }
    s.add(row.entity.toLowerCase().trim());
  }

  // 作用域隔离矛盾关系探测：UNION 分别命中 ix_rel_type 与 ix_rel_type_to，并通过 scopeFilterSQL 阻断跨工作区/跨会话矛盾泄漏
  const targetScope = scopeFilterSQL(
    { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
    'target'
  );
  const relRows = db.all<{ cand_id: string }>(
    `SELECT r.from_id AS cand_id
     FROM memory_relations r
     JOIN memories target ON target.id = r.to_id
     WHERE r.rel = 'contradicts'
       AND r.from_id IN (${placeholders})
       AND target.status IN ('active', 'frozen')
       AND (${targetScope.sql})
     UNION
     SELECT r.to_id AS cand_id
     FROM memory_relations r
     JOIN memories target ON target.id = r.from_id
     WHERE r.rel = 'contradicts'
       AND r.to_id IN (${placeholders})
       AND target.status IN ('active', 'frozen')
       AND (${targetScope.sql})`,
    [...idList, ...targetScope.params, ...idList, ...targetScope.params]
  );
  const contradictionsSet = new Set<string>();
  for (const rel of relRows) {
    contradictionsSet.add(rel.cand_id);
  }

  // 4. 融合与打分 (绝对相关性门槛 -> GraphRAG 拓扑协同 -> RRF -> 综合评分 -> 相对排名过滤)
  const scored = fuseCandidates(
    plan,
    channelResults,
    memoriesMap,
    memoryEntitiesMap,
    contradictionsSet,
    strategy,
    cfg,
    now,
    associativeNeighbors
  );

  for (const sc of scored) {
    if (sc.graphExpanded || sc.synergyBoosted) {
      const list = matchedChannels[sc.memory.id] || [];
      if (!list.includes('graph')) list.push('graph');
      matchedChannels[sc.memory.id] = list;
    }
  }

  if (scored.length === 0) {
    return {
      items: [],
      block: '',
      latencyMs: Date.now() - t0,
      strategyVersion,
      candidatesCount: allIds.size,
      matchedChannels,
    };
  }

  // 5 & 6. 预算装箱并复用 governor 最终验证阶段产出的渲染块，消除重复 render() 调用
  const budget =
    cfg.dynamicBudgetTokens === 0
      ? 0
      : Math.min(
          ctx.budget ?? Infinity,
          strategy.dynamicBudgetTokens ?? cfg.dynamicBudgetTokens ?? 1600
        );
  const scopeCtx = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId };
  const governed = governWithResult(scored, {
    budget,
    maxItems: strategy.maxItems,
    alreadyInjected,
    strategyVersion,
    layer: 'dynamic',
    db,
    scopeCtx,
    temporalBrowse: plan.temporalBrowse,
    contradictionsSet,
    now,
  });

  return {
    items: governed.items,
    block: governed.renderedBlock,
    latencyMs: Date.now() - t0,
    strategyVersion,
    candidatesCount: allIds.size,
    matchedChannels,
  };
}

/**
 * 异步检索入口：当显式启用并授权远程 OpenAI-compatible Embedding 时，先通过 embedQueryWithFallback
 * 计算查询向量再注入 recall()；离线/异常/未启用时无缝回退本地 128D 内存向量矩阵。
 */
export async function recallAsync(
  db: Db,
  plan: QueryPlan,
  ctx: RecallContext,
  embedOptions?: EmbedQueryOptions
): Promise<RecallResult> {
  const cfg = ctx.cfg || DEFAULTS;
  let queryVec = ctx.queryVec;
  if (!queryVec && isRemoteEmbeddingEnabled(cfg)) {
    const queryText = buildVectorQueryText(plan);
    if (queryText) {
      const embedded = await embedQueryWithFallback(queryText, cfg, embedOptions);
      queryVec = embedded.vec;
    }
  }
  return recall(db, plan, { ...ctx, queryVec });
}
