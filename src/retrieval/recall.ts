import type { Db, QueryPlan, MemoryRecord, StrategyConfig } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { runAllChannels } from './channels.js';
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
  for (const cands of Object.values(channelResults)) {
    for (const c of cands) {
      allIds.add(c.id);
    }
  }

  if (allIds.size === 0) {
    return {
      items: [],
      block: '',
      latencyMs: Date.now() - t0,
      strategyVersion,
      candidatesCount: 0,
    };
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

  // 查询是否有处于 active 状态的矛盾项
  const relRows = db.all<{ from_id: string; to_id: string; target_id: string }>(
    `SELECT r.from_id, r.to_id, target.id as target_id
     FROM memory_relations r
     JOIN memories target ON (target.id = r.to_id OR target.id = r.from_id)
     WHERE r.rel = 'contradicts'
       AND target.status IN ('active', 'frozen')
       AND (r.from_id IN (${placeholders}) OR r.to_id IN (${placeholders}))`,
    [...idList, ...idList]
  );
  const contradictionsSet = new Set<string>();
  for (const rel of relRows) {
    if (allIds.has(rel.from_id) && rel.target_id === rel.to_id) {
      contradictionsSet.add(rel.from_id);
    }
    if (allIds.has(rel.to_id) && rel.target_id === rel.from_id) {
      contradictionsSet.add(rel.to_id);
    }
  }

  // 4. 融合与打分 (绝对相关性门槛 -> RRF -> 综合评分 -> 相对排名过滤)
  const scored = fuseCandidates(
    plan,
    channelResults,
    memoriesMap,
    memoryEntitiesMap,
    contradictionsSet,
    strategy,
    cfg,
    now
  );

  if (scored.length === 0) {
    return {
      items: [],
      block: '',
      latencyMs: Date.now() - t0,
      strategyVersion,
      candidatesCount: allIds.size,
    };
  }

  // 5. 预算装箱
  const budget = ctx.budget ?? strategy.dynamicBudgetTokens ?? cfg.dynamicBudgetTokens ?? 1600;
  const selected = govern(scored, {
    budget,
    maxItems: strategy.maxItems,
    alreadyInjected,
    strategyVersion,
    layer: 'dynamic',
  });

  // 6. 渲染
  const block = render(
    selected.map((s) => ({ memory: s.memory, form: s.form })),
    {
      strategyVersion,
      layer: 'dynamic',
      db,
      scopeCtx: { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
    }
  );

  return {
    items: selected,
    block,
    latencyMs: Date.now() - t0,
    strategyVersion,
    candidatesCount: allIds.size,
  };
}
