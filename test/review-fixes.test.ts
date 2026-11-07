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
  forget,
  confirmMemory,
  invalidateMemory,
  restoreMemory,
} from '../src/core/writer.js';
import { exportMemoryBank, importMemoryBank } from '../src/core/markdown.js';
import { auditMemoryHealth, autoHealMemoryHealth } from '../src/core/health.js';
import { get, list, getGraphData } from '../src/core/store.js';
import { workspaceId } from '../src/core/scope.js';
import { buildQueryPlan, parseTimeRange } from '../src/retrieval/query.js';
import { evaluateTurnOutcome, CORRECTION_REGEX, CONFIRMATION_REGEX } from '../src/evolution/outcome.js';
import { getActiveStrategy, initDefaultStrategy } from '../src/evolution/strategy.js';
import { MemoryTools } from '../src/dsh/tools.js';
import { handlePreStep } from '../src/dsh/pre-step.js';
import { PromptSectionManager } from '../src/dsh/prompt-section.js';
import { runRules } from '../src/ingest/rules.js';
import { runReflectJob } from '../src/evolution/reflector.js';
import { distillSession } from '../src/evolution/extractor.js';
import { curateMemoriesWithLLM, pruneInvalidMemories } from '../src/evolution/maintenance.js';
import { parseOutput } from '../src/evolution/parse.js';

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

  it('13. R4 reflect:failure_sig job includes sessionId/turn and runReflectJob executes cleanly', async () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/r4-reflect');
    const now = Date.now();

    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
       VALUES ('sess_a', 1, ?, 'tool_result', ?, 1, 'tool', 'tool', 'bash', 1, 'Command failed: EACCES permission denied /var/run/docker.sock', 0),
              ('sess_b', 1, ?, 'tool_result', ?, 2, 'tool', 'tool', 'bash', 1, 'Command failed: EACCES permission denied /var/run/docker.sock', 0)`,
      [ws, now, ws, now + 100]
    );

    const evA = db.get<any>(`SELECT * FROM raw_events WHERE session_id = 'sess_a' AND seq = 1`);
    const evB = db.get<any>(`SELECT * FROM raw_events WHERE session_id = 'sess_b' AND seq = 1`);
    runRules(db, evA, DEFAULTS, now);
    runRules(db, evB, DEFAULTS, now + 100);

    const jobRow = db.get<any>(`SELECT * FROM jobs WHERE kind = 'reflect' AND key LIKE 'reflect:failure_sig:%'`);
    expect(jobRow).toBeDefined();
    const payload = JSON.parse(jobRow.payload);
    expect(payload.sessionId).toBe('sess_b');
    expect(payload.turn).toBe(2);
    expect(payload.signalKind).toBe('repeated_tool_failure');

    const mockCfg = validateConfig({
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['http://localhost:11434'],
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'http://localhost:11434/v1',
        model: 'test-model',
        apiKeyEnv: '',
      },
    } as any);

    const mockFetch: any = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    type: 'failure',
                    text: '调用 bash 访问 docker.sock 权限不足时应检查用户组权限',
                    summary: 'docker.sock 权限不足排错',
                    scope: 'workspace',
                    confidence: 0.85,
                    evidence: [{ seq: 1, quote: 'EACCES permission denied' }],
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 40 },
      }),
    });

    const jobRes = await runReflectJob(db, mockCfg, jobRow, undefined, mockFetch);
    expect(jobRes.action).toBe('done');
  });

  it('14. autoHealMemoryHealth enforces trust boundary against web and raw rule tool candidates', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/trust-boundary');
    const now = Date.now();

    const webCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '外部网页抓取的未经验证配置说明文档',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'web',
        origin_kinds: ['web'],
        confidence: 0.9,
        status: 'candidate',
        sources: [{ session_id: 's1', seq: 1, kind: 'web' }],
        actor: 'llm',
      },
      now
    );

    const ruleToolCand = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '工具 bash 执行失败: exit code <NUM>',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'rule',
        origin_kinds: ['tool'],
        confidence: 0.5,
        status: 'candidate',
        sources: [{ session_id: 's1', seq: 2, kind: 'tool_result' }],
        actor: 'rule',
      },
      now + 10
    );

    const verifiedCand = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '经过离线提炼验证的标准部署检查流水线步骤',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'assistant',
        origin_kinds: ['user', 'assistant'],
        confidence: 0.85,
        status: 'candidate',
        sources: [{ session_id: 's1', seq: 3, kind: 'user_msg' }],
        actor: 'llm',
      },
      now + 20
    );

    const heal = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 100 });
    expect(heal.candidatesPromoted).toBe(1);
    expect(get(db, (webCand as any).id)?.status).toBe('candidate');
    expect(get(db, (ruleToolCand as any).id)?.status).toBe('candidate');
    expect(get(db, (verifiedCand as any).id)?.status).toBe('active');
  });

  it('15. upsertCandidate reactivates archived or superseded memories when user explicitly re-asserts them', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/reactivate');
    const now = Date.now();

    const res1 = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '构建脚本统一使用 pnpm build 执行',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 1.0,
        status: 'active',
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      now
    );
    const id = (res1 as any).id;
    expect(get(db, id)?.status).toBe('active');

    // User forgets it -> archived
    forget(db, id, 'user', now + 100);
    expect(get(db, id)?.status).toBe('archived');

    // User explicitly states the exact same preference again (even with same or new source)
    const res2 = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '构建脚本统一使用 pnpm build 执行',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 1.0,
        status: 'active',
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      now + 200
    );
    expect(res2.action).toBe('merged');
    expect(get(db, id)?.status).toBe('active');
    expect(get(db, id)?.valid_to).toBeNull();
  });

  it('16. parseOutput accepts <workspace> anonymized quotes when matching raw ledger excerpts', () => {
    const ledger = new Map();
    ledger.set(1, {
      seq: 1,
      original_seq: 1,
      session_id: 's1',
      kind: 'user_msg',
      origin_kinds: ['user'],
      redacted_text: '配置文件位于 /Users/alice/secret-proj/config/app.json 目录中',
      time: Date.now(),
    });

    const rawJson = JSON.stringify({
      items: [
        {
          type: 'semantic',
          text: '应用配置文件位于 <workspace>/config/app.json',
          summary: '应用配置文件路径',
          scope: 'workspace',
          confidence: 0.9,
          evidence: [
            {
              seq: 1,
              quote: '配置文件位于 <workspace>/config/app.json 目录中',
            },
          ],
        },
      ],
    });

    const parsed = parseOutput(rawJson, {
      taskKind: 'distill',
      evidenceLedger: ledger,
      workspaceId: workspaceId('/Users/alice/secret-proj'),
      sessionId: 's1',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.items.length).toBe(1);
    }
  });

  it('17. distillSession and curateMemoriesWithLLM autonomously update memories and discard invalid ones via LLM', async () => {
    const db = openDb(':memory:');
    const ws = workspaceId('/project/llm-auto-curate');
    const now = Date.now();

    // 1. Insert an old active memory (to be superseded via supersedes_id) and an invalid noisy memory (to be discarded via discard_ids)
    const oldMem = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目网关默认监听端口为 3000',
        slot_key: 'project.gateway.port',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        status: 'active',
        sources: [{ session_id: 's0', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      now
    );
    const oldId = (oldMem as any).id;

    const noisyMem = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '刚才临时测试了一下健康检查接口返回 200',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'llm_extract',
        origin_kinds: ['assistant'],
        confidence: 0.6,
        status: 'active',
        sources: [{ session_id: 's0', seq: 2, kind: 'assistant_msg' }],
        actor: 'llm',
      },
      now + 5
    );
    const noisyId = (noisyMem as any).id;

    // 2. Insert session events for distillSession
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed)
       VALUES ('s_distill', 1, ?, 'user', ?, 1, 'user', 'user', 0, '我们已经把网关默认监听端口统一升级为 8080 了，旧的 3000 端口彻底停用。', 0)`,
      [ws, now + 20]
    );

    const mockCfg = validateConfig({
      distillMinEvents: 1,
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['http://localhost:11434'],
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'http://localhost:11434/v1',
        model: 'test-model',
        apiKeyEnv: '',
      },
    } as any);

    const distillFetch: any = async (_url: string, init: any) => {
      const bodyStr = String(init?.body || '');
      // Verify existing workspace memories were injected into distill prompt
      expect(bodyStr).toContain('EXISTING WORKSPACE MEMORIES');
      expect(bodyStr).toContain(oldId);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      type: 'semantic',
                      text: '项目网关默认监听端口已统一升级为 8080。',
                      slot_key: 'project.gateway.port',
                      supersedes_id: oldId,
                      confidence: 0.92,
                      scope: 'workspace',
                      evidence: [
                        {
                          seq: 1,
                          quote: '把网关默认监听端口统一升级为 8080',
                        },
                      ],
                    },
                  ],
                  discard_ids: [noisyId],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 60 },
        }),
      };
    };

    const distillRes = await distillSession(db, mockCfg, {
      sessionId: 's_distill',
      fetchFn: distillFetch,
      isIdle: true,
    });
    expect(distillRes.success).toBe(true);
    expect(distillRes.itemsCreated).toBe(1);
    expect(distillRes.itemsUpdated).toBe(1);
    expect(distillRes.itemsDiscarded).toBe(1);

    // Old memory is superseded, noisy memory is rejected/archived, new memory is auto-activated
    expect(get(db, oldId)?.status).toBe('superseded');
    expect(['archived', 'rejected']).toContain(get(db, noisyId)?.status);
    const newId = distillRes.candidateIds![0];
    expect(get(db, newId)?.status).toBe('active');
    expect(get(db, newId)?.content).toContain('8080');

    // 3. Test curateMemoriesWithLLM (deterministic prune + LLM discard + LLM in-place update/absorb)
    const transientNoise = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '请帮我写一个临时测试脚本看看输出',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'llm_extract',
        origin_kinds: ['user'],
        confidence: 0.6,
        status: 'candidate',
        sources: [{ session_id: 's2', seq: 1, kind: 'user_msg' }],
        actor: 'llm',
      },
      now + 100
    );

    const invalidCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '刚才控制台打印了一段临时调试日志',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'llm_extract',
        origin_kinds: ['assistant'],
        confidence: 0.55,
        status: 'candidate',
        sources: [{ session_id: 's2', seq: 2, kind: 'assistant_msg' }],
        actor: 'llm',
      },
      now + 110
    );

    const dupMem = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '网关监听在 8080 端口，支持 HTTP/2 协议',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'llm_extract',
        origin_kinds: ['user'],
        confidence: 0.8,
        status: 'candidate',
        sources: [{ session_id: 's2', seq: 3, kind: 'user_msg' }],
        actor: 'llm',
      },
      now + 120
    );

    const curateFetch: any = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                discard_ids: [(invalidCand as any).id],
                updates: [
                  {
                    target_id: newId,
                    absorb_ids: [(dupMem as any).id],
                    type: 'semantic',
                    text: '项目网关默认监听端口为 8080，并启用 HTTP/2 协议支持。',
                    slot_key: 'project.gateway.port',
                    confidence: 0.95,
                  },
                ],
                reason: 'Discarded transient log and merged HTTP/2 gateway detail',
              }),
            },
          },
        ],
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      }),
    });

    const curateRes = await curateMemoriesWithLLM(db, mockCfg, {
      workspaceId: ws,
      fetchFn: curateFetch,
      now: now + 200,
    });
    expect(curateRes.ok).toBe(true);
    expect(curateRes.deterministicPruned).toBe(1);
    expect(curateRes.llmDiscarded).toBe(1);
    expect(curateRes.llmUpdated).toBe(1);

    expect(get(db, (transientNoise as any).id)?.status).toBe('rejected');
    expect(get(db, (invalidCand as any).id)?.status).toBe('rejected');
    expect(get(db, (dupMem as any).id)?.status).toBe('superseded');
    expect(get(db, newId)?.content).toBe('项目网关默认监听端口为 8080，并启用 HTTP/2 协议支持。');
  });
});
