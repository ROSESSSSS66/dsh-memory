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
});
