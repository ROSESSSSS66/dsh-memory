import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { SessionListener, SELF_MEMORY_TOOL_NAMES } from '../../src/dsh/session-listener.js';
import { DEFAULTS } from '../../src/config.js';

describe('SessionListener (session-listener.ts)', () => {
  let db: Db;
  let queue: IngestQueue;
  const wsPath = '/projects/session-listener-demo';
  const wsId = workspaceId(wsPath);

  beforeEach(() => {
    db = openDb(':memory:');
    queue = new IngestQueue(db, DEFAULTS, { batchSize: 1000, flushIntervalMs: 60_000 });
  });

  afterEach(async () => {
    await queue.close();
    db.close();
  });

  it('tracks turn/start and step/start without storing raw_events and fills missing user/message data.turn', async () => {
    const listener = new SessionListener(queue, DEFAULTS, undefined, db);
    const session = { id: 'sess_turns', header: { cwd: wsPath } };

    // turn/start sets turn = 3 without inserting a raw_events row
    listener.handleEvent(session, { type: 'turn/start', seq: 1, data: { turn: 3 } });
    // user/message without data.turn inherits turn = 3
    listener.handleEvent(session, {
      type: 'user/message',
      seq: 2,
      time: 1000,
      data: { source: { kind: 'user' }, content: 'How do we deploy?' },
    });
    // turn/start without explicit turn auto-increments to 4
    listener.handleEvent(session, { type: 'turn/start', seq: 3, data: {} });
    listener.handleEvent(session, {
      type: 'user/message',
      seq: 4,
      time: 2000,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Next question' }] },
    });

    await queue.flush();
    const rows = db.all<{ seq: number; turn: number | null; text: string }>(
      'SELECT seq, turn, text FROM raw_events WHERE session_id = ? ORDER BY seq ASC',
      ['sess_turns']
    );
    expect(rows).toEqual([
      { seq: 2, turn: 3, text: 'How do we deploy?' },
      { seq: 4, turn: 4, text: 'Next question' },
    ]);
  });

  it('skips tool/call and tool/result for self memory tools to prevent echo loops even when tool/result omits name', async () => {
    const listener = new SessionListener(queue, DEFAULTS, undefined, db);
    const session = { id: 'sess_self_tools', cwd: wsPath };

    let seq = 1;
    for (const toolName of SELF_MEMORY_TOOL_NAMES) {
      const callId = `call_${toolName}`;
      listener.handleEvent(session, {
        type: 'tool/call',
        seq: seq++,
        data: { callId, name: toolName, arguments: { query: 'test' } },
      });
      // tool/result omits data.name and only supplies toolCallId
      listener.handleEvent(session, {
        type: 'tool/result',
        seq: seq++,
        data: {
          toolCallId: callId,
          content: [{ type: 'text', text: `[FACT m_1234] echoed memory output` }],
        },
      });
    }

    // Regular tool call/result IS ingested and consumes callId from map
    listener.handleEvent(session, {
      type: 'tool/call',
      seq: seq++,
      data: { id: 'call_bash_1', name: 'bash', arguments: 'npm test' },
    });
    listener.handleEvent(session, {
      type: 'tool/result',
      seq: seq++,
      data: {
        message: {
          toolCallId: 'call_bash_1',
          content: [
            { type: 'image', text: 'ignore non-text block' },
            { type: 'text', text: 'All tests passed' },
          ],
        },
      },
    });
    // Reusing consumed callId without data.name yields tool_name = null (proving deletion)
    listener.handleEvent(session, {
      type: 'tool/result',
      seq: seq++,
      data: { toolCallId: 'call_bash_1', content: 'plain string result' },
    });

    await queue.flush();
    const rows = db.all<{ type: string; tool_name: string | null; text: string | null }>(
      'SELECT type, tool_name, text FROM raw_events WHERE session_id = ? ORDER BY seq ASC',
      ['sess_self_tools']
    );
    expect(rows).toEqual([
      { type: 'tool/call', tool_name: 'bash', text: 'npm test' },
      { type: 'tool/result', tool_name: 'bash', text: 'All tests passed' },
      { type: 'tool/result', tool_name: null, text: 'plain string result' },
    ]);
  });

  it('bounds multi-MB tool output before redacting and never bisects [REDACTED:...] markers', async () => {
    const listener = new SessionListener(queue, DEFAULTS, undefined, db);
    const session = { id: 'sess_redact', cwd: wsPath };

    // 1. Multi-MB payload should complete rapidly (< 100ms)
    const bigText = 'A'.repeat(2 * 1024 * 1024);
    const start = performance.now();
    listener.handleEvent(session, {
      type: 'tool/result',
      seq: 1,
      data: { name: 'bash', content: bigText },
    });
    expect(performance.now() - start).toBeLessThan(150);

    // 2. Secret near 800-char boundary must never be sliced into a broken "[REDACTED:SE" fragment
    const prefix = 'a'.repeat(792);
    const secretPayload = `${prefix} sk-proj-1234567890abcdef1234567890abcdef trailing`;
    listener.handleEvent(session, {
      type: 'tool/result',
      seq: 2,
      data: { name: 'bash', content: secretPayload },
    });

    await queue.flush();
    const row = db.get<{ text: string }>(
      'SELECT text FROM raw_events WHERE session_id = ? AND seq = 2',
      ['sess_redact']
    );
    expect(row?.text).toBeDefined();
    expect(row!.text).not.toContain('sk-proj-1234567890');
    expect(row!.text).not.toMatch(/\[REDACTED:[^\]]*$/);
    expect(row!.text.length).toBeLessThanOrEqual(800);
  });

  it('excludes compaction pings from pressure count, emits context-pressure asynchronously via microtask, and re-triggers every +40 events', async () => {
    const pressureEvents: any[] = [];
    const mockCtx: any = {
      emit: (evt: string, payload: any) => {
        if (evt === 'memory/context-pressure') {
          pressureEvents.push(payload);
        }
      },
    };
    const listener = new SessionListener(queue, DEFAULTS, mockCtx, db);
    const session = { id: 'sess_pressure', cwd: wsPath };

    // 50 compaction pings must NOT trigger pressure
    for (let i = 1; i <= 50; i++) {
      listener.handleEvent(session, { type: 'compaction/ping', seq: i, data: {} });
    }
    await Promise.resolve();
    expect(pressureEvents).toHaveLength(0);

    // 40 real events trigger first pressure asynchronously
    for (let i = 51; i <= 90; i++) {
      listener.handleEvent(session, {
        type: 'user/message',
        seq: i,
        data: { source: { kind: 'user' }, content: `msg ${i}` },
      });
    }
    // Must not fire synchronously inside handleEvent
    expect(pressureEvents).toHaveLength(0);
    await Promise.resolve();
    expect(pressureEvents).toHaveLength(1);
    expect(pressureEvents[0]).toMatchObject({ sessionId: 'sess_pressure', eventCount: 40 });

    // Next 40 events re-trigger at eventCount = 80
    for (let i = 91; i <= 130; i++) {
      listener.handleEvent(session, {
        type: 'assistant/message',
        seq: i,
        data: { content: `reply ${i}` },
      });
    }
    await Promise.resolve();
    expect(pressureEvents).toHaveLength(2);
    expect(pressureEvents[1].eventCount).toBe(80);
  });

  it('resolves empty cwd via session_workspace_owners and enforces excludeWorkspaces without falling back to process.cwd()', async () => {
    const excludedPath = '/private/excluded-repo';
    const excludedWsId = workspaceId(excludedPath);
    db.run(
      'INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
      ['sess_excluded', excludedWsId]
    );
    db.run(
      'INSERT INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
      ['sess_known', wsId]
    );

    const cfg = { ...DEFAULTS, excludeWorkspaces: [excludedPath] };
    const listener = new SessionListener(queue, cfg, undefined, db);

    // Session owned by excluded workspace with empty cwd MUST still be blocked
    listener.handleEvent(
      { id: 'sess_excluded' },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: 'Secret text' } }
    );
    // Session owned by allowed workspace with empty cwd recovers wsId from session_workspace_owners
    listener.handleEvent(
      { id: 'sess_known' },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: 'Allowed text' } }
    );
    // Completely unknown session with empty cwd gets workspace_id = '' (never process.cwd())
    listener.handleEvent(
      { id: 'sess_orphan' },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: 'Orphan text' } }
    );

    await queue.flush();
    const rows = db.all<{ session_id: string; workspace_id: string }>(
      'SELECT session_id, workspace_id FROM raw_events ORDER BY session_id ASC'
    );
    expect(rows).toEqual([
      { session_id: 'sess_known', workspace_id: wsId },
      { session_id: 'sess_orphan', workspace_id: '' },
    ]);
  });
});
