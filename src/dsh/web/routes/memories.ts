import type { PluginConfig } from '../../../config.js';
import { scopeFilterSQL } from '../../../core/scope.js';
import { segment } from '../../../core/text.js';
import { getLedgerUsage } from '../../../evolution/ledger.js';
import { listStrategies } from '../../../evolution/strategy.js';
import {
  type ApiMemoryRecord,
  getMemoryDetail,
  normalizeMemoryType,
  stripMemoryForApi,
  VALID_SCOPES,
} from '../../../service/index.js';
import { type Db, hydrateMemoryRow, type MemoryRecord, type MemoryRow } from '../../../types.js';
import {
  buildPrivacyWhereSQL,
  HttpError,
  resolveWebScope,
  sendJson,
  type WebScope,
} from '../http.js';
import type { RouteEntry } from '../router.js';
import { type ActiveStrategySnapshot, getReadOnlyActiveStrategy } from './core-memory.js';

export const MEMORY_COLUMNS_NO_EMBEDDING =
  'm.rowid_, m.id, m.type, m.status, m.content, m.summary, m.slot_key, m.scope, m.workspace_id, m.session_id, m.origin_kinds, m.approved_at, m.approved_by, m.source_kind, m.confidence, m.utility, m.use_count, m.success_count, m.fail_count, m.token_cost, m.summary_cost, m.hash, m.version, m.content_rev, m.pinned, m.valid_from, m.valid_to, m.importance, m.invalidated_at, m.created_at, m.updated_at, m.last_used_at, m.last_repair_at';

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface MemoriesListQuery {
  q?: string;
  type?: string;
  status?: string;
  scope?: string;
  excludeCore?: boolean;
  wsId?: string;
  sessionId?: string;
  limit: number;
  offset: number;
}

export interface MemoriesListResult {
  total: number;
  limit: number;
  offset: number;
  items: ApiMemoryRecord[];
}

function buildFtsMatchQuery(q: string): string | null {
  const trimmed = q.trim();
  if (!trimmed || trimmed.startsWith('m_')) return null;
  const rawTokens = segment(trimmed.slice(0, 200));
  const ftsTokens = Array.from(
    new Set(
      rawTokens
        .slice(0, 12)
        .map((t) => t.replace(/"/g, '').trim())
        .filter((t) => t.length >= 2 && /[\p{L}\p{N}]/u.test(t))
    )
  );
  if (ftsTokens.length === 0) return null;
  return ftsTokens.map((t) => `"${t}"*`).join(' AND ');
}

export function queryMemoriesList(
  db: Db,
  cfg: PluginConfig,
  query: MemoriesListQuery
): MemoriesListResult {
  const whereClauses: string[] = [];
  const baseParams: unknown[] = [];

  if (query.wsId) {
    const sf = scopeFilterSQL({ workspaceId: query.wsId, sessionId: query.sessionId }, 'm');
    whereClauses.push(sf.sql);
    baseParams.push(...sf.params);
  } else if (query.sessionId) {
    whereClauses.push("(m.scope != 'session' OR m.session_id = ?)");
    baseParams.push(query.sessionId);
  } else {
    whereClauses.push("m.scope != 'session'");
  }

  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length > 0) {
    whereClauses.push(privacy.sql);
    baseParams.push(...privacy.params);
  }

  if (query.excludeCore) {
    whereClauses.push("COALESCE(m.slot_key, '') NOT LIKE 'core:%'");
  }

  if (query.type && query.type !== 'all') {
    if (query.type === 'experience') {
      whereClauses.push("m.type IN ('episodic', 'failure', 'belief', 'goal', 'meta')");
    } else {
      whereClauses.push('m.type = ?');
      baseParams.push(normalizeMemoryType(query.type));
    }
  }

  if (query.status && query.status !== 'all') {
    if (query.status === 'pinned') {
      whereClauses.push("m.pinned = 1 AND m.status IN ('active', 'frozen')");
    } else if (query.status === 'live') {
      whereClauses.push("m.status IN ('active', 'frozen')");
    } else {
      whereClauses.push('m.status = ?');
      baseParams.push(query.status);
    }
  }

  if (query.scope && query.scope !== 'all') {
    if (VALID_SCOPES.has(query.scope as any)) {
      whereClauses.push('m.scope = ?');
      baseParams.push(query.scope);
    } else {
      return { total: 0, limit: query.limit, offset: query.offset, items: [] };
    }
  }

  const baseWhere = whereClauses.length > 0 ? whereClauses.join(' AND ') : '1 = 1';
  const q = (query.q || '').trim();

  // 1. 优先尝试 memory_fts 倒排索引检索，避免大数据量全表扫描
  if (q) {
    const ftsExpr = buildFtsMatchQuery(q);
    if (ftsExpr) {
      try {
        const ftsCountRow = db.get<{ total: number }>(
          `SELECT COUNT(*) AS total
           FROM memory_fts f
           JOIN memories m ON m.rowid_ = f.rowid
           WHERE memory_fts MATCH ? AND ${baseWhere}`,
          [ftsExpr, ...baseParams]
        );
        const ftsTotal = Number(ftsCountRow?.total || 0);
        if (ftsTotal > 0) {
          const ftsRows = db
            .all<MemoryRow>(
              `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING}
               FROM memory_fts f
               JOIN memories m ON m.rowid_ = f.rowid
               WHERE memory_fts MATCH ? AND ${baseWhere}
               ORDER BY m.pinned DESC, m.updated_at DESC
               LIMIT ? OFFSET ?`,
              [ftsExpr, ...baseParams, query.limit, query.offset]
            )
            .map((r) => hydrateMemoryRow(r));
          return {
            total: ftsTotal,
            limit: query.limit,
            offset: query.offset,
            items: stripMemoryForApi(db, ftsRows),
          };
        }
      } catch {
        // fallback safely to escaped LIKE below
      }
    }
  }

  // 2. 无搜索词、或 FTS 未命中（如按 m_* ID / 标点 / 中缀子串查找）时走转义 LIKE 回退
  const finalClauses = [...whereClauses];
  const finalParams = [...baseParams];
  if (q) {
    finalClauses.push(
      "(m.content LIKE ? ESCAPE '\\' OR m.summary LIKE ? ESCAPE '\\' OR m.slot_key LIKE ? ESCAPE '\\' OR m.id LIKE ? ESCAPE '\\')"
    );
    const qPattern = `%${escapeLike(q.slice(0, 200))}%`;
    finalParams.push(qPattern, qPattern, qPattern, qPattern);
  }

  const finalWhere = finalClauses.length > 0 ? finalClauses.join(' AND ') : '1 = 1';
  const countRow = db.get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM memories m WHERE ${finalWhere}`,
    finalParams
  );
  const totalCount = Number(countRow?.total || 0);

  const rawItems = db
    .all<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING}
       FROM memories m
       WHERE ${finalWhere}
       ORDER BY m.pinned DESC, m.updated_at DESC
       LIMIT ? OFFSET ?`,
      [...finalParams, query.limit, query.offset]
    )
    .map((r) => hydrateMemoryRow(r));

  return {
    total: totalCount,
    limit: query.limit,
    offset: query.offset,
    items: stripMemoryForApi(db, rawItems),
  };
}

