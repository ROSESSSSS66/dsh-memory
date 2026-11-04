import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { distillSession } from '../../src/evolution/extractor.js';
import type { Db, MemoryRecord } from '../../src/types.js';

describe('Extractor (M3-T3)', () => {
  let db: Db;
  let cfg: PluginConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = {
      ...DEFAULTS,
      distillMinEvents: 3,
      distillMaxInputTokens: 6000,
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.deepseek.com'],
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
      },
    };
  });

  function insertEvents(sessionId: string, count: number, startSeq = 1): void {
    for (let i = 0; i < count; i++) {
      const seq = startSeq + i;
      db.run(
        `INSERT INTO raw_events (
          session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed
        ) VALUES (?, ?, ?, 'user/message', ?, 1, 'user', 'user', ?, 0)`,
        [sessionId, seq, 'ws_demo', 1000 + seq * 10, `User message line number ${seq}: pnpm build && pnpm test`]
      );
    }
  }

  it('produces candidate memories using genuine Appendix B-1 fixtures (3份真实fixture)', async () => {
    insertEvents('s1', 5);

    // 3份不同类型的符合 B-1 规范的合法记忆
    const fixtureResponse = {
      items: [
        {
          type: 'procedural',
          text: '在本项目中运行测试之前必须先执行 pnpm build，以生成最新的构建产物。',
          slot_key: 'build-before-test',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'pnpm build && pnpm test' }],
        },
        {
          type: 'semantic',
          text: '当前项目配置的包管理器为 pnpm。',
          slot_key: 'project.package-manager',
          confidence: 0.85,
          scope: 'workspace',
          evidence: [{ seq: 2, quote: 'pnpm build && pnpm test' }],
        },
        {
          type: 'goal',
          text: '当前目标是完成单元测试并通过 CI 流程。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 3, quote: 'pnpm build && pnpm test' }],
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fixtureResponse) } }],
          usage: { prompt_tokens: 300, completion_tokens: 150 },
        }),
        { status: 200 }
      );
    };

    const res = await distillSession(db, cfg, {
      sessionId: 's1',
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(true);
    expect(res.itemsCreated).toBe(3);
    expect(res.consumedCount).toBe(5);

    // 验证记忆表落盘
    const memories = db.all<MemoryRecord>("SELECT * FROM memories WHERE status = 'candidate'");
    expect(memories).toHaveLength(3);

    // 验证事件 processed 更新为 2
    const unprocessed = db.all("SELECT * FROM raw_events WHERE session_id = 's1' AND processed < 2");
    expect(unprocessed).toHaveLength(0);

    // 验证 watermark 写入 meta
    const watermark = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'distill:s1'");
    expect(watermark).toBeDefined();
    const parsedMeta = JSON.parse(watermark!.value);
    expect(parsedMeta.lastSeq).toBe(5);
  });

  it('discards items citing invalid quotes, non-existent seqs, or redacted tokens', async () => {
    insertEvents('s2', 3);

    const badResponse = {
      items: [
        {
          type: 'semantic',
          text: '有效文本描述内容必须大于八个字符。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 999, quote: 'valid length quote here' }], // 不存在的 seq
        },
        {
          type: 'semantic',
          text: '有效文本描述内容必须大于八个字符。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'this text does not exist in event 1' }], // 虚假 quote
        },
        {
          type: 'semantic',
          text: '有效文本描述内容必须大于八个字符。',
          confidence: 0.8,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: '[REDACTED:SECRET]' }], // 引用遮罩占位符
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(badResponse) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }),
        { status: 200 }
      );
    };

    const res = await distillSession(db, cfg, {
      sessionId: 's2',
      fetchFn: mockFetch,
    });

    // 全部 item 无效导致蒸馏失败
    expect(res.success).toBe(false);
    expect(res.error).toBe('all_items_invalid');

    // 事务未推进 processed
    const unprocessed = db.all("SELECT * FROM raw_events WHERE session_id = 's2' AND processed < 2");
    expect(unprocessed).toHaveLength(3);

    // watermark 未推进
    const watermark = db.get("SELECT * FROM meta WHERE key = 'distill:s2'");
    expect(watermark).toBeUndefined();
  });

  it('preserves early events and bounds batch size within input budget (连续有界批不能丢早期事件)', async () => {
    // 插入大批量事件，单条很长
    const longText = 'Configuring database connection string '.repeat(30);
    for (let seq = 1; seq <= 40; seq++) {
      db.run(
        `INSERT INTO raw_events (
          session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed
        ) VALUES ('s3', ?, 'ws_demo', 'user/message', ?, 1, 'user', 'user', ?, 0)`,
        [seq, 1000 + seq * 10, `[Event ${seq}] ${longText}`]
      );
    }

    // 设置紧凑的预算，只够装下前几个事件 (系统提示词约 700 tokens + 若干事件)
    const tightCfg: PluginConfig = {
      ...cfg,
      distillMaxInputTokens: 1800,
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
          usage: { prompt_tokens: 200, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    };

    const res = await distillSession(db, tightCfg, {
      sessionId: 's3',
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(true);
    expect(res.consumedCount).toBeLessThan(40);
    expect(res.consumedCount).toBeGreaterThan(0);

    // 验证最早的连续批次被标记为 processed=2，后续事件保持 processed=0（早期事件未丢失）
    const consumedEvents = db.all<{ seq: number }>(
      "SELECT seq FROM raw_events WHERE session_id = 's3' AND processed = 2 ORDER BY seq ASC"
    );
    expect(consumedEvents[0].seq).toBe(1);
    expect(consumedEvents[consumedEvents.length - 1].seq).toBe(res.consumedCount);

    const remainingEvents = db.all<{ seq: number }>(
      "SELECT seq FROM raw_events WHERE session_id = 's3' AND processed = 0 ORDER BY seq ASC"
    );
    expect(remainingEvents[0].seq).toBe(res.consumedCount + 1);
  });

  it('advances processed and watermark on valid empty items (空items可以推进实际消费区间)', async () => {
    insertEvents('s4', 4);

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    };

    const res = await distillSession(db, cfg, {
      sessionId: 's4',
      fetchFn: mockFetch,
    });

    expect(res.success).toBe(true);
    expect(res.itemsCreated).toBe(0);
    expect(res.consumedCount).toBe(4);

    // 事件被标记为已处理
    const unprocessed = db.all("SELECT * FROM raw_events WHERE session_id = 's4' AND processed < 2");
    expect(unprocessed).toHaveLength(0);

    // watermark 被写入
    const watermark = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'distill:s4'");
    expect(watermark).toBeDefined();
    expect(JSON.parse(watermark!.value).lastSeq).toBe(4);
  });
});
