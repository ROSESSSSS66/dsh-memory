import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/core/db.js';
import { isOfflineEndpointAllowed } from '../src/core/privacy.js';
import { validateConfig, saveConfigToDb, loadConfigFromDb, DEFAULTS } from '../src/config.js';
import {
  upsertCandidate,
  freeze,
  unfreeze,
  confirmMemory,
  invalidateMemory,
  restoreMemory,
} from '../src/core/writer.js';
import { exportMemoryBank, importMemoryBank } from '../src/core/markdown.js';
import { auditMemoryHealth } from '../src/core/health.js';
import { list, getGraphData } from '../src/core/store.js';
import { workspaceId } from '../src/core/scope.js';
import { buildQueryPlan, parseTimeRange } from '../src/retrieval/query.js';
import { evaluateTurnOutcome, CORRECTION_REGEX, CONFIRMATION_REGEX } from '../src/evolution/outcome.js';
import { getActiveStrategy, initDefaultStrategy } from '../src/evolution/strategy.js';
import { MemoryTools } from '../src/dsh/tools.js';
import { handlePreStep } from '../src/dsh/pre-step.js';
import { PromptSectionManager } from '../src/dsh/prompt-section.js';

describe('Comprehensive Review Fixes Regression Suite', () => {
  it('1. nested db.transaction rollback releases savepoint cleanly without leaking', () => {
    const db = openDb(':memory:');
    db.transaction(() => {
      try {
        db.transaction(() => {
          throw new Error('inner failure');
        });
      } catch {
        // expected
      }
      // Outer transaction should still be valid and able to commit
      db.run(`INSERT INTO meta(key, value) VALUES ('nested_tx_ok', '1')`);
    });
    const row = db.get<{ value: string }>(`SELECT value FROM meta WHERE key = 'nested_tx_ok'`);
    expect(row?.value).toBe('1');
  });

  it('2. isOfflineEndpointAllowed rejects non-http protocols and matches bare host:port', () => {
    expect(isOfflineEndpointAllowed('file:///etc/passwd', ['localhost:11434'], true)).toBe(false);
    expect(isOfflineEndpointAllowed('localhost:11434', ['other:9999'], true)).toBe(false);
    expect(isOfflineEndpointAllowed('http://localhost:11434/v1/chat/completions', ['localhost:11434'], true)).toBe(true);
    expect(isOfflineEndpointAllowed('https://api.deepseek.com/v1', ['https://api.deepseek.com'], true)).toBe(true);
    expect(isOfflineEndpointAllowed('ftp://api.deepseek.com/v1', ['api.deepseek.com'], true)).toBe(false);
  });

  it('3. validateConfig supports top-level llmBaseUrl/llmApiKey/llmModel and saveConfigToDb preserves baseCfg', () => {
    const cfg = validateConfig({
      llmBaseUrl: 'https://api.openai.com/v1',
      llmApiKey: 'sk-test-top-level',
      llmModel: 'gpt-4o-mini',
      dynamicBudgetTokens: 2048,
    } as any);
    expect(cfg.offlineLLM.baseURL).toBe('https://api.openai.com/v1');
    expect(cfg.offlineLLM.apiKey).toBe('sk-test-top-level');
    expect(cfg.offlineLLM.model).toBe('gpt-4o-mini');

    const db = openDb(':memory:');
    const saved = saveConfigToDb(db, { dailyLLMCalls: 88 }, cfg);
    expect(saved.dynamicBudgetTokens).toBe(2048);
    expect(saved.dailyLLMCalls).toBe(88);
    const loaded = loadConfigFromDb(db, cfg);
    expect(loaded.dynamicBudgetTokens).toBe(2048);
  });

  it('4. writer slot_key conflicts in confirmMemory/restoreMemory and frozen protection in invalidateMemory', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/slot-test');

    // Create candidate c1 on slot_key 'env.node'
    const c1 = upsertCandidate(db, {
      type: 'semantic',
      content: 'Node.js 版本要求 >= 22.0.0',
      slot_key: 'env.node',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'assistant',
      origin_kinds: ['assistant'],
      confidence: 0.7,
      status: 'candidate',
      sources: [{ session_id: 's1', seq: 1, kind: 'assistant' }],
      actor: 'llm',
    });
    expect('id' in c1).toBe(true);
    const c1Id = (c1 as any).id;

    // Create active m2 on the same slot_key 'env.node'
    const m2 = upsertCandidate(db, {
      type: 'semantic',
      content: 'Node.js 版本要求 >= 24.0.0',
      slot_key: 'env.node',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.9,
      status: 'active',
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'user',
    });
    const m2Id = (m2 as any).id;

    // Confirming c1 should supersede m2 without throwing SQLITE_CONSTRAINT_UNIQUE
    const confRes = confirmMemory(db, c1Id, 'user');
    expect(confRes.success).toBe(true);

    // Freeze c1 and verify invalidateMemory rejects frozen memory
    freeze(db, c1Id, 'user');
    const invFrozen = invalidateMemory(db, c1Id, 'try invalidate frozen', 'user');
    expect(invFrozen).toBe(false);

    // Restoring m2 while c1 is frozen on the same slot should fail gracefully
    const restWhileFrozen = restoreMemory(db, m2Id, 'user');
    expect(restWhileFrozen.success).toBe(false);

    // Unfreeze c1, then restoring m2 should succeed and supersede c1
    unfreeze(db, c1Id, 'user');
    const restOk = restoreMemory(db, m2Id, 'user');
    expect(restOk.success).toBe(true);
  });

  it('5. markdown Memory Bank export/import round-trip preserves type, slot_key, and clean content', () => {
    const db1 = openDb(':memory:');
    const ws = workspaceId('/project/md-roundtrip');
    upsertCandidate(db1, {
      type: 'procedural',
      content: '部署前必须先执行 npm run typecheck 与 npm test',
      summary: '部署前检查流程',
      slot_key: 'deploy.check',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.95,
      importance: 9,
      status: 'active',
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-roundtrip-'));
    try {
      exportMemoryBank(db1, tmpDir, { workspaceId: ws });

      const db2 = openDb(':memory:');
      const imp = importMemoryBank(db2, tmpDir, { workspaceId: ws });
      expect(imp.imported).toBeGreaterThanOrEqual(1);

      const items = list(db2, { workspaceId: ws, status: 'active' });
      const proc = items.find((m) => m.slot_key === 'deploy.check');
      expect(proc).toBeDefined();
      expect(proc?.type).toBe('procedural');
      expect(proc?.content).not.toContain('- **ID**:');
      expect(proc?.content).not.toContain('- **槽位**:');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. store.list, health audit, and getGraphData handle user/global scope and NaN limit', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/scope-test');
    upsertCandidate(db, {
      type: 'preference',
      content: '用户偏好中文简洁回复',
      scope: 'user',
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.95,
      status: 'active',
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    const listed = list(db, { workspaceId: ws });
    expect(listed.length).toBe(1);
    expect(listed[0].scope).toBe('user');

    const health = auditMemoryHealth(db, { workspaceId: ws });
    expect(health.counts.active).toBe(1);

    const graph = getGraphData(db, { workspaceId: ws, limit: Number.NaN });
    expect(graph.nodes.length).toBe(1);
  });

  it('7. query parser preserves valid CJK compounds (目的/几何/了解/正确) and parses 前几天/这几天', () => {
    const now = new Date('2026-11-07T12:00:00Z').getTime();
    const tr = parseTimeRange('前几天讨论的数据库方案是什么', now);
    expect(tr).toBeDefined();
    expect(tr!.from).toBe(now - 7 * 86400_000);

    const plan = buildQueryPlan({
      userText: '了解项目的几何算法目的与正确性',
      now,
    });
    expect(plan.tokens).toContain('目的');
    expect(plan.tokens).toContain('几何');
    expect(plan.tokens).toContain('了解');
    expect(plan.tokens).toContain('正确');
  });

  it('8. outcome analyzer avoids false-positive confirmation on 不可以/nothing works and false-positive correction on questions', () => {
    expect(CONFIRMATION_REGEX.test('不可以，这样还是报错')).toBe(false);
    expect(CORRECTION_REGEX.test('不可以，这样还是报错')).toBe(true);
    expect(CONFIRMATION_REGEX.test('nothing works after this change')).toBe(false);

    const db = openDb(':memory:');
    const res = evaluateTurnOutcome(
      db,
      {
        sessionId: 'sess_q',
        turn: 1,
        nextUserMessage: '这是不是因为环境变量没有加载？',
      },
      DEFAULTS
    );
    expect(res.isCorrection).toBe(false);
    expect(res.outcome).toBeGreaterThanOrEqual(0);
  });

  it('9. evaluateTurnOutcome harvests positive samples with populated setup memories', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/harvest');
    const ins = upsertCandidate(db, {
      type: 'semantic',
      content: 'Redis 缓存过期时间统一设置为 3600 秒',
      summary: 'Redis 缓存 TTL 3600s',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.9,
      status: 'active',
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const memId = (ins as any).id;

    // Insert raw_events and injection for turn 1 so attribution weight >= 0.4 and r === 1.0
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed)
       VALUES ('s1', 1, ?, 'message', 1000, 1, 'user', 'user', 0, 'Redis 缓存过期时间设置多少', 1),
              ('s1', 2, ?, 'message', 1001, 1, 'assistant', 'assistant', 0, 'Redis 缓存过期时间统一设置为 3600 秒', 1)`,
      [ws, ws]
    );
    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES ('s1', 1, ?, 1, 'dynamic', 1, 20, 'content', 1, 1000)`,
      [memId]
    );

    const evalRes = evaluateTurnOutcome(
      db,
      {
        sessionId: 's1',
        turn: 1,
        nextUserMessage: '完美，解决了！',
        cwd: ws,
      },
      DEFAULTS
    );
    expect(evalRes.outcome).toBe(1.0);
    const row = db.get<{ payload: string }>(`SELECT payload FROM eval_cases WHERE suite = 'harvested' LIMIT 1`);
    expect(row).toBeDefined();
    const sample = JSON.parse(row!.payload);
    expect(Array.isArray(sample.setup)).toBe(true);
    expect(sample.setup.length).toBe(1);
    expect(sample.setup[0].content).toContain('Redis 缓存过期时间统一设置为 3600 秒');
  });

  it('10. strategy cache is isolated per Db instance via WeakMap', () => {
    const db1 = openDb(':memory:');
    const db2 = openDb(':memory:');
    initDefaultStrategy(db1);
    initDefaultStrategy(db2);
    const s1Init = getActiveStrategy(db1);
    // Modify db2's strategy row before getActiveStrategy(db2) caches it (or clear and reload)
    const customStrat = { ...s1Init.config, rrfK: 99 };
    db2.run(`UPDATE strategies SET config = ? WHERE version = 1`, [JSON.stringify(customStrat)]);
    // Create a fresh db3 with custom rrfK in DB before first getActiveStrategy call
    const db3 = openDb(':memory:');
    db3.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (1, ?, 'active', NULL, NULL, 1000, 1000)`,
      [JSON.stringify(customStrat)]
    );
    const s1 = getActiveStrategy(db1);
    const s3 = getActiveStrategy(db3);
    expect(s1.config.rrfK).toBe(60);
    expect(s3.config.rrfK).toBe(99);
  });

  it('11. MemoryTools.expand records tool injection so cross-turn MemoryTools.feedback succeeds', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/tools-expand-feedback');
    const ins = upsertCandidate(db, {
      type: 'semantic',
      content: 'ClickHouse 分区键按 toYYYYMM(event_time) 设计',
      summary: 'ClickHouse 分区键设计',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.9,
      status: 'active',
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const memId = (ins as any).id;
    const tools = new MemoryTools({ db });

    // Expand at turn 1
    const expOut = tools.expand({ id: memId }, { workspaceId: ws, sessionId: 'sess_fb', turn: 1 });
    expect(expOut).toContain('ClickHouse');

    // Feedback at turn 3 (cross-turn)
    const fbOut = tools.feedback(
      { id: memId, contentRev: 1, helpful: true },
      { sessionId: 'sess_fb', turn: 3 }
    );
    expect(fbOut).toBe('ok');

    const inj = db.get<{ outcome: number; used: number }>(
      `SELECT outcome, used FROM injections WHERE session_id = 'sess_fb' AND memory_id = ?`,
      [memId]
    );
    expect(inj?.outcome).toBe(1);
    expect(inj?.used).toBe(1);
  });

  it('12. handlePreStep freezes injected message objects according to DSH §A.6.3 contract', async () => {
    const db = openDb(':memory:');
    const ws = workspaceId('prestep-freeze-ws');
    upsertCandidate(db, {
      type: 'semantic',
      content: '微服务间 RPC 通信统一使用 gRPC + Protobuf v3',
      summary: 'gRPC + Protobuf v3 通信规范',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      origin_kinds: ['user'],
      confidence: 0.95,
      status: 'active',
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    const promptSections = new PromptSectionManager(db);
    const userMsg = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '微服务 RPC 通信用什么协议？' }],
      source: { kind: 'user' },
    };
    const payload = {
      sessionId: 'sess_freeze',
      turn: 1,
      step: 0,
      agent: {
        id: 'test_agent',
        cwd: ws,
        session: { id: 'sess_freeze', cwd: ws },
        ctx: { systemPrompt: { section: () => () => {} } },
      },
    };
    const decision = await handlePreStep(
      payload,
      async () => ({ kind: 'enter', messages: [userMsg] }),
      { db, promptSections }
    );
    expect(decision.messages.length).toBe(2);
    const injectedMsg = decision.messages[1];
    expect(Object.isFrozen(injectedMsg)).toBe(true);
    expect(Object.isFrozen(injectedMsg.content)).toBe(true);
    expect(Object.isFrozen(injectedMsg.content[0])).toBe(true);
    expect(Object.isFrozen(injectedMsg.source)).toBe(true);
    expect(Object.isFrozen(injectedMsg.source.memoryRefs)).toBe(true);
  });
});