function safeParseCandidateIds(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    }
  } catch {}
  return [];
}

export interface EvolutionPayload {
  activeStrategy?: ActiveStrategySnapshot;
  strategies?: ReturnType<typeof listStrategies>;
  repairProposals?: Array<{
    id: number;
    jobId: number;
    memoryId: string;
    contentRev: number;
    action: string;
    candidateIds: string[];
    reason: string;
    status: string;
    createdAt: number;
    expiresAt: number;
    approvedAt: number | null;
    approvedBy: string | null;
    targetSummary: string;
    targetContent: string;
    targetStatus: string;
    candidates: Array<{
      id: string;
      type: string;
      content: string;
      summary: string;
      slot_key: string | null | undefined;
    }>;
  }>;
  recentJobs: Array<{
    id: number;
    kind: string;
    key: string;
    status: string;
    attempts: number;
    last_error: string | null;
    created_at: number;
    updated_at: number | null;
  }>;
  ledger?: ReturnType<typeof getLedgerUsage>;
}

const RECENT_JOBS_SQL =
  'SELECT id, kind, key, status, attempts, error AS last_error, created_at, finished_at AS updated_at FROM jobs ORDER BY id DESC LIMIT 20';

/**
 * 严格只读组装 Evolution 视图（不调用 initDefaultStrategy 写库，repairProposals 限制 LIMIT 50 且过滤 excludeWorkspaces）
 */
