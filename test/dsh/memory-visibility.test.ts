import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { upsertCandidate, editContent } from '../../src/core/writer.js';
import { DEFAULTS } from '../../src/config.js';
import { PromptSectionManager, renderStableLayer } from '../../src/dsh/prompt-section.js';
import { handlePreStep } from '../../src/dsh/pre-step.js';
import {
  emptyMemoryVisibility, foldMemoryVisibility, visibleMemoryRefs,
  memoryVisibilityProjection, registerMemoryVisibility, MEMORY_VISIBILITY_KEY,
} from '../../src/dsh/memory-visibility.js';
import { visibilityHarness } from '../helpers/visibility.js';
import { runCase } from '../../src/eval/runner.js';
import { validateAndClampStrategy } from '../../src/evolution/strategy.js';
import { DEFAULT_STRATEGY } from '../../src/retrieval/fuse.js';
import type { Db } from '../../src/types.js';

const fullId = 'm_1234567890abcdef';
const secondId = 'm_abcdef1234567890';
const committed = (seq: number, id = fullId, contentRev = 1) => ({
  type: 'user/message', seq, surfaceOp: { op: 'append' },
  data: { id: `msg-${seq}`, source: { kind: 'plugin', plugin: 'dsh-memory', memoryRefs: [{ id, contentRev }] } },
});

