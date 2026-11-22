import crypto from 'node:crypto';
import type { Db } from '../../../types.js';
import type { PluginConfig } from '../../../config.js';
import { scopeFilterSQL } from '../../../core/scope.js';
import { getAllCoreMemories } from '../../../core/core-memory.js';
import { auditMemoryHealth, type MemoryHealthReport } from '../../../core/health.js';
import { runHindsightReflect } from '../../../core/hindsight.js';
import { getLedgerUsage } from '../../../evolution/ledger.js';
import { listActiveWorkspaces, queryInjectionTelemetry7d } from '../../../service/index.js';
import { renderStableLayer } from '../../prompt-section.js';
import {
  buildPrivacyWhereSQL,
  resolveWebScope,
  sendJson,
  type WebScope,
} from '../http.js';
import { getHeader, securityHeaders } from '../security.js';
import type { BoundedHealthCache, RouteEntry } from '../router.js';
import {
  buildCoreMemoryData,
  getReadOnlyActiveStrategy,
  NO_ACTIVE_WORKSPACE_SENTINEL,
  type ActiveStrategySnapshot,
  type StableLayerSnapshot,
} from './core-memory.js';
import { buildEvolutionData, queryMemoriesList } from './memories.js';
import { buildVikingRootSummary } from './epistemic.js';

export function computeMemoryFingerprint(db: Db): string {
  const m = db.get<{ c: number; u: number | null; v: number | null }>(
    'SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(version) AS v FROM memories'
  );
  const r = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM memory_relations');
  return `${m?.c ?? 0}:${m?.u ?? 0}:${m?.v ?? 0}:${r?.c ?? 0}`;
}

function computeSnapshotFingerprint(db: Db): string {
  const memFp = computeMemoryFingerprint(db);
  const jobs = db.get<{ c: number; mid: number | null; f: number | null; s: number | null }>(
    'SELECT COUNT(*) AS c, MAX(id) AS mid, MAX(finished_at) AS f, MAX(started_at) AS s FROM jobs'
  );
  const rp = db.get<{ c: number; mid: number | null; pend: number | null }>(
    "SELECT COUNT(*) AS c, MAX(id) AS mid, SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END) AS pend FROM repair_proposals"
  );
  const strat = db.get<{ c: number; mv: number | null; mp: number | null }>(
    'SELECT COUNT(*) AS c, MAX(version) AS mv, MAX(promoted_at) AS mp FROM strategies'
  );
  const ledger = db.get<{ c: number; mid: number | null }>(
    'SELECT COUNT(*) AS c, MAX(id) AS mid FROM llm_ledger'
  );
  const inj = db.get<{ c: number; mc: number | null }>(
    'SELECT COUNT(*) AS c, MAX(created_at) AS mc FROM injections'
  );
  return [
    memFp,
    `${jobs?.c ?? 0}:${jobs?.mid ?? 0}:${jobs?.f ?? 0}:${jobs?.s ?? 0}`,
    `${rp?.c ?? 0}:${rp?.mid ?? 0}:${rp?.pend ?? 0}`,
    `${strat?.c ?? 0}:${strat?.mv ?? 0}:${strat?.mp ?? 0}`,
    `${ledger?.c ?? 0}:${ledger?.mid ?? 0}`,
    `${inj?.c ?? 0}:${inj?.mc ?? 0}`,
  ].join('|');
}

function excludeSignature(cfg: PluginConfig): string {
  const list = cfg.excludeWorkspaces || [];
  if (list.length === 0) return '';
  return crypto.createHash('sha256').update(list.join('\n')).digest('hex').slice(0, 12);
}

function getCachedHealth(
  db: Db,
  cfg: PluginConfig,
  scope: WebScope,
  cache: BoundedHealthCache
): MemoryHealthReport {
  const fp = computeMemoryFingerprint(db);
  const cacheKey = `${scope.wsId || '*'}::${scope.sessionId || ''}::${excludeSignature(cfg)}`;
  const cached = cache.get<MemoryHealthReport>(cacheKey, fp);
  if (cached) return cached;

  const health = auditMemoryHealth(db, {
    workspaceId: scope.wsId,
    sessionId: scope.sessionId,
    excludeWorkspaces: cfg.excludeWorkspaces,
  });
  cache.set(cacheKey, fp, health);
  return health;
}

