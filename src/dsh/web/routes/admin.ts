import * as z from 'zod';
import type { PluginConfig } from '../../../config.js';
import { autoBootstrapMemory } from '../../../core/bootstrap.js';
import { appendCoreMemory, getAllCoreMemories, setCoreMemory } from '../../../core/core-memory.js';
import { autoHealMemoryHealth, weaveZettelkastenLinks } from '../../../core/health.js';
import { runHindsightReflect } from '../../../core/hindsight.js';
import { serializeMemoryToMarkdown } from '../../../core/markdown.js';
import { redactSecrets } from '../../../core/privacy.js';
import { normalizeWorkspacePath, scopeFilterSQL } from '../../../core/scope.js';
import { get, getGraphData, getSubgraph } from '../../../core/store.js';
import { estimateTokens } from '../../../core/tokens.js';
import {
  addRelation,
  approveCandidate,
  confirmMemory,
  freeze,
  mergeMemories,
  pin,
  restoreMemory,
  rollback,
  unfreeze,
  unpin,
  upsertCandidate,
} from '../../../core/writer.js';
import { generateDataset } from '../../../eval/gen-dataset.js';
import { runEvalSuite } from '../../../eval/runner.js';
import { consolidateCluster, findConsolidationClusters } from '../../../evolution/consolidator.js';
import { distillSession } from '../../../evolution/extractor.js';
import { runStrategyEvolution } from '../../../evolution/lab.js';
import { curateMemoriesWithLLM } from '../../../evolution/maintenance.js';
import { reconcileAndUpsert, reconcileCandidate } from '../../../evolution/reconciler.js';
import { approveRepairProposal, rejectRepairProposal } from '../../../evolution/repair.js';
import { rollbackStrategy } from '../../../evolution/strategy.js';
import { runBackfill } from '../../../ingest/backfill.js';
import { buildQueryPlan } from '../../../retrieval/query.js';
import { recall } from '../../../retrieval/recall.js';
import {
  assertWorkspaceAllowed,
  editMemoryRecord,
  expandExcludedWorkspaceIds,
  forgetWithTrash,
  importJsonMemories,
  normalizeMemoryType,
  runUnifiedMaintenance,
  stripMemoryForApi,
  VALID_SCOPES,
} from '../../../service/index.js';
import {
  type Db,
  type GraphData,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type RelationType,
  type Scope,
} from '../../../types.js';
import { renderStableLayer } from '../../prompt-section.js';
import {
  buildPrivacyWhereSQL,
  HttpError,
  readBodyJson,
  resolveWebScope,
  resolveWebScopeValues,
  sendJson,
  str,
} from '../http.js';
import type { RouteEntry, WebRouteContext } from '../router.js';
import { securityHeaders } from '../security.js';
import { getReadOnlyActiveStrategy, NO_ACTIVE_WORKSPACE_SENTINEL } from './core-memory.js';
import { MEMORY_COLUMNS_NO_EMBEDDING } from './memories.js';

const EXPORT_FORMAT_VERSION = '0.11.0';
const MAX_BATCH_IDS = 500;
const MAX_EXPORT_LIMIT = 10_000;
const DEFAULT_EXPORT_LIMIT = 5_000;
const VALID_BATCH_SUBACTIONS = [
  'pin',
  'unpin',
  'freeze',
  'unfreeze',
  'forget',
  'restore',
  'approve',
  'confirm',
] as const;
const VALID_RELATIONS = ['related', 'supersedes', 'contradicts', 'derived_from'] as const;
const CORE_BLOCK_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

const HindsightReflectBodySchema = z
  .object({
    workspaceId: z.string().max(512).optional(),
    sessionId: z.string().max(256).optional(),
    topic: z.string().max(200).optional(),
    autoSynthesize: z.boolean().optional(),
    persistCalibration: z.boolean().optional(),
    minClusterSize: z.number().int().min(2).max(20).optional(),
    disposition: z
      .object({
        skepticism: z.number().finite().min(0).max(1).optional(),
        literalism: z.number().finite().min(0).max(1).optional(),
        empathy: z.number().finite().min(0).max(1).optional(),
      })
      .optional(),
  })
  .strip();

const CoreMemoryPostSchema = z
  .object({
    block: z
      .string()
      .trim()
      .min(1, '请指定 Core Memory 块名称')
      .regex(CORE_BLOCK_NAME_RE, 'Invalid core memory block name'),
    content: z.string().trim().min(1, 'Core Memory 内容不能为空').max(16_000),
    mode: z.enum(['set', 'append']).optional(),
    workspaceId: z.string().max(512).optional(),
    sessionId: z.string().max(256).optional(),
  })
  .strip();

const ReconcilePostSchema = z
  .object({
    content: z.string().trim().min(4, '调和内容至少需要 4 个字符').max(16_000),
    type: z.string().max(64).optional(),
    scope: z.enum(['session', 'workspace', 'user', 'global']).optional(),
    workspaceId: z.string().max(512).optional(),
    sessionId: z.string().max(256).optional(),
    slot_key: z.string().max(128).optional(),
    importance: z.number().optional(),
    dryRun: z.boolean().optional(),
  })
  .strip();

const ImportPostSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    memories: z.array(z.unknown()).optional(),
    workspaceId: z.string().max(512).optional(),
    sessionId: z.string().max(256).optional(),
    allowCrossWorkspace: z.boolean().optional(),
    allowCore: z.boolean().optional(),
  })
  .strip();

const SandboxPostSchema = z
  .object({
    query: z.string().max(2000).optional(),
    workspaceId: z.string().max(512).optional(),
    sessionId: z.string().max(256).optional(),
  })
  .strip();

function assertWebAdminEnabled(rctx: WebRouteContext): boolean {
  if (!rctx.cfg.webAdminEnabled) {
    sendJson(
      rctx.res,
      403,
      {
        ok: false,
        code: 'web_admin_disabled',
        error: 'Web admin endpoints are disabled (enable webAdminEnabled or use /memory CLI)',
      },
      rctx.reqOrigin
    );
    return false;
  }
  return true;
}

function clampFiniteImportance(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(10, Math.round(raw)));
}

