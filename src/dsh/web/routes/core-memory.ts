import type { Db, StrategyConfig } from '../../../types.js';
import type { PluginConfig } from '../../../config.js';
import { getAllCoreMemories, DEFAULT_CORE_BLOCKS } from '../../../core/core-memory.js';
import { estimateTokens } from '../../../core/tokens.js';
import { DEFAULT_STRATEGY, validateAndClampStrategy } from '../../../evolution/strategy.js';
import { renderStableLayer } from '../../prompt-section.js';
import { resolveWebScope, sendJson, type WebScope } from '../http.js';
import type { RouteEntry } from '../router.js';

export const NO_ACTIVE_WORKSPACE_SENTINEL = '__dsh_no_active_workspace__';

export interface ActiveStrategySnapshot {
  version: number;
  config: StrategyConfig;
}

export interface StableLayerSnapshot {
  text: string;
  visibleRefs: Set<string>;
  stableTokens: number;
  estimatedTokens: number;
}

/**
 * 严格只读获取当前活跃策略：绝不在 GET 路径触发 initDefaultStrategy 写库
 */
export function getReadOnlyActiveStrategy(
  db: Db,
  cfg: PluginConfig
): ActiveStrategySnapshot {
  try {
    const row = db.get<{ version: number; config: string }>(
      "SELECT version, config FROM strategies WHERE status = 'active' LIMIT 1"
    );
    if (row) {
      const parsed = JSON.parse(row.config);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
          version: row.version,
          config: validateAndClampStrategy(parsed as StrategyConfig, cfg),
        };
      }
    }
  } catch {
    // fallback cleanly to in-memory clamped default strategy
  }
  return {
    version: 1,
    config: validateAndClampStrategy(DEFAULT_STRATEGY, cfg),
  };
}

export interface CoreMemoryBlockDto {
  block: string;
  content: string;
  updated_at: number;
  version: number;
  id: string;
  tokens: number;
}

export interface CoreMemoryPayload {
  blocks: CoreMemoryBlockDto[];
  totalTokens: number;
  stableLayerTokens: number;
  stableByteTokens: number;
  stableBudgetTokens: number;
}

export function buildCoreMemoryData(
  db: Db,
  cfg: PluginConfig,
  scope: WebScope,
  precomputed?: {
    activeStrat?: ActiveStrategySnapshot;
    stableLayer?: StableLayerSnapshot;
  }
): CoreMemoryPayload {
  const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
  const entries = getAllCoreMemories(db, { workspaceId: effectiveWs });
  const entryMap = new Map(entries.map((e) => [e.block, e]));

  const blocks: CoreMemoryBlockDto[] = DEFAULT_CORE_BLOCKS.map((b) => {
    const existing = entryMap.get(b);
    if (existing) {
      entryMap.delete(b);
      return {
        ...existing,
        tokens: estimateTokens(existing.content),
      };
    }
    return {
      block: b,
      content: '',
      updated_at: 0,
      version: 0,
      id: '',
      tokens: 0,
    };
  });

  for (const extra of entryMap.values()) {
    blocks.push({
      ...extra,
      tokens: estimateTokens(extra.content),
    });
  }

  const totalTokens = blocks.reduce((acc, b) => acc + b.tokens, 0);
  const activeStrat = precomputed?.activeStrat ?? getReadOnlyActiveStrategy(db, cfg);
  const stableLayer =
    precomputed?.stableLayer ??
    renderStableLayer(
      db,
      { workspaceId: effectiveWs, sessionId: scope.sessionId },
      cfg,
      activeStrat.version
    );

  return {
    blocks,
    totalTokens,
    stableLayerTokens: stableLayer.estimatedTokens,
    stableByteTokens: stableLayer.stableTokens,
    stableBudgetTokens: cfg.stableBudgetTokens ?? 600,
  };
}

export function createCoreMemoryRoutes(): RouteEntry[] {
  const handleGetCoreMemory = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const data = buildCoreMemoryData(rctx.db, rctx.cfg, scope);
    sendJson(rctx.res, 200, { ok: true, ...data }, rctx.reqOrigin);
  };

  return [
    { path: '/core-memory', methods: { GET: handleGetCoreMemory } },
    { path: '/core', methods: { GET: handleGetCoreMemory } },
  ];
}
