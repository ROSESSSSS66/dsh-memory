import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { PromptSectionManager } from '../../src/dsh/prompt-section.js';
import { handlePreStep } from '../../src/dsh/pre-step.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { visibilityHarness } from '../helpers/visibility.js';

describe('Pre-Step Waterfall Injection (pre-step.ts)', () => {
  let db: Db;
  let promptSections: PromptSectionManager;
  let visibility: ReturnType<typeof visibilityHarness>;
  const ws1 = workspaceId('test-ws-prestep');
  const sess1 = 'sess_prestep_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
    promptSections = new PromptSectionManager(db);
    visibility = visibilityHarness(db);
  });
  afterEach(async () => {
    await visibility.close();
    db.close();
  });

  it('在同一个会话里连续问 5 个与数据库相关的问题 → 同一条记忆只注入一次 (验收项 4)', async () => {
    const insertRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库为 PostgreSQL 16 稳定版',
        summary: '数据库版本配置',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    expect(insertRes.action).toBe('inserted');
    const memId = (insertRes as any).id;

    const questions = [
      '我的数据库是什么版本？',
      '数据库连接池怎么配置？',
      '数据库支持读写分离吗？',
      '怎么备份数据库？',
      '数据库端口是多少？',
    ];

    let currentMessages: any[] = [];

    for (let turn = 1; turn <= 5; turn++) {
      const q = questions[turn - 1];
      const payload = {
        sessionId: sess1,
        turn,
        step: 0,
        agent: {
          id: 'test_agent',
          cwd: ws1,
          session: { id: sess1, cwd: ws1 },
          ctx: { systemPrompt: { section: () => () => {} } },
        },
      };

      const userMsg = {
        id: `user_msg_${turn}`,
        role: 'user',
        content: [{ type: 'text', text: q }],
        source: { kind: 'user' },
      };

      const next = async () => ({
        kind: 'enter',
        messages: [userMsg],
      });

      const decision = await handlePreStep(payload, next, {
        db,
        promptSections,
        getVisibleRefs: visibility.getVisibleRefs,
      });

      expect(decision.kind).toBe('enter');
      currentMessages = decision.messages;
      for (const message of currentMessages.filter((m) => m.source?.plugin === 'dsh-memory')) {
        await visibility.commitEvent(payload.agent.session, {
          type: 'user/message',
          seq: turn * 10,
          data: message,
          surfaceOp: { op: 'append' },
        });
      }
    }

    const rows = db.all<{ memory_id: string; turn: number }>(
      'SELECT memory_id, turn FROM injections WHERE session_id = ? AND memory_id = ?',
      [sess1, memId]
    );

    expect(rows.length).toBe(1);
    expect(rows[0].turn).toBe(1);
  });

  it('实际提交消息 source.memoryRefs 包含完整 id/正文版本 (验收项 6)', async () => {
    const insertRes = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: 'API 超时排查步骤：先调整超时时间到 180s',
        summary: 'API 超时解决步骤',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (insertRes as any).id;

    const payload = {
      sessionId: sess1,
      turn: 1,
      step: 0,
      agent: {
        id: 'test_agent',
        cwd: ws1,
        session: { id: sess1, cwd: ws1 },
        ctx: { systemPrompt: { section: () => () => {} } },
      },
    };

    const userMsg = {
      id: 'msg_001',
      role: 'user',
      content: [{ type: 'text', text: 'API 超时怎么办' }],
      source: { kind: 'user' },
    };

    const decision = await handlePreStep(
      payload,
      async () => ({
        kind: 'enter',
        messages: [userMsg],
      }),
      {
        db,
        promptSections,
      }
    );

    expect(decision.messages.length).toBe(2);
    const injected = decision.messages[1];
    expect(injected.role).toBe('user');
    expect(injected.source.kind).toBe('dsh-memory');
    expect(injected.source.plugin).toBe('dsh-memory');
    expect(Array.isArray(injected.source.memoryRefs)).toBe(true);
    expect(injected.source.memoryRefs.length).toBe(1);
    expect(injected.source.memoryRefs[0]).toEqual({
      id: memId,
      contentRev: 1,
    });
  });

  it('accumulates all real user messages, skips flushIngest/updateSection on tool-only steps, and does not fall back to process.cwd()', async () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'RabbitMQ exchange uses topic routing for billing events.',
        summary: 'RabbitMQ billing routing',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    // Seed a memory in process.cwd() to prove pre-step NEVER leaks process.cwd() when cwd is absent
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Host process cwd secret deployment key marker xyz987.',
        summary: 'Host cwd secret marker xyz987',
        scope: 'workspace',
        workspaceId: workspaceId(process.cwd()),
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 'other', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    // 1. Intermediate tool-only step (no real user message): must NOT call flushIngest or updateSection
    const flushSpy = vi.fn(async () => 0);
    const updateSpy = vi.spyOn(promptSections, 'updateSection');
    const toolOnlyDec = await handlePreStep(
      {
        sessionId: sess1,
        turn: 1,
        agent: { id: 'a1', cwd: ws1, session: { id: sess1, cwd: ws1 } },
      },
      async () => ({
        kind: 'enter',
        messages: [{ id: 'tool-1', role: 'tool', toolName: 'read', content: 'ok' }],
      }),
      { db, promptSections, flushIngest: flushSpy }
    );
    expect(toolOnlyDec.messages).toHaveLength(1);
    expect(flushSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();

    // 2. Multiple user messages in the same batch: BOTH earlier and later text must be included in query
    const multiMsgDec = await handlePreStep(
      {
        sessionId: sess1,
        turn: 1,
        agent: { id: 'a1', cwd: ws1, session: { id: sess1, cwd: ws1 } },
      },
      async () => ({
        kind: 'enter',
        messages: [
          {
            id: 'u1',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Check RabbitMQ billing exchange routing' }],
          },
          {
            id: 'u2',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Please summarize briefly' }],
          },
        ],
      }),
      { db, promptSections }
    );
    expect(multiMsgDec.messages).toHaveLength(3);
    expect(multiMsgDec.messages[2].content[0].text).toContain('RabbitMQ');

    // 3. Absent cwd without session_workspace_owners must NOT leak process.cwd() workspace memories
    const noCwdDec = await handlePreStep(
      {
        sessionId: 'sess_no_cwd',
        turn: 1,
        agent: { id: 'a_nocwd', session: { id: 'sess_no_cwd' } },
      },
      async () => ({
        kind: 'enter',
        messages: [
          {
            id: 'u3',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Host process cwd secret marker xyz987' }],
          },
        ],
      }),
      { db, promptSections }
    );
    expect(noCwdDec.messages).toHaveLength(1);
  });

  it('defers 1-based prior turn evaluation asynchronously only when turn > 1', async () => {
    const ins = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Elasticsearch index uses daily rotation.',
        summary: 'Elasticsearch daily rotation',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (ins as any).id;

    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES (?, 1, ?, 1, 'dynamic', 1, 20, 'content', 1, ?)`,
      [sess1, memId, fixedNow]
    );

    await handlePreStep(
      {
        sessionId: sess1,
        turn: 2,
        agent: { id: 'a_eval', cwd: ws1, session: { id: sess1, cwd: ws1 } },
      },
      async () => ({
        kind: 'enter',
        messages: [
          {
            id: 'u_turn2',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: '完美，解决了！' }],
          },
        ],
      }),
      { db, promptSections }
    );

    // Flush microtask queue so deferred evaluateTurnOutcome completes
    await new Promise((r) => setTimeout(r, 10));
    const inj = db.get<{ outcome: number | null }>(
      'SELECT outcome FROM injections WHERE session_id = ? AND turn = 1 AND memory_id = ?',
      [sess1, memId]
    );
    expect(inj?.outcome).toBe(1);
  });

  it('临时数据库异常时优雅降级，不阻断对话 (验收项 5)', async () => {
    const brokenDb = {
      ...db,
      all: () => {
        throw new Error('Database is locked or corrupted');
      },
    };

    const payload = {
      sessionId: sess1,
      turn: 1,
      step: 0,
      agent: {
        id: 'test_agent',
        cwd: ws1,
        session: { id: sess1, cwd: ws1 },
      },
    };

    const userMsg = {
      id: 'msg_001',
      role: 'user',
      content: [{ type: 'text', text: '数据库是什么？' }],
      source: { kind: 'user' },
    };

    const decision = await handlePreStep(
      payload,
      async () => ({
        kind: 'enter',
        messages: [userMsg],
      }),
      {
        db: brokenDb as any,
        promptSections,
      }
    );

    expect(decision.kind).toBe('enter');
    expect(decision.messages).toEqual([userMsg]);
  });
});
