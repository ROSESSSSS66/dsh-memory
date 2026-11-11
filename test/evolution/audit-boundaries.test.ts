import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate, freeze, editContent, approveCandidate } from '../../src/core/writer.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { callOfflineLLM } from '../../src/evolution/llm.js';
import { distillSession, findEligibleDistillSession } from '../../src/evolution/extractor.js';
import { curateMemoriesWithLLM, cleanOldTelemetry } from '../../src/evolution/maintenance.js';
import { MemoryTools } from '../../src/dsh/tools.js';
import { SessionListener } from '../../src/dsh/session-listener.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { executeRepair, approveRepairProposal, listRepairProposals } from '../../src/evolution/repair.js';
import { autoHealMemoryHealth } from '../../src/core/health.js';
import { runReflectJob } from '../../src/evolution/reflector.js';
import { consolidateCluster } from '../../src/evolution/consolidator.js';
import type { JobRecord } from '../../src/jobs/types.js';
import type { CandidateInput, Db, MemoryRecord } from '../../src/types.js';

const publicPath = '/audit/public';
const privatePath = '/audit/private';
const ws = workspaceId(publicPath);
const privateWs = workspaceId(privatePath);
const text = 'The project database is PostgreSQL 16.';

function response(output: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(output) } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  }), { status: 200 });
}

