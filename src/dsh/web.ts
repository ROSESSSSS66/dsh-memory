import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import type { Db, MemoryRecord, MemoryType } from '../types.js';
import { type PluginConfig, saveConfigToDb } from '../config.js';
import { get, list, stats, sources, history, getGraphData, getSubgraph } from '../core/store.js';
import {
  approveCandidate,
  upsertCandidate,
  pin,
  unpin,
  freeze,
  unfreeze,
  forget,
  confirmMemory,
  mergeMemories,
  restoreMemory,
  editContent,
  rollback,
  addRelation,
} from '../core/writer.js';
import { redactSecrets, isOfflineEndpointAllowed, isSafeApiKeyEnvName } from '../core/privacy.js';
import { workspaceId } from '../core/scope.js';
import { serializeMemoryToMarkdown, trashMemory, resolveTrashDir } from '../core/markdown.js';
import { estimateTokens } from '../core/tokens.js';
import { auditMemoryHealth, autoHealMemoryHealth, weaveZettelkastenLinks } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import { contentHash } from '../core/text.js';
import {
  backfillMissingEmbeddings,
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from '../core/vector.js';
import { findConsolidationClusters, consolidateCluster } from '../evolution/consolidator.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import { runAllChannels } from '../retrieval/channels.js';
import { renderStableLayer } from './prompt-section.js';
import {
  getAllCoreMemories,
  setCoreMemory,
  appendCoreMemory,
  DEFAULT_CORE_BLOCKS,
} from '../core/core-memory.js';
import { getLedgerUsage } from '../evolution/ledger.js';
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  checkAndRepairFts,
  cleanOldTelemetry,
  pruneInvalidMemories,
  curateMemoriesWithLLM,
} from '../evolution/maintenance.js';
import { resolveEndpointAndProtocol, buildProtocolPayload, type LLMProtocol } from '../evolution/llm.js';
import {
  getActiveStrategy,
  listStrategies,
  rollbackStrategy,
  initDefaultStrategy,
} from '../evolution/strategy.js';
import { runStrategyEvolution, checkSentinelAndRollback } from '../evolution/lab.js';
import {
  listRepairProposals,
  approveRepairProposal,
  rejectRepairProposal,
} from '../evolution/repair.js';
import { reconcileCandidate, reconcileAndUpsert } from '../evolution/reconciler.js';
import { distillSession } from '../evolution/extractor.js';
import { runBackfill } from '../ingest/backfill.js';
import { generateDataset } from '../eval/gen-dataset.js';
import { runEvalSuite } from '../eval/runner.js';

export const API_PREFIX = '/api/dsh-memory';

export function normalizeMemoryType(raw?: string): MemoryType {
  const t = (raw || '').toLowerCase();
  if (t === 'fact') return 'semantic';
  if (t === 'procedure') return 'procedural';
  if (t === 'preference') return 'preference';
  const valid: MemoryType[] = [
    'episodic',
    'semantic',
    'procedural',
    'belief',
    'preference',
    'goal',
    'failure',
    'meta',
  ];
  if (valid.includes(t as MemoryType)) return t as MemoryType;
  return 'semantic';
}

