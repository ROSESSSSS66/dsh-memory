import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { runReflectJob } from '../../src/evolution/reflector.js';
import { PROMPT_REFLECT } from '../../src/evolution/prompts.js';
import { estimateTokens } from '../../src/core/tokens.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import type { JobRecord } from '../../src/jobs/types.js';

describe('Reflector Job (M3-T4)', () => {
  let db: Db;
  let cfg: PluginConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = {
      ...DEFAULTS,
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

  afterEach(() => {
    db.close();
  });

  it('runs reflect job and produces failure candidate according to Appendix B-2', async () => {
    // 写入事件：turn 1 报错，turn 2 用户纠正
    db.run(
      `INSERT INTO raw_events (
        session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed
      ) VALUES
      ('s1', 1, 'ws1', 'tool/result', 1000, 1, 'tool', 'tool', 'Error: Cannot find module dsh-memory', 0),
      ('s1', 2, 'ws1', 'user/message', 1100, 2, 'user', 'user', '不对，路径引错了，应该从本地 dist 目录引用', 0)`
    );

    const fixtureReflectResponse = {
      items: [
        {
          type: 'failure',
          text: '工具提示无法解析 dsh-memory 时，先检查本地环境中的依赖与解析路径，再重试，以错误消除验证。',
          slot_key: null,
          confidence: 0.8,
          scope: 'workspace',
          evidence: [
            {
              seq: 1,
              quote: 'Error: Cannot find module dsh-memory',
            },
          ],
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fixtureReflectResponse) } }],
          usage: { prompt_tokens: 250, completion_tokens: 100 },
        }),
        { status: 200 }
      );
    };

    const job: JobRecord = {
      id: 1,
      kind: 'reflect',
      key: 'reflect:s1:1',
      payload: JSON.stringify({
        sessionId: 's1',
        turn: 1,
        cwd: 'ws1',
        correctionMessage: '不对，路径引错了',
      }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1000,
      started_at: 1050,
      finished_at: null,
      next_eligible_at: 0,
    };

    const result = await runReflectJob(db, cfg, job, undefined, mockFetch);

    expect(result.action).toBe('done');

    // 验证产生的新候选记忆
    const candidates = db.all<MemoryRecord>("SELECT * FROM memories WHERE status = 'candidate'");
    expect(candidates).toHaveLength(1);

    const failureMem = candidates[0];
    expect(failureMem.type).toBe('failure');
    expect(failureMem.content).toContain('工具提示无法解析 dsh-memory 时');
    expect(failureMem.source_kind).toBe('llm_extract');
    // 来自 tool 的来源证据受来源信任上限约束：Math.min(0.8 * 0.8, 0.5) = 0.5
    expect(failureMem.confidence).toBe(0.5);
  });

  it('bounds 400+ events (>150k chars) within distillMaxInputTokens while retaining NULL-turn user prompts, error evidence, and session_workspace_owners', async () => {
    const ownerWs = 'aabbccddeeff0011';
    db.run(
      'INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
      ['s_big', ownerWs]
    );

    // 1. turn IS NULL 的初始用户输入 (seq=1)
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('s_big', 1, '', 'user/message', 1000, NULL, 'user', 'user', '请帮我排查 fwq 的构建脚本为什么失败', 0)`
    );

    // 2. 400 条 turn=1 的超大噪音事件 (>150k 字符)，中间夹杂 1 次真实 tool/result 报错
    db.transaction(() => {
      for (let seq = 2; seq <= 401; seq++) {
        if (seq === 150) {
          db.run(
            `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
             VALUES ('s_big', ?, '', 'tool/result', ?, 1, 'tool', 'tool', 'bash', 1, 'Error: ENOENT fwq/dist/index.js not built yet', 0)`,
            [seq, 1000 + seq]
          );
        } else {
          const bigText = `日志第 ${seq} 行: ` + 'A'.repeat(420);
          db.run(
            `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
             VALUES ('s_big', ?, '', 'assistant/message', ?, 1, 'assistant', 'assistant', ?, 0)`,
            [seq, 1000 + seq, bigText]
          );
        }
      }
      // 3. turn IS NULL 的用户纠正 (triggerSeq=402)
      db.run(
        `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
         VALUES ('s_big', 402, '', 'user/message', 2000, NULL, 'user', 'user', '不对，fwq 必须先构建 dist 再执行检测。', 0)`
      );
    });

    let sentUserPrompt = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      sentUserPrompt = String(body.messages?.[1]?.content || '');
      const errMatch = sentUserPrompt.match(/\[T#(\d+)\][^\n]*ENOENT fwq\/dist\/index\.js/);
      const errLedgerSeq = errMatch ? Number(errMatch[1]) : -1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [
                    {
                      type: 'failure',
                      text: '遇到 ENOENT fwq/dist/index.js 报错时，应先构建 dist 产物再执行检测。',
                      slot_key: null,
                      confidence: 0.85,
                      scope: 'workspace',
                      evidence: [
                        {
                          seq: errLedgerSeq,
                          quote: 'Error: ENOENT fwq/dist/index.js not built yet',
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1800, completion_tokens: 120 },
        }),
        { status: 200 }
      );
    };

    const job: JobRecord = {
      id: 2,
      kind: 'reflect',
      key: 'reflect:s_big:1',
      payload: JSON.stringify({
        sessionId: 's_big',
        turn: 1,
        triggerSeq: 402,
        workspaceId: '',
      }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 2000,
      started_at: 2050,
      finished_at: null,
      next_eligible_at: 0,
    };

    const result = await runReflectJob(db, cfg, job, undefined, mockFetch);
    expect(result.action).toBe('done');
    expect(estimateTokens(PROMPT_REFLECT.system + sentUserPrompt) + 200).toBeLessThanOrEqual(
      cfg.distillMaxInputTokens
    );
    expect(sentUserPrompt).toContain('请帮我排查 fwq 的构建脚本为什么失败');
    expect(sentUserPrompt).toContain('ENOENT fwq/dist/index.js not built yet');
    expect(sentUserPrompt).toContain('不对，fwq 必须先构建 dist 再执行检测');

    const candidates = db.all<MemoryRecord>("SELECT * FROM memories WHERE status = 'candidate'");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].workspace_id).toBe(ownerWs);
  });

  it('truncates a single oversized CJK event within distillMaxInputTokens', async () => {
    const megaCjk = '中文长日志报错信息需要截断避免超预算'.repeat(600);
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed)
       VALUES ('s_cjk', 1, 'ws_cjk', 'tool/result', 1000, 1, 'tool', 'tool', 1, ?, 0)`,
      [megaCjk]
    );

    let sentUserPrompt = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      sentUserPrompt = String(body.messages?.[1]?.content || '');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [] }) } }],
          usage: { prompt_tokens: 900, completion_tokens: 20 },
        }),
        { status: 200 }
      );
    };

    const job: JobRecord = {
      id: 3,
      kind: 'reflect',
      key: 'reflect:s_cjk:1',
      payload: JSON.stringify({ sessionId: 's_cjk', turn: 1, cwd: 'ws_cjk' }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1000,
      started_at: 1010,
      finished_at: null,
      next_eligible_at: 0,
    };

    const res = await runReflectJob(db, cfg, job, undefined, mockFetch);
    expect(res.action).toBe('done');
    expect(estimateTokens(PROMPT_REFLECT.system + sentUserPrompt) + 200).toBeLessThanOrEqual(
      cfg.distillMaxInputTokens
    );
  });

  it('enforces excludeWorkspaces via session_workspace_owners when raw_events.workspace_id is empty', async () => {
    const excludedWs = 'ffeeddccbbaa9988';
    db.run(
      'INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
      ['s_priv', excludedWs]
    );
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('s_priv', 1, '', 'user/message', 1000, 1, 'user', 'user', '机密排查消息', 0)`
    );

    let fetched = false;
    const mockFetch: typeof fetch = async () => {
      fetched = true;
      return new Response('{}');
    };

    const excludedCfg: PluginConfig = {
      ...cfg,
      excludeWorkspaces: [excludedWs],
    };

    const job: JobRecord = {
      id: 4,
      kind: 'reflect',
      key: 'reflect:s_priv:1',
      payload: JSON.stringify({ sessionId: 's_priv', turn: 1 }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 1000,
      started_at: 1010,
      finished_at: null,
      next_eligible_at: 0,
    };

    const res = await runReflectJob(db, excludedCfg, job, undefined, mockFetch);
    expect(res).toMatchObject({ action: 'failed', error: 'workspace_excluded' });
    expect(fetched).toBe(false);
  });

  it('uses triggerSeq when turn is omitted (without synthesizing turn=0 pulling turn 1) and scopes failure_sigs by workspace_id', async () => {
    // Turn 1 unrelated event (seq=1), 20 intervening events (seq=2..21), and later failure at seq=50 (turn IS NULL)
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
       VALUES ('s_trig', 1, 'ws_a', 'user/message', 1000, 1, 'user', 'user', NULL, 0, 'UNRELATED_TURN_1_NOISE', 0)`
    );
    for (let s = 2; s <= 21; s++) {
      db.run(
        `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
         VALUES ('s_trig', ?, 'ws_a', 'assistant/message', ?, NULL, 'assistant', 'assistant', NULL, 0, ?, 0)`,
        [s, 1000 + s * 10, `intermediate step ${s}`]
      );
    }
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
       VALUES ('s_trig', 50, 'ws_a', 'tool/result', 5000, NULL, 'tool', 'tool', 'bash', 1, 'Error: EACCES permission denied /opt/app', 0)`
    );

    // Same sig in two workspaces: ws_a (allowed) and ws_excluded (excluded)
    db.run(
      `INSERT INTO failure_sigs (sig, workspace_id, count, sessions, last_seq_ref, updated_at)
       VALUES
       ('bash:EACCES', 'ws_a', 2, '["s_trig"]', 's_trig:50', 5000),
       ('bash:EACCES', 'ws_excluded', 5, '["s_priv"]', 's_priv:10', 9000)`
    );

    let sentUserPrompt = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body || '{}'));
      sentUserPrompt = String(body.messages?.[1]?.content || '');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [] }) } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    };

    const scopedCfg: PluginConfig = {
      ...cfg,
      excludeWorkspaces: ['ws_excluded'],
    };

    const job: JobRecord = {
      id: 5,
      kind: 'reflect',
      key: 'reflect:failure_sig:test',
      payload: JSON.stringify({
        sig: 'bash:EACCES',
        workspaceId: 'ws_a',
      }),
      status: 'running',
      attempts: 1,
      error: null,
      created_at: 5000,
      started_at: 5010,
      finished_at: null,
      next_eligible_at: 0,
    };

    const res = await runReflectJob(db, scopedCfg, job, undefined, mockFetch);
    expect(res.action).toBe('done');
    expect(sentUserPrompt).toContain('EACCES permission denied');
    expect(sentUserPrompt).not.toContain('UNRELATED_TURN_1_NOISE');
  });
});
