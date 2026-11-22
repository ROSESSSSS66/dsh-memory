import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import { JobScheduler, enqueueJob } from '../../src/jobs/scheduler.js';
import {
  JobRunner,
  registerJobHandler,
  unregisterJobHandler,
  runNextJob,
} from '../../src/jobs/runner.js';
import type { Db } from '../../src/types.js';

describe('Deferred job wakeups', () => {
  let db: Db;
  let scheduler: JobScheduler;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    db = openDb(':memory:');
    scheduler = new JobScheduler(db, DEFAULTS, { idleMs: 30_000 });
  });
  afterEach(async () => {
    await scheduler.stopAndWait();
    unregisterJobHandler('wakeup');
    unregisterJobHandler('busy');
    db.close();
    vi.useRealTimers();
  });

  it('retries at both backoff deadlines without another turn', async () => {
    let attempts = 0;
    registerJobHandler('wakeup', async () => ++attempts < 3
      ? { action: 'retry', error: 'transient' } : { action: 'done' });
    scheduler.enqueue('wakeup', 'retry');
    scheduler.scheduleTurnStopping();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempts).toBe(3);
    expect(db.get('SELECT status FROM jobs')?.status).toBe('done');
  });

  it('wakes skipped budget jobs the next day', async () => {
    let attempts = 0;
    registerJobHandler('wakeup', async () => ++attempts === 1
      ? { action: 'skipped', reason: 'daily_tokens_exceeded' } : { action: 'done' });
    scheduler.enqueue('wakeup', 'budget');
    await scheduler.triggerNow();
    const due = db.get('SELECT next_eligible_at FROM jobs')!.next_eligible_at;
    await vi.advanceTimersByTimeAsync(due - Date.now());
    expect(attempts).toBe(2);
  });

  it('resumes persisted eligible jobs at startup and cancels wakeups on stop', async () => {
    scheduler.stop();
    const handler = vi.fn(async () => ({ action: 'retry' as const, error: 'transient' }));
    registerJobHandler('wakeup', handler);
    enqueueJob(db, { kind: 'wakeup', key: 'persisted' });
    scheduler = new JobScheduler(db, DEFAULTS, { idleMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(1);
    await scheduler.stopAndWait();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reschedules when another runner owns the global execution lock', async () => {
    let release!: () => void;
    registerJobHandler('busy', async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return { action: 'done' };
    });
    enqueueJob(db, { kind: 'busy', key: 'busy' });
    const busy = runNextJob(db, DEFAULTS);
    const handler = vi.fn(async () => ({ action: 'done' as const }));
    registerJobHandler('wakeup', handler);
    scheduler.enqueue('wakeup', 'waiting');
    await scheduler.triggerNow();
    expect(handler).not.toHaveBeenCalled();
    release();
    await busy;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('respects cfg.idleMinutes when idleMs override is omitted and slices timers across 60s OS-sleep heartbeats', async () => {
    await scheduler.stopAndWait();
    const runner = new JobRunner();
    const handler = vi.fn(async () => ({ action: 'done' as const }));
    runner.registerHandler('idle_cfg', handler);

    // idleMinutes = 2 -> 120_000ms (2 heartbeat slices of 60_000ms)
    scheduler = new JobScheduler(db, { ...DEFAULTS, idleMinutes: 2 }, { runner });
    scheduler.enqueue('idle_cfg', 'job_idle');
    await vi.advanceTimersByTimeAsync(119_999);
    expect(handler).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('respects idleUntil inside scheduled background cycles when a new turn starts, while explicit triggerNow() bypasses idleUntil', async () => {
    await scheduler.stopAndWait();
    const runner = new JobRunner();
    const executed: string[] = [];
    let releaseJob1!: () => void;

    runner.registerHandler('bg_job', async (job) => {
      executed.push(job.key);
      if (job.key === 'j1') {
        await new Promise<void>((resolve) => {
          releaseJob1 = resolve;
        });
      }
      return { action: 'done' };
    });

    scheduler = new JobScheduler(db, DEFAULTS, { runner, idleMs: 30_000 });
    scheduler.enqueue('bg_job', 'j1');
    scheduler.enqueue('bg_job', 'j2');

    // Reach idle -> background cycle starts j1
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed).toEqual(['j1']);

    // User resumes activity during j1 -> scheduleTurnStopping() pushes idleUntil +30s
    scheduler.scheduleTurnStopping();
    releaseJob1();
    await Promise.resolve();
    await Promise.resolve();

    // Background cycle must pause before j2 because idleUntil is in the future!
    expect(executed).toEqual(['j1']);

    // Explicit triggerNow() must bypass idleUntil and execute j2 immediately
    await scheduler.triggerNow();
    expect(executed).toEqual(['j1', 'j2']);
  });
});
