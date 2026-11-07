import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../src/core/db.js';
import type { Db, MemoryRecord } from '../src/types.js';
import { DEFAULTS } from '../src/config.js';
import { workspaceId } from '../src/core/scope.js';
import { upsertCandidate, addRelation, freeze } from '../src/core/writer.js';
import {
  computeLocalEmbedding,
  cosineSimilarity,
  clearRuntimeVectorCache,
} from '../src/core/vector.js';
import { getCoreMemory, setCoreMemory } from '../src/core/core-memory.js';
import { autoHealMemoryHealth, syncAutonomousCoreMemory } from '../src/core/health.js';
import { buildQueryPlan } from '../src/retrieval/query.js';
import { recallVector } from '../src/retrieval/channels.js';
import { computeHybridOverlap, govern } from '../src/retrieval/governor.js';
import { MemoryTools } from '../src/dsh/tools.js';
import { registerWebRoutes } from '../src/dsh/web.js';
import { distillSession, findEligibleDistillSession } from '../src/evolution/extractor.js';
import { harvestSample } from '../src/evolution/lab.js';
import { importDatabaseFile } from '../src/evolution/maintenance.js';
import { JobScheduler } from '../src/jobs/scheduler.js';

describe('v0.7.0 Algorithmic, Closed-Loop & Studio UI Upgrades', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-v070');
  const now = 1762500000000;

  beforeEach(() => {
    db = openDb(':memory:');
    clearRuntimeVectorCache();
  });

  it('1. persists 128D embeddings inline at write time and eliminates >120 scale vector blindspot + hierarchical path similarity', () => {
    // Hierarchical directory prefix feature check
    const vGov = computeLocalEmbedding('重构 src/retrieval/governor.ts 预算装箱逻辑');
    const vFuse = computeLocalEmbedding('调整 src/retrieval/fuse.ts 打分策略');
    const vClient = computeLocalEmbedding('调整 ui/theme/palette.css 颜色配置');
    expect(cosineSimilarity(vGov, vFuse)).toBeGreaterThan(cosineSimilarity(vGov, vClient));

    // Insert 150 background memories + 1 target memory without running backfillMissingEmbeddings
    for (let i = 1; i <= 150; i++) {
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: `历史背景记录条目编号 ${i}：常规服务心跳检查配置端口 ${3000 + i}`,
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          confidence: 0.85,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_bulk', seq: i, kind: 'user' }],
          actor: 'user',
        },
        now + i
      );
    }

    const targetRes = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '排查 WebAssembly 内存泄漏时需开启 --expose-wasm-memory-stats 采样堆快照',
        summary: 'WebAssembly 内存泄漏采样步骤',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.96,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_bulk', seq: 151, kind: 'user' }],
        actor: 'user',
      },
      now + 500
    );
    const targetId = (targetRes as any).id;

    // Even after clearing in-memory LRU cache and with >150 rows in workspace, SQLite BLOB embedding recalls immediately
    clearRuntimeVectorCache();
    const plan = buildQueryPlan({
      userText: 'WebAssembly 内存泄漏 --expose-wasm-memory-stats 采样堆快照',
    });
    const hits = recallVector(db, plan, { workspaceId: ws, sessionId: 's_bulk' });
    expect(hits.some((h) => h.id === targetId)).toBe(true);
  });

  it('2. Hybrid Lexical-Semantic MMR suppresses high-vector-overlap same-type paraphrases while preserving orthogonal facts', () => {
    const rAnchor = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '修改 src/retrieval/governor.ts 后必须执行 npm run check 验证类型与测试套件',
        summary: 'src/retrieval/governor.ts 验证规范',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const rParaphrase = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '改动 src/retrieval/governor.ts 代码后务必运行 npm run check 检查类型及单元测试',
        summary: 'governor.ts 提交前验证',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.94,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );
    const rOrthogonal = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '离线慢环配额硬上限设定为每日最多 40 次请求与 200,000 Tokens',
        summary: '离线慢环每日配额硬上限',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );

    const mAnchor = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [(rAnchor as any).id])!;
    const mPara = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [(rParaphrase as any).id])!;
    const mOrtho = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [(rOrthogonal as any).id])!;

    const hybridSim = computeHybridOverlap(
      new Set(['governor']),
      new Set(['check']),
      computeLocalEmbedding(mAnchor.content),
      computeLocalEmbedding(mPara.content),
      true
    );
    expect(hybridSim).toBeGreaterThan(0.5);

    const packed = govern(
      [
        { memory: mAnchor, score: 0.92, relevance: 0.9, fusedRrf: 0.9 },
        { memory: mPara, score: 0.90, relevance: 0.88, fusedRrf: 0.88 },
        { memory: mOrtho, score: 0.82, relevance: 0.8, fusedRrf: 0.8 },
      ],
      {
        budget: 1600,
        maxItems: 2,
        alreadyInjected: new Set(),
      }
    );

    expect(packed).toHaveLength(2);
    expect(packed[0].memory.id).toBe(mAnchor.id);
    expect(packed[1].memory.id).toBe(mOrtho.id);
  });

  it('3. upgrades memory_search to full 7-channel graph/preference/vector fusion and renders causal relations in memory_expand', () => {
    const tools = new MemoryTools({ db });

    const rSeed = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '网关鉴权中间件位于 src/auth/jwt-guard.ts，采用 Ed25519 公钥验签',
        summary: 'jwt-guard.ts Ed25519 验签机制',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_tool', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const rNeighbor = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '轮换鉴权公钥对时必须保留旧公钥 15 分钟宽限窗口以防飞行中请求 401',
        summary: '鉴权公钥轮换 15 分钟宽限窗口教训',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.93,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_tool', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const seedId = (rSeed as any).id;
    const neighborId = (rNeighbor as any).id;
    addRelation(db, seedId, neighborId, 'related', now + 20);

    // Search hits seed via entity/lexical and expands 1-hop neighbor via 7th graph channel
    const searchOut = tools.search(
      { query: 'src/auth/jwt-guard.ts 鉴权问题', limit: 5 },
      { workspaceId: ws, sessionId: 's_tool', turn: 1 }
    );
    expect(searchOut).toContain(seedId);
    expect(searchOut).toContain(neighborId);

    // Expand shows 1-hop Relations section
    const expandOut = tools.expand({ id: seedId }, { workspaceId: ws, sessionId: 's_tool' });
    expect(expandOut).toContain('Relations:');
    expect(expandOut).toContain(neighborId);
  });

  it('4. prevents multi-turn distill job deadlock via watermark sequence keys and reconciles extracted items', async () => {
    const scheduler = new JobScheduler(db, DEFAULTS);

    // Turn 1 raw events (seq 1..2)
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('sess_multi', 1, ?, 'user/message', ?, 1, 'user', 'user', '项目后端目前采用 Express 4 框架运行在 3000 端口', 0)`,
      [ws, now]
    );
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('sess_multi', 2, ?, 'assistant/message', ?, 1, 'assistant', 'assistant', '已收到 Express 4 架构信息', 0)`,
      [ws, now + 10]
    );

    // Pre-existing active memory that will be evolved in turn 2
    const rOld = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目后端目前采用 Express 4 框架运行在 3000 端口',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_init', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now - 1000
    );
    const oldMemId = (rOld as any).id;

    const batch1 = findEligibleDistillSession(db, DEFAULTS, true, 'sess_multi');
    expect(batch1?.minSeq).toBe(1);
    const key1 = `${batch1!.sessionId}:seq:${batch1!.minSeq}`;
    expect(scheduler.enqueue('distill', key1, { sessionId: 'sess_multi' })).toBe(true);

    // Distill turn 1 (subsumed duplicate -> skipped via NOOP reconciliation, watermark advances to seq 2)
    const testCfg = {
      ...DEFAULTS,
      privacy: { offlineConsent: true, allowedOfflineEndpoints: ['https://api.deepseek.com'] },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
      },
    };
    const res1 = await distillSession(db, testCfg, {
      sessionId: 'sess_multi',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [
                      {
                        type: 'semantic',
                        text: '项目后端目前采用 Express 4 框架运行在 3000 端口',
                        confidence: 0.85,
                        scope: 'workspace',
                        evidence: [{ seq: 1, quote: 'Express 4 框架运行在 3000 端口' }],
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 40 },
          }),
          { status: 200 }
        ),
    });
    expect(res1.success).toBe(true);
    expect(res1.itemsCreated).toBe(0); // Subsumed NOOP skipped cleanly!
    db.run(`UPDATE jobs SET status = 'done' WHERE kind = 'distill' AND key = ?`, [key1]);

    // Turn 2 arrives in the SAME session (seq 3): semantic evolution to Fastify 5!
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('sess_multi', 3, ?, 'user/message', ?, 2, 'user', 'user', '项目后端已从 Express 4 迁移到 Fastify 5 并监听 8080 端口', 0)`,
      [ws, now + 500]
    );

    const batch2 = findEligibleDistillSession(db, DEFAULTS, true, 'sess_multi');
    expect(batch2?.minSeq).toBe(3);
    const key2 = `${batch2!.sessionId}:seq:${batch2!.minSeq}`;
    expect(key2).not.toBe(key1);
    // Must NOT deadlock against completed turn-1 job!
    expect(scheduler.enqueue('distill', key2, { sessionId: 'sess_multi' })).toBe(true);

    const res2 = await distillSession(db, testCfg, {
      sessionId: 'sess_multi',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [
                      {
                        type: 'semantic',
                        text: '项目后端已从 Express 4 迁移到 Fastify 5 并监听 8080 端口',
                        confidence: 0.9,
                        scope: 'workspace',
                        evidence: [{ seq: 1, quote: '从 Express 4 迁移到 Fastify 5' }],
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 50 },
          }),
          { status: 200 }
        ),
    });
    expect(res2.success).toBe(true);
    expect(res2.itemsCreated).toBe(1);
    const newCandId = res2.candidateIds![0];

    // Reconciler linked contradicts relation to oldMemId even without explicit slot_key
    const rel = db.get<{ rel: string }>(
      `SELECT rel FROM memory_relations WHERE from_id = ? AND to_id = ?`,
      [newCandId, oldMemId]
    );
    expect(rel?.rel).toBe('contradicts');

    // Also verify harvested eval samples table query matches harvestSample('harvested')
    harvestSample(db, {
      id: 'harvest_sess_multi_2',
      suite: 'harvested',
      critical: false,
      now: new Date(now).toISOString(),
      workspace: ws,
      setup: [{ type: 'semantic', content: '当前后端服务已从 Express 4 迁移到 Fastify 5，默认监听 8080 端口' }],
      query: '后端使用什么框架和端口？',
      expect: { include: ['Fastify 5'] },
    });
    const harvestedCnt =
      db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM eval_cases WHERE suite = 'harvested'")
        ?.cnt || 0;
    expect(harvestedCnt).toBe(1);
  });

  it('5. autonomously syncs battle-tested memories into Core Memory idempotently and imports .db losslessly', () => {
    // 1. User-level battle-tested preference + workspace-level battle-tested rule
    const rPref = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '所有新增公共函数必须包含返回类型显式声明与错误处理测试',
        summary: '新增公共函数需显式声明返回类型',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_core', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const rRule = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '发布版本前必须依次通过 npm run check、npm run build 与 npm run eval 三道门禁',
        summary: '发版前必跑 check / build / eval 三道门禁',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.96,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_core', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const prefId = (rPref as any).id;
    const ruleId = (rRule as any).id;
    db.run(`UPDATE memories SET utility = 0.82, success_count = 2 WHERE id IN (?, ?)`, [
      prefId,
      ruleId,
    ]);

    const synced1 = syncAutonomousCoreMemory(db, { workspaceId: ws, now: now + 100 });
    expect(synced1).toBe(2);
    expect(getCoreMemory(db, 'human')?.content).toContain('新增公共函数需显式声明返回类型');
    expect(getCoreMemory(db, 'project', { workspaceId: ws })?.content).toContain(
      '发版前必跑 check / build / eval 三道门禁'
    );

    // Second run is strictly idempotent (0 duplicate lines)
    const synced2 = syncAutonomousCoreMemory(db, { workspaceId: ws, now: now + 200 });
    expect(synced2).toBe(0);

    // Frozen core blocks are never overwritten
    const personaRes = setCoreMemory(db, 'human', '手工锁定画像', { actor: 'user' });
    freeze(db, personaRes.id, 'user', now + 300);
    expect(syncAutonomousCoreMemory(db, { workspaceId: ws, now: now + 400 })).toBe(0);

    // 2. Lossless importDatabaseFile preserves entities, sources, relations, importance, and embeddings
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v070-import-'));
    const srcDbPath = path.join(tmpDir, 'source.db');
    try {
      const srcDb = openDb(srcDbPath);
      const a = upsertCandidate(
        srcDb,
        {
          type: 'semantic',
          content: '核心状态存储位于 src/core/store.ts，支持 K-Hop 子图查询',
          importance: 9,
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          confidence: 0.95,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_imp', seq: 7, kind: 'user', excerpt: 'K-Hop 子图查询' }],
          actor: 'user',
        },
        now
      );
      const b = upsertCandidate(
        srcDb,
        {
          type: 'procedural',
          content: '图谱导出采用 Mermaid flowchart TD 语法渲染',
          importance: 8,
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_imp', seq: 8, kind: 'user' }],
          actor: 'user',
        },
        now + 10
      );
      addRelation(srcDb, (a as any).id, (b as any).id, 'related', now + 20);
      srcDb.close();

      const destDb = openDb(':memory:');
      const impRes = importDatabaseFile(destDb, ':memory:', srcDbPath);
      expect(impRes.success).toBe(true);
      expect(impRes.importedRecords).toBe(2);

      const importedA = destDb.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
        (a as any).id,
      ]);
      expect(importedA?.importance).toBe(9);
      expect(importedA?.embedding?.byteLength).toBe(512);

      const entCnt =
        destDb.get<{ c: number }>('SELECT COUNT(*) as c FROM memory_entities WHERE memory_id = ?', [
          (a as any).id,
        ])?.c || 0;
      const srcCnt =
        destDb.get<{ c: number }>('SELECT COUNT(*) as c FROM memory_sources WHERE memory_id = ?', [
          (a as any).id,
        ])?.c || 0;
      const relCnt =
        destDb.get<{ c: number }>('SELECT COUNT(*) as c FROM memory_relations')?.c || 0;
      expect(entCnt).toBeGreaterThanOrEqual(1);
      expect(srcCnt).toBe(1);
      expect(relCnt).toBeGreaterThanOrEqual(1);
      destDb.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. serves /core alias, status=live&excludeCore=1, strips binary embeddings, and enforces single-<button> Studio UI invariant', async () => {
    let routeHandler: any = null;
    registerWebRoutes(
      {
        webServer: {
          register: (spec: any) => {
            routeHandler = spec.handler;
            return () => {};
          },
        },
      },
      db,
      DEFAULTS
    );

    const callApi = (method: string, urlPath: string, body?: unknown): Promise<any> =>
      new Promise((resolve) => {
        const req: any = new EventEmitter();
        req.method = method;
        req.url = urlPath;
        let rawOut = '';
        const res: any = {
          statusCode: 200,
          writeHead(code: number) {
            this.statusCode = code;
          },
          end(chunk?: string) {
            if (chunk) rawOut += chunk;
            resolve({ status: this.statusCode, json: rawOut ? JSON.parse(rawOut) : null });
          },
        };
        routeHandler(req, res);
        if (body !== undefined) {
          req.emit('data', Buffer.from(JSON.stringify(body)));
        }
        req.emit('end');
      });

    // Populate Core Memory + 1 active + 1 frozen memory
    setCoreMemory(db, 'project', 'Node 24 + SQLite FTS5 核心底座', { workspaceId: ws });
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '活跃事实记忆：API 前缀统一为 /api/dsh-memory',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_web', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const rFrozen = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '冻结规则记忆：禁止直接向 main 分支推送提交',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.99,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_web', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );
    freeze(db, (rFrozen as any).id, 'user', now + 20);

    // /core alias works identically to /core-memory and returns stableLayerTokens > 0
    const coreRes = await callApi('GET', `/api/dsh-memory/core?workspaceId=${ws}`);
    expect(coreRes.status).toBe(200);
    expect(coreRes.json.ok).toBe(true);
    expect(coreRes.json.totalTokens).toBeGreaterThan(0);
    expect(coreRes.json.stableLayerTokens).toBeGreaterThan(0);

    // status=live&excludeCore=1 includes active + frozen while excluding core:* scratchpad blocks, and strips binary embedding
    const memRes = await callApi(
      'GET',
      `/api/dsh-memory/memories?status=live&excludeCore=1&workspaceId=${ws}`
    );
    expect(memRes.status).toBe(200);
    expect(memRes.json.items).toHaveLength(2);
    expect(memRes.json.items.some((m: any) => String(m.slot_key || '').startsWith('core:'))).toBe(
      false
    );
    expect(memRes.json.items.some((m: any) => m.status === 'frozen')).toBe(true);
    expect(memRes.json.items[0].embedding).toBeUndefined();

    // Auto-heal integrates coreBlocksSynced smoothly
    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 50 });
    expect(healRes.coreBlocksSynced).toBeDefined();

    // Verify strict single-<button> invariant across the entire src/client/ Studio UI codebase
    const clientDir = path.resolve(process.cwd(), 'src/client');
    const walkFiles = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkFiles(full));
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const clientFiles = walkFiles(clientDir);
    let totalButtonTags = 0;
    for (const file of clientFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const matches = src.match(/<button\b/g);
      if (matches) totalButtonTags += matches.length;
    }
    expect(totalButtonTags).toBe(1);
  });
});