describe('Offline data and mutation boundaries', () => {
  let db: Db;
  let cfg: PluginConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = {
      ...DEFAULTS,
      offlineLLM: { useDshLlm: false, baseURL: 'https://audit.invalid/v1', apiKeyEnv: '', model: 'audit' },
      privacy: { offlineConsent: true, allowedOfflineEndpoints: ['https://audit.invalid'] },
      excludeWorkspaces: [privatePath],
    };
  });

  afterEach(() => db.close());

  function seed(content: string, extra: Partial<CandidateInput> = {}): string {
    const result = upsertCandidate(db, {
      type: 'semantic', content, scope: 'workspace', workspaceId: ws,
      source_kind: 'user', origin_kinds: ['user'], confidence: 0.9,
      sources: [{ session_id: 'source', seq: 1, kind: 'user', excerpt: content }],
      actor: 'user', ...extra,
    });
    if (!('id' in result)) throw new Error(result.reason);
    return result.id;
  }

  function event(sessionId = 'public-session', owner = ws, seq = 1): void {
    db.run(`INSERT INTO raw_events
      (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
      VALUES (?, ?, ?, 'user/message', ?, 1, 'user', 'user', ?, 0)`,
    [sessionId, seq, owner, Date.now(), text]);
  }

  function memory(id: string): MemoryRecord {
    return db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
  }

  it('checks the data owner even when the caller cwd is public', async () => {
    event('private-session', privateWs);
    const fetchFn = vi.fn(async () => response({ items: [] }));
    const result = await distillSession(db, cfg, {
      sessionId: 'private-session', cwd: publicPath, fetchFn,
    });
    expect(result).toMatchObject({ success: false, error: 'workspace_excluded', consumedCount: 0 });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(db.get('SELECT processed FROM raw_events')?.processed).toBe(0);
  });

  it.each(['reflect', 'repair', 'consolidate', 'legacy-repair', 'legacy-consolidate'] as const)('blocks excluded owners in %s', async (operation) => {
    event('private-source', privateWs);
    const id = seed(text, {
      scope: 'global', sources: [{ session_id: 'private-source', seq: 1, kind: 'user', excerpt: text }],
    });
    const fetchFn = vi.fn(async () => response({ items: [] }));
    if (operation.startsWith('legacy')) {
      db.run('DELETE FROM raw_events');
      db.run('DELETE FROM session_workspace_owners');
    }
    if (operation === 'reflect') {
      const result = await runReflectJob(db, cfg, {
        payload: JSON.stringify({ sessionId: 'private-source', turn: 1, cwd: publicPath, workspaceId: ws }),
      } as JobRecord, undefined, fetchFn);
      expect(result).toMatchObject({ action: 'failed', error: 'workspace_excluded' });
    } else if (operation.endsWith('repair')) {
      db.run('DELETE FROM raw_events');
      const result = await executeRepair(db, {
        id: 1, key: 'private-repair',
        payload: JSON.stringify({ memoryId: id, sessionId: 'public-session', query: 'Repair', turn: 1 }),
      }, { fetchFn }, cfg);
      expect(result).toMatchObject({ action: 'failed', error: 'workspace_excluded' });
    } else {
      const m = memory(id);
      const result = await consolidateCluster(db, cfg, {
        clusterKey: 'private-cluster', workspaceId: ws,
        memories: [m], snapshots: [{ ...m, valid_from: m.valid_from ?? null }], distinctSuccessfulSessions: [],
      }, { fetchFn });
      expect(result).toMatchObject({ success: false, error: 'workspace_excluded' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('skips excluded sessions while finding an eligible public batch', () => {
    event('private-session', privateWs);
    event('private-session', ws, 2);
    event();
    expect(findEligibleDistillSession(db, cfg, true)?.sessionId).toBe('public-session');
    expect(findEligibleDistillSession(db, cfg, true, 'private-session')).toBeNull();
  });

  it.each([false, true])('filters private global memories even after telemetry cleanup=%s', async (cleanup) => {
    const privateId = seed('Private release credential policy.', { workspaceId: privateWs });
    event('private-source', privateWs);
    const globalId = seed('Private global deployment information.', {
      scope: 'global', sources: [{ session_id: 'private-source', seq: 1, kind: 'user' }],
    });
    const publicId = seed(text);
    const unknownOwnerId = seed('Legacy shared information with expired source ownership.', {
      scope: 'global', sources: [{ session_id: 'expired-source', seq: 1, kind: 'user' }],
    });
    if (cleanup) {
      db.run('UPDATE raw_events SET processed = 2');
      expect(cleanOldTelemetry(db, Date.now() + 31 * 86400_000).deletedEvents).toBe(1);
    }
    let body = '';
    const result = await curateMemoriesWithLLM(db, cfg, {
      cwd: publicPath,
      fetchFn: async (_url, init) => {
        body = String(init?.body);
        return response({ discard_ids: [], updates: [] });
      },
    });
    expect(result.ok).toBe(true);
    expect(body).toContain(publicId);
    expect(body).not.toContain(privateId);
    expect(body).not.toContain(globalId);
    expect(body).not.toContain(unknownOwnerId);
  });

  it('redacts cookie values before ingestion and again before outbound transmission', async () => {
    const secret = 'auditSyntheticSessionCookie000000000000';
    const queue = new IngestQueue(db, cfg);
    try {
      new SessionListener(queue, cfg).handleEvent(
        { id: 'cookie-session', cwd: publicPath },
        { type: 'tool/result', seq: 1, data: { text: `Cookie: session=${secret}` } },
      );
      await queue.flush();
      expect(db.get('SELECT text FROM raw_events')?.text).not.toContain(secret);
      let body = '';
      const result = await distillSession(db, cfg, {
        sessionId: 'cookie-session', cwd: publicPath,
        fetchFn: async (_url, init) => {
          body = String(init?.body);
          return response({ items: [] });
        },
      });
      expect(result.success).toBe(true);
      expect(body).not.toContain(secret);
    } finally {
      await queue.close();
    }
  });

  it.each(['discard', 'supersede'] as const)('ignores a foreign memory ID supplied via %s', async (action) => {
    const victim = seed('Another project uses Redis 7.', { workspaceId: workspaceId('/audit/other') });
    event();
    let body = '';
    const result = await distillSession(db, cfg, {
      sessionId: 'public-session', cwd: publicPath,
      fetchFn: async (_url, init) => {
        body = String(init?.body);
        return response(action === 'discard'
          ? { items: [], discard_ids: [victim] }
          : { items: [{
            type: 'semantic', text, scope: 'workspace', confidence: 0.9,
            supersedes_id: victim, evidence: [{ seq: 1, quote: text }],
          }] });
      },
    });
    expect(result.success).toBe(true);
    expect(body).not.toContain(victim);
    expect(memory(victim).status).toBe('active');
  });

  it('does not supersede a shared memory with a workspace-local replacement', async () => {
    const victim = seed('The user prefers SQLite for all personal projects.', { scope: 'user' });
    event();
    await distillSession(db, cfg, {
      sessionId: 'public-session', cwd: publicPath,
      fetchFn: async () => response({ items: [{
        type: 'semantic', text, scope: 'workspace', confidence: 0.9,
        supersedes_id: victim, evidence: [{ seq: 1, quote: text }],
      }] }),
    });
    expect(memory(victim).status).toBe('active');
  });

  it.each(['freeze', 'edit', 'pin'] as const)('ignores stale distill discard after a concurrent %s', async (change) => {
    const id = seed(text);
    event();
    await distillSession(db, cfg, {
      sessionId: 'public-session', cwd: publicPath,
      fetchFn: async () => {
        if (change === 'freeze') freeze(db, id);
        if (change === 'edit') editContent(db, id, 'The user updated the database to PostgreSQL 17.');
        if (change === 'pin') db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [id]);
        return response({ items: [], discard_ids: [id] });
      },
    });
    expect(memory(id).status).toBe(change === 'freeze' ? 'frozen' : 'active');
  });

  it.each(['discard', 'update', 'absorb'] as const)('does not apply stale curate %s after a freeze', async (action) => {
    const id = seed(text);
    const other = seed('Database migrations must run before starting the service.');
    await curateMemoriesWithLLM(db, cfg, {
      workspaceId: ws,
      fetchFn: async () => {
        freeze(db, id);
        return response({
          discard_ids: action === 'discard' ? [id] : [],
          updates: action === 'discard' ? [] : [{
            target_id: action === 'update' ? id : other,
            text: 'Database maintenance requires a verified backup before migration.',
            type: 'semantic', confidence: 0.9,
            absorb_ids: action === 'absorb' ? [id] : [],
          }],
        });
      },
    });
    expect(memory(id)).toMatchObject({ status: 'frozen', content: text });
  });

  it('preserves a user edit made while curate is awaiting its response', async () => {
    const id = seed(text);
    const userEdit = 'The user selected PostgreSQL 17 for the project.';
    await curateMemoriesWithLLM(db, cfg, {
      workspaceId: ws,
      fetchFn: async () => {
        editContent(db, id, userEdit);
        return response({ discard_ids: [], updates: [{
          target_id: id, text: 'The obsolete model answer selects SQLite.',
          type: 'semantic', confidence: 0.9,
        }] });
      },
    });
    expect(memory(id).content).toBe(userEdit);
  });

  it.each(['pin', 'new-slot'] as const)('preserves a protected curate dependency after %s', async (change) => {
    const id = seed(text);
    let occupant = change === 'pin'
      ? seed('Keep the existing database maintenance policy.', { slot_key: 'project.maintenance' }) : '';
    await curateMemoriesWithLLM(db, cfg, {
      workspaceId: ws,
      fetchFn: async () => {
        if (change === 'pin') db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [occupant]);
        else occupant = seed('Keep the existing database maintenance policy.', { slot_key: 'project.maintenance' });
        return response({ discard_ids: [], updates: [{
          target_id: id, text: 'Replace the protected database maintenance policy.',
          type: 'semantic', confidence: 0.9, slot_key: 'project.maintenance',
        }] });
      },
    });
    expect(memory(id).content).toBe(text);
    expect(memory(occupant).status).toBe('active');
  });

  it.each(['freeze', 'edit', 'pin', 'blocked-slot'] as const)('does not invalidate a distill target after %s', async (change) => {
    const id = seed('The project previously used SQLite as its primary database.');
    event();
    const edited = 'The user explicitly chose MariaDB after reviewing the database plan.';
    await distillSession(db, cfg, {
      sessionId: 'public-session', cwd: publicPath,
      fetchFn: async () => {
        if (change === 'freeze') freeze(db, id);
        if (change === 'edit') editContent(db, id, edited);
        if (change === 'pin') db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [id]);
        if (change === 'blocked-slot') {
          const occupant = seed('The database policy requires explicit user approval.', { slot_key: 'project.database' });
          freeze(db, occupant);
        }
        return response({ items: [{
          type: 'semantic', text, scope: 'workspace', confidence: 0.9, slot_key: 'project.database',
          supersedes_id: id, evidence: [{ seq: 1, quote: text }],
        }] });
      },
    });
    expect(memory(id).status).toBe(change === 'freeze' ? 'frozen' : 'active');
    if (change === 'edit') expect(memory(id).content).toBe(edited);
  });

  it('keeps assistant-derived replacements from superseding active user memories', async () => {
    const id = seed('The project previously used SQLite as its primary database.');
    event();
    db.run("UPDATE raw_events SET origin_kind = 'assistant', role = 'assistant', type = 'assistant/message'");
    await distillSession(db, cfg, {
      sessionId: 'public-session', cwd: publicPath,
      fetchFn: async () => response({ items: [{
        type: 'semantic', text, scope: 'workspace', confidence: 0.99,
        supersedes_id: id, evidence: [{ seq: 1, quote: text }],
      }] }),
    });
    expect(memory(id).status).toBe('active');
  });

  it('cannot self-approve an assistant note through confirm and heal', () => {
    const tools = new MemoryTools({ db, cfg });
    const saved = tools.note({ content: text, kind: 'fact' }, { workspaceId: ws, sessionId: 'note', turn: 1 });
    const id = saved.match(/m_[a-z0-9_]+/)![0];
    tools.confirm({ id }, { workspaceId: ws });
    tools.heal({ workspaceId: ws });
    expect(memory(id).status).toBe('candidate');
  });

  it('curation cannot promote an assistant-only candidate', async () => {
    const id = seed(text, { actor: 'llm', source_kind: 'assistant', origin_kinds: ['assistant'],
      sources: [{ session_id: 'note', seq: 0, kind: 'assistant' }] });
    await curateMemoriesWithLLM(db, cfg, {
      workspaceId: ws,
      fetchFn: async () => response({ discard_ids: [], updates: [{
        target_id: id, text: 'PostgreSQL 16 is the chosen database engine.',
        type: 'semantic', confidence: 0.99,
      }] }),
    });
    expect(memory(id).status).toBe('candidate');
  });

  it('requires current-revision user evidence while preserving explicit approval', () => {
    const id = seed(text, { actor: 'llm' });
    expect(approveCandidate(db, id, 'autonomous')).toMatchObject({ action: 'approved' });
    const stale = seed('A different proposed database is PostgreSQL 17.', { actor: 'llm' });
    editContent(db, stale, 'A completely different proposal now selects MongoDB.');
    expect(approveCandidate(db, stale, 'autonomous')).toHaveProperty('reason');
    expect(memory(stale).status).toBe('candidate');
    expect(approveCandidate(db, stale, 'user')).toMatchObject({ action: 'approved' });
  });

  it('rejects autonomous repair approval of an assistant-only candidate', () => {
    const id = seed(text);
    const candidate = seed('The assistant now suggests SQLite for the database.', {
      actor: 'llm', source_kind: 'assistant', origin_kinds: ['assistant'],
      sources: [{ session_id: 'assistant-note', seq: 1, kind: 'assistant' }],
    });
    db.run(`INSERT INTO repair_proposals
      (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
      VALUES (1, ?, 1, 'revise', ?, 'test', 'candidate', ?, ?)`,
    [id, JSON.stringify([candidate]), Date.now(), Date.now() + 86400_000]);
    const proposalId = db.get('SELECT id FROM repair_proposals')!.id;
    expect(approveRepairProposal(db, proposalId, 'autonomous')).toMatchObject({ ok: false });
    expect(memory(id).status).toBe('active');
    expect(memory(candidate).status).toBe('candidate');
  });

  it.each(['revise', 'invalidate'] as const)('blocks autonomous approval of LLM %s repair proposals even when target has user evidence', async (action) => {
    const id = seed(text);
    const result = await executeRepair(db, {
      id: action === 'revise' ? 11 : 12,
      key: `repair-${action}`,
      payload: JSON.stringify({ memoryId: id, sessionId: 'public-session', query: 'Update DB', turn: 1 }),
    }, {
      fetchFn: async () => response(action === 'revise'
        ? {
          action: 'revise',
          reason: 'Model proposes changing database engine.',
          items: [{
            type: 'semantic',
            text: 'The project database is PostgreSQL 17 with read replicas.',
            confidence: 0.99,
            scope: 'workspace',
            evidence: [{ seq: 1, quote: text }],
          }],
        }
        : {
          action: 'invalidate',
          reason: 'Model proposes archiving user-confirmed fact.',
          items: [],
        }),
    }, cfg);
    expect(result.action).toBe('done');

    const [proposal] = listRepairProposals(db, 'candidate');
    expect(proposal).toBeDefined();
    if (action === 'revise') {
      const candId = proposal.candidateIds[0];
      expect(memory(candId).source_kind).toBe('llm_extract');
      const srcKinds = db.all<{ kind: string }>('SELECT kind FROM memory_sources WHERE memory_id = ?', [candId]);
      expect(srcKinds.every(s => s.kind === 'llm_repair')).toBe(true);
    }

    expect(approveRepairProposal(db, proposal.id, 'autonomous')).toMatchObject({ ok: false });
    const healRes = autoHealMemoryHealth(db, { workspaceId: ws });
    expect(healRes.repairsApplied).toBe(0);
    expect(memory(id).status).toBe('active');
    expect(listRepairProposals(db, 'candidate')).toHaveLength(1);

    // Explicit user approval remains functional.
    expect(approveRepairProposal(db, proposal.id, 'user')).toMatchObject({ ok: true });
    expect(memory(id).status).toBe(action === 'revise' ? 'superseded' : 'archived');
  });

  it('scopes autoHealMemoryHealth repair proposals to the requested workspace', () => {
    const otherWs = workspaceId('/audit/foreign');
    const foreignTarget = seed('Foreign service runs on port 4000.', { workspaceId: otherWs, slot_key: 'foreign.port' });
    const foreignCand = seed('Foreign service runs on port 4001.', {
      workspaceId: otherWs,
      slot_key: 'foreign.port',
      actor: 'llm',
      source_kind: 'assistant',
      status: 'candidate',
      origin_kinds: ['user'],
      sources: [{ session_id: 's_foreign', seq: 1, kind: 'user' }],
    });
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
       VALUES (1, ?, 1, 'revise', ?, 'foreign update', 'candidate', ?, ?)`,
      [foreignTarget, JSON.stringify([foreignCand]), Date.now(), Date.now() + 86400_000]
    );

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws });
    expect(healRes.repairsApplied).toBe(0);
    expect(memory(foreignTarget).status).toBe('active');
    expect(memory(foreignCand).status).toBe('candidate');
  });

  it('preserves user sources across curate edits, blocks evidence laundering, and isolates savepoint errors', async () => {
    const activeTarget = seed(text, {
      sources: [{ session_id: 's-target', seq: 1, kind: 'user', excerpt: text }],
    });
    const absorbedActive = seed('PostgreSQL 16 runs with TLS enabled by default.', {
      sources: [{ session_id: 's-abs', seq: 2, kind: 'user', excerpt: 'TLS enabled by default' }],
    });
    const unapprovedAssistant = seed('Assistant thinks dark mode might be enabled.', {
      actor: 'llm',
      source_kind: 'assistant',
      status: 'candidate',
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's-assist', seq: 1, kind: 'assistant' }],
    });
    const userCand = seed('The user confirmed indentation uses two spaces.', {
      actor: 'llm',
      source_kind: 'assistant',
      status: 'candidate',
      origin_kinds: ['user'],
      sources: [{ session_id: 's-ucand', seq: 1, kind: 'user' }],
    });
    const secretTarget = seed('Temporary build note about release artifacts.');
    const discardCand = seed('Obsolete assistant speculation.', {
      actor: 'llm',
      source_kind: 'assistant',
      status: 'candidate',
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's-disc', seq: 1, kind: 'assistant' }],
    });

    const curateRes = await curateMemoriesWithLLM(db, cfg, {
      workspaceId: ws,
      fetchFn: async () => response({
        discard_ids: [discardCand],
        updates: [
          {
            // Throws sensitive_content_detected inside editContent; must not abort sibling update/discard
            target_id: secretTarget,
            text: 'Use database url postgres://admin:superSecretPassword123@db.internal:5432/prod',
            type: 'semantic',
            confidence: 0.9,
          },
          {
            // Assistant candidate must not absorb a user-evidenced candidate
            target_id: unapprovedAssistant,
            absorb_ids: [userCand],
            text: 'Dark mode and two-space indentation enabled.',
            type: 'preference',
            confidence: 0.95,
          },
          {
            // Valid update + absorb preserves sources under content_rev = 2
            target_id: activeTarget,
            absorb_ids: [absorbedActive],
            text: 'The project database is PostgreSQL 16 with TLS enabled by default.',
            type: 'semantic',
            confidence: 0.96,
          },
        ],
      }),
    });

    expect(curateRes.ok).toBe(true);
    expect(curateRes.llmDiscarded).toBe(1);
    expect(curateRes.llmUpdated).toBe(1);
    expect(memory(discardCand).status).toBe('rejected');
    expect(memory(secretTarget).content).toBe('Temporary build note about release artifacts.');
    expect(memory(unapprovedAssistant).status).toBe('candidate');
    expect(memory(userCand).status).toBe('candidate');

    const updated = memory(activeTarget);
    expect(updated.content_rev).toBe(2);
    expect(memory(absorbedActive).status).toBe('superseded');
    const rev2Sources = db.all<{ session_id: string; kind: string }>(
      'SELECT session_id, kind FROM memory_sources WHERE memory_id = ? AND content_rev = ?',
      [activeTarget, updated.content_rev]
    );
    expect(rev2Sources).toEqual(expect.arrayContaining([
      { session_id: 's-target', kind: 'user' },
      { session_id: 's-abs', kind: 'user' },
    ]));
  });
  it('does not forward private request bodies through a cross-origin redirect', async () => {
    let received = 0;
    const destination = createServer((req, res) => {
      received++;
      req.resume();
      res.end(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }));
    });
    const listen = (server: Server) => new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
    const close = (server: Server) => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close(err => err ? reject(err) : resolve());
    });
    const destinationUrl = await listen(destination);
    const redirect = createServer((req, res) => {
      req.resume();
      res.writeHead(307, { Location: destinationUrl });
      res.end();
    });
    const originUrl = await listen(redirect);
    try {
      const result = await callOfflineLLM(db, {
        jobKind: 'distill', promptVersion: 'audit', systemPrompt: 'System',
        userPrompt: 'Synthetic private memory data.', maxOutputTokens: 100,
        cwd: publicPath, workspaceId: ws,
      }, { ...cfg, offlineLLM: { ...cfg.offlineLLM, baseURL: originUrl },
        privacy: { offlineConsent: true, allowedOfflineEndpoints: [originUrl] } });
      expect(result.ok).toBe(false);
      expect(received).toBe(0);
    } finally {
      await close(redirect);
      await close(destination);
    }
  });
});
