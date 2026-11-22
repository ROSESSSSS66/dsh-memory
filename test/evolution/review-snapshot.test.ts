import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { upsertCandidate, editContent, freeze, pin } from '../../src/core/writer.js';
import {
  getUnchangedReviewedMemory,
  isProtectedFromModelDiscard,
  sameMemoryOwner,
} from '../../src/evolution/review-snapshot.js';
import { hydrateMemoryRow, type Db, type MemoryRecord, type MemoryRow } from '../../src/types.js';

describe('Review Snapshot & Model Mutation Guards (review-snapshot.ts)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function loadMem(id: string): MemoryRecord {
    return hydrateMemoryRow(db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id])!);
  }

  it('protects frozen, pinned, user/system-approved active, and cleanly user-evidenced active memories', () => {
    // 1. User-approved active memory -> protected
    const userRes = upsertCandidate(db, {
      type: 'semantic',
      content: 'Database is PostgreSQL 16.',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user', excerpt: 'PostgreSQL 16' }],
      actor: 'user',
    });
    const userId = (userRes as any).id;
    expect(isProtectedFromModelDiscard(db, loadMem(userId))).toBe(true);

    // 2. Candidate memory (even with user evidence) -> NOT protected from candidate review
    const candRes = upsertCandidate(db, {
      type: 'semantic',
      content: 'Candidate fact awaiting curation.',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'llm_extract',
      confidence: 0.8,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user', excerpt: 'Candidate fact' }],
      actor: 'llm',
    });
    const candId = (candRes as any).id;
    expect(isProtectedFromModelDiscard(db, loadMem(candId))).toBe(false);

    // 3. Active LLM-only memory (no user evidence, approved_by='llm-auto-update') -> NOT protected
    const llmRes = upsertCandidate(db, {
      type: 'semantic',
      content: 'Assistant-inferred temporary convention.',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'assistant',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 3, kind: 'assistant' }],
      actor: 'llm',
    });
    const llmId = (llmRes as any).id;
    db.run("UPDATE memories SET status = 'active', approved_by = 'llm-auto-update' WHERE id = ?", [llmId]);
    expect(isProtectedFromModelDiscard(db, loadMem(llmId))).toBe(false);

    // Pinning or freezing it immediately protects it
    pin(db, llmId);
    expect(isProtectedFromModelDiscard(db, loadMem(llmId))).toBe(true);
    db.run('UPDATE memories SET pinned = 0 WHERE id = ?', [llmId]);
    freeze(db, llmId);
    expect(isProtectedFromModelDiscard(db, loadMem(llmId))).toBe(true);
  });

  it('compares memory ownership strictly by scope, workspace_id, and session_id', () => {
    const a = { scope: 'workspace', workspace_id: 'ws1', session_id: null } as MemoryRecord;
    const b = { scope: 'workspace', workspace_id: 'ws1', session_id: null } as MemoryRecord;
    const c = { scope: 'workspace', workspace_id: 'ws2', session_id: null } as MemoryRecord;
    const d = { scope: 'user', workspace_id: null, session_id: null } as MemoryRecord;
    const e = { scope: 'session', workspace_id: 'ws1', session_id: 's1' } as MemoryRecord;
    const f = { scope: 'session', workspace_id: 'ws1', session_id: 's2' } as MemoryRecord;

    expect(sameMemoryOwner(a, b)).toBe(true);
    expect(sameMemoryOwner(a, c)).toBe(false);
    expect(sameMemoryOwner(a, d)).toBe(false);
    expect(sameMemoryOwner(e, f)).toBe(false);
  });

  it('getUnchangedReviewedMemory returns hydrated record only when completely unchanged and unpinned', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: 'Initial reviewed fact for snapshot check.',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const id = (res as any).id;
    const snap = loadMem(id);
    const reviewed = new Map<string, MemoryRecord>([[id, snap]]);

    // Unchanged -> returns hydrated MemoryRecord with parsed origin_kinds array
    const unchanged = getUnchangedReviewedMemory(db, reviewed, id);
    expect(unchanged).toBeDefined();
    expect(Array.isArray(unchanged!.origin_kinds)).toBe(true);
    expect(unchanged!.origin_kinds).toEqual(['user']);

    // Unknown id -> undefined
    expect(getUnchangedReviewedMemory(db, reviewed, 'm_unknown')).toBeUndefined();

    // Edited concurrently -> undefined
    editContent(db, id, 'Modified content after review snapshot.');
    expect(getUnchangedReviewedMemory(db, reviewed, id)).toBeUndefined();
  });
});
