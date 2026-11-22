import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import {
  enqueueJob,
  recoverJobsOnStartup,
  JobScheduler,
} from '../../src/jobs/scheduler.js';
import {
  JobRunner,
  registerJobHandler,
  unregisterJobHandler,
  runNextJob,
} from '../../src/jobs/runner.js';
import { reserve } from '../../src/evolution/ledger.js';
import type { Db } from '../../src/types.js';
import type { JobRecord } from '../../src/jobs/types.js';

describe('Job Scheduler & Runner (M3-T2)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    unregisterJobHandler('test_distill');
    unregisterJobHandler('test_timeout');
    unregisterJobHandler('test_fail');
    db.close();
  });

  it('ensures kind+key is idempotent (kind+key 幂等)', () => {
    const enq1 = enqueueJob(db, {
      kind: 'distill',
      key: 'session_s1:turn_1',
      payload: { sessionId: 's1' },
    });
    expect(enq1).toBe(true);

    // 重复同一 kind + key 入队
    const enq2 = enqueueJob(db, {
      kind: 'distill',
      key: 'session_s1:turn_1',
      payload: { sessionId: 's1' },
    });
    expect(enq2).toBe(false);

    const rows = db.all('SELECT * FROM jobs WHERE kind = ? AND key = ?', [
      'distill',
      'session_s1:turn_1',
    ]);
    expect(rows).toHaveLength(1);
  });

  it('enforces global non-concurrency (全局不并发)', async () => {
    let activeWorkers = 0;
    let maxConcurrent = 0;

    registerJobHandler('test_distill', async () => {
      activeWorkers++;
      maxConcurrent = Math.max(maxConcurrent, activeWorkers);
      await new Promise(r => setTimeout(r, 40));
      activeWorkers--;
      return { action: 'done' };
    });

    enqueueJob(db, { kind: 'test_distill', key: 'job_1' });
    enqueueJob(db, { kind: 'test_distill', key: 'job_2' });

    // 并发尝试运行两个任务
    const p1 = runNextJob(db, DEFAULTS);
    const p2 = runNextJob(db, DEFAULTS);

    const [r1, r2] = await Promise.all([p1, p2]);

    // 由于互斥锁，其中一个必然返回 false
    expect(r1 && r2).toBe(false);
    expect(maxConcurrent).toBe(1);
  });

  it('aborts on timeout and waits for runner convergence (超时Abort并等runner收敛)', async () => {
    let aborted = false;
    let cleanupDone = false;

    registerJobHandler('test_timeout', async (_job, signal) => {
      return new Promise(resolve => {
        signal.addEventListener('abort', () => {
          aborted = true;
          setTimeout(() => {
            cleanupDone = true;
            resolve({ action: 'failed', error: 'aborted_cleanly' });
          }, 20);
        });
      });
    });

    enqueueJob(db, { kind: 'test_timeout', key: 'timeout_job' });

    // 设置很短的超时时间
    const shortTimeoutCfg = { ...DEFAULTS, jobTimeoutMs: 30 };
    const ran = await runNextJob(db, shortTimeoutCfg);

    expect(ran).toBe(true);
    expect(aborted).toBe(true);
    expect(cleanupDone).toBe(true);

    const row = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['timeout_job']);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('job_timeout_aborted');
  });

  it('recovers running jobs and unknown ledger consistently on startup (running恢复和unknown账本保守一致)', () => {
    // 模拟奔溃前遗留的陈旧 running job (> 5 分钟) 与另一进程正在运行的 fresh running job
    db.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at)
       VALUES ('distill', 'crash_job', 'running', 1, 1000, 1050)`
    );
    db.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at)
       VALUES ('distill', 'sibling_live_job', 'running', 1, 395000, 395000)`
    );

    // 模拟奔溃前 reserved 的 ledger 记录
    const r = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-chat',
        promptVersion: 'distill-v2',
        reservedTokens: 5000,
      },
      DEFAULTS
    );
    expect(r.reserved).toBe(true);

    // 启动恢复：仅回收超过 300_000ms 陈旧阈值的 running 任务，不误杀兄弟进程正在运行的任务
    const recovery = recoverJobsOnStartup(db, 400_000);
    expect(recovery.recoveredJobs).toBe(1);
    expect(recovery.recoveredLedger).toBe(1);

    const job = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['crash_job']);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('recovered_from_running_on_restart');

    const liveSibling = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['sibling_live_job']);
    expect(liveSibling?.status).toBe('running');

    // 显式 recoverAll: true 时才回收全部 running 任务
    const forced = recoverJobsOnStartup(db, 400_000, { recoverAll: true });
    expect(forced.recoveredJobs).toBe(1);
    expect(db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['sibling_live_job'])?.status).toBe('failed');

    const ledger = db.get<{ status: string; note: string }>(
      'SELECT status, note FROM llm_ledger WHERE id = ?',
      [r.ledgerId!]
    );
    expect(ledger?.status).toBe('unknown');
    expect(ledger?.note).toBe('recovered_on_startup');
  });

  it('skips on budget and can be recovered the next day (预算skip次日可恢复)', async () => {
    registerJobHandler('test_distill', async () => {
      return { action: 'skipped', reason: 'daily_tokens_exceeded' };
    });

    enqueueJob(db, { kind: 'test_distill', key: 'skip_job' });

    const now = 100000;
    await runNextJob(db, DEFAULTS, now);

    const row = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['skip_job']);
    expect(row?.status).toBe('skipped');
    expect(row?.error).toBe('daily_tokens_exceeded');
    expect(row?.next_eligible_at).toBeGreaterThan(now);

    // 在当日重新执行，不应被调度
    const ranAgainToday = await runNextJob(db, DEFAULTS, now + 1000);
    expect(ranAgainToday).toBe(false);

    // 到达次日恢复时刻，应该被成功调度
    unregisterJobHandler('test_distill');
    registerJobHandler('test_distill', async () => {
      return { action: 'done' };
    });

    const ranNextDay = await runNextJob(db, DEFAULTS, row!.next_eligible_at + 1);
    expect(ranNextDay).toBe(true);

    const updatedRow = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['skip_job']);
    expect(updatedRow?.status).toBe('done');
  });

  it('does not retry parse failure input (解析失败输入不重发)', async () => {
    registerJobHandler('test_fail', async () => {
      throw new Error('json_parse_failed: invalid character');
    });

    enqueueJob(db, { kind: 'test_fail', key: 'parse_fail_job' });

    await runNextJob(db, DEFAULTS);

    const row = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['parse_fail_job']);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);
    expect(row?.error).toContain('json_parse_failed');

    // 确认不会被重试（status 是 failed，不是 queued）
    const ranAgain = await runNextJob(db, DEFAULTS);
    expect(ranAgain).toBe(false);
  });

  it('self-heals after schedulePending DB errors with 5s retry and wakes via notifyPending()', async () => {
    vi.useFakeTimers();
    try {
      const runner = new JobRunner();
      const ranKeys: string[] = [];
      runner.registerHandler('heal_kind', async (job) => {
        ranKeys.push(job.key);
        return { action: 'done' };
      });

      const originalGet = db.get.bind(db);
      let failOnce = true;
      const getSpy = vi.spyOn(db, 'get').mockImplementation((sql, params) => {
        if (failOnce && sql.includes('MIN(next_eligible_at)')) {
          failOnce = false;
          throw new Error('SQLITE_BUSY: simulated transient read error');
        }
        return originalGet(sql, params);
      });

      enqueueJob(db, { kind: 'heal_kind', key: 'k_heal' });
      const scheduler = new JobScheduler(db, DEFAULTS, { runner, idleMs: 0 });
      // Initial schedulePending threw -> scheduled 5s self-heal retry
      await vi.advanceTimersByTimeAsync(4_999);
      expect(ranKeys).toEqual([]);

      // At 5000ms self-heal retry queries DB and schedules immediate busy-floor 1s wakeup
      await vi.advanceTimersByTimeAsync(1_001);
      expect(ranKeys).toEqual(['k_heal']);

      // External producer inserts directly + calls notifyPending()
      enqueueJob(db, { kind: 'heal_kind', key: 'k_ext' });
      scheduler.notifyPending();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ranKeys).toEqual(['k_heal', 'k_ext']);

      getSpy.mockRestore();
      await scheduler.stopAndWait();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopAndWait passes shutdown reason so interrupted jobs revert to queued instead of failed', async () => {
    const runner = new JobRunner();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    runner.registerHandler('graceful_kind', async (_job, signal) => {
      startedResolve();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ action: 'failed', error: 'aborted' });
        });
      });
    });

    const scheduler = new JobScheduler(db, DEFAULTS, { runner, idleMs: 0 });
    scheduler.enqueue('graceful_kind', 'shutdown_requeue');
    const cyclePromise = scheduler.triggerNow();
    await started;

    await scheduler.stopAndWait(2_000);
    await cyclePromise;

    const row = db.get<JobRecord>("SELECT * FROM jobs WHERE key = 'shutdown_requeue'");
    expect(row?.status).toBe('queued');
    expect(row?.attempts).toBe(0);
    expect(row?.started_at).toBeNull();
    expect(row?.next_eligible_at).toBe(0);
  });
});
