import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { runReflectJob } from '../../src/evolution/reflector.js';
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
});
