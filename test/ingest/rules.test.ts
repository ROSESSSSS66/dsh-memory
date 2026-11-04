import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db, RawEvent } from '../../src/types.js';
import { runRules, normalizeErrorText } from '../../src/ingest/rules.js';
import { list } from '../../src/core/store.js';

describe('M2-T1: rules.ts tests', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rules-test-'));
    db = openDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('R1: Real user "记住：回复一律用中文" generates active user preference memory and slot', () => {
    const event: RawEvent = {
      session_id: 's1',
      seq: 1,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 1000,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '记住：回复一律用中文',
      processed: 0,
    };

    // 先在 raw_events 插入一行
    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [event.session_id, event.seq, event.workspace_id, event.type, event.time, event.turn, event.role, event.origin_kind, event.is_error, event.text]
    );

    runRules(db, event, undefined, 1000);

    const memories = list(db);
    expect(memories).toHaveLength(1);
    const mem = memories[0];
    expect(mem.type).toBe('preference');
    expect(mem.scope).toBe('user');
    expect(mem.slot_key).toBe('user.pref.reply_language');
    expect(mem.status).toBe('active');
    expect(mem.approved_by).toBe('user');
    expect(mem.confidence).toBe(1.0);
    expect(mem.content).toBe('回复一律用中文');
  });

  it('R1: Real user "记住：我的项目数据库是 PostgreSQL 16" generates active workspace semantic memory and slot', () => {
    const event: RawEvent = {
      session_id: 's1',
      seq: 2,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 1000,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '记住：我的项目数据库是 PostgreSQL 16',
      processed: 0,
    };

    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [event.session_id, event.seq, event.workspace_id, event.type, event.time, event.turn, event.role, event.origin_kind, event.is_error, event.text]
    );

    runRules(db, event, undefined, 1000);

    const memories = list(db);
    expect(memories).toHaveLength(1);
    const mem = memories[0];
    expect(mem.type).toBe('semantic');
    expect(mem.scope).toBe('workspace');
    expect(mem.slot_key).toBe('project.database');
    expect(mem.status).toBe('active');
  });

  it('R2: "本项目不要再用SQLite" generates active workspace preference', () => {
    const event: RawEvent = {
      session_id: 's1',
      seq: 3,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 1000,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '本项目不要再用SQLite',
      processed: 0,
    };

    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [event.session_id, event.seq, event.workspace_id, event.type, event.time, event.turn, event.role, event.origin_kind, event.is_error, event.text]
    );

    runRules(db, event, undefined, 1000);

    const memories = list(db);
    expect(memories).toHaveLength(1);
    const mem = memories[0];
    expect(mem.type).toBe('preference');
    expect(mem.scope).toBe('workspace');
    expect(mem.slot_key).toBe('project.pref.avoid.sqlite');
    expect(mem.status).toBe('active');
  });

  it('Non-user plugin messages do not trigger R1/R2 user approval or memories', () => {
    const event: RawEvent = {
      session_id: 's1',
      seq: 4,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 1000,
      turn: 1,
      role: 'user',
      origin_kind: 'system', // 来自插件注入
      is_error: 0,
      text: '记住：回复一律用中文',
      processed: 0,
    };

    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
      [event.session_id, event.seq, event.workspace_id, event.type, event.time, event.turn, event.role, event.origin_kind, event.is_error, event.text]
    );

    runRules(db, event, undefined, 1000);

    const memories = list(db);
    expect(memories).toHaveLength(0);
  });

  it('R3: User correction marks previous turn and enqueues reflect job', () => {
    db.run(
      'INSERT INTO turn_metrics (session_id, turn, query_tokens, candidates, injected, inject_tokens, latency_ms, correction, strategy_v, created_at) VALUES (?, 1, 10, 2, 1, 50, 10.0, 0, 1, 1000)',
      ['s1']
    );

    const event: RawEvent = {
      session_id: 's1',
      seq: 5,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 2000,
      turn: 2,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '不对，搞错了，不是这样',
      processed: 0,
    };

    runRules(db, event, undefined, 2000);

    const tm = db.get<{ correction: number }>('SELECT correction FROM turn_metrics WHERE session_id = ? AND turn = 1', ['s1']);
    expect(tm?.correction).toBe(1);

    const job = db.get<{ kind: string; key: string; status: string }>('SELECT kind, key, status FROM jobs WHERE kind = ?', ['reflect']);
    expect(job).toBeDefined();
    expect(job?.key).toBe('reflect:s1:1');
    expect(job?.status).toBe('queued');
  });

  it('R4: Tool failure normalization and cross-session candidate promotion', () => {
    const errorText = 'Error in C:\\Users\\Windows11\\Desktop\\app\\index.ts: connection failed at 0xdeadbeef with port 5432: "timeout"';
    const normalized = normalizeErrorText(errorText);
    expect(normalized).toBe('Error in <PATH>: connection failed at <HEX> with port <NUM>: <STR>');

    // Session 1 失败
    const ev1: RawEvent = {
      session_id: 'sess_1',
      seq: 10,
      workspace_id: 'ws_test',
      type: 'tool/result',
      time: 1000,
      turn: 1,
      role: 'tool',
      origin_kind: 'tool',
      tool_name: 'db_query',
      is_error: 1,
      text: errorText,
      processed: 0,
    };
    runRules(db, ev1, undefined, 1000);

    // 1 次失败不产生 candidate
    let mems = list(db);
    expect(mems).toHaveLength(0);

    const sigRow1 = db.get<{ count: number; sessions: string; memory_id: string | null }>(
      'SELECT count, sessions, memory_id FROM failure_sigs WHERE workspace_id = ?',
      ['ws_test']
    );
    expect(sigRow1?.count).toBe(1);
    expect(JSON.parse(sigRow1?.sessions || '[]')).toEqual(['sess_1']);
    expect(sigRow1?.memory_id).toBeNull();

    // 相同 session 相同 seq 重放：幂等不增加计数
    runRules(db, ev1, undefined, 1000);
    const sigRowReplay = db.get<{ count: number }>('SELECT count FROM failure_sigs WHERE workspace_id = ?', ['ws_test']);
    expect(sigRowReplay?.count).toBe(1);

    // Session 2 发生同名签名失败
    const ev2: RawEvent = {
      session_id: 'sess_2',
      seq: 20,
      workspace_id: 'ws_test',
      type: 'tool/result',
      time: 2000,
      turn: 1,
      role: 'tool',
      origin_kind: 'tool',
      tool_name: 'db_query',
      is_error: 1,
      text: errorText,
      processed: 0,
    };
    runRules(db, ev2, undefined, 2000);

    const sigRow2 = db.get<{ count: number; sessions: string; memory_id: string | null }>(
      'SELECT count, sessions, memory_id FROM failure_sigs WHERE workspace_id = ?',
      ['ws_test']
    );
    expect(sigRow2?.count).toBe(2);
    expect(JSON.parse(sigRow2?.sessions || '[]')).toHaveLength(2);
    expect(sigRow2?.memory_id).not.toBeNull();

    // 跨 session 失败只产出 candidate，且 confidence <= 0.5
    mems = list(db, { status: 'candidate' });
    expect(mems).toHaveLength(1);
    expect(mems[0].type).toBe('failure');
    expect(mems[0].status).toBe('candidate');
    expect(mems[0].confidence).toBeLessThanOrEqual(0.5);
  });

  it('R5: Same turn fail-to-fix pair enqueues distill job', () => {
    // 先在 raw_events 存一次失败
    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      ['s_fix', 1, 'ws_test', 'tool/result', 1000, 1, 'tool', 'tool', 'cargo_build', 1, 'build failed']
    );

    // 紧接着同一 turn 该工具成功
    const successEvent: RawEvent = {
      session_id: 's_fix',
      seq: 2,
      workspace_id: 'ws_test',
      type: 'tool/result',
      time: 2000,
      turn: 1,
      role: 'tool',
      origin_kind: 'tool',
      tool_name: 'cargo_build',
      is_error: 0,
      text: 'build succeeded',
      processed: 0,
    };

    runRules(db, successEvent, undefined, 2000);

    const distillJob = db.get<{ kind: string; key: string }>(
      'SELECT kind, key FROM jobs WHERE kind = ?',
      ['distill']
    );
    expect(distillJob).toBeDefined();
    expect(distillJob?.key).toBe('fixpair:s_fix:1');
  });

  it('Privacy: Raw credentials are not accepted into memories', () => {
    const event: RawEvent = {
      session_id: 's1',
      seq: 99,
      workspace_id: 'ws_test',
      type: 'user/message',
      time: 1000,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '记住：数据库连接 postgres://admin:superSecret123@db.internal:5432/prod',
      processed: 0,
    };

    runRules(db, event, undefined, 1000);
    const mems = list(db);
    expect(mems).toHaveLength(0);
  });
});