function computeScopedStats(db: Db, cfg: PluginConfig, scope: WebScope) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (scope.wsId) {
    const sf = scopeFilterSQL({ workspaceId: scope.wsId, sessionId: scope.sessionId }, 'm');
    clauses.push(sf.sql);
    params.push(...sf.params);
  } else if (scope.sessionId) {
    clauses.push("(m.scope != 'session' OR m.session_id = ?)");
    params.push(scope.sessionId);
  } else {
    clauses.push("m.scope != 'session'");
  }

  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length > 0) {
    clauses.push(privacy.sql);
    params.push(...privacy.params);
  }

  const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

  const agg = db.get<{
    total: number;
    avg_conf: number | null;
    avg_util: number | null;
    pinned_count: number | null;
  }>(
    `SELECT
       COUNT(*) AS total,
       AVG(m.confidence) AS avg_conf,
       AVG(m.utility) AS avg_util,
       SUM(CASE WHEN m.pinned != 0 AND m.status IN ('active', 'frozen') THEN 1 ELSE 0 END) AS pinned_count
     FROM memories m${whereSql}`,
    params
  );

  const statusRows = db.all<{ status: string; cnt: number }>(
    `SELECT m.status, COUNT(*) AS cnt FROM memories m${whereSql} GROUP BY m.status`,
    params
  );
  const typeRows = db.all<{ type: string; cnt: number }>(
    `SELECT m.type, COUNT(*) AS cnt FROM memories m${whereSql} GROUP BY m.type`,
    params
  );

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) byStatus[r.status] = Number(r.cnt);
  const byType: Record<string, number> = {};
  for (const r of typeRows) byType[r.type] = Number(r.cnt);

  const total = Number(agg?.total ?? 0);
  return {
    total,
    byStatus,
    byType,
    avgConfidence: total > 0 && agg?.avg_conf != null ? Number(agg.avg_conf) : 0,
    avgUtility: total > 0 && agg?.avg_util != null ? Number(agg.avg_util) : 0,
    pinnedCount: Number(agg?.pinned_count ?? 0),
    active: byStatus.active || 0,
    candidate: byStatus.candidate || 0,
    frozen: byStatus.frozen || 0,
    superseded: byStatus.superseded || 0,
    archived: byStatus.archived || 0,
  };
}

function countScopedPendingRepairs(db: Db, cfg: PluginConfig, scope: WebScope): number {
  const clauses: string[] = ["rp.status = 'candidate'"];
  const params: unknown[] = [];

  if (scope.wsId) {
    const sf = scopeFilterSQL({ workspaceId: scope.wsId, sessionId: scope.sessionId }, 'm');
    clauses.push(sf.sql);
    params.push(...sf.params);
  }
  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length > 0) {
    clauses.push(privacy.sql);
    params.push(...privacy.params);
  }

  return Number(
    db.get<{ c: number }>(
      `SELECT COUNT(*) AS c
       FROM repair_proposals rp
       JOIN memories m ON m.id = rp.memory_id
       WHERE ${clauses.join(' AND ')}`,
      params
    )?.c || 0
  );
}

export function buildOverviewData(
  db: Db,
  cfg: PluginConfig,
  scope: WebScope,
  precomputed?: {
    activeStrat?: ActiveStrategySnapshot;
    stableLayer?: StableLayerSnapshot;
  }
) {
  const st = computeScopedStats(db, cfg, scope);
  const ledger = getLedgerUsage(db, undefined, cfg);
  const telemetry = queryInjectionTelemetry7d(db, {
    workspaceId: scope.wsId,
    excludeWorkspaces: cfg.excludeWorkspaces,
  });
  const pendingRepairsCount = countScopedPendingRepairs(db, cfg, scope);

  const activeStrat = precomputed?.activeStrat ?? getReadOnlyActiveStrategy(db, cfg);
  const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
  const coreBlocks = getAllCoreMemories(db, { workspaceId: effectiveWs });
  const stableLayer =
    precomputed?.stableLayer ??
    renderStableLayer(
      db,
      { workspaceId: effectiveWs, sessionId: scope.sessionId },
      cfg,
      activeStrat.version
    );

  return {
    stats: st,
    dynamicBudgetTokens: activeStrat.config.dynamicBudgetTokens,
    stableBudgetTokens: cfg.stableBudgetTokens ?? 600,
    stableLayerTokens: stableLayer.estimatedTokens,
    stableByteTokens: stableLayer.stableTokens,
    hardBudgetTokens: cfg.hardBudgetTokens ?? 3200,
    pendingRepairsCount,
    activeStrategyVersion: activeStrat.version,
    coreMemoryCount: coreBlocks.length,
    ledger: {
      callsToday: ledger.callsCount,
      tokensToday: ledger.tokensConsumed,
      maxDailyCalls: cfg.dailyLLMCalls || 40,
      maxDailyTokens: cfg.dailyLLMTokens || 200_000,
    },
    recentTelemetry: {
      injectionCount: telemetry.totalInjections,
      totalInjections: telemetry.totalInjections,
      totalTokens: telemetry.totalTokens,
      avgTokens: telemetry.avgTokens,
      hitRate: telemetry.hitRate,
      positiveRate: telemetry.positiveRate,
      negativeRate: telemetry.negativeRate,
      totalTurns: telemetry.totalTurns,
      correctionRate: telemetry.correctionRate,
    },
  };
}

