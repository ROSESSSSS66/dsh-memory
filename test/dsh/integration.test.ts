import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { apply } from '../../src/dsh/plugin.js';
import { SessionListener } from '../../src/dsh/session-listener.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { PromptSectionManager } from '../../src/dsh/prompt-section.js';
import { handlePreStep } from '../../src/dsh/pre-step.js';
import { MemoryCommands } from '../../src/dsh/commands.js';

describe('M2-T3 End-to-End Acceptance Integration', () => {
  let db: Db;
  let queue: IngestQueue;
  let listener: SessionListener;
  let promptSections: PromptSectionManager;
  let commands: MemoryCommands;

  const ws = workspaceId('test-ws-m2t3');
  const sess1 = 'session_one_id_1111';
  const sess2 = 'session_two_id_2222';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
    queue = new IngestQueue(db);
    listener = new SessionListener(queue);
    promptSections = new PromptSectionManager(db);
    commands = new MemoryCommands(db);
  });

  it('完整执行 M2-T3 核心验收流程 (验收项 1, 2, 3, 4, 6, 7)', async () => {
    // 步骤 1: 会话 1 中说 "记住：我的项目数据库是 PostgreSQL 16"
    // 模拟 session 1 的用户消息事件流
    listener.handleEvent(
      { id: sess1, cwd: ws },
      {
        type: 'user/message',
        seq: 1,
        time: fixedNow,
        data: {
          turn: 1,
          source: { kind: 'user' },
          content: [{ type: 'text', text: '记住：我的项目数据库是 PostgreSQL 16' }],
        },
      }
    );

    // 摄入并消费队列
    queue.flush();

    // 验证规则抽取器 R1 成功生成 active 状态的记忆与 slot_key = project.database
    const mem = db.get<{ id: string; status: string; slot_key: string; content: string }>(
      'SELECT id, status, slot_key, content FROM memories WHERE content LIKE ?',
      ['%PostgreSQL 16%']
    );
    expect(mem).toBeDefined();
    expect(mem?.status).toBe('active');
    expect(mem?.slot_key).toBe('project.database');
    const memoryId = mem!.id;

    // 步骤 2: 新建会话 2，问 "我的数据库是什么版本？"
    // 模拟 session 2 的 pre-step waterfall 注入
    const sess2UserMsg = {
      id: 'sess2_msg_001',
      role: 'user',
      content: [{ type: 'text', text: '我的数据库是什么版本？' }],
      source: { kind: 'user' },
    };

    const sess2Payload = {
      sessionId: sess2,
      turn: 1,
      step: 0,
      agent: {
        id: 'agent_sess2',
        cwd: ws,
        session: { id: sess2, cwd: ws },
        ctx: { systemPrompt: { section: () => () => {} } },
      },
    };

    const next1 = async () => ({
      kind: 'enter',
      messages: [sess2UserMsg],
    });

    const decision1 = await handlePreStep(sess2Payload, next1, {
      db,
      promptSections,
    });

    // 模型消息应看到 memory_context 块，且包含 PostgreSQL 16
    expect(decision1.messages.length).toBe(2);
    const injectedMsg = decision1.messages[1];
    expect(injectedMsg.role).toBe('user');
    expect(injectedMsg.source.kind).toBe('plugin');
    expect(injectedMsg.source.plugin).toBe('dsh-memory');
    expect(injectedMsg.content[0].text).toContain('<memory_context');
    expect(injectedMsg.content[0].text).toContain('PostgreSQL 16');

    // 验收项 6: 检查 source.memoryRefs 包含完整 id 与 contentRev
    expect(injectedMsg.source.memoryRefs).toEqual([
      { id: memoryId, contentRev: 1 },
    ]);

    // 步骤 3: /memory stats 和 /memory inspect <id> 的输出正确，并且包含来源 session
    const statsOutput = commands.stats({ workspaceId: ws, sessionId: sess2 });
    expect(statsOutput).toContain('记忆总数 1');
    expect(statsOutput).toContain('active 1');

    const inspectOutput = commands.inspect(memoryId, { workspaceId: ws, sessionId: sess2 });
    expect(inspectOutput).toContain(`ID: ${memoryId}`);
    expect(inspectOutput).toContain('PostgreSQL 16');
    // 必须包含来源 session (sess1)
    expect(inspectOutput).toContain(sess1);

    // 步骤 4: 在同一个会话里连续问 5 个与数据库相关的问题 → 同一条记忆只注入一次
    const followupQuestions = [
      '数据库端口是多少？',
      '怎么配置数据库备份？',
      '数据库连接超时怎么办？',
      '数据库表结构有吗？',
    ];

    for (let i = 0; i < followupQuestions.length; i++) {
      const q = followupQuestions[i];
      const payload = {
        sessionId: sess2,
        turn: i + 2,
        step: 0,
        agent: {
          id: 'agent_sess2',
          cwd: ws,
          session: { id: sess2, cwd: ws },
          ctx: { systemPrompt: { section: () => () => {} } },
        },
      };

      const userMsg = {
        id: `sess2_msg_${i + 2}`,
        role: 'user',
        content: [{ type: 'text', text: q }],
        source: { kind: 'user' },
      };

      const dec = await handlePreStep(payload, async () => ({
        kind: 'enter',
        messages: [userMsg],
      }), {
        db,
        promptSections,
      });

      // 因为上一轮已经注入过 memoryId@1，后续问题不重复追加该记忆
      expect(dec.messages.length).toBe(1);
    }

    // 验证 injections 表中 session 2 仅有 1 次该记忆注入记录
    const injections = db.all<{ memory_id: string }>(
      'SELECT memory_id FROM injections WHERE session_id = ? AND memory_id = ?',
      [sess2, memoryId]
    );
    expect(injections.length).toBe(1);
  });

  it('验收项 5: 临时把数据库文件改名，让插件无法打开 → 插件初始化优雅降级，DSH 照常对话', () => {
    // 传递一个指向无效/无权限目录的 dbPath 模拟无法打开
    const mockCtx = {
      tools: { register: () => {} },
      commands: { register: () => {} },
      on: () => {},
    };

    // apply 应正常捕获并打印降级提示，不抛出异常
    expect(() => {
      apply(mockCtx, {
        dbPath: 'Z:\\invalid_drive_path_cannot_open\\memory.db',
      });
    }).not.toThrow();
  });
});
