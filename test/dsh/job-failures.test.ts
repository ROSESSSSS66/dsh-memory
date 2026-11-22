import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../../src/dsh/plugin.js';
import { registerPluginJobHandlers, parseJobPayload } from '../../src/dsh/job-handlers.js';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { callOfflineLLM } from '../../src/evolution/llm.js';
import { enqueueJob } from '../../src/jobs/scheduler.js';
import { JobRunner, getNextDayStartMs, runNextJob } from '../../src/jobs/runner.js';
import type { JobRecord } from '../../src/jobs/types.js';
import type { Db } from '../../src/types.js';

vi.mock('../../src/evolution/llm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/evolution/llm.js')>()),
  callOfflineLLM: vi.fn(),
}));

describe('Registered offline job failure handling (instance-scoped JobRunner)', () => {
  let db: Db;
  let runner: JobRunner;
  let unregisterHandlers: (() => void) | undefined;
  let memoryId: string;
  const cwd = '/audit/job-failures';
  const ws = workspaceId(cwd);
  const sessionId = 'failure-session';

  const consentCfg: PluginConfig = {
    ...DEFAULTS,
    privacy: {
      offlineConsent: true,
      allowedOfflineEndpoints: ['https://api.deepseek.com'],
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    vi.mocked(callOfflineLLM).mockReset();

    db = openDb(':memory:');
    runner = new JobRunner();
    unregisterHandlers = registerPluginJobHandlers(runner, {
      db,
      getLiveCfg: () => consentCfg,
    });

    db.run(
      `INSERT INTO raw_events
        (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES (?, 1, ?, 'user/message', ?, 1, 'user', 'user', 'Run pnpm build before vitest.', 0)`,
      [sessionId, ws, Date.now()]
    );
    for (let i = 0; i < 3; i++) {
      const result = upsertCandidate(db, {
        type: 'episodic',
        content: `Running vitest failed because dist/index.js was missing; pnpm build fixed case ${i}.`,
        slot_key: `build.case.${i}`,
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        actor: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        sources: [{ session_id: `source-${i}`, seq: 1, kind: 'user', excerpt: 'pnpm build before vitest' }],
      });
      if (!('id' in result)) throw new Error(JSON.stringify(result));
      memoryId = result.id;
      db.run(
        `INSERT INTO injections
          (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, outcome, used, created_at)
         VALUES (?, 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1, 1, ?)`,
        [`source-${i}`, result.id, Date.now()]
      );
    }
  });

  afterEach(() => {
    unregisterHandlers?.();
    db?.close();
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
    it.each(failures)(`${kind}: %s becomes %s with correct attempts and recovery deadline`, async (error, status) => {
      vi.mocked(callOfflineLLM).mockResolvedValue({ ok: false, error });
      enqueueJob(db, {
        kind,
        key: 'failure-case',
        payload: { cwd, workspaceId: ws, sessionId, memoryId, turn: 1, query: 'build failure' },
      });

      expect(await runner.runNextJob(db, consentCfg)).toBe(true);
      expect(callOfflineLLM).toHaveBeenCalledTimes(1);
      expect(vi.mocked(callOfflineLLM).mock.calls[0][1].jobKind).toBe(
        kind === 'maintain' ? 'curate' : kind
      );

      const job = db.get<JobRecord>('SELECT * FROM jobs')!;
      if (kind === 'maintain' && error === 'privacy_offline_consent_required') {
        // Unified maintenance succeeds locally even when LLM curate is skipped due to consent
        expect(job).toMatchObject({ status: 'done', error: null, attempts: 1 });
      } else {
        // Skipped jobs preserve attempts=0 so daily budget deferrals never exhaust failure retries
        const expectedAttempts = status === 'skipped' ? 0 : 1;
        expect(job).toMatchObject({ status, error, attempts: expectedAttempts });
        if (status === 'skipped') {
          expect(job.next_eligible_at).toBe(getNextDayStartMs());
        } else if (status === 'queued') {
          expect(job.next_eligible_at).toBe(Date.now() + 60_000);
        }
      }

      expect(db.get('SELECT processed FROM raw_events')?.processed).toBe(0);
      expect(db.all('SELECT * FROM repair_proposals')).toHaveLength(0);
      expect(db.all("SELECT * FROM memories WHERE status != 'active'")).toHaveLength(0);
    });
  }

  it('maintain completes as done locally when offlineConsent is false without invoking callOfflineLLM', async () => {
    const localOnlyRunner = new JobRunner();
    const unreg = registerPluginJobHandlers(localOnlyRunner, {
      db,
      getLiveCfg: () => DEFAULTS,
    });
    try {
      enqueueJob(db, { kind: 'maintain', key: 'local-only-maintain', payload: { workspaceId: ws } });
      expect(await localOnlyRunner.runNextJob(db, DEFAULTS)).toBe(true);
      expect(callOfflineLLM).not.toHaveBeenCalled();
      const job = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['local-only-maintain'])!;
      expect(job.status).toBe('done');
    } finally {
      unreg();
    }
  });

  it('parseJobPayload fails malformed JSON immediately as non-retryable without wasted retries', async () => {
    expect(parseJobPayload({ payload: '{broken json' })).toEqual({
      ok: false,
      failure: { action: 'failed', nonRetryable: true, error: 'malformed_payload' },
    });

    db.run(
      `INSERT INTO jobs (kind, key, payload, status, attempts, created_at, next_eligible_at)
       VALUES ('distill', 'corrupt-json', '{not-valid', 'queued', 0, ?, 0)`,
      [Date.now()]
    );
    expect(await runner.runNextJob(db, consentCfg)).toBe(true);
    const job = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['corrupt-json'])!;
    expect(job.status).toBe('failed');
    expect(job.error).toBe('malformed_payload');
    expect(callOfflineLLM).not.toHaveBeenCalled();
  });

  it('consolidate isolates per-cluster failures so remaining clusters and Hindsight reflect still execute', async () => {
    // Seed a second independent cluster (3 episodic memories sharing a distinct file entity)
    for (let i = 0; i < 3; i++) {
      const res = upsertCandidate(db, {
        type: 'episodic',
        content: `Deploying docker container failed because deploy/docker.yml was missing ENV PORT; rebuild fixed step ${i}.`,
        slot_key: `docker.deploy.${i}`,
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        actor: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        sources: [{ session_id: `docker-src-${i}`, seq: 1, kind: 'user', excerpt: 'deploy/docker.yml ENV PORT' }],
      });
      if (!('id' in res)) throw new Error(JSON.stringify(res));
      db.run(
        `INSERT INTO injections
          (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, outcome, used, created_at)
         VALUES (?, 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1, 1, ?)`,
        [`docker-src-${i}`, res.id, Date.now()]
      );
    }

    // First cluster fails, second cluster succeeds (returns valid empty no-op items)
    vi.mocked(callOfflineLLM)
      .mockResolvedValueOnce({ ok: false, error: 'http_503' })
      .mockResolvedValueOnce({
        ok: true,
        content: JSON.stringify({ items: [] }),
        inputTokens: 100,
        outputTokens: 20,
        model: 'test-model',
        ledgerId: 1,
      } as any);

    enqueueJob(db, { kind: 'consolidate', key: 'multi-cluster-isolation', payload: { workspaceId: ws } });
    expect(await runner.runNextJob(db, consentCfg)).toBe(true);
    // Both clusters were attempted despite cluster #1 failing
    expect(callOfflineLLM).toHaveBeenCalledTimes(2);
    const job = db.get<JobRecord>('SELECT * FROM jobs WHERE key = ?', ['multi-cluster-isolation'])!;
    expect(job.status).toBe('done');
  });

  it('plugin.apply registers handlers on an instance-scoped JobRunner and NEVER mutates global defaultJobRunner', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-runner-iso-'));
    let dispose: (() => Promise<void>) | undefined;
    try {
      const dbPath = path.join(tmpDir, 'memory.db');
      await apply(
        {
          on: (event: string, cb: () => Promise<void>) => {
            if (event === 'dispose') dispose = cb;
            return () => {};
          },
        },
        { dbPath, autoBootstrap: false }
      );
      expect(dispose).toBeTypeOf('function');

      // Global defaultJobRunner must NOT have plugin handlers registered
      const probeDb = openDb(':memory:');
      try {
        enqueueJob(probeDb, { kind: 'distill', key: 'global-isolation-check', payload: {} });
        await runNextJob(probeDb, DEFAULTS);
        const probeJob = probeDb.get<JobRecord>('SELECT * FROM jobs')!;
        expect(probeJob.status).toBe('failed');
        expect(probeJob.error).toBe('no_handler_registered_for_kind_distill');
      } finally {
        probeDb.close();
      }
    } finally {
      await dispose?.();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
