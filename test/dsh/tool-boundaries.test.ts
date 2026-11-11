import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { get } from '../../src/core/store.js';
import { workspaceId } from '../../src/core/scope.js';
import { budgetTokens } from '../../src/core/tokens.js';
import { getCoreMemory, setCoreMemory } from '../../src/core/core-memory.js';
import { approveCandidate, editContent, forget, freeze, upsertCandidate } from '../../src/core/writer.js';
import { MemoryTools } from '../../src/dsh/tools.js';
import { MemoryCommands } from '../../src/dsh/commands.js';
import type { CandidateInput, Db, MemoryRecord } from '../../src/types.js';

describe('Tool trust and scope boundaries', () => {
  let db: Db;
  let tools: MemoryTools;
  const ws = workspaceId('/audit/tools');
  const otherWs = workspaceId('/audit/other-tools');
  const ctx = { workspaceId: ws, sessionId: 'current-session', turn: 1 };

  beforeEach(() => {
    db = openDb();
    tools = new MemoryTools({ db });
  });

  afterEach(() => db.close());

  function seed(content: string, overrides: Partial<CandidateInput> = {}): string {
    const result = upsertCandidate(db, {
      type: 'semantic', content, summary: content, scope: 'workspace', workspaceId: ws,
      source_kind: 'user', actor: 'user', confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 'user-evidence', seq: 1, kind: 'user' }],
      ...overrides,
    });
    if (!('id' in result)) throw new Error(JSON.stringify(result));
    return result.id;
  }

  it.each(['full', 'short'] as const)('enforces workspace and session scope for %s IDs', (form) => {
    const foreign = seed('Foreign workspace details.', { workspaceId: otherWs });
    const hiddenSession = seed('Other session details.', { scope: 'session', sessionId: 'other-session' });
    const ownSession = seed('Current session details.', { scope: 'session', sessionId: ctx.sessionId });
    const shared = seed('Shared user preference.', { scope: 'user', type: 'preference' });
    const id = (value: string) => form === 'full' ? value : value.slice(0, 12);

    for (const hidden of [foreign, hiddenSession]) {
      expect(get(db, id(hidden), ctx)).toBeUndefined();
      expect(tools.expand({ id: id(hidden) }, ctx)).toContain('Error:');
      expect(tools.confirm({ id: id(hidden) }, ctx)).toContain('Error:');
    }
    expect(get(db, id(ownSession), ctx)?.id).toBe(ownSession);
    expect(tools.expand({ id: id(ownSession) }, ctx)).toContain('Current session details.');
    expect(get(db, id(shared), ctx)?.id).toBe(shared);
  });

  it('preserves unscoped administration lookups with omitted scope fields', () => {
    const foreign = seed('Foreign administrative record.', { workspaceId: otherWs });
    for (const id of [foreign, foreign.slice(0, 12)]) {
      expect(get(db, id)?.id).toBe(foreign);
      expect(get(db, id, { workspaceId: undefined })?.id).toBe(foreign);
    }
  });

  it('records only search results actually returned within the output budget', () => {
    const ids = Array.from({ length: 8 }, (_, i) => seed(
      `PostgreSQL database configuration ${i} uses a separate connection pool and timeout setting.`,
      { slot_key: `database.setting.${i}`, summary: `PostgreSQL database configuration ${i}: ${'details '.repeat(12)}` }
    ));
    const output = tools.search({ query: 'PostgreSQL database configuration', limit: 8 }, ctx);
    const visible = ids.filter(id => output.includes(id));
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(ids.length);
    expect(budgetTokens(output)).toBeLessThanOrEqual(800);
    const recorded = db.all<{ memory_id: string }>('SELECT memory_id FROM injections');
    expect(recorded.map(r => r.memory_id).sort()).toEqual([...visible].sort());
    const omitted = ids.find(id => !visible.includes(id))!;
    expect(tools.feedback({ id: omitted, contentRev: 1, helpful: true }, ctx)).toContain('not referenced');
  });

  it('does not attribute an oversized expansion that returns an error', () => {
    const id = seed(`PostgreSQL configuration: ${'db '.repeat(600)}`);
    expect(tools.expand({ id }, ctx)).toContain('exceeds token limit');
    expect(db.all('SELECT * FROM injections')).toHaveLength(0);
    expect(tools.feedback({ id, contentRev: 1, helpful: true }, ctx)).toContain('not referenced');
  });

  it('rejects feedback after a session changes workspace', () => {
    const id = seed('Foreign database configuration.', { workspaceId: otherWs });
    expect(tools.expand({ id }, { ...ctx, workspaceId: otherWs })).toContain(id);
    const before = get(db, id);
    expect(tools.feedback({ id, contentRev: 1, helpful: true }, ctx)).toContain('not found');
    expect(get(db, id)).toEqual(before);
  });

  it('filters expanded relation summaries before applying the relation limit', () => {
    const root = seed('Public root record.');
    const visible = seed('Visible related record.');
    db.run("INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', 1)", [root, visible]);
    for (let i = 0; i < 5; i++) {
      const hidden = seed(`Private related record ${i}.`, i % 2
        ? { scope: 'session', sessionId: 'other-session' }
        : { workspaceId: otherWs });
      db.run("INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', ?)", [root, hidden, i + 10]);
    }
    const output = tools.expand({ id: root }, ctx);
    expect(output).toContain('Visible related record.');
    expect(output).not.toContain('Private related record');
  });

  it.each(['human', 'persona', 'project'])('keeps model-written %s core memory pending user approval', (block) => {
    const output = tools.coreSet({ block, content: 'Model-proposed core policy.' }, ctx);
    expect(output).toContain('pending user approval');
    expect(getCoreMemory(db, block, ctx)).toBeNull();
    const proposal = db.get<MemoryRecord>('SELECT * FROM memories WHERE slot_key = ?', [`core:${block}`])!;
    expect(proposal.status).toBe('candidate');
    expect(proposal.approved_by).toBeNull();
    expect(proposal.source_kind).toBe('assistant');
    tools.confirm({ id: proposal.id }, ctx);
    expect(getCoreMemory(db, block, ctx)).toBeNull();
    expect(approveCandidate(db, proposal.id, 'user').action).toBe('approved');
    expect(getCoreMemory(db, block, ctx)?.content).toBe('Model-proposed core policy.');
  });

  it.each([false, true])('preserves existing core content on model set/append (frozen=%s)', (frozen) => {
    const original = setCoreMemory(db, 'project', 'User-approved project policy.', ctx);
    if (frozen) freeze(db, original.id);
    const before = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [original.id]);
    tools.coreSet({ block: 'project', content: 'Model replacement proposal.' }, ctx);
    tools.coreAppend({ block: 'project', text: 'Model appended proposal.' }, ctx);
    expect(db.get('SELECT * FROM memories WHERE id = ?', [original.id])).toEqual(before);
    const proposals = db.all<MemoryRecord>("SELECT * FROM memories WHERE status = 'candidate'");
    expect(proposals).toHaveLength(2);
    expect(proposals.some(m => m.content.includes('User-approved project policy.\nModel appended proposal.'))).toBe(true);
  });

  it('cannot launder user evidence by merging an approved record into a model proposal', () => {
    const approved = seed('Approved deployment requires review.');
    const proposal = seed('Model proposal disables deployment review.', {
      actor: 'llm', source_kind: 'assistant',
      sources: [{ session_id: ctx.sessionId, seq: 2, kind: 'assistant' }],
    });
    expect(tools.merge({ sourceId: approved, targetId: proposal }, ctx)).toContain('Error:');
    tools.confirm({ id: proposal }, ctx);
    expect(db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [approved])?.status).toBe('active');
    expect(db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [proposal])?.status).toBe('candidate');
    expect(db.get("SELECT 1 FROM memory_sources WHERE memory_id = ? AND kind = 'user'", [proposal])).toBeUndefined();
  });

  it('rejects model merging between workspace and shared ownership', () => {
    const source = seed('Workspace-specific deployment policy.');
    const shared = seed('Shared deployment policy.', { scope: 'user' });
    expect(tools.merge({ sourceId: source, targetId: shared }, ctx)).toContain('Error:');
    expect(db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [source])?.status).toBe('active');
  });

  it('enforces scope in history, rollback and restore command fallbacks', () => {
    const hidden = seed('Private original content.', { workspaceId: otherWs });
    editContent(db, hidden, 'Private updated content.');
    forget(db, hidden);
    const before = db.get('SELECT * FROM memories WHERE id = ?', [hidden]);
    const commands = new MemoryCommands(db);
    expect(commands.handleCommand(`history ${hidden}`, ctx).text).not.toContain('Private original');
    expect(commands.handleCommand(`rollback ${hidden} 1`, ctx).text).toContain('not found');
    expect(commands.restore(hidden, ctx)).toContain('not found');
    expect(db.get('SELECT * FROM memories WHERE id = ?', [hidden])).toEqual(before);

    const own = seed('Session proposal.', {
      scope: 'session', sessionId: ctx.sessionId, actor: 'llm', source_kind: 'assistant',
    });
    expect(commands.approve(own, ctx)).toContain('approved');
  });

  it('resolves short prefix IDs in feedback and handles ambiguous short IDs safely', () => {
    const target = seed('Redis connection timeout defaults to 5000ms.');
    const prefix = target.slice(0, 10);
    expect(tools.expand({ id: prefix }, ctx)).toContain('Redis connection timeout');

    const res = tools.feedback(
      { id: prefix, contentRev: 1, helpful: false, note: 'Outdated timeout' },
      ctx
    );
    expect(res).toBe('ok');

    const updated = get(db, target)!;
    expect(updated.fail_count).toBe(1);
    expect(updated.utility).toBeLessThan(0.5);
    const inj = db.get<{ outcome: number; used: number }>(
      'SELECT outcome, used FROM injections WHERE session_id = ? AND memory_id = ?',
      [ctx.sessionId, target]
    );
    expect(inj).toMatchObject({ outcome: -1, used: 1 });

    const job = db.get<{ payload: string }>("SELECT payload FROM jobs WHERE kind = 'repair'");
    expect(job).toBeDefined();
    expect(JSON.parse(job!.payload).memoryId).toBe(target);

    db.run(
      `INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES
      ('m_ambig011111111111', 'semantic', 'active', 'First entry.', 'First', 'workspace', ?, '["user"]', 'user', 0.9, 0.5, 0, 0, 0, 5, 2, 'ha1', 1, 1, 0, 1, 1),
      ('m_ambig022222222222', 'semantic', 'active', 'Second entry.', 'Second', 'workspace', ?, '["user"]', 'user', 0.9, 0.5, 0, 0, 0, 5, 2, 'ha2', 1, 1, 0, 1, 1)`,
      [ws, ws]
    );
    expect(tools.feedback({ id: 'm_ambig0', contentRev: 1, helpful: true }, ctx)).toContain('Ambiguous short id');
  });
});
