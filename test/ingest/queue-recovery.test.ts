import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { DEFAULTS } from '../../src/config.js';
import type { Db, RawEvent } from '../../src/types.js';

describe('Ingest database failure recovery', () => {
  let db: Db;
  let queue: IngestQueue;
  const event: RawEvent = {
    session_id: 'recovery-session', seq: 1, workspace_id: 'recovery-workspace',
    type: 'user/message', time: 1, origin_kind: 'user', is_error: 0, processed: 0,
    text: 'A synthetic event that must survive a storage failure.',
  };

  beforeEach(() => {
    db = openDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queue?.close();
    db.close();
    vi.useRealTimers();
  });

  it('rolls back and requeues every event when an individual insert has an I/O failure', async () => {
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 100 });
    queue.push(event);
    queue.push({ ...event, seq: 2 });
    const originalRun = db.run.bind(db);
    const run = vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('INSERT INTO raw_events') && params?.[1] === 2) {
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
      }
      return originalRun(sql, params);
    });
    await expect(queue.flush()).rejects.toThrow('disk I/O');
    expect(queue.size()).toBe(2);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM raw_events')?.count).toBe(0);
    run.mockRestore();
    expect(await queue.flush()).toBe(2);
    expect(queue.size()).toBe(0);
  });

  it('waits for the periodic retry instead of spinning when a full batch cannot start a transaction', async () => {
    vi.useFakeTimers();
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 1, flushIntervalMs: 2000 });
    const transaction = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 });
    });
    queue.push(event);
    await vi.advanceTimersByTimeAsync(100);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(1);
    transaction.mockRestore();
    await vi.advanceTimersByTimeAsync(1900);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM raw_events')?.count).toBe(1);
    expect(queue.size()).toBe(0);
  });

  it('applies exponential backoff on repeated SQLITE_BUSY errors so push() never spins', async () => {
    vi.useFakeTimers();
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 1, flushIntervalMs: 2000 });
    const transaction = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 });
    });

    queue.push(event);
    await vi.advanceTimersByTimeAsync(10);
    // Failure 1 -> backoff 1000ms
    expect(transaction).toHaveBeenCalledTimes(1);

    // Additional push during backoff window must NOT trigger another flush attempt
    queue.push({ ...event, seq: 2 });
    await vi.advanceTimersByTimeAsync(500);
    expect(transaction).toHaveBeenCalledTimes(1);

    // Periodic timer at 2000ms fires (>= 1000ms backoff) -> failure 2 -> backoff 2000ms (nextRetryAt = 4000ms)
    await vi.advanceTimersByTimeAsync(1500);
    expect(transaction).toHaveBeenCalledTimes(2);

    // Push at t=2500ms still in backoff -> no attempt
    queue.push({ ...event, seq: 3 });
    await vi.advanceTimersByTimeAsync(500);
    expect(transaction).toHaveBeenCalledTimes(2);

    transaction.mockRestore();
    // Current fake clock is 2510ms; next periodic timer at t=4000ms (>= 4000ms backoff) drains all 3 events
    await vi.advanceTimersByTimeAsync(1500);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM raw_events')?.count).toBe(3);
    expect(queue.size()).toBe(0);
  });

  it('isolates and drops a non-transient poison-pill event via single-item SAVEPOINT without losing valid siblings', async () => {
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 60000 });
    queue.push({ ...event, seq: 1 });
    queue.push({ ...event, seq: 2 });
    queue.push({ ...event, seq: 3 });

    const originalRun = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('INSERT INTO raw_events') && params?.[1] === 2) {
        throw new Error('synthetic_corrupt_payload');
      }
      return originalRun(sql, params);
    });

    const inserted = await queue.flush();
    expect(inserted).toBe(2);
    expect(queue.size()).toBe(0);
    expect(queue.getDroppedCount()).toBe(1);
    const seqs = db.all<{ seq: number }>('SELECT seq FROM raw_events ORDER BY seq').map((r) => r.seq);
    expect(seqs).toEqual([1, 3]);
  });

  it('falls back to single-item SAVEPOINT isolation after >= 3 repeated non-lock batch failures', async () => {
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 60000 });
    queue.push({ ...event, seq: 1 });
    queue.push({ ...event, seq: 2 });
    queue.push({ ...event, seq: 3 });

    const originalRun = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('INSERT INTO raw_events') && params?.[1] === 2) {
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
      }
      return originalRun(sql, params);
    });

    // Failures 1 & 2 roll back and requeue entire batch
    await expect(queue.flush()).rejects.toThrow('disk I/O');
    expect(queue.size()).toBe(3);
    await expect(queue.flush()).rejects.toThrow('disk I/O');
    expect(queue.size()).toBe(3);

    // Failure 3 triggers DLQ single-item SAVEPOINT isolation: seq 1 & 3 commit, seq 2 dropped
    const inserted = await queue.flush();
    expect(inserted).toBe(2);
    expect(queue.size()).toBe(0);
    expect(queue.getDroppedCount()).toBe(1);
    const seqs = db.all<{ seq: number }>('SELECT seq FROM raw_events ORDER BY seq').map((r) => r.seq);
    expect(seqs).toEqual([1, 3]);
  });

  it('rolls back only partial runRules mutations via nested SAVEPOINT on non-transient rule error, but rethrows transient SQLite errors', async () => {
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 60000 });
    queue.push({
      ...event,
      seq: 1,
      role: 'user',
      text: '记住：项目使用 TypeScript 严格模式',
    });

    const originalRun = db.run.bind(db);
    // Simulate non-transient error during raw_events processed=1 update AFTER upsertCandidate wrote to memories
    const spy = vi.spyOn(db, 'run').mockImplementation((sql, params) => {
      if (sql.includes('UPDATE raw_events SET processed = 1')) {
        throw new Error('rule_bug_after_memory_insert');
      }
      return originalRun(sql, params);
    });

    const inserted = await queue.flush();
    expect(inserted).toBe(1);
    // raw_events insert succeeded, while runRules's partial memory insert was cleanly rolled back by nested SAVEPOINT
    expect(db.get<{ c: number }>('SELECT COUNT(*) as c FROM raw_events')?.c).toBe(1);
    expect(db.get<{ c: number }>('SELECT COUNT(*) as c FROM memories')?.c).toBe(0);

    // Now simulate a transient SQLITE_BUSY error inside runRules -> must roll back outer batch & requeue
    spy.mockImplementation((sql, params) => {
      if (sql.includes('UPDATE raw_events SET processed = 1')) {
        throw Object.assign(new Error('database is locked'), { errcode: 5 });
      }
      return originalRun(sql, params);
    });

    queue.push({
      ...event,
      seq: 2,
      role: 'user',
      text: '记住：构建使用 pnpm build',
    });
    await expect(queue.flush()).rejects.toThrow('database is locked');
    expect(queue.size()).toBe(1);
    expect(db.get<{ c: number }>('SELECT COUNT(*) as c FROM raw_events WHERE seq = 2')?.c).toBe(0);
  });
});
