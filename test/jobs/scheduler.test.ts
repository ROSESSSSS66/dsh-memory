import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import {
  enqueueJob,
  recoverJobsOnStartup,
  JobScheduler,
} from '../../src/jobs/scheduler.js';
import {
  registerJobHandler,
  unregisterJobHandler,
  runNextJob,
  getNextDayStartMs,
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
    // 模拟奔溃前 running 的 job
    db.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at)
       VALUES ('distill', 'crash_job', 'running', 1, 1000, 1050)`
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

    // 启动恢复
    const recovery = recoverJobsOnStartup(db, 2000);
    expect(recovery.recoveredJobs).toBe(1);
    expect(recovery.recoveredLedger).toBe(1);

    const job = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['crash_job']);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('recovered_from_running_on_restart');

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
});
