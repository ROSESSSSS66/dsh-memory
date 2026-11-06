import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Db, MemoryRecord, MemoryType } from '../types.js';
import { type PluginConfig, saveConfigToDb } from '../config.js';
import { get, list, stats, sources, history, getGraphData } from '../core/store.js';
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
} from '../core/writer.js';
import { redactSecrets } from '../core/privacy.js';
import { serializeMemoryToMarkdown } from '../core/markdown.js';
import { getLedgerUsage } from '../evolution/ledger.js';
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  checkAndRepairFts,
  cleanOldTelemetry,
} from '../evolution/maintenance.js';
import { resolveEndpointAndProtocol, buildProtocolPayload } from '../evolution/llm.js';

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

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBodyJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > 1024 * 1024) return; // 1MB limit
      chunks.push(buf);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export function registerWebRoutes(ctx: any, db: Db, cfg: PluginConfig) {
  if (!ctx.webServer?.register) {
    return () => {};
  }

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
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
          const wsId = reqUrl.searchParams.get('workspaceId') || undefined;
          const st = stats(db, wsId);
          const ledger = getLedgerUsage(db, 'enforce');

          // Recent 7 days injection stats
          const sevenDaysAgo = Date.now() - 7 * 86400000;
          const injRows = db.all<{ tokens: number; outcome: number | null }>(
            'SELECT tokens, outcome FROM injections WHERE created_at >= ?',
            [sevenDaysAgo]
          );
          let totalTokens = 0;
          let corrections = 0;
          for (const r of injRows) {
            totalTokens += r.tokens;
            if (r.outcome !== null && r.outcome <= -0.5) {
              corrections++;
            }
          }
          const avgTokens = injRows.length > 0 ? Math.round(totalTokens / injRows.length) : 0;
          const correctionRate =
            injRows.length > 0 ? Number(((corrections / injRows.length) * 100).toFixed(1)) : 0;

          sendJson(res, 200, {
            ok: true,
            stats: st,
            dynamicBudgetTokens: cfg.dynamicBudgetTokens || 1600,
            ledger: {
              callsToday: ledger.callsCount,
              tokensToday: ledger.tokensConsumed,
              maxDailyCalls: cfg.dailyLLMCalls || 40,
              maxDailyTokens: cfg.dailyLLMTokens || 200000,
            },
            recentTelemetry: {
              injectionCount: injRows.length,
              avgTokens,
              correctionRate,
            },
          });
          return;
        }

        // 1.5. Graph Topology (汲取自 qwert702/dsh-memory 与 omdsh-dev/dsh-mnemon Obsidian 拓扑图)
        if (subPath === '/graph') {
          const wsId = reqUrl.searchParams.get('workspaceId') || undefined;
          const limit = parseInt(reqUrl.searchParams.get('limit') || '80', 10);
          const gData = getGraphData(db, { workspaceId: wsId, limit });
          sendJson(res, 200, { ok: true, graph: gData });
          return;
        }

        // 2. Memories list (with search, filter, pagination)
        if (subPath === '/memories' || subPath === '/list') {
          const q = (reqUrl.searchParams.get('q') || '').trim();
          const type = (reqUrl.searchParams.get('type') || '') as any;
          const status = (reqUrl.searchParams.get('status') || '') as any;
          const scope = (reqUrl.searchParams.get('scope') || '') as any;
          const wsId = reqUrl.searchParams.get('workspaceId') || undefined;
          const limit = parseInt(reqUrl.searchParams.get('limit') || '50', 10);
          const offset = parseInt(reqUrl.searchParams.get('offset') || '0', 10);

          let sql = 'SELECT * FROM memories WHERE 1=1';
          const params: unknown[] = [];

          if (q) {
            sql += ' AND (content LIKE ? OR summary LIKE ? OR slot_key LIKE ?)';
            const qPattern = `%${q}%`;
            params.push(qPattern, qPattern, qPattern);
          }
          if (type && type !== 'all') {
            sql += ' AND type = ?';
            params.push(normalizeMemoryType(type));
          }
          if (status && status !== 'all') {
            sql += ' AND status = ?';
            params.push(status);
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

          const items = db.all<MemoryRecord>(sql, params);

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
          const relations = db.all<{ to_id: string; rel: string }>(
            'SELECT to_id, rel FROM memory_relations WHERE from_id = ?',
            [mem.id]
          );

          sendJson(res, 200, {
            ok: true,
            memory: mem,
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
              sendJson(res, 404, { ok: false, error: `Memory ${id} not found` });
              return;
            }
            sendJson(res, 200, { ok: true, id, status: action === 'freeze' ? 'frozen' : 'active' });
            return;
          }

          if (action === 'forget') {
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
            const { content, summary, reason } = body;
            if (!content || typeof content !== 'string' || content.trim().length < 4) {
              sendJson(res, 400, { ok: false, error: '记忆内容至少需要 4 个字符' });
              return;
            }
            try {
              const resEdit = editContent(db, id, content.trim(), summary, 'user', Date.now());
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
            const { subAction, ids } = body;
            if (!Array.isArray(ids) || ids.length === 0) {
              sendJson(res, 400, { ok: false, error: '请选择至少一条记忆' });
              return;
            }
            let successCount = 0;
            const now = Date.now();
            for (const targetId of ids) {
              try {
                if (subAction === 'pin') pin(db, targetId, 'user', now);
                else if (subAction === 'unpin') unpin(db, targetId, 'user', now);
                else if (subAction === 'freeze') freeze(db, targetId, 'user', now);
                else if (subAction === 'unfreeze') unfreeze(db, targetId, 'user', now);
                else if (subAction === 'forget') forget(db, targetId, 'user', now);
                else if (subAction === 'restore') restoreMemory(db, targetId, 'user', now);
                successCount++;
              } catch {}
            }
            sendJson(res, 200, { ok: true, affected: successCount, total: ids.length });
            return;
          }

          if (action === 'create') {
            const { content, type = 'preference', scope = 'global', workspaceId: customWsId, pinned = false } = body;
            if (!content || typeof content !== 'string' || content.trim().length < 4) {
              sendJson(res, 400, { ok: false, error: 'Content must be at least 4 characters' });
              return;
            }
            const clean = redactSecrets(content.trim());
            const now = Date.now();
            const resUpsert = upsertCandidate(
              db,
              {
                type: normalizeMemoryType(type),
                scope: (scope || 'global') as any,
                workspaceId: scope === 'workspace' ? customWsId : undefined,
                content: clean.text,
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

            const record = get(db, resUpsert.id);
            sendJson(res, 200, { ok: true, memory: record });
            return;
          }

          if (action === 'maintain') {
            archiveColdMemories(db, cfg);
            expireCandidates(db);
            autoPinMemories(db);
            checkAndRepairFts(db);
            cleanOldTelemetry(db);
            sendJson(res, 200, { ok: true, message: 'Maintenance completed successfully' });
            return;
          }

          sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
          return;
        }

        // 4.5. Export memories (GET)
        if (subPath === '/export') {
          const wsId = reqUrl.searchParams.get('workspaceId') || undefined;
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
            const mdSections = items.map((m) => {
              const entities = db
                .all<{ entity: string }>(
                  'SELECT entity FROM memory_entities WHERE memory_id = ?',
                  [m.id]
                )
                .map((e) => e.entity);
              return serializeMemoryToMarkdown(m, entities);
            });
            const fullMd =
              `# DSH 长期记忆知识库导出 (${items.length} 条)\n\n导出时间: ${new Date().toLocaleString()}\n\n---\n\n` +
              mdSections.join('\n\n---\n\n');
            res.writeHead(200, {
              'Content-Type': 'text/markdown; charset=utf-8',
              'Content-Disposition': 'attachment; filename="dsh-memories.md"',
              'Access-Control-Allow-Origin': '*',
            });
            res.end(fullMd);
            return;
          }

          sendJson(res, 200, {
            ok: true,
            version: '0.1.0',
            exportedAt: Date.now(),
            total: items.length,
            memories: items,
          });
          return;
        }

        // 4.6. Import memories (POST)
        if (subPath === '/import' && req.method === 'POST') {
          const body = await readBodyJson(req);
          const items = Array.isArray(body.items) ? body.items : [];
          if (items.length === 0) {
            sendJson(res, 400, { ok: false, error: '导入数据不能为空，未发现有效记忆条目' });
            return;
          }
          let imported = 0;
          let skipped = 0;
          const now = Date.now();
          for (const item of items) {
            const raw = item.content || item.summary;
            if (!raw || typeof raw !== 'string' || raw.trim().length < 4) {
              skipped++;
              continue;
            }
            try {
              const clean = redactSecrets(raw.trim());
              const upsertRes = upsertCandidate(
                db,
                {
                  type: normalizeMemoryType(item.type),
                  scope: item.scope || 'global',
                  content: clean.text,
                  confidence: typeof item.confidence === 'number' ? item.confidence : 0.95,
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
                patch.offlineLLM.baseURL = body.offlineLLM.baseURL.trim();
              }
              if (typeof body.offlineLLM.model === 'string') {
                patch.offlineLLM.model = body.offlineLLM.model.trim();
              }
              if (typeof body.offlineLLM.apiKeyEnv === 'string') {
                patch.offlineLLM.apiKeyEnv = body.offlineLLM.apiKeyEnv.trim();
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
                patch.privacy.allowedOfflineEndpoints = [...body.privacy.allowedOfflineEndpoints];
              }
            }

            // Ensure baseURL is added to allowedOfflineEndpoints if offlineConsent is enabled
            const effectiveConsent =
              patch.privacy?.offlineConsent !== undefined
                ? patch.privacy.offlineConsent
                : cfg.privacy.offlineConsent;
            const targetBaseURL = patch.offlineLLM?.baseURL ?? cfg.offlineLLM.baseURL;
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

            if (typeof body.dailyLLMCalls === 'number' && body.dailyLLMCalls > 0) {
              patch.dailyLLMCalls = Math.floor(body.dailyLLMCalls);
            }
            if (typeof body.dailyLLMTokens === 'number' && body.dailyLLMTokens > 0) {
              patch.dailyLLMTokens = Math.floor(body.dailyLLMTokens);
            }
            if (typeof body.distillMaxInputTokens === 'number' && body.distillMaxInputTokens > 0) {
              patch.distillMaxInputTokens = Math.floor(body.distillMaxInputTokens);
            }

            const updated = saveConfigToDb(db, patch);
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
          const baseURL = (body.baseURL || cfg.offlineLLM.baseURL || '').trim();
          const model = (body.model || cfg.offlineLLM.model || 'deepseek-chat').trim();

          let apiKey = '';
          if (
            typeof body.apiKey === 'string' &&
            body.apiKey.trim() &&
            !body.apiKey.includes('****')
          ) {
            apiKey = body.apiKey.trim();
          } else {
            apiKey = cfg.offlineLLM.apiKey || '';
          }

          const envName = (body.apiKeyEnv || cfg.offlineLLM.apiKeyEnv || '').trim();
          if (!apiKey && envName && process.env[envName]) {
            apiKey = process.env[envName]!;
          }

          if (!baseURL) {
            sendJson(res, 400, { ok: false, error: '请先填写接口 Base URL' });
            return;
          }

          const chosenProtocol = body.protocol || cfg.offlineLLM.protocol || 'chat/completions';
          const { endpointUrl, protocol } = resolveEndpointAndProtocol(baseURL, chosenProtocol);
          const { requestBody, headers: protoHeaders } = buildProtocolPayload(
            protocol,
            model,
            '',
            'hi',
            5
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
        console.error('[dsh-memory web API error]', err);
        sendJson(res, 500, { ok: false, error: err?.message || 'Internal server error' });
      }
    },
  });

  return dispose;
}