describe('Committed memory visibility projection', () => {
  it.each(['compaction/start', 'compaction/end', 'compaction/summary'])('preserves references on %s including failure/cancel', (type) => {
    const state = foldMemoryVisibility(emptyMemoryVisibility(), committed(10));
    const after = foldMemoryVisibility(state, {
      type, seq: 20, data: { error: 'failed', cancelled: true },
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 19 }, sourceEventSeqs: [10],
    });
    expect(visibleMemoryRefs(after)).toEqual(new Set([`${fullId}@1`]));
  });

  it('requires both interval coverage and explicit sourceEventSeqs for partial replacement', () => {
    const events = [committed(10), committed(20, secondId), committed(30)];
    let state = events.reduce(foldMemoryVisibility, emptyMemoryVisibility());
    state = foldMemoryVisibility(state, {
      type: 'user/message', seq: 40, data: { id: 'summary' },
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 20 },
      sourceEventSeqs: [10, 30],
    });
    expect(state.visibleInjections.map(item => item.seq)).toEqual([20, 30]);
    expect(visibleMemoryRefs(state)).toEqual(new Set([`${fullId}@1`, `${secondId}@1`]));
    state = foldMemoryVisibility(state, {
      type: 'user/message', seq: 41, data: { id: 'summary-2' },
      surfaceOp: { op: 'replace', startSeq: 30, endSeq: 30 }, sourceEventSeqs: [30],
    });
    expect(visibleMemoryRefs(state)).toEqual(new Set([`${secondId}@1`]));
  });

  it('uses only top-level replacement metadata and adds new references after removing covered nodes', () => {
    const before = foldMemoryVisibility(emptyMemoryVisibility(), committed(10));
    const ignored = foldMemoryVisibility(before, {
      type: 'user/message', seq: 20,
      data: { surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 }, sourceEventSeqs: [10] },
    });
    expect(visibleMemoryRefs(ignored)).toEqual(visibleMemoryRefs(before));
    const after = foldMemoryVisibility(before, {
      ...committed(30, secondId, 2),
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 }, sourceEventSeqs: [10],
    });
    expect(visibleMemoryRefs(after)).toEqual(new Set([`${secondId}@2`]));
  });

  it('rebuilds identical references from persisted events on restart and inherited fork logs', () => {
    const events = [committed(10), committed(20, fullId, 2)];
    const parent = events.reduce(foldMemoryVisibility, emptyMemoryVisibility());
    const restart = JSON.parse(JSON.stringify(events)).reduce(foldMemoryVisibility, memoryVisibilityProjection.init());
    const fork = events.reduce(foldMemoryVisibility, memoryVisibilityProjection.init());
    expect(restart).toEqual(parent);
    expect(fork).toEqual(parent);
    expect(memoryVisibilityProjection.stateVersion).toBe(2);
  });

  it.each([undefined, [{ id: 'm_1234', contentRev: 1 }], [{ id: fullId, contentRev: 0 }]])(
    'rejects missing, abbreviated, or invalid references: %j', (memoryRefs) => {
      const event = committed(10);
      (event.data.source as any).memoryRefs = memoryRefs;
      const state = foldMemoryVisibility(emptyMemoryVisibility(), event);
      expect(visibleMemoryRefs(state).size).toBe(0);
      expect(state.invalidReferenceEvents).toBe(1);
    }
  );

  it.each(['stateOf', 'snapshot'])('registers and reads through the host %s API', async (method) => {
    const state = foldMemoryVisibility(emptyMemoryVisibility(), committed(10));
    const dispose = vi.fn();
    const register = vi.fn(async (definition) => {
      expect(definition.stateSchema.parse(state)).toEqual(state);
      expect(definition.schema.parse(definition.view(state))).toEqual(state);
      return dispose;
    });
    const service = { register, [method]: () => method === 'stateOf' ? state : { values: { [MEMORY_VISIBILITY_KEY]: state } } };
    const reader = await registerMemoryVisibility({ sessionProjections: service });
    expect(reader.getVisibleRefs({ id: 'session' })).toEqual(new Set([`${fullId}@1`]));
    reader.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe('Injection lifecycle and zero budgets', () => {
  let db: Db;
  let visibility: ReturnType<typeof visibilityHarness>;
  let promptSections: PromptSectionManager;
  let id: string;
  const session = { id: 'visibility-session', cwd: '/visibility-test' };
  beforeEach(() => {
    db = openDb(':memory:');
    visibility = visibilityHarness(db);
    promptSections = new PromptSectionManager(db);
    const saved = upsertCandidate(db, {
      type: 'semantic', content: 'The project database is PostgreSQL 16.',
      scope: 'workspace', workspaceId: session.cwd, source_kind: 'user',
      origin_kinds: ['user'], confidence: 0.9, actor: 'user',
      sources: [{ session_id: 'source', seq: 1, kind: 'user' }],
    });
    if (!('id' in saved)) throw new Error(saved.reason);
    id = saved.id;
  });
  afterEach(async () => { await visibility.close(); db.close(); });

  async function step(turn: number, cfg = DEFAULTS) {
    return handlePreStep({
      turn, session,
      agent: { id: 'visibility-agent', session, ctx: { systemPrompt: { section: () => () => {} } } },
    }, async () => ({
      kind: 'enter',
      messages: [{ id: `user-${turn}`, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: 'What database does the project use?' }] }],
    }), { db, promptSections, cfg, getVisibleRefs: visibility.getVisibleRefs });
  }

  it('does not count or deduplicate a message that was never committed', async () => {
    const first = await step(1);
    expect(first.messages).toHaveLength(2);
    expect(db.all('SELECT * FROM injections')).toHaveLength(0);
    expect(db.get('SELECT use_count FROM memories WHERE id = ?', [id])?.use_count).toBe(0);
    expect((await step(2)).messages).toHaveLength(2);
    await visibility.commitEvent(session, { type: 'user/message', seq: 10, data: first.messages[1] });
    await visibility.commitEvent(session, { type: 'user/message', seq: 10, data: first.messages[1] });
    expect(db.all('SELECT * FROM injections')).toHaveLength(1);
    expect(db.get('SELECT use_count FROM memories WHERE id = ?', [id])?.use_count).toBe(1);
    expect((await step(3)).messages).toHaveLength(1);
  });

  it('keeps failed compaction deduplication and reinjects after a committed covering replacement', async () => {
    const first = await step(1);
    await visibility.commitEvent(session, { type: 'user/message', seq: 10, data: first.messages[1] });
    await visibility.commitEvent(session, { type: 'compaction/end', seq: 20, data: { error: 'failed' } });
    expect((await step(2)).messages).toHaveLength(1);
    await visibility.commitEvent(session, {
      type: 'user/message', seq: 30, data: { id: 'summary', text: 'Database summary with a short code m_1234' },
      surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 }, sourceEventSeqs: [10],
    });
    expect((await step(3)).messages).toHaveLength(2);
  });

  it('injects a new content revision while the old revision remains visible', async () => {
    const first = await step(1);
    await visibility.commitEvent(session, { type: 'user/message', seq: 10, data: first.messages[1] });
    editContent(db, id, 'The project database is PostgreSQL 17.');
    const next = await step(2);
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].source.memoryRefs).toEqual([{ id, contentRev: 2 }]);
  });

  it('honors zero stable and dynamic budgets', async () => {
    db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [id]);
    const cfg = { ...DEFAULTS, stableBudgetTokens: 0, dynamicBudgetTokens: 0 };
    expect(renderStableLayer(db, { workspaceId: session.cwd }, cfg).text).toBe('');
    expect((await step(1, cfg)).messages).toHaveLength(1);
    expect(validateAndClampStrategy(DEFAULT_STRATEGY, cfg).dynamicBudgetTokens).toBe(0);
    expect(validateAndClampStrategy({ ...DEFAULT_STRATEGY, dynamicBudgetTokens: 0 }).dynamicBudgetTokens).toBe(0);
    const result = runCase({
      id: 'zero-budget', suite: 'factual', critical: true, now: '2026-11-11T12:00:00Z',
      workspace: session.cwd, setup: [{
        type: 'semantic', content: 'The project database is PostgreSQL 16.', pinned: 1,
      }], query: 'What database does the project use?', expect: { include: [], exclude: ['PostgreSQL'] },
    }, undefined, cfg);
    expect(result.pass).toBe(true);
  });

  it('disables dynamic injection independently of the stable layer', async () => {
    expect((await step(1)).messages).toHaveLength(2);
    const cfg = { ...DEFAULTS, dynamicBudgetTokens: 0 };
    expect(renderStableLayer(db, { workspaceId: session.cwd }, cfg).visibleRefs.size).toBe(0);
    expect((await step(2, cfg)).messages).toHaveLength(1);
    const result = runCase({
      id: 'zero-dynamic-budget', suite: 'factual', critical: true, now: '2026-11-11T12:00:00Z',
      workspace: session.cwd, setup: [{
        type: 'semantic', content: 'The project database is PostgreSQL 16.', pinned: 0,
      }], query: 'What database does the project use?', expect: { include: [], exclude: ['PostgreSQL'] },
    }, undefined, cfg);
    expect(result.pass).toBe(true);
  });

  it('accepts format v4 producer-owned source kind (kind: dsh-memory)', () => {
    const v4Committed = {
      type: 'user/message', seq: 15, surfaceOp: { op: 'append' },
      data: { id: 'msg-15', source: { kind: 'dsh-memory', plugin: 'dsh-memory', memoryRefs: [{ id: fullId, contentRev: 1 }] } },
    };
    const state = foldMemoryVisibility(emptyMemoryVisibility(), v4Committed);
    expect(visibleMemoryRefs(state)).toEqual(new Set([`${fullId}@1`]));
  });

  it('prefers handle.stateOf over deprecated sessionProjections.stateOf', async () => {
    const dummySession = { id: 'sess-test' };
    const mockHandle = {
      stateOf: vi.fn().mockReturnValue({ visibleInjections: [{ messageId: 'm1', seq: 1, refs: [{ id: fullId, contentRev: 1 }] }], invalidReferenceEvents: 0 }),
      dispose: vi.fn(),
    };
    const mockCtx = {
      sessionProjections: {
        register: vi.fn().mockResolvedValue(mockHandle),
        stateOf: vi.fn(),
      },
    };
    const reader = await registerMemoryVisibility(mockCtx);
    const refs = reader.getVisibleRefs(dummySession);
    expect(mockHandle.stateOf).toHaveBeenCalledWith(dummySession);
    expect(mockCtx.sessionProjections.stateOf).not.toHaveBeenCalled();
    expect(refs).toEqual(new Set([`${fullId}@1`]));
  });
});
