import type { PluginConfig } from '../../../config.js';
import { runHindsightReflect, traceHindsightEvolution } from '../../../core/hindsight.js';
import { scopeFilterSQL } from '../../../core/scope.js';
import {
  browseVikingDirectory,
  findInVikingTree,
  getVikingEvolutionDiff,
  resolveMemoryByVikingUriOrId,
  VIKING_CATEGORY_DESCRIPTIONS,
} from '../../../core/viking.js';
import type { Db, VikingCategory } from '../../../types.js';
import { buildPrivacyWhereSQL, resolveWebScope, sendJson, type WebScope } from '../http.js';
import type { RouteEntry } from '../router.js';
import { NO_ACTIVE_WORKSPACE_SENTINEL } from './core-memory.js';

const VIKING_ROOT_CATEGORY_ORDER: VikingCategory[] = [
  'core',
  'preferences',
  'entities',
  'skills',
  'cases',
  'models',
  'events',
  'profile',
];

function categoryRootUri(cat: VikingCategory): string {
  if (cat === 'core') return 'viking://agent/core/';
  if (cat === 'preferences' || cat === 'profile') return `viking://user/memories/${cat}/`;
  return `viking://workspace/memories/${cat}/`;
}

export interface VikingRootSummary {
  rootUri: string;
  workspaceId: string;
  totalMemories: number;
  categories: Array<{
    category: VikingCategory;
    uri: string;
    count: number;
    description: string;
  }>;
}

/**
 * 严格只读的 OpenViking 根目录分类摘要（单次 SQL GROUP BY，供 /studio-snapshot 使用）
 */
export function buildVikingRootSummary(
  db: Db,
  cfg: PluginConfig,
  scope: WebScope
): VikingRootSummary {
  const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
  const scopeSql = scopeFilterSQL({ workspaceId: effectiveWs, sessionId: scope.sessionId }, 'm');
  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  const privClause = privacy.params.length > 0 ? `AND ${privacy.sql}` : '';

  const rows = db.all<{ cat: VikingCategory; cnt: number }>(
    `SELECT
       CASE
         WHEN m.slot_key LIKE 'core:%' THEN 'core'
         WHEN m.scope = 'user' AND COALESCE(m.slot_key, '') LIKE 'user.profile%' THEN 'profile'
         WHEN COALESCE(m.slot_key, '') LIKE 'hindsight.model.%' THEN 'models'
         WHEN m.type = 'preference' THEN 'preferences'
         WHEN m.type = 'semantic' THEN 'entities'
         WHEN m.type IN ('episodic', 'goal') THEN 'events'
         WHEN m.type = 'failure' THEN 'cases'
         WHEN m.type = 'procedural' THEN 'skills'
         WHEN m.type = 'belief' THEN 'models'
         ELSE 'entities'
       END AS cat,
       COUNT(*) AS cnt
     FROM memories m
     WHERE (${scopeSql.sql})
       AND m.status IN ('active', 'frozen')
       AND m.type != 'meta'
       ${privClause}
     GROUP BY cat`,
    [...scopeSql.params, ...privacy.params]
  );

  const countByCat = new Map<VikingCategory, number>();
  let totalMemories = 0;
  for (const r of rows) {
    const cnt = Number(r.cnt || 0);
    countByCat.set(r.cat, cnt);
    totalMemories += cnt;
  }

  return {
    rootUri: 'viking://',
    workspaceId: scope.defaultWsId,
    totalMemories,
    categories: VIKING_ROOT_CATEGORY_ORDER.map((category) => ({
      category,
      uri: categoryRootUri(category),
      count: countByCat.get(category) ?? 0,
      description: VIKING_CATEGORY_DESCRIPTIONS[category],
    })),
  };
}

export function createEpistemicRoutes(): RouteEntry[] {
  const handleGetViking = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
    const uri = rctx.url.searchParams.get('uri') || 'viking://';
    const query = rctx.url.searchParams.get('query') || '';
    const tierParam = (rctx.url.searchParams.get('tier') || 'L0').toUpperCase();
    const tier = tierParam === 'L2' ? 'L2' : tierParam === 'L1' ? 'L1' : 'L0';
    const includeDiff = rctx.url.searchParams.get('diff') === '1';

    const tree = query.trim()
      ? findInVikingTree(rctx.db, {
          uri,
          query,
          workspaceId: effectiveWs,
          sessionId: scope.sessionId,
          tier,
        })
      : browseVikingDirectory(rctx.db, {
          uri,
          workspaceId: effectiveWs,
          sessionId: scope.sessionId,
          tier,
        });

    const diff = includeDiff
      ? getVikingEvolutionDiff(rctx.db, {
          workspaceId: effectiveWs,
          sessionId: scope.sessionId,
          excludeWorkspaces: rctx.cfg.excludeWorkspaces,
        })
      : null;

    sendJson(rctx.res, 200, { ok: true, uri, tier, tree, diff }, rctx.reqOrigin);
  };

  /**
   * GET /hindsight 严格只读（禁止通过 GET 参数触发合成/校准写库，根除 CSRF-via-GET）
   */
  const handleGetHindsight = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
    const topic = rctx.url.searchParams.get('topic') || undefined;
    const traceTarget = (rctx.url.searchParams.get('trace') || '').trim() || undefined;

    const report = runHindsightReflect(rctx.db, {
      workspaceId: effectiveWs,
      sessionId: scope.sessionId,
      excludeWorkspaces: rctx.cfg.excludeWorkspaces,
      topic,
      autoSynthesize: false,
      persistCalibration: false,
    });

    let trace = null;
    if (traceTarget) {
      const targetMem = resolveMemoryByVikingUriOrId(rctx.db, traceTarget, {
        workspaceId: effectiveWs,
        sessionId: scope.sessionId,
      });
      if (targetMem) {
        const privacy = buildPrivacyWhereSQL(rctx.db, rctx.cfg, 'm');
        const visible =
          privacy.params.length === 0 ||
          Boolean(
            rctx.db.get<{ ok: number }>(
              `SELECT 1 AS ok FROM memories m WHERE m.id = ? AND ${privacy.sql}`,
              [targetMem.id, ...privacy.params]
            )
          );
        if (visible) {
          trace = traceHindsightEvolution(rctx.db, targetMem, {
            workspaceId: effectiveWs,
            sessionId: scope.sessionId,
            excludeWorkspaces: rctx.cfg.excludeWorkspaces,
          });
        }
      }
    }

    sendJson(rctx.res, 200, { ok: true, report, trace }, rctx.reqOrigin);
  };

  return [
    { path: '/viking', methods: { GET: handleGetViking } },
    { path: '/hindsight', methods: { GET: handleGetHindsight } },
  ];
}
