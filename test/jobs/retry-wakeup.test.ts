import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import { JobScheduler, enqueueJob } from '../../src/jobs/scheduler.js';
import { registerJobHandler, unregisterJobHandler, runNextJob } from '../../src/jobs/runner.js';
import type { Db } from '../../src/types.js';

describe('Deferred job wakeups', () => {
  let db: Db;
  let scheduler: JobScheduler;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    db = openDb(':memory:');
    scheduler = new JobScheduler(db, DEFAULTS);
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
    scheduler = new JobScheduler(db, DEFAULTS);
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
});