function resolveScopedTarget(
  db: Db,
  cfg: PluginConfig,
  idRaw: string,
  scopeCtx?: { workspaceId: string; sessionId?: string }
): MemoryRecord | undefined {
  const id = idRaw.trim();
  if (!id) return undefined;
  const mem = get(db, id, scopeCtx);
  if (!mem) return undefined;
  if (mem.workspace_id) {
    assertWorkspaceAllowed(mem.workspace_id, cfg, { db });
  }
  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length > 0) {
    const allowed = db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM memories m WHERE m.id = ? AND ${privacy.sql}`,
      [mem.id, ...privacy.params]
    );
    if (!allowed) return undefined;
  }
  return mem;
}

function filterGraphByPrivacy(db: Db, cfg: PluginConfig, graph: GraphData): GraphData {
  const privacy = buildPrivacyWhereSQL(db, cfg, 'm');
  if (privacy.params.length === 0 || graph.nodes.length === 0) return graph;

  const memNodeIds = graph.nodes.filter((n) => n.type === 'memory').map((n) => n.id);
  if (memNodeIds.length === 0) return graph;

  const ph = memNodeIds.map(() => '?').join(', ');
  const allowedRows = db.all<{ id: string }>(
    `SELECT m.id FROM memories m WHERE m.id IN (${ph}) AND ${privacy.sql}`,
    [...memNodeIds, ...privacy.params]
  );
  const allowedMemIds = new Set(allowedRows.map((r) => r.id));

  const keptLinks = graph.links.filter((l) => {
    const srcIsMem = memNodeIds.includes(l.source);
    const tgtIsMem = memNodeIds.includes(l.target);
    if (srcIsMem && !allowedMemIds.has(l.source)) return false;
    if (tgtIsMem && !allowedMemIds.has(l.target)) return false;
    return true;
  });

  const activeEntities = new Set<string>();
  const connCounts = new Map<string, number>();
  for (const l of keptLinks) {
    connCounts.set(l.source, (connCounts.get(l.source) || 0) + 1);
    connCounts.set(l.target, (connCounts.get(l.target) || 0) + 1);
    if (!allowedMemIds.has(l.source)) activeEntities.add(l.source);
    if (!allowedMemIds.has(l.target)) activeEntities.add(l.target);
  }

  const keptNodes = graph.nodes
    .filter((n) => (n.type === 'memory' ? allowedMemIds.has(n.id) : activeEntities.has(n.id)))
    .map((n) => ({ ...n, connections: connCounts.get(n.id) || 0 }));

  const memCount = keptNodes.filter((n) => n.type === 'memory').length;
  return {
    nodes: keptNodes,
    links: keptLinks,
    stats: {
      totalNodes: keptNodes.length,
      memoryNodes: memCount,
      entityNodes: keptNodes.length - memCount,
      totalLinks: keptLinks.length,
    },
  };
}

function loadEntitiesForIds(db: Db, memoryIds: string[]): Map<string, string[]> {
  const entityMap = new Map<string, string[]>();
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  for (let i = 0; i < uniqueIds.length; i += 400) {
    const chunk = uniqueIds.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(', ');
    for (const row of db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${ph}) ORDER BY entity ASC`,
      chunk
    )) {
      const arr = entityMap.get(row.memory_id);
      if (arr) arr.push(row.entity);
      else entityMap.set(row.memory_id, [row.entity]);
    }
  }
  return entityMap;
}

function enqueueOrRunAdminJob(
  rctx: WebRouteContext,
  jobSpec: { kind: string; key: string; payload: Record<string, unknown> },
  fallback: () => Promise<void> | void
): Promise<void> | void {
  if (rctx.options?.scheduler) {
    const enqueued = rctx.options.scheduler.enqueue(jobSpec.kind, jobSpec.key, jobSpec.payload);
    sendJson(
      rctx.res,
      202,
      {
        ok: true,
        queued: true,
        enqueued,
        jobKind: jobSpec.kind,
        jobKey: jobSpec.key,
      },
      rctx.reqOrigin
    );
    return;
  }

  return rctx.singleFlight.run(jobSpec.kind, async () => {
    if (rctx.signal.aborted) {
      throw new HttpError(503, 'server_shutting_down', 'Server is shutting down');
    }
    await fallback();
  });
}

