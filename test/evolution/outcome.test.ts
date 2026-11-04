import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { evaluateTurnOutcome } from '../../src/evolution/outcome.js';
import { upsertCandidate } from '../../src/core/writer.js';
import type { Db, MemoryRecord } from '../../src/types.js';

describe('Turn Outcome & Utility Evaluation (M3-T4)', () => {
  let db: Db;
  let cfg: PluginConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = {
      ...DEFAULTS,
      utilityLR: 0.1,
    };
  });

  it('updates utility accurately for used vs unused memories upon positive outcome (精确数值断言)', () => {
    // 写入两条初始 utility = 0.5 的活跃记忆
    const c1 = upsertCandidate(db, {
      type: 'semantic',
      content: 'PostgreSQL 数据库的端口默认是 5432。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const c2 = upsertCandidate(db, {
      type: 'semantic',
      content: 'Redis 缓存的过期时间统一设置为 3600 秒。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'user',
    });

    const m1Id = (c1 as any).id;
    const m2Id = (c2 as any).id;

    // 将两条记忆置为 active
    db.run("UPDATE memories SET status = 'active', utility = 0.5 WHERE id IN (?, ?)", [m1Id, m2Id]);

    // 记录在 turn 1 注入了这两条记忆
    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES ('s1', 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1000)`,
      [m1Id]
    );
    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES ('s1', 1, ?, 1, 'dynamic', 2, 50, 'content', 1, 1000)`,
      [m2Id]
    );

    // 插入 turn 1 的 assistant 响应：只使用了 PostgreSQL 和 5432，未提及 Redis
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('s1', 3, 'ws1', 'assistant/message', 1100, 1, 'assistant', 'assistant',
               '连接 PostgreSQL 数据库，请使用默认端口 5432。', 0)`
    );

    // 下一轮用户肯定："好的，完美解决了！"
    const res = evaluateTurnOutcome(
      db,
      {
        sessionId: 's1',
        turn: 1,
        nextUserMessage: '好的，完美解决了！',
      },
      cfg
    );

    expect(res.outcome).toBe(1.0);
    expect(res.isCorrection).toBe(false);
    expect(res.updatedInjections).toBe(2);

    // 验证效用变化公式：
    // target = (1 + 1) / 2 = 1.0
    // m1 (used): w = 1.0, utility = 0.5 + 0.1 * 1.0 * (1.0 - 0.5) = 0.55
    const m1 = db.get<MemoryRecord>('SELECT utility, success_count, fail_count FROM memories WHERE id = ?', [m1Id]);
    expect(m1?.utility).toBeCloseTo(0.55, 4);
    expect(m1?.success_count).toBe(1);
    expect(m1?.fail_count).toBe(0);

    // m2 (unused): w = 0.2, utility = 0.5 + 0.1 * 0.2 * (1.0 - 0.5) = 0.51
    const m2 = db.get<MemoryRecord>('SELECT utility, success_count, fail_count FROM memories WHERE id = ?', [m2Id]);
    expect(m2?.utility).toBeCloseTo(0.51, 4);
    expect(m2?.success_count).toBe(0);
    expect(m2?.fail_count).toBe(0);

    // 验证 injections 表回填
    const inj1 = db.get<{ outcome: number; used: number }>(
      "SELECT outcome, used FROM injections WHERE session_id = 's1' AND turn = 1 AND memory_id = ?",
      [m1Id]
    );
    expect(inj1?.outcome).toBe(1.0);
    expect(inj1?.used).toBe(1);

    const inj2 = db.get<{ outcome: number; used: number }>(
      "SELECT outcome, used FROM injections WHERE session_id = 's1' AND turn = 1 AND memory_id = ?",
      [m2Id]
    );
    expect(inj2?.outcome).toBe(1.0);
    expect(inj2?.used).toBe(0);
  });

  it('enqueues reflect job once upon correction and updates utility (纠正场景入队reflect，同一turn只入队一次)', () => {
    const c1 = upsertCandidate(db, {
      type: 'semantic',
      content: '当前构建命令是 npm run build。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's2', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const m1Id = (c1 as any).id;
    db.run("UPDATE memories SET status = 'active', utility = 0.5 WHERE id = ?", [m1Id]);

    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES ('s2', 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1000)`,
      [m1Id]
    );

    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('s2', 2, 'ws1', 'assistant/message', 1100, 1, 'assistant', 'assistant',
               '请运行 npm run build 来构建项目。', 0)`
    );

    // 用户反馈纠正："不对，命令搞错了，应该用 pnpm"
    const res1 = evaluateTurnOutcome(
      db,
      {
        sessionId: 's2',
        turn: 1,
        nextUserMessage: '不对，命令搞错了，应该用 pnpm',
      },
      cfg
    );

    expect(res1.outcome).toBe(-1.0);
    expect(res1.isCorrection).toBe(true);
    expect(res1.reflectEnqueued).toBe(true);

    // target = (-1 + 1) / 2 = 0.0
    // m1 (used): w = 1.0, utility = 0.5 + 0.1 * 1.0 * (0.0 - 0.5) = 0.45
    const m1 = db.get<MemoryRecord>('SELECT utility, success_count, fail_count FROM memories WHERE id = ?', [m1Id]);
    expect(m1?.utility).toBeCloseTo(0.45, 4);
    expect(m1?.fail_count).toBe(1);

    // 检查 reflect 任务是否已入队
    const jobs = db.all<{ kind: string; key: string }>(
      "SELECT kind, key FROM jobs WHERE kind = 'reflect'"
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].key).toBe('reflect:s2:1');

    // 重复对同一个 turn 进行判定，不会重复入队任务
    const res2 = evaluateTurnOutcome(
      db,
      {
        sessionId: 's2',
        turn: 1,
        nextUserMessage: '不对，完全错了',
      },
      cfg
    );
    expect(res2.reflectEnqueued).toBe(false);

    const jobsAfter = db.all("SELECT * FROM jobs WHERE kind = 'reflect'");
    expect(jobsAfter).toHaveLength(1);
  });
});
