import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db, Context } from '../../src/types.js';
import { IngestQueue } from '../../src/ingest/queue.js';
import { registerSessionListener } from '../../src/dsh/session-listener.js';
import { DEFAULTS } from '../../src/config.js';

class MockContext implements Context {
  private listeners = new Map<string, Array<(...args: any[]) => any>>();

  on(event: string, callback: (...args: any[]) => any): () => void {
    let list = this.listeners.get(event);
    if (!list) {
      list = [];
      this.listeners.set(event, list);
    }
    list.push(callback);
    return () => {
      const idx = list!.indexOf(callback);
      if (idx >= 0) list!.splice(idx, 1);
    };
  }

  emit(event: string, ...args: any[]): void {
    const list = this.listeners.get(event) || [];
    for (const fn of list) {
      fn(...args);
    }
  }
}

describe('M2-T1: queue.ts & session-listener.ts tests', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-queue-test-'));
    db = openDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('IngestQueue flushes events and ignores duplicate seq in raw_events', async () => {
    const queue = new IngestQueue(db, DEFAULTS, { batchSize: 5, flushIntervalMs: 10000 });

    for (let i = 1; i <= 5; i++) {
      queue.push({
        session_id: 's_q',
        seq: i,
        workspace_id: 'ws_q',
        type: 'user/message',
        time: 1000 + i,
        turn: 1,
        role: 'user',
        origin_kind: 'user',
        is_error: 0,
        text: `Message ${i}`,
        processed: 0,
      });
    }

    // 等待自动触发批写入或手动 flush
    await queue.flush();

    const countRow = db.get<{ c: number }>('SELECT count(*) as c FROM raw_events WHERE session_id = ?', ['s_q']);
    expect(countRow?.c).toBe(5);

    // 再次推送重复 seq 的事件
    queue.push({
      session_id: 's_q',
      seq: 3,
      workspace_id: 'ws_q',
      type: 'user/message',
      time: 1003,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: 'Duplicate seq 3',
      processed: 0,
    });
    const inserted = await queue.flush();
    expect(inserted).toBe(0);

    const countRowAfter = db.get<{ c: number }>('SELECT count(*) as c FROM raw_events WHERE session_id = ?', ['s_q']);
    expect(countRowAfter?.c).toBe(5);

    await queue.close();
  });

  it('SessionListener filters plugin echo and runtime-context', async () => {
    const ctx = new MockContext();
    const queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 10000 });
    registerSessionListener(ctx, queue, DEFAULTS);

    const session = { id: 's_filter', cwd: 'C:\\test\\ws' };

    // 1. dsh-memory 自身注入回声
    ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      time: 1000,
      data: {
        source: { kind: 'plugin', plugin: 'dsh-memory' },
        content: [{ type: 'text', text: 'memory echo' }],
      },
    });

    // 2. runtime-context 注入
    ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 2,
      time: 1001,
      data: {
        source: { kind: 'runtime-context' },
        content: [{ type: 'text', text: 'runtime snapshot' }],
      },
    });

    // 3. 正常真实用户消息
    ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 3,
      time: 1002,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Real user prompt' }],
      },
    });

    await queue.flush();

    const rows = db.all<{ seq: number; text: string }>('SELECT seq, text FROM raw_events WHERE session_id = ? ORDER BY seq', ['s_filter']);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(3);
    expect(rows[0].text).toBe('Real user prompt');

    await queue.close();
  });

  it('SessionListener filters reasoning blocks from assistant messages', async () => {
    const ctx = new MockContext();
    const queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 10000 });
    registerSessionListener(ctx, queue, DEFAULTS);

    const session = { id: 's_reason', cwd: 'C:\\test\\ws' };

    ctx.emit('session/event', session, {
      type: 'assistant/message',
      seq: 1,
      time: 1000,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'Internal chain of thought should NOT be extracted' },
            { type: 'text', text: 'Visible answer to user' },
          ],
        },
      },
    });

    await queue.flush();

    const row = db.get<{ text: string }>('SELECT text FROM raw_events WHERE session_id = ?', ['s_reason']);
    expect(row?.text).toBe('Visible answer to user');
    expect(row?.text).not.toContain('Internal chain of thought');

    await queue.close();
  });

  it('SessionListener pairs tool call and tool result via callId and redacts secrets', async () => {
    const ctx = new MockContext();
    const queue = new IngestQueue(db, DEFAULTS, { batchSize: 100, flushIntervalMs: 10000 });
    registerSessionListener(ctx, queue, DEFAULTS);

    const session = { id: 's_tool', cwd: 'C:\\test\\ws' };

    // 1. Tool Call
    ctx.emit('session/event', session, {
      type: 'tool/call',
      seq: 1,
      time: 1000,
      data: {
        callId: 'call_abc_123',
        name: 'database_connect',
        arguments: '{"connection": "postgres://admin:pwd123@host:5432/db"}',
      },
    });

    // 2. Tool Result
    ctx.emit('session/event', session, {
      type: 'tool/result',
      seq: 2,
      time: 1001,
      data: {
        toolCallId: 'call_abc_123',
        isError: true,
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'Failed to authenticate Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeak' }],
        },
      },
    });

    await queue.flush();

    const rows = db.all<{ seq: number; tool_name: string; is_error: number; text: string }>(
      'SELECT seq, tool_name, is_error, text FROM raw_events WHERE session_id = ? ORDER BY seq',
      ['s_tool']
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].tool_name).toBe('database_connect');
    expect(rows[0].text).toContain('[REDACTED:CREDENTIAL]');
    expect(rows[0].text).not.toContain('pwd123');

    expect(rows[1].tool_name).toBe('database_connect');
    expect(rows[1].is_error).toBe(1);
    expect(rows[1].text).toContain('[REDACTED:JWT]');
    expect(rows[1].text).not.toContain('doNotLeak');

    await queue.close();
  });

  it('SessionListener skips excluded workspaces', async () => {
    const ctx = new MockContext();
    const cfg = { ...DEFAULTS, excludeWorkspaces: ['C:\\Users\\Windows11\\Desktop\\secret-project'] };
    const queue = new IngestQueue(db, cfg, { batchSize: 100, flushIntervalMs: 10000 });
    registerSessionListener(ctx, queue, cfg);

    const session = { id: 's_ex', cwd: 'C:\\Users\\Windows11\\Desktop\\secret-project' };
    ctx.emit('session/event', session, {
      type: 'user/message',
      seq: 1,
      time: 1000,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Secret message' }],
      },
    });

    await queue.flush();
    const countRow = db.get<{ c: number }>('SELECT count(*) as c FROM raw_events WHERE session_id = ?', ['s_ex']);
    expect(countRow?.c).toBe(0);

    await queue.close();
  });
});
