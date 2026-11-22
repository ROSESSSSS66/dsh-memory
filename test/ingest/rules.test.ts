import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import type { Db, RawEvent } from '../../src/types.js';
import {
  runRules,
  normalizeErrorText,
  resolveFixedSlot,
  isCorrectionMessage,
  CORRECTION_REGEX,
} from '../../src/ingest/rules.js';
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

  it('R2 P0: enforces word boundaries, normative framing, skips questions/code/stack traces, and handles English workspace cues', () => {
    let seq = 100;
    const fire = (text: string) =>
      runRules(
        db,
        {
          session_id: 's_r2_p0',
          seq: ++seq,
          workspace_id: 'ws_r2',
          type: 'user/message',
          time: 1000 + seq,
          turn: 1,
          role: 'user',
          origin_kind: 'user',
          is_error: 0,
          text,
          processed: 0,
        },
        undefined,
        1000 + seq
      );

    // Substring traps must NEVER trigger
    fire('Nevertheless, we should use pnpm for this.');
    fire('Whenever I run tests, the cache warms up.');
    fire('Nevermind, keep the old config.');

    // Factual bug reports without normative framing must NEVER trigger
    fire('The build always fails on CI');
    fire('这个函数总是返回 undefined');

    // Questions (including non-?), multiline blockquotes, fenced code, stack traces must be SKIPPED (not candidate!)
    fire('does this always retry on 503');
    fire('是不是总是这样');
    fire('说明如下：\n> 以后总是使用 pnpm');
    fire('```ts\n// always use const\n```');
    fire('TypeError: always fails\n    at main (index.ts:10:5)');

    expect(list(db)).toHaveLength(0);

    // Valid non-fixed-slot English preference with workspace scope cue -> candidate + workspace scope
    const res = fire('From now on, always use pnpm in this repo');
    expect(res.memoriesCreated).toBe(1);
    const mems = list(db);
    expect(mems).toHaveLength(1);
    expect(mems[0].status).toBe('candidate');
    expect(mems[0].scope).toBe('workspace');
  });

  it('R1 P1: validates directive syntax, downgrades code/quotes, truncates long directives, and runs R3 on combined messages', () => {
    let seq = 200;
    const mkUser = (text: string, turn = 2): RawEvent => ({
      session_id: 's_r1_p1',
      seq: ++seq,
      workspace_id: 'ws_r1',
      type: 'user/message',
      time: 2000 + seq,
      turn,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text,
      processed: 0,
    });

    // Non-directive remember questions/clauses must be ignored
    runRules(db, mkUser('Remember when we migrated the server?'), undefined, 2001);
    runRules(db, mkUser('Remember how the cache invalidates'), undefined, 2002);
    runRules(db, mkUser('Remember why this failed'), undefined, 2003);
    runRules(db, mkUser('Remember if you restarted nginx'), undefined, 2004);
    runRules(db, mkUser('Remember whether the flag is on'), undefined, 2005);
    runRules(db, mkUser('记住明天开会吗？'), undefined, 2006);
    expect(list(db)).toHaveLength(0);

    // English directive with slot resolution
    const r1En = runRules(db, mkUser('Remember that our database is Postgres'), undefined, 2010);
    expect(r1En.memoriesCreated).toBe(1);
    expect(list(db)[0]).toMatchObject({
      slot_key: 'project.database',
      status: 'active',
      scope: 'workspace',
    });

    // Pasted code block in R1 downgraded to candidate
    runRules(db, mkUser('Remember:\n```bash\npnpm run build\n```'), undefined, 2011);
    const codeMems = list(db, { status: 'candidate' });
    expect(codeMems).toHaveLength(1);

    // >400-char directive truncated cleanly to token budget instead of dropped
    const longText = 'Remember: ' + 'deploy service alpha using zero-downtime blue-green strategy '.repeat(45);
    expect(longText.length).toBeGreaterThan(2000);
    const longRes = runRules(db, mkUser(longText), undefined, 2012);
    expect(longRes.memoriesCreated).toBe(1);

    // Combined R1 + R3: both creates R1 memory AND triggers R3 reflect job with correctionMessage
    db.run(
      'INSERT INTO turn_metrics (session_id, turn, query_tokens, candidates, injected, inject_tokens, latency_ms, correction, strategy_v, created_at) VALUES (?, 1, 10, 1, 1, 20, 5.0, 0, 1, 1000)',
      ['s_r1_p1']
    );
    let notified = 0;
    const comboRes = runRules(
      db,
      mkUser('记住：之前搞错了，测试服务端口改为 9090', 2),
      undefined,
      2020,
      { onJobEnqueued: () => { notified++; } }
    );
    expect(comboRes.memoriesCreated).toBe(1);
    expect(comboRes.jobsEnqueued).toBe(1);
    expect(notified).toBe(1);

    const reflectJob = db.get<{ payload: string }>(
      "SELECT payload FROM jobs WHERE key = 'reflect:s_r1_p1:1'"
    );
    expect(reflectJob).toBeDefined();
    expect(JSON.parse(reflectJob!.payload).correctionMessage).toContain('搞错了');
  });

  it('Shared isCorrectionMessage & CORRECTION_REGEX handle word boundaries, questions, and conditionals', () => {
    expect(CORRECTION_REGEX.test('wrongdoing')).toBe(false);
    expect(CORRECTION_REGEX.test('incorrectly')).toBe(false);
    expect(isCorrectionMessage('actually no, use port 8080')).toBe(true);
    expect(isCorrectionMessage("that didn't work at all")).toBe(true);
    expect(isCorrectionMessage('不对，为什么这样改？')).toBe(true);
    expect(isCorrectionMessage('这样改是不是不对？')).toBe(false);
    expect(isCorrectionMessage('nothing is wrong here')).toBe(false);
    expect(isCorrectionMessage('如果不行就回退到上一版本')).toBe(false);
    expect(isCorrectionMessage("if it doesn't work, revert the PR")).toBe(false);
  });

  it('R4 & R5: normalizes UUID/ISO/forward-slash paths, caps sig/content, omits null turn, gates jobs, and ignores tool/call in R5', () => {
    const norm = normalizeErrorText(
      'Fail at 2026-11-22T18:44:46.123Z req 550e8400-e29b-41d4-a716-446655440000 in C:/Users/dev/app.ts'
    );
    expect(norm).toBe('Fail at <TIME> req <UUID> in <PATH>');

    // Long error text: sig <= 256 chars, candidate content <= 600 chars, turn omitted when null
    const hugeErr = 'ERR_DETAIL_' + 'segment_alpha_beta_gamma '.repeat(50);
    runRules(
      db,
      {
        session_id: 's_r4_a',
        seq: 1,
        workspace_id: 'ws_r4',
        type: 'tool/result',
        time: 1000,
        turn: null,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'run_cmd',
        is_error: 1,
        text: hugeErr,
        processed: 0,
      },
      undefined,
      1000
    );
    const res2 = runRules(
      db,
      {
        session_id: 's_r4_b',
        seq: 2,
        workspace_id: 'ws_r4',
        type: 'tool/result',
        time: 2000,
        turn: null,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'run_cmd',
        is_error: 1,
        text: hugeErr,
        processed: 0,
      },
      undefined,
      2000
    );
    expect(res2.memoriesCreated).toBe(1);
    expect(res2.jobsEnqueued).toBe(1);

    const sigRow = db.get<{ sig: string }>('SELECT sig FROM failure_sigs WHERE workspace_id = ?', ['ws_r4']);
    expect(sigRow!.sig.length).toBeLessThanOrEqual(256);

    const failMem = list(db, { status: 'candidate' })[0];
    expect(failMem.content.length).toBeLessThanOrEqual(600);

    const r4Job = db.get<{ payload: string }>("SELECT payload FROM jobs WHERE key LIKE 'reflect:failure_sig:%'");
    const r4Payload = JSON.parse(r4Job!.payload);
    expect(r4Payload.triggerSeq).toBe(2);
    expect('turn' in r4Payload).toBe(false);

    // R5 must NOT trigger on tool/call with is_error=0
    db.run(
      'INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
      ['s_r5_call', 1, 'ws_r5', 'tool/result', 1000, 1, 'tool', 'tool', 'bash', 1, 'failed']
    );
    const callRes = runRules(
      db,
      {
        session_id: 's_r5_call',
        seq: 2,
        workspace_id: 'ws_r5',
        type: 'tool/call',
        time: 1001,
        turn: 1,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'bash',
        is_error: 0,
        text: '{"cmd":"ls"}',
        processed: 0,
      },
      undefined,
      1001
    );
    expect(callRes.jobsEnqueued).toBe(0);
    expect(db.get("SELECT * FROM jobs WHERE key = 'fixpair:s_r5_call:1'")).toBeUndefined();

    // Respects enqueueOfflineJobs: false
    const gatedRes = runRules(
      db,
      {
        session_id: 's_r5_call',
        seq: 3,
        workspace_id: 'ws_r5',
        type: 'tool/result',
        time: 1002,
        turn: 1,
        role: 'tool',
        origin_kind: 'tool',
        tool_name: 'bash',
        is_error: 0,
        text: 'ok',
        processed: 0,
      },
      undefined,
      1002,
      { enqueueOfflineJobs: false }
    );
    expect(gatedRes.jobsEnqueued).toBe(0);
    expect(db.get("SELECT * FROM jobs WHERE key = 'fixpair:s_r5_call:1'")).toBeUndefined();
  });

  it('resolveFixedSlot excludes symptom/interrogative contexts and supports English patterns', () => {
    expect(resolveFixedSlot('回复中文会乱码').slotKey).toBeNull();
    expect(resolveFixedSlot('数据库使用 CPU 过高').slotKey).toBeNull();
    expect(resolveFixedSlot('our database is down').slotKey).toBeNull();
    expect(resolveFixedSlot('why does our database use Postgres?').slotKey).toBeNull();

    expect(resolveFixedSlot('our database is Postgres')).toEqual({
      slotKey: 'project.database',
      scope: 'workspace',
      type: 'semantic',
    });
    expect(resolveFixedSlot('Always reply in English')).toEqual({
      slotKey: 'user.pref.reply_language',
      scope: 'user',
      type: 'preference',
    });
    expect(resolveFixedSlot('Never use momentjs in this project')).toEqual({
      slotKey: 'project.pref.avoid.momentjs',
      scope: 'workspace',
      type: 'preference',
    });
  });
});
