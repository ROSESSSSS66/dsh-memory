import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../src/dsh/plugin.js';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { DEFAULTS } from '../../src/config.js';
import { callOfflineLLM } from '../../src/evolution/llm.js';
import { enqueueJob } from '../../src/jobs/scheduler.js';
import { getNextDayStartMs, runNextJob } from '../../src/jobs/runner.js';
import type { JobRecord } from '../../src/jobs/types.js';
import type { Db } from '../../src/types.js';

vi.mock('../../src/evolution/llm.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/evolution/llm.js')>(),
  callOfflineLLM: vi.fn(),
}));

describe('Registered offline job failure handling', () => {
  let db: Db;
  let tempDir: string;
  let dispose: () => Promise<void>;
  let memoryId: string;
  const cwd = '/audit/job-failures';
  const ws = workspaceId(cwd);
  const sessionId = 'failure-session';

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    vi.mocked(callOfflineLLM).mockReset();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-job-failures-'));
    const dbPath = path.join(tempDir, 'memory.db');
    await apply({
      agent: { cwd },
      on: (event: string, callback: () => Promise<void>) => {
        if (event === 'dispose') dispose = callback;
        return () => {};
      },
    }, { dbPath, autoBootstrap: false });
    expect(dispose).toBeTypeOf('function');
    db = openDb(dbPath);
    db.run(`INSERT INTO raw_events
      (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
      VALUES (?, 1, ?, 'user/message', ?, 1, 'user', 'user', 'Run pnpm build before vitest.', 0)`,
    [sessionId, ws, Date.now()]);
    for (let i = 0; i < 3; i++) {
      const result = upsertCandidate(db, {
        type: 'episodic',
        content: `Running vitest failed because dist/index.js was missing; pnpm build fixed case ${i}.`,
        slot_key: `build.case.${i}`, scope: 'workspace', workspaceId: ws,
        source_kind: 'user', actor: 'user', origin_kinds: ['user'], confidence: 0.9,
        sources: [{ session_id: `source-${i}`, seq: 1, kind: 'user', excerpt: 'pnpm build before vitest' }],
      });
      if (!('id' in result)) throw new Error(JSON.stringify(result));
      memoryId = result.id;
      db.run(`INSERT INTO injections
        (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, outcome, used, created_at)
        VALUES (?, 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1, 1, ?)`,
      [`source-${i}`, result.id, Date.now()]);
    }
  });

  afterEach(async () => {
    await dispose?.();
    db?.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const failures = [
    ['daily_tokens_exceeded', 'skipped'],
    ['daily_calls_exceeded', 'skipped'],
    ['daily_limit_exceeded', 'skipped'],
    ['network_error', 'queued'],
    ['timeout', 'queued'],
    ['http_429', 'queued'],
    ['http_503', 'queued'],
    ['http_401', 'failed'],
    ['json_parse_failed', 'failed'],
    ['privacy_offline_consent_required', 'failed'],
  ] as const;

  for (const kind of ['distill', 'reflect', 'consolidate', 'curate', 'repair', 'maintain']) {
    it.each(failures)(`${kind}: %s becomes %s with the correct recovery deadline`, async (error, status) => {
      vi.mocked(callOfflineLLM).mockResolvedValue({ ok: false, error });
      enqueueJob(db, {
        kind, key: 'failure-case',
        payload: { cwd, workspaceId: ws, sessionId, memoryId, turn: 1, query: 'build failure' },
      });
      expect(await runNextJob(db, DEFAULTS)).toBe(true);
      expect(callOfflineLLM).toHaveBeenCalledTimes(1);
      expect(vi.mocked(callOfflineLLM).mock.calls[0][1].jobKind).toBe(kind === 'maintain' ? 'curate' : kind);
      const job = db.get<JobRecord>('SELECT * FROM jobs')!;
      expect(job).toMatchObject({ status, error, attempts: 1 });
      if (status === 'skipped') {
        expect(job.next_eligible_at).toBe(getNextDayStartMs());
      } else if (status === 'queued') {
        expect(job.next_eligible_at).toBe(Date.now() + 60_000);
      }
      expect(db.get('SELECT processed FROM raw_events')?.processed).toBe(0);
      expect(db.all('SELECT * FROM repair_proposals')).toHaveLength(0);
      expect(db.all("SELECT * FROM memories WHERE status != 'active'")).toHaveLength(0);
    });
  }
});
