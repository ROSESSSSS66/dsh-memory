import type { Db, QueryPlan, MemoryRecord, StrategyConfig } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { runAllChannels, expandGraphNeighbors } from './channels.js';
import { fuseCandidates, DEFAULT_STRATEGY } from './fuse.js';
import { govern, type SelectedItem } from './governor.js';
import { render } from './render.js';
import { getActiveStrategy } from '../evolution/strategy.js';

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
}

export interface RecallResult {
  items: SelectedItem[];
  block: string;
  latencyMs: number;
  strategyVersion?: number;
  candidatesCount?: number;
  matchedChannels?: Record<string, string[]>;
}

/**
 * 检索协调主入口 (§5.4 - §5.7)
 */
export function recall(
  db: Db,
  plan: QueryPlan,
  ctx: RecallContext
): RecallResult {
  const t0 = Date.now();
  const cfg = ctx.cfg || DEFAULTS;
  const now = ctx.now ?? Date.now();
  const activeStrat = ctx.strategy
    ? { version: ctx.strategyVersion ?? 1, config: ctx.strategy }
    : getActiveStrategy(db, cfg);
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
      sessionId: ctx.sessionId || '',
      cfg,
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

  // 2.5 GraphRAG 一跳拓扑关联候选发现 (沿着 related / derived_from 关系扩展)
  const topSeedIds = [
    ...channelResults.lexical.slice(0, 4).map((c) => c.id),
    ...channelResults.entity.slice(0, 4).map((c) => c.id),
    ...channelResults.vector.slice(0, 3).map((c) => c.id),
  ];
  const associativeNeighbors =
    Date.now() - t0 <= onlineBudget
      ? expandGraphNeighbors(
          db,
          topSeedIds,
          { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId || '', cfg },
          12
        )
      : [];
  for (const edge of associativeNeighbors) {
    allIds.add(edge.neighborId);
  }

  // 3. 批量从数据库加载记忆实体与矛盾关系
  const idList = Array.from(allIds);
  const placeholders = idList.map(() => '?').join(', ');

  const memRows = db.all<MemoryRecord>(
    `SELECT * FROM memories WHERE id IN (${placeholders})`,
    idList
  );
  const memoriesMap = new Map<string, MemoryRecord>();
  for (const m of memRows) {
    memoriesMap.set(m.id, m);
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

  // 查询是否有处于 active 状态的矛盾项 (利用 memory_relations 联合主键与 memories(id) 快速索引查找)
  const relRows = db.all<{ cand_id: string }>(
    `SELECT r.from_id as cand_id
     FROM memory_relations r
     JOIN memories target ON target.id = r.to_id
     WHERE r.rel = 'contradicts'
       AND target.status IN ('active', 'frozen')
       AND r.from_id IN (${placeholders})
     UNION
     SELECT r.to_id as cand_id
     FROM memory_relations r
     JOIN memories target ON target.id = r.from_id
     WHERE r.rel = 'contradicts'
       AND target.status IN ('active', 'frozen')
       AND r.to_id IN (${placeholders})`,
    [...idList, ...idList]
  );
  const contradictionsSet = new Set<string>();
  for (const rel of relRows) {
    contradictionsSet.add(rel.cand_id);
  }

  // 4. 融合与打分 (绝对相关性门槛 -> GraphRAG 一跳协同 -> RRF -> 综合评分 -> 相对排名过滤)
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

  // 5. 预算装箱
  // ctx.budget 是调用方给出的上限（硬预算扣除稳定层后的余量），不覆盖策略自身的动态预算，
  // 否则实验室晋升的 dynamicBudgetTokens 在线上永远不生效
  const budget = cfg.dynamicBudgetTokens === 0 ? 0
    : Math.min(ctx.budget ?? Infinity, strategy.dynamicBudgetTokens ?? cfg.dynamicBudgetTokens ?? 1600);
  const scopeCtx = { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId };
  const selected = govern(scored, {
    budget,
    maxItems: strategy.maxItems,
    alreadyInjected,
    strategyVersion,
    layer: 'dynamic',
    db,
    scopeCtx,
  });

  // 6. 渲染
  const block = render(
    selected.map((s) => ({ memory: s.memory, form: s.form })),
    {
      strategyVersion,
      layer: 'dynamic',
      db,
      scopeCtx,
    }
  );

  return {
    items: selected,
    block,
    latencyMs: Date.now() - t0,
    strategyVersion,
    candidatesCount: allIds.size,
    matchedChannels,
  };
}