export function createAdminRoutes(): RouteEntry[] {
  // 1. POST /hindsight/reflect (显式 POST 执行心智模型合成与置信度校准)
  const handlePostHindsightReflect = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const rawBody = await readBodyJson(rctx.req);
    const body = HindsightReflectBodySchema.parse(rawBody);
    const scope = resolveWebScopeValues(body.workspaceId, body.sessionId, rctx.cfg, rctx.db);
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;

    const report = runHindsightReflect(rctx.db, {
      workspaceId: effectiveWs,
      sessionId: scope.sessionId,
      excludeWorkspaces: rctx.cfg.excludeWorkspaces,
      topic: body.topic,
      disposition: body.disposition,
      autoSynthesize: body.autoSynthesize ?? true,
      persistCalibration: body.persistCalibration ?? true,
      minClusterSize: body.minClusterSize,
    });

    sendJson(rctx.res, 200, { ok: true, report }, rctx.reqOrigin);
  };

  // 2. POST /core-memory & POST /core
  const handlePostCoreMemory = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const rawBody = await readBodyJson(rctx.req);
    const body = CoreMemoryPostSchema.parse(rawBody);

    const block = body.block.toLowerCase();
    const content = body.content;
    if (redactSecrets(content).hasSensitive) {
      throw new HttpError(
        400,
        'sensitive_content_detected',
        'Core memory content contains sensitive credentials'
      );
    }

    const urlWs = rctx.url.searchParams.get('workspaceId') || undefined;
    const urlSession = rctx.url.searchParams.get('sessionId') || undefined;
    const scope = resolveWebScopeValues(
      body.workspaceId || urlWs,
      body.sessionId || urlSession,
      rctx.cfg,
      rctx.db
    );
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;

    if (body.mode === 'append') {
      appendCoreMemory(rctx.db, block, content, {
        workspaceId: effectiveWs,
        sessionId: scope.sessionId,
        actor: 'user',
      });
    } else {
      setCoreMemory(rctx.db, block, content, {
        workspaceId: effectiveWs,
        sessionId: scope.sessionId,
        actor: 'user',
      });
    }

    const blocks = getAllCoreMemories(rctx.db, { workspaceId: effectiveWs }).map((e) => ({
      ...e,
      tokens: estimateTokens(e.content),
    }));
    const totalTokens = blocks.reduce((acc, b) => acc + b.tokens, 0);

    sendJson(rctx.res, 200, { ok: true, block, blocks, totalTokens }, rctx.reqOrigin);
  };

  // 3. POST /reconcile
  const handlePostReconcile = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const rawBody = await readBodyJson(rctx.req);
    const body = ReconcilePostSchema.parse(rawBody);

    const clean = redactSecrets(body.content);
    if (clean.hasSensitive) {
      throw new HttpError(
        400,
        'sensitive_content_detected',
        'Reconcile content contains sensitive credentials'
      );
    }

    const scopeCtx = resolveWebScopeValues(body.workspaceId, body.sessionId, rctx.cfg, rctx.db);
    const effectiveScope: Scope = body.scope ?? (scopeCtx.wsId ? 'workspace' : 'global');
    const slotKey = body.slot_key?.trim() || undefined;
    if (slotKey && slotKey.toLowerCase().startsWith('core:')) {
      throw new HttpError(
        400,
        'cannot_assign_core_slot_key',
        'Cannot assign core:* slot key via reconcile endpoint'
      );
    }

    const dryRun = body.dryRun !== false;
    const importance = clampFiniteImportance(body.importance, 7);
    const targetWsId =
      effectiveScope === 'workspace' || effectiveScope === 'session'
        ? scopeCtx.wsId || scopeCtx.defaultWsId
        : undefined;
    const targetSessionId =
      effectiveScope === 'session' ? scopeCtx.sessionId || 'reconcile_sandbox' : undefined;

    const candidateInput = {
      type: normalizeMemoryType(body.type),
      content: clean.text,
      slot_key: slotKey,
      scope: effectiveScope,
      workspaceId: targetWsId,
      sessionId: targetSessionId,
      source_kind: 'user' as const,
      origin_kinds: ['user' as const],
      confidence: 0.9,
      importance,
      status: 'active' as const,
      sources: [
        {
          session_id: targetSessionId || 'reconcile_sandbox',
          seq: 1,
          kind: 'user',
          excerpt: clean.text.slice(0, 100),
        },
      ],
      actor: 'user' as const,
    };

    if (dryRun) {
      const decision = reconcileCandidate(rctx.db, candidateInput);
      const targetMem = decision.targetId
        ? resolveScopedTarget(
            rctx.db,
            rctx.cfg,
            decision.targetId,
            targetWsId ? { workspaceId: targetWsId, sessionId: targetSessionId } : undefined
          )
        : undefined;
      const targetMemory = targetMem ? stripMemoryForApi(rctx.db, [targetMem])[0] : null;
      sendJson(rctx.res, 200, { ok: true, dryRun: true, decision, targetMemory }, rctx.reqOrigin);
      return;
    }

    const resRec = reconcileAndUpsert(rctx.db, candidateInput, Date.now());
    const savedId = 'id' in resRec ? resRec.id : undefined;
    const savedMem = savedId ? get(rctx.db, savedId) : undefined;
    const memory = savedMem ? stripMemoryForApi(rctx.db, [savedMem])[0] : null;

    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        dryRun: false,
        decision: resRec.decision,
        resultAction: resRec.action,
        memory,
      },
      rctx.reqOrigin
    );
  };

  // 4. GET /graph
  const handleGetGraph = (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const centerId = (rctx.url.searchParams.get('centerId') || '').trim() || undefined;
    const rawLimit = parseInt(rctx.url.searchParams.get('limit') || '80', 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 80;

    if (centerId) {
      const sub = getSubgraph(rctx.db, centerId, {
        workspaceId: scope.wsId,
        sessionId: scope.sessionId,
        hops: 2,
        maxNodes: limit,
      });
      const safeGraph = filterGraphByPrivacy(
        rctx.db,
        rctx.cfg,
        sub || {
          nodes: [],
          links: [],
          stats: { totalNodes: 0, memoryNodes: 0, entityNodes: 0, totalLinks: 0 },
        }
      );
      sendJson(rctx.res, 200, { ok: true, graph: safeGraph }, rctx.reqOrigin);
      return;
    }

    const gData = getGraphData(rctx.db, {
      workspaceId: scope.wsId,
      sessionId: scope.sessionId,
      limit,
    });
    const safeGraph = filterGraphByPrivacy(rctx.db, rctx.cfg, gData);
    sendJson(rctx.res, 200, { ok: true, graph: safeGraph }, rctx.reqOrigin);
  };

  // 5. GET & POST /sandbox
  const handleSandbox = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    let queryText = (rctx.url.searchParams.get('q') || '').trim();
    let rawWs = rctx.url.searchParams.get('workspaceId') || undefined;
    let rawSession = rctx.url.searchParams.get('sessionId') || undefined;

    if (rctx.method === 'POST') {
      const rawBody = await readBodyJson(rctx.req);
      const body = SandboxPostSchema.parse(rawBody);
      if (body.query !== undefined) queryText = body.query.trim();
      if (body.workspaceId !== undefined) rawWs = body.workspaceId.trim() || undefined;
      if (body.sessionId !== undefined) rawSession = body.sessionId.trim() || undefined;
    }

    const scope = resolveWebScopeValues(rawWs, rawSession, rctx.cfg, rctx.db);
    const effectiveWs = scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
    const activeStrat = getReadOnlyActiveStrategy(rctx.db, rctx.cfg);
    const stableLayer = renderStableLayer(
      rctx.db,
      { workspaceId: effectiveWs, sessionId: scope.sessionId },
      rctx.cfg,
      activeStrat.version
    );

    let recallSimulation: unknown = null;
    if (queryText) {
      const plan = buildQueryPlan({ userText: queryText, cfg: rctx.cfg });
      // 直接复用 recall() 内部单次 runAllChannels 结果与 matchedChannels，消除重复检索
      const recRes = recall(rctx.db, plan, {
        workspaceId: effectiveWs,
        sessionId: scope.sessionId,
        alreadyInjected: stableLayer.visibleRefs,
        strategy: activeStrat.config,
        strategyVersion: activeStrat.version,
        cfg: rctx.cfg,
      });

      const strippedMemories = stripMemoryForApi(
        rctx.db,
        recRes.items.map((it) => it.memory)
      );

      recallSimulation = {
        query: queryText,
        latencyMs: recRes.latencyMs,
        dynamicTokens: estimateTokens(recRes.block),
        block: recRes.block,
        plan: {
          tokens: plan.tokens,
          contentTokens: plan.contentTokens,
          entities: plan.entities,
          intents: plan.intents,
          temporalBrowse: plan.temporalBrowse,
          preferenceBrowse: plan.preferenceBrowse,
        },
        items: recRes.items.map((it, idx) => ({
          memory: strippedMemories[idx],
          form: it.form,
          score: Number(it.score.toFixed(4)),
          tokens: it.tokens,
          matchedChannels: recRes.matchedChannels?.[it.memory.id] || ['lexical'],
        })),
      };
    }

    // 按 scope 与 excludeWorkspaces 过滤 recentInjections
    const injClauses: string[] = [];
    const injParams: unknown[] = [];
    if (scope.wsId) {
      injClauses.push(
        'EXISTS (SELECT 1 FROM session_workspace_owners swo WHERE swo.session_id = i.session_id AND swo.workspace_id = ?)'
      );
      injParams.push(scope.wsId);
    }
    const excludedIds = expandExcludedWorkspaceIds(rctx.db, rctx.cfg.excludeWorkspaces || []);
    if (excludedIds.length > 0) {
      const ph = excludedIds.map(() => '?').join(', ');
      injClauses.push(
        `NOT EXISTS (SELECT 1 FROM session_workspace_owners swo_ex WHERE swo_ex.session_id = i.session_id AND swo_ex.workspace_id IN (${ph}))`
      );
      injParams.push(...excludedIds);
      const priv = buildPrivacyWhereSQL(rctx.db, rctx.cfg, 'm');
      if (priv.params.length > 0) {
        injClauses.push(`(m.id IS NULL OR ${priv.sql})`);
        injParams.push(...priv.params);
      }
    }
    const injWhere = injClauses.length > 0 ? `WHERE ${injClauses.join(' AND ')}` : '';

    const recentInjections = rctx.db.all(
      `SELECT i.rowid AS id, i.session_id, i.turn, i.memory_id, i.layer, i.rank, i.tokens, i.form,
              i.strategy_v, i.outcome, i.created_at,
              m.type AS memory_type, m.content AS memory_content, m.summary AS memory_summary, m.slot_key
       FROM injections i
       LEFT JOIN memories m ON m.id = i.memory_id
       ${injWhere}
       ORDER BY i.created_at DESC, i.rowid DESC
       LIMIT 30`,
      injParams
    );

    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        stableLayer: {
          text: stableLayer.text,
          stableTokens: stableLayer.estimatedTokens,
          stableByteTokens: stableLayer.stableTokens,
          stableBudgetTokens: rctx.cfg.stableBudgetTokens ?? 600,
          visibleCount: stableLayer.visibleRefs.size,
        },
        dynamicBudgetTokens: activeStrat.config.dynamicBudgetTokens,
        hardBudgetTokens: rctx.cfg.hardBudgetTokens ?? 3200,
        strategyVersion: activeStrat.version,
        recallSimulation,
        recentInjections,
      },
      rctx.reqOrigin
    );
  };

  // 6. GET /export
  const handleGetExport = (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const scope = resolveWebScope(rctx.url, rctx.cfg, rctx.db);
    const format = (rctx.url.searchParams.get('format') || 'json').toLowerCase();
    if (format !== 'json' && format !== 'markdown') {
      throw new HttpError(400, 'invalid_format', 'format must be json or markdown');
    }

    const rawLimit = parseInt(
      rctx.url.searchParams.get('limit') || String(DEFAULT_EXPORT_LIMIT),
      10
    );
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_EXPORT_LIMIT, rawLimit))
      : DEFAULT_EXPORT_LIMIT;

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

    const privacy = buildPrivacyWhereSQL(rctx.db, rctx.cfg, 'm');
    if (privacy.params.length > 0) {
      clauses.push(privacy.sql);
      params.push(...privacy.params);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const items = rctx.db
      .all<MemoryRow>(
        `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING}
         FROM memories m
         ${whereSql}
         ORDER BY m.pinned DESC, m.updated_at DESC
         LIMIT ?`,
        [...params, limit]
      )
      .map((r) => hydrateMemoryRow(r));

    if (format === 'markdown') {
      const entityMap = loadEntitiesForIds(
        rctx.db,
        items.map((m) => m.id)
      );
      const mdSections = items.map((m) => serializeMemoryToMarkdown(m, entityMap.get(m.id) || []));
      const fullMd =
        `# DSH 长期记忆知识库导出 (${items.length} 条)\n\n导出时间: ${new Date().toISOString()}\n\n---\n\n` +
        mdSections.join('\n\n---\n\n');
      rctx.res.writeHead(200, {
        ...securityHeaders(rctx.reqOrigin),
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dsh-memories.md"',
        'Content-Security-Policy': 'sandbox',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      rctx.res.end(fullMd);
      return;
    }

    const apiItems = stripMemoryForApi(rctx.db, items).map((m) => ({
      ...m,
      content: redactSecrets(m.content).text,
      summary: redactSecrets(m.summary).text,
      slot_key: m.slot_key ? redactSecrets(m.slot_key).text : m.slot_key,
    }));

    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        version: EXPORT_FORMAT_VERSION,
        exportedAt: Date.now(),
        total: apiItems.length,
        memories: apiItems,
      },
      rctx.reqOrigin
    );
  };

  // 7. POST /import (委托 importJsonMemories：保留 candidate 与 frozen，严守 core:* 守卫)
  const handlePostImport = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const rawBody = await readBodyJson(rctx.req);
    const body = ImportPostSchema.parse(rawBody);
    const rawItems = body.items ?? body.memories ?? [];
    if (rawItems.length === 0) {
      throw new HttpError(400, 'empty_import', '导入数据不能为空，未发现有效记忆条目');
    }

    const scope = resolveWebScopeValues(body.workspaceId, body.sessionId, rctx.cfg, rctx.db);
    const allowCore = body.allowCore === true;

    // 显式守护 core:* 槽位：除非明确传 allowCore: true，否则拦截 core:* 覆盖，同时保持 trusted=true 以便还原 frozen/pinned
    const filteredItems: unknown[] = [];
    let coreRejected = 0;
    const coreErrors: string[] = [];
    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      if (
        !allowCore &&
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).slot_key === 'string' &&
        ((item as Record<string, unknown>).slot_key as string)
          .trim()
          .toLowerCase()
          .startsWith('core:')
      ) {
        coreRejected++;
        coreErrors.push(`item[${i}]: core_slot_requires_allow_core`);
        continue;
      }
      filteredItems.push(item);
    }

    const resImp = importJsonMemories(rctx.db, filteredItems, {
      workspaceId: scope.wsId,
      sessionId: scope.sessionId,
      trusted: true,
      actor: 'user',
      cfg: rctx.cfg,
      allowCrossWorkspace: body.allowCrossWorkspace ?? !scope.wsId,
    });

    if (resImp.errors.some((e) => e.startsWith('exceeds_max_items:'))) {
      throw new HttpError(400, 'exceeds_max_items', resImp.errors[0]);
    }
    if (resImp.errors.includes('workspace_excluded')) {
      throw new HttpError(
        403,
        'workspace_excluded',
        'Workspace is excluded by privacy configuration'
      );
    }

    if (resImp.imported > 0) {
      try {
        weaveZettelkastenLinks(rctx.db, {
          workspaceId: scope.wsId,
          excludeWorkspaces: rctx.cfg.excludeWorkspaces,
        });
      } catch {}
    }

    sendJson(
      rctx.res,
      200,
      {
        ok: true,
        imported: resImp.imported,
        merged: resImp.merged,
        skipped: resImp.skipped + coreRejected,
        total: rawItems.length,
        errors: [...coreErrors, ...resImp.errors],
      },
      rctx.reqOrigin
    );
  };

  // 8. POST /action
  const handlePostAction = async (rctx: WebRouteContext) => {
    if (!assertWebAdminEnabled(rctx)) return;
    const body = await readBodyJson(rctx.req);
    const action = str(body.action);
    if (!action) {
      throw new HttpError(400, 'action_required', 'action is required');
    }

    const bodyWsRaw = str(body.workspaceId) || undefined;
    const bodySessionRaw = str(body.sessionId) || undefined;
    const scope = resolveWebScopeValues(bodyWsRaw, bodySessionRaw, rctx.cfg, rctx.db);
    const scopeCtx = scope.wsId
      ? { workspaceId: scope.wsId, sessionId: scope.sessionId }
      : undefined;
    const id = str(body.id);

    if (action === 'pin' || action === 'unpin') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const ok =
        action === 'pin' ? pin(rctx.db, target.id, 'user') : unpin(rctx.db, target.id, 'user');
      if (!ok) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      sendJson(
        rctx.res,
        200,
        { ok: true, id: target.id, pinned: action === 'pin' },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'freeze' || action === 'unfreeze') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const ok =
        action === 'freeze'
          ? freeze(rctx.db, target.id, 'user')
          : unfreeze(rctx.db, target.id, 'user');
      if (!ok) {
        throw new HttpError(
          404,
          'invalid_status_transition',
          `Memory ${id} cannot be ${action === 'freeze' ? 'frozen' : 'unfrozen'} in its current status`
        );
      }
      sendJson(
        rctx.res,
        200,
        { ok: true, id: target.id, status: action === 'freeze' ? 'frozen' : 'active' },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'forget') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const resForget = forgetWithTrash(rctx.db, target.id, {
        actor: 'user',
        scopeCtx,
        dataDir: rctx.cfg.dataDir,
      });
      if (!resForget.ok) {
        if (resForget.error === 'memory_is_frozen') {
          throw new HttpError(409, 'memory_is_frozen', 'Memory is frozen and cannot be forgotten');
        }
        if (resForget.error === 'memory_not_found') {
          throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
        }
        throw new HttpError(400, 'forget_failed', resForget.error || 'Failed to forget memory');
      }
      sendJson(
        rctx.res,
        200,
        {
          ok: true,
          id: resForget.id ?? target.id,
          status: 'archived',
          ...(resForget.trashedPath ? { trashedPath: resForget.trashedPath } : {}),
        },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'approve') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const approveRes = approveCandidate(rctx.db, target.id, 'user', Date.now());
      if (approveRes.action === 'rejected') {
        throw new HttpError(400, 'approve_rejected', approveRes.reason);
      }
      sendJson(rctx.res, 200, { ok: true, id: target.id, result: approveRes }, rctx.reqOrigin);
      return;
    }

    if (action === 'confirm') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const resConfirm = confirmMemory(rctx.db, target.id, 'user');
      if (!resConfirm.success) {
        throw new HttpError(400, 'confirm_failed', resConfirm.message);
      }
      sendJson(
        rctx.res,
        200,
        { ok: true, id: target.id, message: resConfirm.message },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'merge') {
      const sourceId = str(body.sourceId);
      const targetId = str(body.targetId);
      const reason = str(body.reason) || 'web_merge';
      const src = resolveScopedTarget(rctx.db, rctx.cfg, sourceId, scopeCtx);
      const tgt = resolveScopedTarget(rctx.db, rctx.cfg, targetId, scopeCtx);
      if (!src || !tgt) {
        throw new HttpError(404, 'memory_not_found', 'Source or target memory not found');
      }
      const resMerge = mergeMemories(rctx.db, src.id, tgt.id, reason, 'user');
      if (!resMerge.success) {
        throw new HttpError(400, 'merge_failed', resMerge.message);
      }
      sendJson(rctx.res, 200, { ok: true, message: resMerge.message }, rctx.reqOrigin);
      return;
    }

    if (action === 'restore') {
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const resRestore = restoreMemory(rctx.db, target.id, 'user');
      if (!resRestore.success) {
        throw new HttpError(400, 'restore_failed', resRestore.message);
      }
      sendJson(
        rctx.res,
        200,
        { ok: true, id: target.id, message: resRestore.message },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'edit') {
      const rawContent = typeof body.content === 'string' ? body.content.trim() : '';
      if (rawContent.length < 4) {
        throw new HttpError(400, 'invalid_content', '记忆内容至少需要 4 个字符');
      }
      const rawScope = str(body.scope);
      if (rawScope && !VALID_SCOPES.has(rawScope as Scope)) {
        throw new HttpError(400, 'invalid_scope', `Invalid scope: ${rawScope}`);
      }
      const patch = {
        content: rawContent,
        ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
        ...(typeof body.type === 'string' && body.type.trim()
          ? { type: normalizeMemoryType(body.type) }
          : {}),
        ...(rawScope ? { scope: rawScope as Scope } : {}),
        ...(body.slot_key !== undefined
          ? { slot_key: body.slot_key ? String(body.slot_key).trim() : null }
          : {}),
        ...(typeof body.importance === 'number' && Number.isFinite(body.importance)
          ? { importance: clampFiniteImportance(body.importance, 5) }
          : {}),
        ...(scope.wsId ? { workspaceId: scope.wsId } : {}),
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      };

      const resEdit = editMemoryRecord(rctx.db, id, patch, {
        actor: 'user',
        cfg: rctx.cfg,
        scopeCtx,
      });

      sendJson(
        rctx.res,
        200,
        {
          ok: true,
          id: resEdit.memory.id,
          version: resEdit.version,
          content_rev: resEdit.content_rev,
          ...(resEdit.supersededId ? { supersededId: resEdit.supersededId } : {}),
          memory: stripMemoryForApi(rctx.db, [resEdit.memory])[0],
        },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'rollback') {
      const targetVersion = body.targetVersion;
      if (
        typeof targetVersion !== 'number' ||
        !Number.isInteger(targetVersion) ||
        targetVersion < 1
      ) {
        throw new HttpError(400, 'invalid_target_version', '请指定要回滚的目标版本号');
      }
      const target = resolveScopedTarget(rctx.db, rctx.cfg, id, scopeCtx);
      if (!target) {
        throw new HttpError(404, 'memory_not_found', `Memory ${id} not found`);
      }
      const resRb = rollback(rctx.db, target.id, targetVersion, 'user', Date.now());
      sendJson(rctx.res, 200, { id: target.id, ...resRb }, rctx.reqOrigin);
      return;
    }

    if (action === 'batch') {
      const subAction = str(body.subAction) as (typeof VALID_BATCH_SUBACTIONS)[number];
      if (!VALID_BATCH_SUBACTIONS.includes(subAction)) {
        throw new HttpError(
          400,
          'invalid_batch_action',
          `Unknown batch action: ${String(body.subAction)}`
        );
      }
      const ids: string[] = Array.isArray(body.ids)
        ? Array.from(
            new Set<string>(
              body.ids
                .filter((x: unknown): x is string => typeof x === 'string' && x.trim().length > 0)
                .map((x) => x.trim())
            )
          )
        : [];
      if (ids.length === 0) {
        throw new HttpError(400, 'empty_batch_ids', '请选择至少一条记忆');
      }
      if (ids.length > MAX_BATCH_IDS) {
        throw new HttpError(400, 'batch_too_large', `单次批量操作最多 ${MAX_BATCH_IDS} 条`);
      }

      const now = Date.now();
      const results: Array<{ id: string; ok: boolean; error?: string }> = [];
      let affected = 0;

      rctx.db.transaction(() => {
        for (const targetId of ids) {
          try {
            const target = resolveScopedTarget(rctx.db, rctx.cfg, targetId, scopeCtx);
            if (!target) {
              results.push({ id: targetId, ok: false, error: 'memory_not_found' });
              continue;
            }
            let ok = false;
            let errMsg: string | undefined;
            if (subAction === 'pin') ok = pin(rctx.db, target.id, 'user', now);
            else if (subAction === 'unpin') ok = unpin(rctx.db, target.id, 'user', now);
            else if (subAction === 'freeze') ok = freeze(rctx.db, target.id, 'user', now);
            else if (subAction === 'unfreeze') ok = unfreeze(rctx.db, target.id, 'user', now);
            else if (subAction === 'forget') {
              const fg = forgetWithTrash(rctx.db, target.id, {
                actor: 'user',
                now,
                scopeCtx,
                dataDir: rctx.cfg.dataDir,
              });
              ok = fg.ok;
              errMsg = fg.error;
            } else if (subAction === 'restore') {
              const rs = restoreMemory(rctx.db, target.id, 'user', now);
              ok = rs.success;
              errMsg = rs.success ? undefined : rs.message;
            } else if (subAction === 'approve') {
              const ap = approveCandidate(rctx.db, target.id, 'user', now);
              ok = ap.action !== 'rejected';
              errMsg = ap.action === 'rejected' ? ap.reason : undefined;
            } else if (subAction === 'confirm') {
              const cf = confirmMemory(rctx.db, target.id, 'user', now);
              ok = cf.success;
              errMsg = cf.success ? undefined : cf.message;
            }

            if (ok) {
              affected++;
              results.push({ id: target.id, ok: true });
            } else {
              results.push({ id: target.id, ok: false, error: errMsg || 'operation_failed' });
            }
          } catch (err: unknown) {
            results.push({
              id: targetId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });

      sendJson(rctx.res, 200, { ok: true, affected, total: ids.length, results }, rctx.reqOrigin);
      return;
    }

    if (action === 'create') {
      const rawContent = typeof body.content === 'string' ? body.content.trim() : '';
      if (rawContent.length < 4) {
        throw new HttpError(400, 'invalid_content', 'Content must be at least 4 characters');
      }
      const targetScope = (str(body.scope) || 'global') as Scope;
      if (!VALID_SCOPES.has(targetScope)) {
        throw new HttpError(400, 'invalid_scope', `Invalid scope: ${String(body.scope)}`);
      }
      const slotKey = str(body.slot_key) || undefined;
      if (slotKey && slotKey.toLowerCase().startsWith('core:')) {
        throw new HttpError(
          400,
          'cannot_assign_core_slot_key',
          'Cannot assign core:* slot key via generic create action'
        );
      }
      const clean = redactSecrets(rawContent);
      if (clean.hasSensitive) {
        throw new HttpError(
          400,
          'sensitive_content_detected',
          'Memory content contains sensitive credentials'
        );
      }
      const rawSummary = typeof body.summary === 'string' ? body.summary.trim() : '';
      if (rawSummary && redactSecrets(rawSummary).hasSensitive) {
        throw new HttpError(
          400,
          'sensitive_content_detected',
          'Memory summary contains sensitive credentials'
        );
      }

      const now = Date.now();
      const resUpsert = upsertCandidate(
        rctx.db,
        {
          type: normalizeMemoryType(body.type, 'preference'),
          scope: targetScope,
          workspaceId:
            targetScope === 'workspace' || targetScope === 'session'
              ? scope.wsId || scope.defaultWsId
              : undefined,
          sessionId: targetScope === 'session' ? scope.sessionId || 'manual_ui_entry' : undefined,
          content: clean.text,
          summary: rawSummary || undefined,
          slot_key: slotKey,
          importance: clampFiniteImportance(body.importance, 5),
          confidence: 0.95,
          source_kind: 'user',
          origin_kinds: ['user'],
          actor: 'user',
          sources: [
            {
              session_id: scope.sessionId || 'manual_ui_entry',
              seq: 1,
              kind: 'user',
              excerpt: clean.text.slice(0, 100),
            },
          ],
        },
        now,
        rctx.cfg
      );

      if (resUpsert.action === 'rejected') {
        throw new HttpError(400, 'upsert_rejected', resUpsert.reason);
      }

      if (body.pinned === true) {
        pin(rctx.db, resUpsert.id, 'user', now);
      }

      const stored = get(rctx.db, resUpsert.id);
      const memory = stored ? stripMemoryForApi(rctx.db, [stored])[0] : null;
      sendJson(rctx.res, 200, { ok: true, memory }, rctx.reqOrigin);
      return;
    }

    if (action === 'add-relation') {
      const fromRaw = str(body.fromId);
      const toRaw = str(body.toId);
      const relType = str(body.rel) as RelationType;
      if (!fromRaw || !toRaw || !(VALID_RELATIONS as readonly string[]).includes(relType)) {
        throw new HttpError(400, 'invalid_relation', '请提供有效的起始 ID、目标 ID 与关联类型');
      }
      const fromMem = resolveScopedTarget(rctx.db, rctx.cfg, fromRaw, scopeCtx);
      const toMem = resolveScopedTarget(rctx.db, rctx.cfg, toRaw, scopeCtx);
      if (!fromMem || !toMem) {
        throw new HttpError(
          404,
          'memory_not_found',
          '未找到对应的记忆条目（支持完整 ID 或前 8 位短 ID）'
        );
      }
      if (fromMem.id === toMem.id) {
        throw new HttpError(400, 'self_relation_forbidden', '不能与自身建立拓扑关联');
      }
      addRelation(rctx.db, fromMem.id, toMem.id, relType, Date.now());
      sendJson(
        rctx.res,
        200,
        { ok: true, fromId: fromMem.id, toId: toMem.id, rel: relType },
        rctx.reqOrigin
      );
      return;
    }

    if (action === 'approve-repair' || action === 'reject-repair') {
      const pId = Number(body.proposalId);
      if (!Number.isInteger(pId) || pId < 1) {
        throw new HttpError(400, 'invalid_proposal_id', '无效的修复提案 ID');
      }
      const propRow = rctx.db.get<{ memory_id: string }>(
        'SELECT memory_id FROM repair_proposals WHERE id = ?',
        [pId]
      );
      if (!propRow) {
        throw new HttpError(404, 'proposal_not_found', `Proposal #${pId} not found`);
      }
      const targetMem = resolveScopedTarget(rctx.db, rctx.cfg, propRow.memory_id, scopeCtx);
      if (!targetMem) {
        throw new HttpError(403, 'workspace_excluded', 'Target memory is outside allowed scope');
      }

      const resProp =
        action === 'approve-repair'
          ? approveRepairProposal(rctx.db, pId, 'user', Date.now())
          : rejectRepairProposal(rctx.db, pId);
      if (!resProp.ok) {
        throw new HttpError(
          400,
          'repair_action_failed',
          resProp.reason || (action === 'approve-repair' ? '批准修复提案失败' : '拒绝修复提案失败')
        );
      }
      sendJson(rctx.res, 200, { ok: true, proposalId: pId }, rctx.reqOrigin);
      return;
    }

    if (action === 'rollback-strategy') {
      const targetVer = body.targetVersion !== undefined ? Number(body.targetVersion) : undefined;
      if (targetVer !== undefined && (!Number.isInteger(targetVer) || targetVer < 1)) {
        throw new HttpError(400, 'invalid_target_version', '无效的策略版本号');
      }
      const resRollback = rollbackStrategy(rctx.db, targetVer);
      if (!resRollback.ok) {
        throw new HttpError(400, 'rollback_strategy_failed', resRollback.reason || '策略回滚失败');
      }
      sendJson(rctx.res, 200, { ok: true, rolledBackTo: resRollback.rolledBackTo }, rctx.reqOrigin);
      return;
    }

    if (action === 'heal') {
      const heal = autoHealMemoryHealth(rctx.db, {
        workspaceId: scope.wsId,
        sessionId: scope.sessionId,
        excludeWorkspaces: rctx.cfg.excludeWorkspaces,
      });
      sendJson(rctx.res, 200, { ok: true, heal }, rctx.reqOrigin);
      return;
    }

    // bootstrap / init: 严禁接受任意 body.workspacePath，仅允许 options.activeWorkspaces() 校验通过的工作区路径
    if (action === 'bootstrap' || action === 'init') {
      const registeredPaths = (rctx.options?.activeWorkspaces?.() || []).filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0
      );
      const allowedByNorm = new Map<string, string>();
      for (const p of registeredPaths) {
        const norm = normalizeWorkspacePath(p);
        if (norm) allowedByNorm.set(norm, p);
      }

      const requestedPath = str(body.workspacePath);
      let verifiedPath: string;
      if (requestedPath) {
        const normReq = normalizeWorkspacePath(requestedPath);
        const matched = normReq ? allowedByNorm.get(normReq) : undefined;
        if (!matched) {
          throw new HttpError(
            403,
            'untrusted_workspace_path',
            'workspacePath is not an active registered workspace'
          );
        }
        verifiedPath = matched;
      } else if (registeredPaths.length > 0) {
        verifiedPath = registeredPaths[0];
      } else {
        verifiedPath = process.cwd();
      }

      assertWorkspaceAllowed(verifiedPath, rctx.cfg, { db: rctx.db });

      const bootstrap = autoBootstrapMemory(rctx.db, {
        workspacePath: verifiedPath,
        cfg: rctx.cfg,
        force: body.force === true,
        includeBackfill: body.includeBackfill !== false,
      });
      sendJson(rctx.res, 200, { ok: true, bootstrap }, rctx.reqOrigin);
      return;
    }

    if (action === 'backfill') {
      const dryRun = body.dryRun === true;
      const statsRes = runBackfill(rctx.db, { dryRun, cfg: rctx.cfg });
      sendJson(rctx.res, 200, { ok: true, dryRun, stats: statsRes }, rctx.reqOrigin);
      return;
    }

    if (action === 'eval') {
      await rctx.singleFlight.run('eval', () => {
        const suite =
          typeof body.suite === 'string' && body.suite.trim() && body.suite !== 'all'
            ? body.suite.trim()
            : undefined;
        const allCases = generateDataset();
        const cases = suite
          ? allCases.filter((c) => c.suite.toLowerCase() === suite.toLowerCase())
          : allCases;
        const report = runEvalSuite(cases);
        sendJson(rctx.res, 200, { ok: true, report }, rctx.reqOrigin);
      });
      return;
    }

    const minuteBucket = Math.floor(Date.now() / 60_000);

    if (action === 'distill') {
      await enqueueOrRunAdminJob(
        rctx,
        {
          kind: 'distill',
          key: `web_distill:${scope.wsId || 'all'}:${minuteBucket}`,
          payload: {
            workspaceId: scope.wsId,
            sessionId: scope.sessionId,
            manual: true,
          },
        },
        async () => {
          const resDistill = await distillSession(rctx.db, rctx.cfg, {
            isIdle: true,
            signal: rctx.signal,
          });
          sendJson(
            rctx.res,
            200,
            {
              ok: true,
              result: {
                ...resDistill,
                eventsProcessed: resDistill.consumedCount,
                candidatesInserted: resDistill.itemsCreated,
              },
            },
            rctx.reqOrigin
          );
        }
      );
      return;
    }

    if (action === 'consolidate') {
      await enqueueOrRunAdminJob(
        rctx,
        {
          kind: 'consolidate',
          key: `web_consolidate:${scope.wsId || 'all'}:${minuteBucket}`,
          payload: { workspaceId: scope.wsId || scope.defaultWsId, manual: true },
        },
        async () => {
          const wsTarget = scope.wsId || scope.defaultWsId || NO_ACTIVE_WORKSPACE_SENTINEL;
          const clusters = findConsolidationClusters(rctx.db, wsTarget, rctx.cfg);
          const results = [];
          for (const c of clusters) {
            if (rctx.signal.aborted) break;
            const r = await consolidateCluster(rctx.db, rctx.cfg, c, { signal: rctx.signal });
            results.push(r);
          }
          sendJson(
            rctx.res,
            200,
            {
              ok: true,
              clustersFound: clusters.length,
              consolidated: results.filter((r) => r.success && r.candidateId).length,
              results,
            },
            rctx.reqOrigin
          );
        }
      );
      return;
    }

    if (action === 'curate') {
      await enqueueOrRunAdminJob(
        rctx,
        {
          kind: 'curate',
          key: `web_curate:${scope.wsId || 'all'}:${minuteBucket}`,
          payload: { workspaceId: scope.wsId, manual: true },
        },
        async () => {
          const curateRes = await curateMemoriesWithLLM(rctx.db, rctx.cfg, {
            workspaceId: scope.wsId,
            signal: rctx.signal,
          });
          sendJson(rctx.res, 200, curateRes, rctx.reqOrigin);
        }
      );
      return;
    }

    if (action === 'maintain') {
      await enqueueOrRunAdminJob(
        rctx,
        {
          kind: 'maintain',
          key: `web_maintain:${scope.wsId || 'all'}:${minuteBucket}`,
          payload: { workspaceId: scope.wsId, manual: true },
        },
        async () => {
          const resMaint = await runUnifiedMaintenance(rctx.db, {
            workspaceId: scope.wsId,
            cfg: rctx.cfg,
            signal: rctx.signal,
            runSentinel: true,
            runLlmCurate: false,
          });
          sendJson(
            rctx.res,
            200,
            {
              ok: true,
              message: 'Maintenance completed successfully',
              result: resMaint,
              stats: {
                archivedCold: resMaint.archivedCold,
                expiredCandidates: resMaint.expiredCandidates,
                prunedInvalid: resMaint.prunedInvalid,
                autoPinned: resMaint.autoPinned,
                ftsRebuilt: resMaint.ftsRepaired > 0,
                embeddingsBackfilled: resMaint.localEmbeddingsBackfilled,
                linksWeaved: resMaint.linksWeaved,
                sentinelRollback: resMaint.sentinelRolledBack,
              },
            },
            rctx.reqOrigin
          );
        }
      );
      return;
    }

    if (action === 'evolve-strategy') {
      await enqueueOrRunAdminJob(
        rctx,
        {
          kind: 'evolve',
          key: `web_evolve:${minuteBucket}`,
          payload: { manual: true },
        },
        () => {
          const resEvolve = runStrategyEvolution(rctx.db, {}, rctx.cfg);
          sendJson(rctx.res, 200, { ok: true, result: resEvolve }, rctx.reqOrigin);
        }
      );
      return;
    }

    throw new HttpError(400, 'unknown_action', `Unknown action: ${action}`);
  };

  return [
    { path: '/hindsight/reflect', methods: { POST: handlePostHindsightReflect } },
    { path: '/core-memory', methods: { POST: handlePostCoreMemory } },
    { path: '/core', methods: { POST: handlePostCoreMemory } },
    { path: '/reconcile', methods: { POST: handlePostReconcile } },
    { path: '/graph', methods: { GET: handleGetGraph } },
    { path: '/sandbox', methods: { GET: handleSandbox, POST: handleSandbox } },
    { path: '/export', methods: { GET: handleGetExport } },
    { path: '/import', methods: { POST: handlePostImport } },
    { path: '/action', methods: { POST: handlePostAction } },
  ];
}
