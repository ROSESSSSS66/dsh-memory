import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import { enqueueJob } from '../../src/jobs/scheduler.js';
import { JobRunner, clearJobHandlers, registerJobHandler } from '../../src/jobs/runner.js';
import { jobFailure, type JobRecord } from '../../src/jobs/types.js';
import type { Db } from '../../src/types.js';

describe('JobRunner instance isolation, atomic claim, shutdown & deferral safety', () => {
  let db1: Db;
  let db2: Db;

  beforeEach(() => {
    db1 = openDb(':memory:');
    db2 = openDb(':memory:');
  });

  afterEach(() => {
    clearJobHandlers();
    db1.close();
    db2.close();
  });

  it('isolates handlers and execution locks across independent JobRunner instances', async () => {
    const runnerA = new JobRunner();
    const runnerB = new JobRunner();

    let releaseA!: () => void;
    let bRanWhileABusy = false;

    runnerA.registerHandler('shared_kind', async () => {
      await new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      return { action: 'done' };
    });

    runnerB.registerHandler('shared_kind', async () => {
      bRanWhileABusy = runnerA.isBusy();
      return { action: 'done' };
    });

    enqueueJob(db1, { kind: 'shared_kind', key: 'a1' });
    enqueueJob(db2, { kind: 'shared_kind', key: 'b1' });

    const pA = runnerA.runNextJob(db1, DEFAULTS);
    // Allow microtask to start runnerA
    await Promise.resolve();
    await Promise.resolve();
    expect(runnerA.isBusy()).toBe(true);
    expect(runnerB.isBusy()).toBe(false);

    const ranB = await runnerB.runNextJob(db2, DEFAULTS);
    expect(ranB).toBe(true);
    expect(bRanWhileABusy).toBe(true);

    releaseA();
    expect(await pA).toBe(true);
    expect(runnerA.isBusy()).toBe(false);
  });

  it('reclaims stale running jobs (< 3 attempts -> queued, >= 3 attempts -> failed) inside atomic claim', async () => {
    const runner = new JobRunner();
    const executedKeys: string[] = [];
    runner.registerHandler('reclaim_kind', async (job) => {
      executedKeys.push(job.key);
      return { action: 'done' };
    });

    const now = 1_000_000;
    // Stale running job with attempts=1 (started > 300s ago) -> should be reclaimed to queued and run
    db1.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at, next_eligible_at)
       VALUES ('reclaim_kind', 'stale_reclaimable', 'running', 1, 1000, 1000, 0)`
    );
    // Stale running job with attempts=3 -> should be marked failed
    db1.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at, next_eligible_at)
       VALUES ('reclaim_kind', 'stale_exhausted', 'running', 3, 2000, 2000, 0)`
    );
    // Fresh running job (started 10s ago) -> must stay untouched
    db1.run(
      `INSERT INTO jobs (kind, key, status, attempts, created_at, started_at, next_eligible_at)
       VALUES ('reclaim_kind', 'fresh_live', 'running', 1, ?, ?, 0)`,
      [now - 10_000, now - 10_000]
    );

    const ran = await runner.runNextJob(db1, DEFAULTS, now);
    expect(ran).toBe(true);
    expect(executedKeys).toEqual(['stale_reclaimable']);

    expect(db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'stale_reclaimable'")?.status).toBe('done');
    expect(db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'stale_exhausted'")).toMatchObject({
      status: 'failed',
      error: 'stale_running_max_attempts',
    });
    expect(db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'fresh_live'")?.status).toBe('running');
  });

  it('passes deadline as 3rd argument and distinguishes graceful shutdown from timeout', async () => {
    const runner = new JobRunner();
    let seenDeadline: number | undefined;
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    runner.registerHandler('long_kind', async (_job, signal, deadline) => {
      seenDeadline = deadline;
      startedResolve();
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          resolve({ action: 'failed', error: 'handler_aborted' });
        });
      });
    });

    const fixedNow = 500_000;
    const cfg = { ...DEFAULTS, jobTimeoutMs: 45_000 };
    enqueueJob(db1, { kind: 'long_kind', key: 'shutdown_job', now: fixedNow });

    const runPromise = runner.runNextJob(db1, cfg, fixedNow);
    await started;
    expect(seenDeadline).toBe(fixedNow + 45_000);

    // Graceful shutdown must revert job back to queued with attempts restored to 0
    await runner.abortAndAwaitRunningJob(2_000, 'shutdown');
    await runPromise;

    const job = db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'shutdown_job'");
    expect(job).toMatchObject({
      status: 'queued',
      attempts: 0,
      started_at: null,
      next_eligible_at: 0,
    });
  });

  it('enforces hard shutdown watchdog so wedged handlers never hang disposal forever', async () => {
    const runner = new JobRunner();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    // Wedged handler that completely ignores AbortSignal
    runner.registerHandler('wedged_kind', async () => {
      startedResolve();
      return new Promise(() => {});
    });

    enqueueJob(db1, { kind: 'wedged_kind', key: 'wedged' });
    void runner.runNextJob(db1, { ...DEFAULTS, jobTimeoutMs: 60_000 });
    await started;

    const t0 = Date.now();
    await runner.abortAndAwaitRunningJob(50, 'shutdown');
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
  });

  it('reverts attempts on skipped results without burning failure retries and caps infinite skips at 14', async () => {
    const runner = new JobRunner();
    runner.registerHandler('budget_kind', async () => ({
      action: 'skipped',
      reason: 'daily_tokens_exceeded',
    }));

    let clock = 1_000_000;
    enqueueJob(db1, { kind: 'budget_kind', key: 'budget_cap', now: clock });

    // Skip 13 times -> stays 'skipped', attempts stays 0, finished_at matches injected clock!
    for (let i = 1; i <= 13; i++) {
      expect(await runner.runNextJob(db1, DEFAULTS, clock)).toBe(true);
      const row = db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'budget_cap'")!;
      expect(row.status).toBe('skipped');
      expect(row.attempts).toBe(0);
      expect(row.error).toBe('daily_tokens_exceeded');
      expect(row.finished_at).toBe(clock);
      clock = row.next_eligible_at + 1;
    }

    // 14th skip hits cap -> transitions to permanently failed
    expect(await runner.runNextJob(db1, DEFAULTS, clock)).toBe(true);
    const capped = db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'budget_cap'")!;
    expect(capped.status).toBe('failed');
    expect(capped.error).toContain('max_deferrals_exceeded');

    // Verify a job skipped 3 times still retains all 3 real failure retry attempts afterwards
    let mode: 'skip' | 'retry' = 'skip';
    runner.registerHandler('skip_then_retry', async () =>
      mode === 'skip'
        ? { action: 'skipped', reason: 'daily_calls_exceeded' }
        : { action: 'retry', error: 'http_408' }
    );
    let clock2 = 2_000_000;
    enqueueJob(db1, { kind: 'skip_then_retry', key: 's_then_r', now: clock2 });
    for (let i = 0; i < 3; i++) {
      await runner.runNextJob(db1, DEFAULTS, clock2);
      const r = db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 's_then_r'")!;
      expect(r.attempts).toBe(0);
      clock2 = r.next_eligible_at + 1;
    }
    mode = 'retry';
    await runner.runNextJob(db1, DEFAULTS, clock2);
    const afterFirstRealFail = db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 's_then_r'")!;
    expect(afterFirstRealFail.status).toBe('queued');
    expect(afterFirstRealFail.attempts).toBe(1);
    expect(afterFirstRealFail.next_eligible_at).toBe(clock2 + 60_000);
  });

  it('classifies SyntaxError and case-insensitive parse/schema errors as non-retryable, and retries http_408 in jobFailure()', async () => {
    expect(jobFailure('http_408')).toEqual({ action: 'retry', error: 'http_408' });
    expect(jobFailure('http_429')).toEqual({ action: 'retry', error: 'http_429' });
    expect(jobFailure('http_401')).toEqual({ action: 'failed', error: 'http_401', nonRetryable: true });

    const runner = new JobRunner();
    runner.registerHandler('syntax_kind', async () => {
      JSON.parse('{bad json');
      return { action: 'done' };
    });
    runner.registerHandler('upper_schema_kind', async () => {
      throw new Error('SCHEMA_MISMATCH in response');
    });

    enqueueJob(db1, { kind: 'syntax_kind', key: 'k_syn', now: 1000 });
    enqueueJob(db1, { kind: 'upper_schema_kind', key: 'k_sch', now: 1001 });

    await runner.runNextJob(db1, DEFAULTS, 1000);
    await runner.runNextJob(db1, DEFAULTS, 1001);

    expect(db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'k_syn'")?.status).toBe('failed');
    expect(db1.get<JobRecord>("SELECT * FROM jobs WHERE key = 'k_sch'")?.status).toBe('failed');

    // Verify clearJobHandlers works on defaultJobRunner and empty queue resets isBusy cleanly
    registerJobHandler('temp_kind', async () => ({ action: 'done' }));
    clearJobHandlers();
    expect(await runner.runNextJob(db1, DEFAULTS, 2000)).toBe(false);
    expect(runner.isBusy()).toBe(false);
  });
});