export function buildEvolutionData(
  db: Db,
  cfg: PluginConfig,
  scope: WebScope,
  options: { lite?: boolean; activeStrat?: ActiveStrategySnapshot } = {}
): EvolutionPayload {
  const recentJobs = db.all<EvolutionPayload['recentJobs'][number]>(RECENT_JOBS_SQL);
  if (options.lite) {
    return { recentJobs };
  }

  const strategies = listStrategies(db);
  const activeStrategy = options.activeStrat ?? getReadOnlyActiveStrategy(db, cfg);

  const rpClauses: string[] = [];
  const rpParams: unknown[] = [];

  if (scope.wsId) {
    const sf = scopeFilterSQL({ workspaceId: scope.wsId, sessionId: scope.sessionId }, 'm');
    rpClauses.push(sf.sql);
    rpParams.push(...sf.params);
  }
  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length > 0) {
    rpClauses.push(privacy.sql);
    rpParams.push(...privacy.params);
  }
  const rpWhere = rpClauses.length > 0 ? `WHERE ${rpClauses.join(' AND ')}` : '';

  const rawProposalRows = db.all<{
    id: number;
    job_id: number;
    memory_id: string;
    content_rev: number;
    action: string;
    candidate_ids: string;
    reason: string;
    status: string;
    created_at: number;
    expires_at: number;
    approved_at: number | null;
    approved_by: string | null;
  }>(
    `SELECT rp.id, rp.job_id, rp.memory_id, rp.content_rev, rp.action, rp.candidate_ids,
            rp.reason, rp.status, rp.created_at, rp.expires_at, rp.approved_at, rp.approved_by
     FROM repair_proposals rp
     JOIN memories m ON m.id = rp.memory_id
     ${rpWhere}
     ORDER BY rp.id DESC
     LIMIT 50`,
    rpParams
  );

  const rawProposals = rawProposalRows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    memoryId: r.memory_id,
    contentRev: r.content_rev,
    action: r.action,
    candidateIds: safeParseCandidateIds(r.candidate_ids),
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
  }));

  const refIds = new Set<string>();
  for (const p of rawProposals) {
    refIds.add(p.memoryId);
    for (const cid of p.candidateIds) refIds.add(cid);
  }

  const memById = new Map<
    string,
    Pick<MemoryRecord, 'id' | 'type' | 'content' | 'summary' | 'slot_key' | 'status'>
  >();
  if (refIds.size > 0) {
    const idWhere = privacy.params.length > 0 ? `AND ${privacy.sql}` : '';
    const rows = db.all<
      Pick<MemoryRecord, 'id' | 'type' | 'content' | 'summary' | 'slot_key' | 'status'>
    >(
      `SELECT m.id, m.type, m.content, m.summary, m.slot_key, m.status
       FROM memories m
       WHERE m.id IN (SELECT value FROM json_each(?)) ${idWhere}`,
      [JSON.stringify([...refIds]), ...privacy.params]
    );
    for (const m of rows) {
      memById.set(m.id, m);
    }
  }

  const repairProposals = rawProposals.map((p) => {
    const targetMem = memById.get(p.memoryId);
    const candidates = p.candidateIds
      .map((cid) => memById.get(cid))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));
    return {
      ...p,
      targetSummary: targetMem?.summary || targetMem?.content?.slice(0, 80) || '',
      targetContent: targetMem?.content || '',
      targetStatus: targetMem?.status || 'unknown',
      candidates: candidates.map((c) => ({
        id: c.id,
        type: c.type,
        content: c.content,
        summary: c.summary,
        slot_key: c.slot_key,
      })),
    };
  });

  const ledger = getLedgerUsage(db, undefined, cfg);

  return {
    activeStrategy,
    strategies,
    repairProposals,
    recentJobs,
    ledger,
  };
}

export function createMemoriesRoutes(): RouteEntry[] {
  const handleListMemories = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const q = (rctx.url.searchParams.get('q') || '').trim();
    const type = (rctx.url.searchParams.get('type') || '').trim();
    const status = (rctx.url.searchParams.get('status') || '').trim();
    const memScope = (rctx.url.searchParams.get('scope') || '').trim();
    const excludeCoreParam = rctx.url.searchParams.get('excludeCore');
    const excludeCore = excludeCoreParam === '1' || excludeCoreParam === 'true';
    const rawLimit = parseInt(rctx.url.searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
    const rawOffset = parseInt(rctx.url.searchParams.get('offset') || '0', 10);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    const result = queryMemoriesList(rctx.db, rctx.cfg, {
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

    sendJson(rctx.res, 200, { ok: true, ...result }, rctx.reqOrigin);
  };

  const handleGetMemory = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const id = (rctx.url.searchParams.get('id') || '').trim();
    if (!id) {
      throw new HttpError(400, 'id_required', 'id is required');
    }

    const detail = getMemoryDetail(rctx.db, id, {
      scopeCtx: scope.wsId ? { workspaceId: scope.wsId, sessionId: scope.sessionId } : undefined,
      excludeWorkspaces: rctx.cfg.excludeWorkspaces,
    });

    if (!detail) {
      throw new HttpError(404, 'memory_not_found', 'Memory not found');
    }

    const apiMem = stripMemoryForApi(rctx.db, [detail.memory])[0];
    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        memory: apiMem,
        sources: detail.sources,
        history: detail.versions,
        versions: detail.versions,
        relations: detail.relations,
        hindsightTrace: detail.hindsightTrace,
        vikingUri: detail.vikingUri,
        hindsightNetwork: detail.hindsightNetwork,
      },
      rctx.reqOrigin
    );
  };

  const handleGetEvolution = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const lite = rctx.url.searchParams.get('lite') === '1';
    const data = buildEvolutionData(rctx.db, rctx.cfg, scope, { lite });
    sendJson(rctx.res, 200, { ok: true, ...data }, rctx.reqOrigin);
  };

  return [
    { path: '/memories', methods: { GET: handleListMemories } },
    { path: '/list', methods: { GET: handleListMemories } },
    { path: '/memory', methods: { GET: handleGetMemory } },
    { path: '/evolution', methods: { GET: handleGetEvolution } },
  ];
}