function etagMatches(ifNoneMatch: string | undefined, currentEtag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  const normCurrent = currentEtag.replace(/^W\//, '');
  return trimmed
    .split(',')
    .map((part) => part.trim().replace(/^W\//, ''))
    .some((part) => part === normCurrent);
}

export function createOverviewRoutes(): RouteEntry[] {
  const handleOverview = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const data = buildOverviewData(rctx.db, rctx.cfg, scope);
    sendJson(rctx.res, 200, { ok: true, ...data }, rctx.reqOrigin);
  };

  const handleHealth = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const health = getCachedHealth(rctx.db, rctx.cfg, scope, rctx.healthCache);
    sendJson(rctx.res, 200, { ok: true, health }, rctx.reqOrigin);
  };

  const handleWorkspaces = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const workspaces = listActiveWorkspaces(rctx.db, rctx.cfg);
    sendJson(rctx.res, 200, { ok: true, workspaces }, rctx.reqOrigin);
  };

  /**
   * 复合只读 Studio 快照端点 (Option A)：
   * 单次往返提供 workspaces / stats / health / coreMemory / memories / evolution / hindsight / viking，
   * 仅调用一次 renderStableLayer，并基于 (wsId, queryHash, snapshotFingerprint, configRev) 支持 ETag / 304。
   */
  const handleStudioSnapshot = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const q = (rctx.url.searchParams.get('q') || '').trim();
    const type = (rctx.url.searchParams.get('type') || '').trim();
    const status = (rctx.url.searchParams.get('status') || 'live').trim();
    const memScope = (rctx.url.searchParams.get('scope') || '').trim();
    const excludeCoreParam = rctx.url.searchParams.get('excludeCore');
    const excludeCore =
      excludeCoreParam === null ? true : excludeCoreParam === '1' || excludeCoreParam === 'true';
    const rawLimit = parseInt(rctx.url.searchParams.get('limit') || '60', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 60;
    const rawOffset = parseInt(rctx.url.searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    const queryHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          wsId: scope.wsId || '*',
          sessionId: scope.sessionId || '',
          q,
          type,
          status,
          memScope,
          excludeCore,
          limit,
          offset,
        })
      )
      .digest('hex')
      .slice(0, 16);

    const snapshotFp = computeSnapshotFingerprint(rctx.db);
    const cfgDigest = [
      rctx.getConfigRev(),
      excludeSignature(rctx.cfg),
      rctx.cfg.stableBudgetTokens,
      rctx.cfg.dynamicBudgetTokens,
      rctx.cfg.hardBudgetTokens,
      rctx.cfg.dailyLLMCalls,
      rctx.cfg.dailyLLMTokens,
    ].join(':');

    const etagRaw = crypto
      .createHash('sha256')
      .update(`${scope.wsId || '*'}|${queryHash}|${snapshotFp}|${cfgDigest}`)
      .digest('hex')
      .slice(0, 24);
    const etag = `W/"${etagRaw}"`;

    const ifNoneMatch = getHeader(rctx.req, 'if-none-match');
    if (etagMatches(ifNoneMatch, etag)) {
      rctx.res.writeHead(304, {
        ...securityHeaders(rctx.reqOrigin),
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'Access-Control-Expose-Headers': 'ETag',
      });
      rctx.res.end();
      return;
    }

    const activeStrat = getReadOnlyActiveStrategy(rctx.db, rctx.cfg);
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
    const stableLayer = renderStableLayer(
      rctx.db,
      { workspaceId: effectiveWs, sessionId: scope.sessionId },
      rctx.cfg,
      activeStrat.version
    );

    const workspaces = listActiveWorkspaces(rctx.db, rctx.cfg);
    const stats = buildOverviewData(rctx.db, rctx.cfg, scope, { activeStrat, stableLayer });
    const health = getCachedHealth(rctx.db, rctx.cfg, scope, rctx.healthCache);
    const coreMemory = buildCoreMemoryData(rctx.db, rctx.cfg, scope, { activeStrat, stableLayer });
    const memories = queryMemoriesList(rctx.db, rctx.cfg, {
      q,
      type,
      status,
      scope: memScope,
      excludeCore,
      wsId: scope.wsId,
      sessionId: scope.sessionId,
      limit,
      offset,
    });
    const evolution = buildEvolutionData(rctx.db, rctx.cfg, scope, {
      lite: false,
      activeStrat,
    });

    const hindsightReport = runHindsightReflect(rctx.db, {
      workspaceId: effectiveWs,
      sessionId: scope.sessionId,
      excludeWorkspaces: rctx.cfg.excludeWorkspaces,
      autoSynthesize: false,
      persistCalibration: false,
    });
    const hindsight = {
      workspaceId: hindsightReport.workspaceId,
      disposition: hindsightReport.disposition,
      networkCounts: hindsightReport.networkCounts,
      existingModels: hindsightReport.existingModels,
      calibratedCount: hindsightReport.calibratedMemories.length,
    };

    const viking = buildVikingRootSummary(rctx.db, rctx.cfg, scope);

    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        etag,
        workspaceId: scope.wsId ?? scope.defaultWsId,
        workspaces,
        stats,
        health,
        coreMemory,
        memories,
        evolution,
        hindsight,
        viking,
      },
      rctx.reqOrigin,
      {
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'Access-Control-Expose-Headers': 'ETag',
      }
    );
  };

  return [
    { path: '/overview', methods: { GET: handleOverview } },
    { path: '/stats', methods: { GET: handleOverview } },
    { path: '/health', methods: { GET: handleHealth } },
    { path: '/workspaces', methods: { GET: handleWorkspaces } },
    { path: '/studio-snapshot', methods: { GET: handleStudioSnapshot } },
  ];
}