export function maskApiKey(key?: string): string {
  if (!key) return '';
  if (key.length <= 8) return '********';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

export function getSanitizedConfig(cfg: PluginConfig) {
  return {
    offlineLLM: {
      useDshLlm: !!cfg.offlineLLM.useDshLlm,
      baseURL: cfg.offlineLLM.baseURL || '',
      model: cfg.offlineLLM.model || 'deepseek-chat',
      apiKeyEnv: cfg.offlineLLM.apiKeyEnv || '',
      apiKeyMasked: maskApiKey(cfg.offlineLLM.apiKey),
      hasApiKey: !!cfg.offlineLLM.apiKey,
      protocol: cfg.offlineLLM.protocol || 'chat/completions',
    },
    privacy: {
      offlineConsent: !!cfg.privacy.offlineConsent,
      allowedOfflineEndpoints: cfg.privacy.allowedOfflineEndpoints || [],
    },
    dailyLLMCalls: cfg.dailyLLMCalls,
    dailyLLMTokens: cfg.dailyLLMTokens,
    distillMaxInputTokens: cfg.distillMaxInputTokens,
    dynamicBudgetTokens: cfg.dynamicBudgetTokens,
    hardBudgetTokens: cfg.hardBudgetTokens,
    stableBudgetTokens: cfg.stableBudgetTokens,
    defaultScope: cfg.defaultScope,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

function isIpLiteral(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || (h.includes(':') && /^[0-9a-f:.]+$/i.test(h));
}

/**
 * 跨源校验：仅信任回环地址与桌面壳协议。
 * 注意：`Origin: null`（沙箱 iframe / data: URL / 跨源重定向）不再被信任，
 * 否则任意网页都能借此发起 CSRF 并读取带 ACAO 回显的响应（如 /export 全量记忆）。
 */
export function isTrustedOrigin(originHeader?: string): boolean {
  if (!originHeader) return true;
  const trimmed = originHeader.trim();
  if (trimmed.startsWith('file://') || trimmed.startsWith('app://') || trimmed.startsWith('dsh://')) {
    return true;
  }
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isLoopbackHostname(u.hostname);
  } catch {
    return false;
  }
}

/**
 * DNS Rebinding 防护：同源 GET 不携带 Origin，必须额外校验 Host。
 * 允许回环主机名与 IP 字面量，拒绝外部域名被解析到本机的情形。
 */
export function isAllowedHostHeader(hostHeader?: string): boolean {
  if (!hostHeader) return true;
  try {
    const u = new URL(`http://${hostHeader.trim()}`);
    return isLoopbackHostname(u.hostname) || isIpLiteral(u.hostname);
  } catch {
    return false;
  }
}

/**
 * allowedOfflineEndpoints 条目：HTTP(S) URL 或 host[:port]
 */
function isValidEndpointEntry(raw: string): boolean {
  return isHttpUrl(raw) || /^[a-z0-9.-]+(:\d{1,5})?$/i.test(raw);
}

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const VALID_SCOPES = ['global', 'workspace', 'user', 'session'] as const;
const MAX_BATCH_IDS = 500;
const MAX_IMPORT_ITEMS = 5000;
const MAX_BODY_BYTES = 1024 * 1024;
const BODY_TOO_LARGE = Symbol('body_too_large');

function isSameOriginUrl(urlA?: string, urlB?: string): boolean {
  if (!urlA || !urlB) return false;
  try {
    return new URL(urlA.trim()).origin === new URL(urlB.trim()).origin;
  } catch {
    return urlA.trim() === urlB.trim();
  }
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': (res as any).__trustedOrigin || 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function stripEmbedding(m: MemoryRecord | null | undefined) {
  if (!m) return null;
  const { embedding: _emb, ...rest } = m;
  return rest;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function readBodyJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0; // 释放已缓冲数据
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        // 不得把无法解析的请求体当作 {} 继续处理：写接口会把它当成一次合法的空修改
        reject(new HttpError(400, 'Request body is not valid JSON'));
      }
    });
    req.on('error', () => resolve({}));
  });
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function registerWebRoutes(ctx: any, db: Db, cfg: PluginConfig) {
  if (!ctx.webServer?.register) {
    return () => {};
  }

  let lastAutoCycleAt = 0;
  let lastLlmCurateAt = 0;
  const healthCache = new Map<string, { fp: string; at: number; health: unknown }>();
  /** 低成本数据指纹：任何记忆写入都会改变 updated_at / 行数，关系变化改变关系行数 */
  const healthFingerprint = (): string => {
    const m = db.get<{ c: number; u: number | null; v: number | null }>(
      'SELECT COUNT(*) AS c, MAX(updated_at) AS u, SUM(version) AS v FROM memories'
    );
    const r = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM memory_relations');
    return `${m?.c}:${m?.u}:${m?.v}:${r?.c}`;
  };
  const runThrottledAutonomousCycle = (wsId?: string) => {
    const now = Date.now();
    if (now - lastAutoCycleAt < 45_000) return;
    lastAutoCycleAt = now;
    try {
      autoHealMemoryHealth(db, { workspaceId: wsId, now });
    } catch {}
    if (cfg.privacy?.offlineConsent && now - lastLlmCurateAt >= 600_000) {
      lastLlmCurateAt = now;
      curateMemoriesWithLLM(db, cfg, { workspaceId: wsId, now }).catch(() => {});
    }
  };

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const reqOrigin = typeof req?.headers?.origin === 'string' ? req.headers.origin : undefined;
      const reqHost = typeof req?.headers?.host === 'string' ? req.headers.host : undefined;
      if (!isAllowedHostHeader(reqHost)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Host not allowed' }));
        return;
      }
      if (reqOrigin && !isTrustedOrigin(reqOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Cross-origin request denied' }));
        return;
      }
      // CSRF 防护：真实浏览器请求的 POST 必须是 application/json（强制触发 CORS 预检），
      // 拦截 text/plain / form 等“简单请求”跨站投递。
      if (req.method === 'POST' && req.headers) {
        const ctype = String(req.headers['content-type'] || '').toLowerCase();
        if (!ctype.startsWith('application/json')) {
          res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Content-Type must be application/json' }));
          return;
        }
      }
      if (reqOrigin) {
        (res as any).__trustedOrigin = reqOrigin;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': (res as any).__trustedOrigin || 'http://127.0.0.1',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        const pathname = reqUrl.pathname;
        const subPath = pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/';

        // 1. Overview & Stats
        if (subPath === '/overview' || subPath === '/stats') {
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          const defaultWsId = wsId || workspaceId(process.cwd());
          runThrottledAutonomousCycle(wsId);
          const st = stats(db, wsId);
          const ledger = getLedgerUsage(db, undefined, cfg);

          // Recent 7 days injection stats（SQL 聚合，避免把整周注入日志拉到 JS 层逐行累加）
          const sevenDaysAgo = Date.now() - 7 * 86400000;
          // injections 每条注入记忆一行：先按轮次聚合动态层，否则得到的是「每条记忆」而非「每轮」的均值
          const injAgg = db.get<{ cnt: number; total_tokens: number | null; corrections: number | null }>(
            `SELECT COUNT(*) AS cnt, SUM(t) AS total_tokens, SUM(neg) AS corrections
             FROM (
               SELECT SUM(tokens) AS t,
                      MAX(CASE WHEN outcome IS NOT NULL AND outcome <= -0.5 THEN 1 ELSE 0 END) AS neg
               FROM injections
               WHERE created_at >= ? AND layer = 'dynamic'
               GROUP BY session_id, turn
             )`,
            [sevenDaysAgo]
          );
          const injCount = Number(injAgg?.cnt || 0);
          const totalTokens = Number(injAgg?.total_tokens || 0);
          const corrections = Number(injAgg?.corrections || 0);
          const avgTokens = injCount > 0 ? Math.round(totalTokens / injCount) : 0;
          const correctionRate =
            injCount > 0 ? Number(((corrections / injCount) * 100).toFixed(1)) : 0;

          const pendingRepairsCount = Number(
            db.get<{ c: number }>(
              `SELECT COUNT(*) AS c FROM repair_proposals WHERE status = 'candidate'`
            )?.c || 0
          );
          const activeStrat = getActiveStrategy(db, cfg);
          const coreBlocks = getAllCoreMemories(db, { workspaceId: wsId });
          const stableLayer = renderStableLayer(
            db,
            { workspaceId: defaultWsId },
            cfg,
            activeStrat.version
          );

          sendJson(res, 200, {
            ok: true,
            stats: {
              ...st,
              active: st.byStatus.active || 0,
              candidate: st.byStatus.candidate || 0,
              frozen: st.byStatus.frozen || 0,
              superseded: st.byStatus.superseded || 0,
              archived: st.byStatus.archived || 0,
            },
            dynamicBudgetTokens: cfg.dynamicBudgetTokens ?? 1600,
            stableBudgetTokens: cfg.stableBudgetTokens ?? 600,
            stableLayerTokens: stableLayer.stableTokens,
            hardBudgetTokens: cfg.hardBudgetTokens ?? 3200,
            pendingRepairsCount,
            activeStrategyVersion: activeStrat.version,
            coreMemoryCount: coreBlocks.length,
            ledger: {
              callsToday: ledger.callsCount,
              tokensToday: ledger.tokensConsumed,
              maxDailyCalls: cfg.dailyLLMCalls || 40,
              maxDailyTokens: cfg.dailyLLMTokens || 200000,
            },
            recentTelemetry: {
              injectionCount: injCount,
              avgTokens,
              correctionRate,
            },
          });
          return;
        }

        // 1.2. Core Memory Scratchpad (GET & POST — supports both /core-memory and /core)
        if (subPath === '/core-memory' || subPath === '/core') {
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          const defaultWsId = wsId || workspaceId(process.cwd());
          if (req.method === 'GET') {
            const entries = getAllCoreMemories(db, { workspaceId: wsId });
            const entryMap = new Map(entries.map((e) => [e.block, e]));
            const blocks = DEFAULT_CORE_BLOCKS.map((b) => {
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
            const activeStrat = getActiveStrategy(db, cfg);
            const stableLayer = renderStableLayer(
              db,
              { workspaceId: defaultWsId },
              cfg,
              activeStrat.version
            );
            sendJson(res, 200, {
              ok: true,
              blocks,
              totalTokens,
              stableLayerTokens: stableLayer.stableTokens,
              stableBudgetTokens: cfg.stableBudgetTokens ?? 600,
            });
            return;
          }

          if (req.method === 'POST') {
            const body = await readBodyJson(req);
            const block = (body.block || '').trim().toLowerCase();
            const content = (body.content || '').trim();
            const mode = body.mode === 'append' ? 'append' : 'set';
            if (!block) {
              sendJson(res, 400, { ok: false, error: '请指定 Core Memory 块名称' });
              return;
            }
            if (!content) {
              sendJson(res, 400, { ok: false, error: 'Core Memory 内容不能为空' });
              return;
            }
            try {
              if (mode === 'append') {
                appendCoreMemory(db, block, content, { workspaceId: body.workspaceId || wsId, actor: 'user' });
              } else {
                setCoreMemory(db, block, content, { workspaceId: body.workspaceId || wsId, actor: 'user' });
              }
              const entries = getAllCoreMemories(db, { workspaceId: body.workspaceId || wsId });
              sendJson(res, 200, { ok: true, block, blocks: entries });
            } catch (err: any) {
              sendJson(res, 400, { ok: false, error: err?.message || '更新 Core Memory 失败' });
            }
            return;
          }
        }

        // 1.3. Evolution, Strategy Lab & Repair Proposals (GET)
        if (subPath === '/evolution') {
          const recentJobsSql =
            'SELECT id, kind, key, status, attempts, error AS last_error, created_at, finished_at AS updated_at FROM jobs ORDER BY id DESC LIMIT 20';
          // 轻量模式：前端轮询只需要最近任务，跳过策略列表与修复提案（含逐条记忆查询）的组装
          if (reqUrl.searchParams.get('lite') === '1') {
            sendJson(res, 200, { ok: true, recentJobs: db.all(recentJobsSql) });
            return;
          }
          let strategies = listStrategies(db);
          if (strategies.length === 0) {
            initDefaultStrategy(db, cfg);
            strategies = listStrategies(db);
          }
          const activeStrategy = getActiveStrategy(db, cfg);
          const rawProposals = listRepairProposals(db);
          // 批量加载提案涉及的全部记忆，消除逐条 get() 的 N+1 查询
          const refIds = new Set<string>();
          for (const p of rawProposals) {
            refIds.add(p.memoryId);
            for (const cid of p.candidateIds) refIds.add(cid);
          }
          const memById = new Map<string, Pick<MemoryRecord, 'id' | 'type' | 'content' | 'summary' | 'slot_key' | 'status'>>();
          if (refIds.size > 0) {
            for (const m of db.all<Pick<MemoryRecord, 'id' | 'type' | 'content' | 'summary' | 'slot_key' | 'status'>>(
              'SELECT id, type, content, summary, slot_key, status FROM memories WHERE id IN (SELECT value FROM json_each(?))',
              [JSON.stringify([...refIds])]
            )) {
              memById.set(m.id, m);
            }
          }
          const repairProposals = rawProposals.map((p) => {
            const targetMem = memById.get(p.memoryId);
            const candidates = p.candidateIds
              .map((cid) => memById.get(cid))
              .filter((m): m is NonNullable<typeof m> => !!m);
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

          const recentJobs = db.all<{
            id: number;
            kind: string;
            key: string;
            status: string;
            attempts: number;
            last_error: string | null;
            created_at: number;
            updated_at: number | null;
          }>(recentJobsSql);

          const ledger = getLedgerUsage(db, undefined, cfg);

          sendJson(res, 200, {
            ok: true,
            activeStrategy,
            strategies,
            repairProposals,
            recentJobs,
            ledger,
          });
          return;
        }

        // 1.4. Recall Sandbox & Context Window Inspector (Letta ADE + Langfuse + Mem0 Audit)
        if (subPath === '/sandbox') {
          let queryText = (reqUrl.searchParams.get('q') || '').trim();
          let rawWs = reqUrl.searchParams.get('workspaceId') || '';
          if (req.method === 'POST') {
            const body = await readBodyJson(req);
            if (typeof body.query === 'string') queryText = body.query.trim();
            if (typeof body.workspaceId === 'string') rawWs = body.workspaceId.trim();
          }
          const wsId = rawWs ? workspaceId(rawWs) : workspaceId(process.cwd());

          const activeStrat = getActiveStrategy(db, cfg);
          const stableLayer = renderStableLayer(
            db,
            { workspaceId: wsId },
            cfg,
            activeStrat.version
          );

          let recallSimulation: any = null;
          if (queryText) {
            const plan = buildQueryPlan({ userText: queryText, cfg });
            const chanRes = runAllChannels(
              db,
              plan,
              { workspaceId: wsId, sessionId: '', cfg },
              { onlineBudgetMs: cfg.onlineBudgetMs || 150, t0: Date.now() }
            );
            const channelHitMap = new Map<string, string[]>();
            for (const [chName, list] of Object.entries(chanRes)) {
              for (const c of list) {
                const arr = channelHitMap.get(c.id) || [];
                if (!arr.includes(chName)) arr.push(chName);
                channelHitMap.set(c.id, arr);
              }
            }

            const recRes = recall(db, plan, {
              workspaceId: wsId,
              alreadyInjected: stableLayer.visibleRefs,
              strategy: activeStrat.config,
              strategyVersion: activeStrat.version,
              cfg,
            });

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
              items: recRes.items.map((it) => ({
                memory: it.memory,
                form: it.form,
                score: Number(it.score.toFixed(4)),
                tokens: it.tokens,
                matchedChannels:
                  recRes.matchedChannels?.[it.memory.id] ||
                  channelHitMap.get(it.memory.id) ||
                  ['lexical'],
              })),
            };
          }

          const recentInjections = db.all<{
            id: number;
            session_id: string;
            turn: number;
            memory_id: string;
            layer: string;
            rank: number;
            tokens: number;
            form: string;
            strategy_v: number;
            outcome: number | null;
            created_at: number;
            memory_type: string | null;
            memory_content: string | null;
            memory_summary: string | null;
            slot_key: string | null;
          }>(
            `SELECT i.rowid AS id, i.session_id, i.turn, i.memory_id, i.layer, i.rank, i.tokens, i.form,
                    i.strategy_v, i.outcome, i.created_at,
                    m.type AS memory_type, m.content AS memory_content, m.summary AS memory_summary, m.slot_key
             FROM injections i
             LEFT JOIN memories m ON m.id = i.memory_id
             ORDER BY i.created_at DESC, i.rowid DESC
             LIMIT 30`
          );

          sendJson(res, 200, {
            ok: true,
            stableLayer: {
              text: stableLayer.text,
              stableTokens: stableLayer.estimatedTokens ?? stableLayer.stableTokens,
              stableByteTokens: stableLayer.stableTokens,
              stableBudgetTokens: cfg.stableBudgetTokens ?? 600,
              visibleCount: stableLayer.visibleRefs.size,
            },
            dynamicBudgetTokens: cfg.dynamicBudgetTokens ?? 1600,
            hardBudgetTokens: cfg.hardBudgetTokens ?? 3200,
            strategyVersion: activeStrat.version,
            recallSimulation,
            recentInjections,
          });
          return;
        }

        // 1.5. Graph Topology (汲取自 qwert702/dsh-memory 与 omdsh-dev/dsh-mnemon Obsidian 拓扑图)
        if (subPath === '/graph') {
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          const centerId = reqUrl.searchParams.get('centerId') || undefined;
          const rawLimit = parseInt(reqUrl.searchParams.get('limit') || '80', 10);
          const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 80;
          if (centerId) {
            const sub = getSubgraph(db, centerId, { workspaceId: wsId, hops: 2, maxNodes: limit });
            sendJson(res, 200, { ok: true, graph: sub || { nodes: [], links: [], stats: { totalNodes: 0, memoryNodes: 0, entityNodes: 0, totalLinks: 0 } } });
            return;
          }
          const gData = getGraphData(db, { workspaceId: wsId, limit });
          sendJson(res, 200, { ok: true, graph: gData });
          return;
        }

        // 1.6. Memory Health & Conflict Doctor (v0.3.0)
        // 由 runThrottledAutonomousCycle (45s 节流) 统一触发后台自愈，避免前端 8s 轮询阻塞主线程
        if (subPath === '/health') {
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          runThrottledAutonomousCycle(wsId);
          // 体检为 O(n²) 相似度扫描，前端每 8s 轮询：在数据指纹未变化时复用 60s 内的结果
          const fp = healthFingerprint();
          const cacheKey = wsId || '*';
          const cached = healthCache.get(cacheKey);
          let health;
          if (cached && cached.fp === fp && Date.now() - cached.at < 60_000) {
            health = cached.health;
          } else {
            health = auditMemoryHealth(db, { workspaceId: wsId });
            if (healthCache.size > 32) healthCache.clear();
            healthCache.set(cacheKey, { fp, at: Date.now(), health });
          }
          sendJson(res, 200, { ok: true, health });
          return;
        }

        // 1.7. Mem0 Dynamic Reconciliation Playground (v0.3.0)
        if (subPath === '/reconcile' && req.method === 'POST') {
          const body = await readBodyJson(req);
          const rawContent = typeof body.content === 'string' ? body.content.trim() : '';
          if (!rawContent || rawContent.length < 4) {
            sendJson(res, 400, { ok: false, error: '调和内容至少需要 4 个字符' });
            return;
          }
          const clean = redactSecrets(rawContent);
          const type = normalizeMemoryType(body.type);
          const scope = (body.scope === 'workspace' ? 'workspace' : 'global') as 'workspace' | 'global';
          const wsId = body.workspaceId ? workspaceId(body.workspaceId) : undefined;
          const slotKey = typeof body.slot_key === 'string' && body.slot_key.trim() ? body.slot_key.trim() : undefined;
          const dryRun = body.dryRun !== false;

          const candidateInput = {
            type,
            content: clean.text,
            slot_key: slotKey,
            scope,
            workspaceId: scope === 'workspace' ? wsId : undefined,
            source_kind: 'user' as const,
            origin_kinds: ['user' as const],
            confidence: 0.9,
            importance: typeof body.importance === 'number' ? body.importance : 7,
            status: 'active' as const,
            sources: [{ session_id: 'reconcile_sandbox', seq: 1, kind: 'user', excerpt: clean.text.slice(0, 100) }],
            actor: 'user' as const,
          };

          if (dryRun) {
            const decision = reconcileCandidate(db, candidateInput);
            const targetMemory = decision.targetId ? stripEmbedding(get(db, decision.targetId)) : null;
            sendJson(res, 200, {
              ok: true,
              dryRun: true,
              decision,
              targetMemory,
            });
            return;
          }

          const resRec = reconcileAndUpsert(db, candidateInput, Date.now());
          const targetMemory = (resRec as any).id ? stripEmbedding(get(db, (resRec as any).id)) : null;
          sendJson(res, 200, {
            ok: true,
            dryRun: false,
            decision: resRec.decision,
            resultAction: resRec.action,
            memory: targetMemory,
          });
          return;
        }

        // 2. Memories list (with search, filter, pagination)
        if (subPath === '/memories' || subPath === '/list') {
          const q = (reqUrl.searchParams.get('q') || '').trim();
          const type = (reqUrl.searchParams.get('type') || '') as any;
          const status = (reqUrl.searchParams.get('status') || '') as any;
          const scope = (reqUrl.searchParams.get('scope') || '') as any;
          const excludeCoreParam = reqUrl.searchParams.get('excludeCore');
          const excludeCore = excludeCoreParam === '1' || excludeCoreParam === 'true';
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          const rawLimit = parseInt(reqUrl.searchParams.get('limit') || '50', 10);
          const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
          const rawOffset = parseInt(reqUrl.searchParams.get('offset') || '0', 10);
          const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

          let sql = 'SELECT * FROM memories WHERE 1=1';
          const params: unknown[] = [];

          if (excludeCore) {
            sql += " AND COALESCE(slot_key, '') NOT LIKE 'core:%'";
          }
          if (q) {
            sql += " AND (content LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR slot_key LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')";
            const qPattern = `%${escapeLike(q.slice(0, 200))}%`;
            params.push(qPattern, qPattern, qPattern, qPattern);
          }
          if (type && type !== 'all') {
            if (type === 'experience') {
              sql += " AND type IN ('episodic', 'failure', 'belief', 'goal', 'meta')";
            } else {
              sql += ' AND type = ?';
              params.push(normalizeMemoryType(type));
            }
          }
          if (status && status !== 'all') {
            if (status === 'pinned') {
              sql += " AND pinned = 1 AND status IN ('active', 'frozen')";
            } else if (status === 'live') {
              sql += " AND status IN ('active', 'frozen')";
            } else {
              sql += ' AND status = ?';
              params.push(status);
            }
          }
          if (scope && scope !== 'all') {
            sql += ' AND scope = ?';
            params.push(scope);
          }
          if (wsId) {
            sql += ' AND (workspace_id = ? OR workspace_id IS NULL)';
            params.push(wsId);
          }

          // Count total matching
          const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
          const countRow = db.get<{ total: number }>(countSql, params);
          const totalCount = countRow?.total || 0;

          // Order: pinned first, then updated_at desc
          sql += ' ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?';
          params.push(limit, offset);

          const rawItems = db.all<MemoryRecord>(sql, params);
          const items = rawItems.map(({ embedding: _emb, ...rest }) => rest);

          sendJson(res, 200, {
            ok: true,
            total: totalCount,
            limit,
            offset,
            items,
          });
          return;
        }

        // 3. Single memory detail
        if (subPath === '/memory') {
          const id = (reqUrl.searchParams.get('id') || '').trim();
          if (!id) {
            sendJson(res, 400, { ok: false, error: 'id is required' });
            return;
          }
          const mem = get(db, id);
          if (!mem) {
            sendJson(res, 404, { ok: false, error: 'Memory not found' });
            return;
          }
          const srcList = sources(db, mem.id, mem.content_rev);
          const verList = history(db, mem.id);
          const outRels = db.all<{ to_id: string; rel: string }>(
            'SELECT to_id, rel FROM memory_relations WHERE from_id = ?',
            [mem.id]
          );
          const inRels = db.all<{ from_id: string; rel: string }>(
            'SELECT from_id, rel FROM memory_relations WHERE to_id = ?',
            [mem.id]
          );
          const relations = [
            ...outRels.map((r) => ({ to_id: r.to_id, rel: r.rel, direction: 'outgoing' as const })),
            ...inRels.map((r) => ({ to_id: r.from_id, rel: r.rel, direction: 'incoming' as const })),
          ];

          const { embedding: _emb, ...cleanMem } = mem;

          sendJson(res, 200, {
            ok: true,
            memory: cleanMem,
            sources: srcList,
            history: verList,
            relations,
          });
          return;
        }

        // 4. Memory actions (POST)
        if (subPath === '/action' && req.method === 'POST') {
          const body = await readBodyJson(req);
          const action = body.action;
          const id = body.id;

          if (action === 'pin' || action === 'unpin') {
            const ok = action === 'pin' ? pin(db, id, 'user') : unpin(db, id, 'user');
            if (!ok) {
              sendJson(res, 404, { ok: false, error: `Memory ${id} not found` });
              return;
            }
            sendJson(res, 200, { ok: true, id, pinned: action === 'pin' });
            return;
          }

          if (action === 'freeze' || action === 'unfreeze') {
            const ok = action === 'freeze' ? freeze(db, id, 'user') : unfreeze(db, id, 'user');
            if (!ok) {
              sendJson(res, 404, { ok: false, error: `Memory ${id} not found or cannot be ${action === 'freeze' ? 'frozen' : 'unfrozen'} in its current status` });
              return;
            }
            sendJson(res, 200, { ok: true, id, status: action === 'freeze' ? 'frozen' : 'active' });
            return;
          }

          if (action === 'forget') {
            const trashDir = resolveTrashDir(db, cfg.dataDir);
            try {
              if (trashDir) trashMemory(db, id, trashDir);
            } catch {}
            const ok = forget(db, id, 'user');
            if (!ok) {
              sendJson(res, 404, { ok: false, error: `Memory ${id} not found` });
              return;
            }
            sendJson(res, 200, { ok: true, id, status: 'archived' });
            return;
          }

          if (action === 'approve') {
            const approveRes = approveCandidate(db, id, 'user', Date.now());
            if (approveRes.action === 'rejected') {
              sendJson(res, 400, { ok: false, error: approveRes.reason });
              return;
            }
            sendJson(res, 200, { ok: true, id, result: approveRes });
            return;
          }

          if (action === 'confirm') {
            const resConfirm = confirmMemory(db, id, 'user');
            if (!resConfirm.success) {
              sendJson(res, 400, { ok: false, error: resConfirm.message });
              return;
            }
            sendJson(res, 200, { ok: true, id, message: resConfirm.message });
            return;
          }

          if (action === 'merge') {
            const { sourceId, targetId, reason } = body;
            const resMerge = mergeMemories(db, sourceId, targetId, reason || 'web_merge', 'user');
            if (!resMerge.success) {
              sendJson(res, 400, { ok: false, error: resMerge.message });
              return;
            }
            sendJson(res, 200, { ok: true, message: resMerge.message });
            return;
          }

          if (action === 'restore') {
            const resRestore = restoreMemory(db, id, 'user');
            if (!resRestore.success) {
              sendJson(res, 400, { ok: false, error: resRestore.message });
              return;
            }
            sendJson(res, 200, { ok: true, id, message: resRestore.message });
            return;
          }

          if (action === 'edit') {
            const { content, summary, type, scope, slot_key, importance } = body;
            if (!content || typeof content !== 'string' || content.trim().length < 4) {
              sendJson(res, 400, { ok: false, error: '记忆内容至少需要 4 个字符' });
              return;
            }
            try {
              const now = Date.now();
              // 正文编辑与元数据（类型/作用域/槽位/重要度）更新必须原子提交，避免半更新状态
              const resEdit = db.transaction(() => {
                const resEdit = editContent(db, id, content.trim(), typeof summary === 'string' ? summary : undefined, 'user', now);
                if (resEdit.ok) {
                  const currentMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
                  const updates: string[] = [];
                  const uParams: unknown[] = [];
                  if (type && typeof type === 'string') {
                    updates.push('type = ?');
                    uParams.push(normalizeMemoryType(type));
                  }
                  if (scope && (scope === 'global' || scope === 'workspace' || scope === 'user' || scope === 'session')) {
                    updates.push('scope = ?');
                    if (scope === 'global' || scope === 'user') {
                      updates.push('workspace_id = NULL', 'session_id = NULL');
                      uParams.push(scope);
                    } else if (scope === 'workspace') {
                      updates.push('workspace_id = ?', 'session_id = NULL');
                      uParams.push(scope, currentMem?.workspace_id || (body.workspaceId ? workspaceId(body.workspaceId) : workspaceId(process.cwd())));
                    } else if (scope === 'session') {
                      updates.push('workspace_id = ?', 'session_id = ?');
                      uParams.push(
                        scope,
                        currentMem?.workspace_id || (body.workspaceId ? workspaceId(body.workspaceId) : workspaceId(process.cwd())),
                        currentMem?.session_id || 'manual_ui_session'
                      );
                    }
                  }
                  if (slot_key !== undefined) {
                    updates.push('slot_key = ?');
                    uParams.push(slot_key ? String(slot_key).trim() : null);
                  }
                  if (typeof importance === 'number' && importance >= 1 && importance <= 10) {
                    updates.push('importance = ?');
                    uParams.push(Math.round(importance));
                  }
                  if (updates.length > 0) {
                    if (currentMem && (currentMem.status === 'active' || currentMem.status === 'frozen')) {
                      const effScope = (scope && ['global', 'workspace', 'user', 'session'].includes(scope)) ? scope : currentMem.scope;
                      const effWsId = (effScope === 'global' || effScope === 'user') ? null : (currentMem.workspace_id || (body.workspaceId ? workspaceId(body.workspaceId) : workspaceId(process.cwd())));
                      const effSessId = effScope === 'session' ? (currentMem.session_id || 'manual_ui_session') : null;
                      const effSlot = slot_key !== undefined ? (slot_key ? String(slot_key).trim() : null) : currentMem.slot_key;
                      if (effSlot) {
                        const conflict = db.get<{ id: string }>(
                          `SELECT id FROM memories WHERE id != ? AND status IN ('active', 'frozen') AND scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ?`,
                          [id, effScope, effWsId || '', effSessId || '', effSlot]
                        );
                        if (conflict) {
                          db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, updated_at = ?, version = version + 1 WHERE id = ?`, [now, now, conflict.id]);
                        }
                      }
                    }
                    uParams.push(id);
                    db.run(`UPDATE memories SET ${updates.join(', ')} WHERE id = ?`, uParams);
                    if (type !== undefined || slot_key !== undefined) {
                      const updatedRow = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
                      if (updatedRow) {
                        const newHash = contentHash(updatedRow.type, updatedRow.content);
                        const newVec = computeLocalEmbedding(
                          `${updatedRow.summary}\n${updatedRow.content}${updatedRow.slot_key ? `\n${updatedRow.slot_key}` : ''}`
                        );
                        db.run('UPDATE memories SET hash = ?, embedding = ? WHERE id = ?', [
                          newHash,
                          encodeEmbeddingBlob(newVec),
                          id,
                        ]);
                        removeCachedRuntimeEmbedding(id);
                        primeRuntimeVectorCache(id, newHash, newVec);
                      }
                    }
                  }
                }
                return resEdit;
              });
              sendJson(res, 200, { id, ...resEdit });
            } catch (err: any) {
              sendJson(res, 400, { ok: false, error: err?.message || '编辑失败' });
            }
            return;
          }

          if (action === 'rollback') {
            const { targetVersion } = body;
            if (typeof targetVersion !== 'number') {
              sendJson(res, 400, { ok: false, error: '请指定要回滚的目标版本号' });
              return;
            }
            try {
              const resRb = rollback(db, id, targetVersion, 'user', Date.now());
              sendJson(res, 200, { id, ...resRb });
            } catch (err: any) {
              sendJson(res, 400, { ok: false, error: err?.message || '回滚失败' });
            }
            return;
          }

          if (action === 'batch') {
            const { subAction } = body;
            const validSubActions = ['pin', 'unpin', 'freeze', 'unfreeze', 'forget', 'restore', 'approve', 'confirm'];
            if (!validSubActions.includes(subAction)) {
              sendJson(res, 400, { ok: false, error: `Unknown batch action: ${String(subAction)}` });
              return;
            }
            const ids: string[] = Array.isArray(body.ids)
              ? Array.from(new Set<string>(body.ids.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())))
              : [];
            if (ids.length === 0) {
              sendJson(res, 400, { ok: false, error: '请选择至少一条记忆' });
              return;
            }
            if (ids.length > MAX_BATCH_IDS) {
              sendJson(res, 400, { ok: false, error: `单次批量操作最多 ${MAX_BATCH_IDS} 条` });
              return;
            }
            let successCount = 0;
            const now = Date.now();
            const trashDir = resolveTrashDir(db, cfg.dataDir);
            for (const targetId of ids) {
              try {
                let ok = false;
                if (subAction === 'pin') ok = pin(db, targetId, 'user', now);
                else if (subAction === 'unpin') ok = unpin(db, targetId, 'user', now);
                else if (subAction === 'freeze') ok = freeze(db, targetId, 'user', now);
                else if (subAction === 'unfreeze') ok = unfreeze(db, targetId, 'user', now);
                else if (subAction === 'forget') {
                  try {
                    if (trashDir) trashMemory(db, targetId, trashDir);
                  } catch {}
                  ok = forget(db, targetId, 'user', now);
                }
                else if (subAction === 'restore') ok = restoreMemory(db, targetId, 'user', now).success;
                else if (subAction === 'approve') ok = approveCandidate(db, targetId, 'user', now).action !== 'rejected';
                else if (subAction === 'confirm') ok = confirmMemory(db, targetId, 'user', now).success;
                if (ok) successCount++;
              } catch {}
            }
            sendJson(res, 200, { ok: true, affected: successCount, total: ids.length });
            return;
          }

          if (action === 'curate') {
            const wsId = body.workspaceId ? workspaceId(body.workspaceId) : undefined;
            const curateRes = await curateMemoriesWithLLM(db, cfg, { workspaceId: wsId });
            sendJson(res, 200, curateRes);
            return;
          }

          if (action === 'create') {
            const {
              content,
              summary,
              slot_key,
              importance,
              type = 'preference',
              scope = 'global',
              workspaceId: customWsId,
              pinned = false,
            } = body;
            if (!content || typeof content !== 'string' || content.trim().length < 4) {
              sendJson(res, 400, { ok: false, error: 'Content must be at least 4 characters' });
              return;
            }
            if (!VALID_SCOPES.includes(scope)) {
              sendJson(res, 400, { ok: false, error: `Invalid scope: ${String(scope)}` });
              return;
            }
            const clean = redactSecrets(content.trim());
            const cleanSummary = summary && typeof summary === 'string' ? redactSecrets(summary.trim()).text : undefined;
            const now = Date.now();
            const resUpsert = upsertCandidate(
              db,
              {
                type: normalizeMemoryType(type),
                scope: (scope || 'global') as any,
                workspaceId: scope === 'workspace' ? customWsId : undefined,
                content: clean.text,
                summary: cleanSummary,
                slot_key: slot_key && typeof slot_key === 'string' ? slot_key.trim() : undefined,
                importance: typeof importance === 'number' ? Math.max(1, Math.min(10, Math.round(importance))) : 5,
                confidence: 0.95,
                source_kind: 'user',
                origin_kinds: ['user'],
                actor: 'user',
                sources: [
                  {
                    session_id: 'manual_ui_entry',
                    seq: 1,
                    kind: 'user',
                    excerpt: clean.text.slice(0, 100),
                  },
                ],
              },
              now
            );

            if (resUpsert.action === 'rejected') {
              sendJson(res, 400, { ok: false, error: resUpsert.reason });
              return;
            }

            if (pinned) {
              pin(db, resUpsert.id, 'user', now);
            }

            const record = stripEmbedding(get(db, resUpsert.id));
            sendJson(res, 200, { ok: true, memory: record });
            return;
          }

          if (action === 'maintain') {
            const archivedCold = archiveColdMemories(db, cfg);
            const expired = expireCandidates(db);
            const autoPinned = autoPinMemories(db);
            const ftsRes = checkAndRepairFts(db);
            const embeddingsBackfilled = backfillMissingEmbeddings(db, { limit: 500 });
            const linksWeaved = weaveZettelkastenLinks(db, { maxNewLinks: 25 });
            cleanOldTelemetry(db);
            const sentinel = checkSentinelAndRollback(db);
            sendJson(res, 200, {
              ok: true,
              message: 'Maintenance completed successfully',
              stats: {
                archivedCold,
                expiredCandidates: expired.expiredCandidates,
                expiredProposals: expired.expiredProposals,
                autoPinned,
                ftsRebuilt: ftsRes.rebuilt,
                embeddingsBackfilled,
                sentinelRollback: sentinel.rolledBack,
              },
            });
            return;
          }

          if (action === 'bootstrap' || action === 'init') {
            const bootstrap = autoBootstrapMemory(db, {
              workspacePath: body.workspacePath || process.cwd(),
              cfg,
              force: body.force !== false,
              includeBackfill: body.includeBackfill !== false,
            });
            sendJson(res, 200, { ok: true, bootstrap });
            return;
          }

          if (action === 'heal') {
            const heal = autoHealMemoryHealth(db, { workspaceId: body.workspaceId });
            sendJson(res, 200, { ok: true, heal });
            return;
          }

          if (action === 'consolidate') {
            const wsTarget = body.workspaceId || process.cwd();
            const clusters = findConsolidationClusters(db, wsTarget, cfg);
            const results = [];
            for (const c of clusters) {
              const r = await consolidateCluster(db, cfg, c);
              results.push(r);
            }
            sendJson(res, 200, {
              ok: true,
              clustersFound: clusters.length,
              consolidated: results.filter((r) => r.success && r.candidateId).length,
              results,
            });
            return;
          }

          if (action === 'add-relation') {
            const fromRaw = typeof body.fromId === 'string' ? body.fromId.trim() : '';
            const toRaw = typeof body.toId === 'string' ? body.toId.trim() : '';
            const relType = body.rel as 'related' | 'supersedes' | 'contradicts' | 'derived_from';
            const validRels = ['related', 'supersedes', 'contradicts', 'derived_from'];
            if (!fromRaw || !toRaw || !validRels.includes(relType)) {
              sendJson(res, 400, { ok: false, error: '请提供有效的起始 ID、目标 ID 与关联类型' });
              return;
            }
            const fromMem = get(db, fromRaw);
            const toMem = get(db, toRaw);
            if (!fromMem || !toMem) {
              sendJson(res, 404, { ok: false, error: '未找到对应的记忆条目（支持完整 ID 或前 8 位短 ID）' });
              return;
            }
            if (fromMem.id === toMem.id) {
              sendJson(res, 400, { ok: false, error: '不能与自身建立拓扑关联' });
              return;
            }
            addRelation(db, fromMem.id, toMem.id, relType, Date.now());
            sendJson(res, 200, { ok: true, fromId: fromMem.id, toId: toMem.id, rel: relType });
            return;
          }

          if (action === 'distill') {
            const resDistill = await distillSession(db, cfg, { isIdle: true });
            sendJson(res, 200, {
              ok: true,
              result: {
                ...resDistill,
                eventsProcessed: resDistill.consumedCount,
                candidatesInserted: resDistill.itemsCreated,
              },
            });
            return;
          }

          if (action === 'approve-repair') {
            const pId = Number(body.proposalId);
            if (!pId || isNaN(pId)) {
              sendJson(res, 400, { ok: false, error: '无效的修复提案 ID' });
              return;
            }
            const resApprove = approveRepairProposal(db, pId, 'user', Date.now());
            if (!resApprove.ok) {
              sendJson(res, 400, { ok: false, error: resApprove.reason || '批准修复提案失败' });
              return;
            }
            sendJson(res, 200, { ok: true, proposalId: pId });
            return;
          }

          if (action === 'reject-repair') {
            const pId = Number(body.proposalId);
            if (!pId || isNaN(pId)) {
              sendJson(res, 400, { ok: false, error: '无效的修复提案 ID' });
              return;
            }
            const resReject = rejectRepairProposal(db, pId);
            if (!resReject.ok) {
              sendJson(res, 400, { ok: false, error: resReject.reason || '拒绝修复提案失败' });
              return;
            }
            sendJson(res, 200, { ok: true, proposalId: pId });
            return;
          }

          if (action === 'evolve-strategy') {
            const resEvolve = runStrategyEvolution(db, {}, cfg);
            sendJson(res, 200, { ok: true, result: resEvolve });
            return;
          }

          if (action === 'rollback-strategy') {
            const targetVer = body.targetVersion !== undefined ? Number(body.targetVersion) : undefined;
            const resRollback = rollbackStrategy(db, targetVer);
            if (!resRollback.ok) {
              sendJson(res, 400, { ok: false, error: resRollback.reason || '策略回滚失败' });
              return;
            }
            sendJson(res, 200, { ok: true, rolledBackTo: resRollback.rolledBackTo });
            return;
          }

          if (action === 'backfill') {
            const dryRun = !!body.dryRun;
            const statsRes = runBackfill(db, { dryRun });
            sendJson(res, 200, { ok: true, dryRun, stats: statsRes });
            return;
          }

          if (action === 'eval') {
            const suite = typeof body.suite === 'string' && body.suite !== 'all' ? body.suite : undefined;
            const allCases = generateDataset();
            const cases = suite
              ? allCases.filter((c) => c.suite.toLowerCase() === suite.toLowerCase())
              : allCases;
            const report = runEvalSuite(cases);
            sendJson(res, 200, { ok: true, report });
            return;
          }

          sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
          return;
        }

        // 4.5. Export memories (GET)
        if (subPath === '/export') {
          const rawWs = reqUrl.searchParams.get('workspaceId') || undefined;
          const wsId = rawWs ? workspaceId(rawWs) : undefined;
          const format = reqUrl.searchParams.get('format') || 'json';
          let sql = 'SELECT * FROM memories WHERE 1=1';
          const params: unknown[] = [];
          if (wsId) {
            sql += ' AND (workspace_id = ? OR workspace_id IS NULL)';
            params.push(wsId);
          }
          sql += ' ORDER BY pinned DESC, updated_at DESC';
          const items = db.all<MemoryRecord>(sql, params);

          if (format === 'markdown') {
            // 单次查询聚合实体，避免逐条 N+1 查询
            const entityMap = new Map<string, string[]>();
            for (const row of db.all<{ memory_id: string; entity: string }>(
              'SELECT memory_id, entity FROM memory_entities'
            )) {
              const arr = entityMap.get(row.memory_id);
              if (arr) arr.push(row.entity);
              else entityMap.set(row.memory_id, [row.entity]);
            }
            const mdSections = items.map((m) => serializeMemoryToMarkdown(m, entityMap.get(m.id) || []));
            const fullMd =
              `# DSH 长期记忆知识库导出 (${items.length} 条)\n\n导出时间: ${new Date().toLocaleString()}\n\n---\n\n` +
              mdSections.join('\n\n---\n\n');
            res.writeHead(200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': 'attachment; filename="dsh-memories.md"',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'Access-Control-Allow-Origin': (res as any).__trustedOrigin || 'http://127.0.0.1',
            });
            res.end(fullMd);
            return;
          }

          sendJson(res, 200, {
            ok: true,
            version: '0.8.1',
            exportedAt: Date.now(),
            total: items.length,
            memories: items.map(({ embedding: _emb, ...rest }) => rest),
          });
          return;
        }

        // 4.6. Import memories (POST)
        if (subPath === '/import' && req.method === 'POST') {
          const body = await readBodyJson(req);
          // 同时接受 /export 的原始输出（memories 字段），导出文件可直接回放
          const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.memories) ? body.memories : [];
          // 按更新时间从旧到新回放：/export 是新者在前，直接回放会让旧值最后写入并取代同槽位的现行值
          const items = [...rawItems].sort(
            (a: any, b: any) => (Number(a?.updated_at) || 0) - (Number(b?.updated_at) || 0)
          );
          if (items.length === 0) {
            sendJson(res, 400, { ok: false, error: '导入数据不能为空，未发现有效记忆条目' });
            return;
          }
          if (items.length > MAX_IMPORT_ITEMS) {
            sendJson(res, 400, { ok: false, error: `单次最多导入 ${MAX_IMPORT_ITEMS} 条记忆` });
            return;
          }
          let imported = 0;
          let skipped = 0;
          const now = Date.now();
          const bodyWs = str(body.workspaceId) || undefined;
          // 单事务批量写入：大幅减少 fsync 次数；单条失败由 upsertCandidate 内部 SAVEPOINT 回滚，不影响其它条目
          db.transaction(() => {
            for (const item of items) {
              if (!item || typeof item !== 'object') {
                skipped++;
                continue;
              }
              // 已遗忘、被取代或被拒绝的记录不得经导入重新生效
              if (item.status === 'superseded' || item.status === 'archived' || item.status === 'rejected') {
                skipped++;
                continue;
              }
              const raw = item.content || item.summary;
              if (!raw || typeof raw !== 'string' || raw.trim().length < 4) {
                skipped++;
                continue;
              }
              try {
                const clean = redactSecrets(raw.trim());
                const cleanSummary =
                  typeof item.summary === 'string' && item.summary.trim()
                    ? redactSecrets(item.summary.trim()).text
                    : undefined;
                const itemWs = str(item.workspace_id) || bodyWs;
                const itemScope = VALID_SCOPES.includes(item.scope) ? item.scope : itemWs ? 'workspace' : undefined;
                const upsertRes = upsertCandidate(
                  db,
                  {
                    type: normalizeMemoryType(item.type),
                    scope: itemScope,
                    workspaceId: itemWs,
                    sessionId: str(item.session_id) || undefined,
                    content: clean.text,
                    summary: cleanSummary,
                    slot_key: typeof item.slot_key === 'string' && item.slot_key.trim() ? item.slot_key.trim() : null,
                    confidence: typeof item.confidence === 'number' ? item.confidence : 0.95,
                    importance:
                      typeof item.importance === 'number' && item.importance >= 1 && item.importance <= 10
                        ? Math.round(item.importance)
                        : undefined,
                    status: item.status === 'candidate' ? 'candidate' : 'active',
                    source_kind: 'user',
                    origin_kinds: ['user'],
                    actor: 'user',
                    sources: [{ session_id: 'import', seq: 1, kind: 'user' }],
                  },
                  now
                );
                if (upsertRes.action !== 'rejected') {
                  if (item.pinned) {
                    pin(db, upsertRes.id, 'user', now);
                  }
                  imported++;
                } else {
                  skipped++;
                }
              } catch {
                skipped++;
              }
            }
          });
          if (imported > 0) {
            try {
              weaveZettelkastenLinks(db, { now });
            } catch {}
          }
          sendJson(res, 200, { ok: true, imported, skipped, total: items.length });
          return;
        }

        // 5. Config management (GET & POST)
        if (subPath === '/config') {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              config: getSanitizedConfig(cfg),
            });
            return;
          }

          if (req.method === 'POST') {
            const body = await readBodyJson(req);
            const patch: any = {};

            if (body.offlineLLM && typeof body.offlineLLM === 'object') {
              patch.offlineLLM = { ...cfg.offlineLLM };
              if (typeof body.offlineLLM.useDshLlm === 'boolean') {
                patch.offlineLLM.useDshLlm = body.offlineLLM.useDshLlm;
              }
              if (typeof body.offlineLLM.baseURL === 'string') {
                const prevBaseUrl = cfg.offlineLLM.baseURL || '';
                const nextBaseUrl = body.offlineLLM.baseURL.trim();
                if (nextBaseUrl && !isHttpUrl(nextBaseUrl)) {
                  sendJson(res, 400, { ok: false, error: 'Base URL 必须是合法的 HTTP/HTTPS 地址' });
                  return;
                }
                patch.offlineLLM.baseURL = nextBaseUrl;
                if (prevBaseUrl && patch.offlineLLM.baseURL && !isSameOriginUrl(prevBaseUrl, patch.offlineLLM.baseURL)) {
                  // 端点跨源变更：清除原有密钥与密钥环境变量绑定，避免把旧凭据发往新端点
                  patch.offlineLLM.apiKey = '';
                  if (typeof body.offlineLLM.apiKeyEnv !== 'string') {
                    patch.offlineLLM.apiKeyEnv = '';
                  }
                }
                if (patch.offlineLLM.baseURL && typeof body.offlineLLM.useDshLlm !== 'boolean') {
                  patch.offlineLLM.useDshLlm = false;
                }
              }
              if (typeof body.offlineLLM.model === 'string') {
                patch.offlineLLM.model = body.offlineLLM.model.trim().slice(0, 200);
              }
              if (typeof body.offlineLLM.apiKeyEnv === 'string') {
                const envName = body.offlineLLM.apiKeyEnv.trim();
                if (envName && !isSafeApiKeyEnvName(envName)) {
                  sendJson(res, 400, {
                    ok: false,
                    error: '密钥环境变量名不合法：仅允许以 _API_KEY / _KEY / _TOKEN 结尾的变量名',
                  });
                  return;
                }
                patch.offlineLLM.apiKeyEnv = envName;
              }
              if (
                typeof body.offlineLLM.protocol === 'string' &&
                ['chat/completions', 'responses', 'messages'].includes(body.offlineLLM.protocol)
              ) {
                patch.offlineLLM.protocol = body.offlineLLM.protocol;
              }
              if (body.offlineLLM.clearApiKey === true) {
                patch.offlineLLM.apiKey = '';
              } else if (
                typeof body.offlineLLM.apiKey === 'string' &&
                body.offlineLLM.apiKey.trim() &&
                !body.offlineLLM.apiKey.includes('****')
              ) {
                patch.offlineLLM.apiKey = body.offlineLLM.apiKey.trim();
              }
            }

            if (body.privacy && typeof body.privacy === 'object') {
              patch.privacy = { ...cfg.privacy };
              if (typeof body.privacy.offlineConsent === 'boolean') {
                patch.privacy.offlineConsent = body.privacy.offlineConsent;
              }
              if (Array.isArray(body.privacy.allowedOfflineEndpoints)) {
                patch.privacy.allowedOfflineEndpoints = body.privacy.allowedOfflineEndpoints
                  .filter((e: unknown): e is string => typeof e === 'string')
                  .map((e: string) => e.trim())
                  .filter((e: string) => e && isValidEndpointEntry(e))
                  .slice(0, 50);
              }
            }

            // 外发授权只接受请求中显式给出的 privacy.offlineConsent：默认 useDshLlm=true，
            // 若据此隐式开启，任何不相关的保存（如仅调整每日配额）都会打开外发授权
            const effectiveConsent =
              patch.privacy?.offlineConsent !== undefined
                ? patch.privacy.offlineConsent
                : cfg.privacy.offlineConsent;
            const prevBaseURL = (cfg.offlineLLM.baseURL || '').trim();
            const targetBaseURL = patch.offlineLLM?.baseURL ?? cfg.offlineLLM.baseURL;
            const endpointChanged =
              Boolean(prevBaseURL) && (!targetBaseURL || !isSameOriginUrl(prevBaseURL, targetBaseURL));
            const explicitAllowList = Array.isArray(body.privacy?.allowedOfflineEndpoints);

            if (patch.offlineLLM && !targetBaseURL && patch.offlineLLM.useDshLlm) {
              // 切回宿主内置通道：自定义端点的密钥不得随宿主环境变量指向的端点一并发出
              patch.offlineLLM.apiKey = '';
            }
            if (endpointChanged && !explicitAllowList) {
              // 端点已更换：旧端点不再保留在白名单中（否则每个输入中途的地址都会永久留存）
              if (!patch.privacy) {
                patch.privacy = { ...cfg.privacy };
              }
              const stale = new Set<string>([prevBaseURL]);
              try {
                stale.add(new URL(prevBaseURL).origin);
              } catch {}
              patch.privacy.allowedOfflineEndpoints = (
                patch.privacy.allowedOfflineEndpoints || cfg.privacy.allowedOfflineEndpoints || []
              ).filter((e: string) => !stale.has(e));
            }
            if (targetBaseURL && effectiveConsent) {
              if (!patch.privacy) {
                patch.privacy = { ...cfg.privacy };
              }
              const allowed = new Set(
                patch.privacy.allowedOfflineEndpoints || cfg.privacy.allowedOfflineEndpoints || []
              );
              allowed.add(targetBaseURL);
              try {
                const u = new URL(targetBaseURL);
                allowed.add(u.origin);
              } catch {}
              patch.privacy.allowedOfflineEndpoints = Array.from(allowed);
            }

            const clampPositiveInt = (v: unknown, max: number): number | undefined =>
              typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, Math.floor(v)) : undefined;
            const calls = clampPositiveInt(body.dailyLLMCalls, 10_000);
            if (calls !== undefined) patch.dailyLLMCalls = calls;
            const tokens = clampPositiveInt(body.dailyLLMTokens, 100_000_000);
            if (tokens !== undefined) patch.dailyLLMTokens = tokens;
            const distillTokens = clampPositiveInt(body.distillMaxInputTokens, 1_000_000);
            if (distillTokens !== undefined) patch.distillMaxInputTokens = distillTokens;

            const updated = saveConfigToDb(db, patch, cfg);
            Object.assign(cfg, updated);

            sendJson(res, 200, {
              ok: true,
              config: getSanitizedConfig(cfg),
            });
            return;
          }
        }

        // 6. Test LLM Connection (POST)
        if (subPath === '/llm/test' && req.method === 'POST') {
          const body = await readBodyJson(req);
          const bodyBaseURL = str(body.baseURL);
          const baseURL = (bodyBaseURL || cfg.offlineLLM.baseURL || '').trim();
          const model = (str(body.model) || cfg.offlineLLM.model || 'deepseek-chat').trim();

          if (!baseURL) {
            sendJson(res, 400, { ok: false, error: '请先填写接口 Base URL' });
            return;
          }

          let parsedTargetUrl: URL;
          try {
            parsedTargetUrl = new URL(baseURL);
            if (parsedTargetUrl.protocol !== 'http:' && parsedTargetUrl.protocol !== 'https:') {
              sendJson(res, 400, { ok: false, error: '仅支持 HTTP/HTTPS 协议端点' });
              return;
            }
          } catch {
            sendJson(res, 400, { ok: false, error: 'Base URL 格式不合法' });
            return;
          }

          const isSameConfiguredEndpoint =
            !bodyBaseURL ||
            bodyBaseURL === (cfg.offlineLLM.baseURL || '').trim() ||
            isSameOriginUrl(baseURL, cfg.offlineLLM.baseURL);

          let apiKey = '';
          if (
            typeof body.apiKey === 'string' &&
            body.apiKey.trim() &&
            !body.apiKey.includes('****')
          ) {
            apiKey = body.apiKey.trim();
          } else if (isSameConfiguredEndpoint) {
            apiKey = cfg.offlineLLM.apiKey || '';
          }

          const envName = (str(body.apiKeyEnv) || cfg.offlineLLM.apiKeyEnv || '').trim();
          const isSafeEnvName =
            (envName === cfg.offlineLLM.apiKeyEnv && isSafeApiKeyEnvName(envName)) ||
            ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DASHSCOPE_API_KEY', 'DSH_MEMORY_API_KEY'].includes(envName.toUpperCase());
          if (!apiKey && envName && isSafeEnvName && isSameConfiguredEndpoint && process.env[envName]) {
            apiKey = process.env[envName]!;
          }

          const rawProtocol = str(body.protocol);
          const chosenProtocol: LLMProtocol = (['chat/completions', 'responses', 'messages'] as const).includes(rawProtocol as LLMProtocol)
            ? (rawProtocol as LLMProtocol)
            : cfg.offlineLLM.protocol || 'chat/completions';
          const { endpointUrl, protocol } = resolveEndpointAndProtocol(baseURL, chosenProtocol);
          const { requestBody, headers: protoHeaders } = buildProtocolPayload(
            protocol,
            model,
            'Reply in valid JSON format.',
            'Return {"ok":true} in json.',
            32
          );

          const start = Date.now();
          try {
            const fetchFn = (globalThis as any).fetch;
            if (!fetchFn) {
              sendJson(res, 500, { ok: false, error: '当前环境缺少 fetch 实现' });
              return;
            }

            const headers: Record<string, string> = {
              ...protoHeaders,
            };
            if (apiKey) {
              headers['Authorization'] = `Bearer ${apiKey}`;
              if (protocol === 'messages') {
                headers['x-api-key'] = apiKey;
              }
            }

            const response = await fetchFn(endpointUrl, {
              method: 'POST',
              headers,
              body: requestBody,
              signal: AbortSignal.timeout(10000),
              redirect: 'manual',
            });

            const latencyMs = Date.now() - start;

            if (response.ok) {
              sendJson(res, 200, {
                ok: true,
                latencyMs,
                status: response.status,
                model,
                protocol,
              });
              return;
            } else {
              const errText = await response.text().catch(() => '');
              let msg = `HTTP ${response.status}`;
              try {
                const parsed = JSON.parse(errText);
                if (parsed.error?.message) {
                  msg = `${msg}: ${parsed.error.message}`;
                } else if (parsed.message) {
                  msg = `${msg}: ${parsed.message}`;
                } else {
                  msg = `${msg}: ${errText.slice(0, 150)}`;
                }
              } catch {
                if (errText) msg = `${msg}: ${errText.slice(0, 150)}`;
              }
              sendJson(res, 200, {
                ok: false,
                latencyMs,
                status: response.status,
                error: msg,
              });
              return;
            }
          } catch (err: any) {
            const latencyMs = Date.now() - start;
            sendJson(res, 200, {
              ok: false,
              latencyMs,
              error:
                err.name === 'TimeoutError' || err.message?.includes('timeout')
                  ? '连接超时 (超过 10 秒无响应)'
                  : err.message || '网络连接失败，请检查地址是否可达',
            });
            return;
          }
        }

        // Unknown route
        sendJson(res, 404, { ok: false, error: `Not found: ${pathname}` });
      } catch (err: any) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { ok: false, error: err.message });
          return;
        }
        console.error('[dsh-memory web API error]', err);
        sendJson(res, 500, { ok: false, error: err?.message || 'Internal server error' });
      }
    },
  });

  return dispose;
}
