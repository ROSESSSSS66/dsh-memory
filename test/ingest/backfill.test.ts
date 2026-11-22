import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import {
  scanZstdFrames,
  readSessionFile,
  runBackfill,
  extractToolCallId,
  extractToolResultCallId,
} from '../../src/ingest/backfill.js';

describe('History Backfill (backfill.ts)', () => {
  let db: Db;
  let tmpDir: string;
  const testCwd = 'C:\\Projects\\MyApp';

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backfill-test-'));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  describe('Zstd Frame Scanning (scanZstdFrames)', () => {
    it('should correctly scan single and multiple valid zstd frames', () => {
      const data1 = Buffer.from('{"version":4,"cwd":"C:\\\\Projects\\\\MyApp"}\n');
      const data2 = Buffer.from('{"seq":1,"type":"user/message","data":{"text":"hello"}}\n');

      const frame1 = (zlib as any).zstdCompressSync(data1);
      const frame2 = (zlib as any).zstdCompressSync(data2);
      const combined = Buffer.concat([frame1, frame2]);

      const res = scanZstdFrames(combined);
      expect(res.frames.length).toBe(2);
      expect(res.frames[0].start).toBe(0);
      expect(res.frames[0].end).toBe(frame1.length);
      expect(res.frames[1].start).toBe(frame1.length);
      expect(res.frames[1].end).toBe(combined.length);
      expect(res.tornStart).toBeUndefined();
    });

    it('should not false-split when payload contains magic bytes (0xFD2FB528)', () => {
      // 构造包含 ZSTD_MAGIC 字节 (28 B5 2F FD) 的 payload 文本
      const magicBytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const payloadWithMagic = Buffer.concat([
        Buffer.from('{"seq":1,"magic":"'),
        magicBytes,
        Buffer.from('"}\n'),
      ]);

      const compressed = (zlib as any).zstdCompressSync(payloadWithMagic);
      // scanZstdFrames 必须识别为一个整体帧，不得错误切分成两个帧
      const res = scanZstdFrames(compressed);
      expect(res.frames.length).toBe(1);
      expect(res.frames[0].start).toBe(0);
      expect(res.frames[0].end).toBe(compressed.length);
    });

    it('should handle multiple complete frames + torn tail frame', () => {
      const data1 = Buffer.from('{"version":4,"cwd":"C:\\\\Projects\\\\MyApp"}\n');
      const data2 = Buffer.from('{"seq":1,"type":"user/message"}\n');
      const data3 = Buffer.from('{"seq":2,"type":"assistant/message"}\n');

      const frame1 = (zlib as any).zstdCompressSync(data1);
      const frame2 = (zlib as any).zstdCompressSync(data2);
      const frame3 = (zlib as any).zstdCompressSync(data3);

      // 截断第三帧（撕裂尾帧）
      const tornFrame3 = frame3.subarray(0, Math.floor(frame3.length / 2));
      const combined = Buffer.concat([frame1, frame2, tornFrame3]);

      const res = scanZstdFrames(combined);
      // 成功解析前两个完整帧，并将第三帧标记为 tornStart
      expect(res.frames.length).toBe(2);
      expect(res.tornStart).toBe(frame1.length + frame2.length);
    });
  });

  describe('Session File Parsing (readSessionFile)', () => {
    it('should discard trailing incomplete JSONL lines', () => {
      const filePath = path.join(tmpDir, 'incomplete.jsonl');
      const content = [
        '{"version":4,"cwd":"C:\\\\Projects\\\\MyApp"}',
        '{"seq":1,"type":"user/message","data":{"text":"完整的第一行"}}',
        '{"seq":2,"type":"user/message","data":{"text":"未闭合的残缺', // 无换行结尾
      ].join('\n');

      fs.writeFileSync(filePath, content, 'utf8');

      const res = readSessionFile(filePath);
      expect(res).not.toBeNull();
      // 残缺行必须被丢弃
      expect(res!.rawLines.length).toBe(1);
      expect(res!.rawLines[0]).toContain('完整的第一行');
    });

    it('should reject files with version != 4 (如旧格式)', () => {
      const filePath = path.join(tmpDir, 'v3.jsonl');
      fs.writeFileSync(
        filePath,
        '{"version":3,"cwd":"C:\\\\Projects\\\\MyApp"}\n{"seq":1,"type":"user/message"}\n',
        'utf8'
      );
      const res = readSessionFile(filePath);
      expect(res).toBeNull();
    });

    it('should reject files missing cwd', () => {
      const filePath = path.join(tmpDir, 'no_cwd.jsonl');
      fs.writeFileSync(
        filePath,
        '{"version":4}\n{"seq":1,"type":"user/message"}\n',
        'utf8'
      );
      const res = readSessionFile(filePath);
      expect(res).toBeNull();
    });
  });

  describe('Full Backfill Run & Dry-Run (验收项 M2-T4)', () => {
    it('dry-run 分别统计原始/过滤/隐私拒绝/可写事件，正式运行新增数与可写统计一致，第二次新增为0 (幂等)', () => {
      // 构造包含各类事件的 session 文件
      const sessionFile = path.join(tmpDir, 'session.v4.jsonl');

      const lines = [
        // 头部
        JSON.stringify({ version: 4, cwd: testCwd }),
        // 1. 合法可写事件 (R1 触发规则记忆)
        JSON.stringify({
          seq: 1,
          time: 1000,
          type: 'user/message',
          data: {
            turn: 1,
            source: { kind: 'user' },
            content: [{ type: 'text', text: '记住：我的项目数据库是 PostgreSQL 16' }],
          },
        }),
        // 2. 忽略的事件类型
        JSON.stringify({
          seq: 2,
          time: 1001,
          type: 'session-log-deepseek/delivery-accepted',
          data: {},
        }),
        // 3. 插件回声事件 (过滤)
        JSON.stringify({
          seq: 3,
          time: 1002,
          type: 'user/message',
          data: {
            source: { kind: 'plugin', plugin: 'dsh-memory' },
            content: [{ type: 'text', text: '回声内容' }],
          },
        }),
        // 4. 隐私拒绝事件 (包含敏感私钥 PEM)
        JSON.stringify({
          seq: 4,
          time: 1003,
          type: 'user/message',
          data: {
            source: { kind: 'user' },
            content: [
              {
                type: 'text',
                text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
              },
            ],
          },
        }),
        // 5. 另一个合法事件 (assistant)
        JSON.stringify({
          seq: 5,
          time: 1004,
          type: 'assistant/message',
          data: {
            turn: 1,
            message: { content: [{ type: 'text', text: '好的，我已经记住了。' }] },
          },
        }),
      ];

      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      // 1. Dry Run
      const dryStats = runBackfill(db, {
        filePaths: [sessionFile],
        dryRun: true,
      });

      expect(dryStats.rawEvents).toBe(5);
      expect(dryStats.filteredEvents).toBe(2); // 忽略事件 + 回声
      expect(dryStats.privacyRejected).toBe(1); // 私钥
      expect(dryStats.writableEvents).toBe(2); // seq 1 和 seq 5
      expect(dryStats.newEventsAdded).toBe(0); // dry run 不入库

      // 验证 DB 仍然为空
      expect(db.all('SELECT * FROM raw_events').length).toBe(0);
      expect(db.all('SELECT * FROM memories').length).toBe(0);

      // 2. 正式运行 (dryRun = false)
      const runStats1 = runBackfill(db, {
        filePaths: [sessionFile],
        dryRun: false,
      });

      // 正式运行新增数与可写统计完全一致
      expect(runStats1.newEventsAdded).toBe(dryStats.writableEvents);
      expect(runStats1.memoriesCreated).toBe(1); // PostgreSQL 16 记忆生成

      // 验证 DB 实际落库
      expect(db.all('SELECT * FROM raw_events').length).toBe(2);
      const mem = db.get<{ content: string }>('SELECT content FROM memories');
      expect(mem?.content).toContain('PostgreSQL 16');

      // 3. 第二次运行 (幂等测试)
      const runStats2 = runBackfill(db, {
        filePaths: [sessionFile],
        dryRun: false,
      });

      // 第二次新增 0
      expect(runStats2.newEventsAdded).toBe(0);
      expect(runStats2.memoriesCreated).toBe(0);
      expect(db.all('SELECT * FROM raw_events').length).toBe(2);
    });

    it('不读取被排除的工作区', () => {
      const excludedCwd = 'C:\\Projects\\SecretProject';
      const sessionFile = path.join(tmpDir, 'excluded.jsonl');
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ version: 4, cwd: excludedCwd }) +
          '\n' +
          JSON.stringify({ seq: 1, type: 'user/message', data: { text: '机密事件' } }) +
          '\n',
        'utf8'
      );

      const stats = runBackfill(db, {
        filePaths: [sessionFile],
        cfg: {
          ...({} as any),
          excludeWorkspaces: [excludedCwd],
        },
      });

      expect(stats.skippedFiles).toBe(1);
      expect(stats.rawEvents).toBe(0);
      expect(db.all('SELECT * FROM raw_events').length).toBe(0);
    });

    it('支持解析 DSH session_projcache / archive_manager_v2 JSON 归档会话并过滤 Subagent', () => {
      const userJsonFile = path.join(tmpDir, 'session_user_1.json');
      fs.writeFileSync(
        userJsonFile,
        JSON.stringify({
          version: 2,
          record: {
            sessionId: 'sess-projcache-1',
            identity: {
              formatVersion: 4,
              createdAt: 2000,
              cwd: testCwd,
            },
            rows: {
              turnOutline: {
                val: {
                  turns: [
                    {
                      turn: 1,
                      seq: 10,
                      prompt: '站点单个请求上限上调到30mb',
                      response: '已将网关单请求体上限上调至 30MB。',
                    },
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      );

      const subagentJsonFile = path.join(tmpDir, 'session_subagent_1.json');
      fs.writeFileSync(
        subagentJsonFile,
        JSON.stringify({
          version: 2,
          record: {
            sessionId: 'sess-subagent-1',
            identity: {
              formatVersion: 4,
              createdAt: 3000,
              cwd: testCwd,
            },
            rows: {
              turnOutline: {
                val: {
                  turns: [
                    {
                      turn: 1,
                      seq: 10,
                      prompt: 'Your parent agent id is "session-parent". Complete task.',
                      response: 'Done.',
                    },
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      );

      const stats = runBackfill(db, {
        filePaths: [userJsonFile, subagentJsonFile],
      });

      expect(stats.processedFiles).toBe(1);
      expect(stats.skippedFiles).toBe(1);
      expect(stats.newEventsAdded).toBe(2);
      // projcache 摘要没有原始 user 来源证明，统一标记为 system，不得越权自动审批写入 active 记忆
      expect(stats.memoriesCreated).toBe(0);
      const userPromptRow = db.get<{ origin_kind: string; role: string }>(
        "SELECT origin_kind, role FROM raw_events WHERE session_id = 'sess-projcache-1' AND role = 'user'"
      );
      expect(userPromptRow?.origin_kind).toBe('system');
    });

    it('过滤 DSH skill-catalog / time-context / tool-jobs / snapshot 合成 user/message，仅保留真实用户与兼容旧事件', () => {
      const sessionFile = path.join(tmpDir, 'synthetic_sources.v4.jsonl');
      const lines = [
        JSON.stringify({ version: 4, cwd: testCwd }),
        JSON.stringify({
          seq: 1,
          time: 1000,
          type: 'user/message',
          data: {
            source: { kind: 'skill-catalog', form: 'catalog' },
            content: [{ type: 'text', text: '记住：这是技能列表快照' }],
          },
        }),
        JSON.stringify({
          seq: 2,
          time: 1001,
          type: 'user/message',
          data: {
            source: { kind: 'time-context', form: 'snapshot' },
            content: [{ type: 'text', text: '记住：当前时间 2026-11-11' }],
          },
        }),
        JSON.stringify({
          seq: 3,
          time: 1002,
          type: 'user/message',
          data: {
            source: { kind: 'tool-jobs', form: 'snapshot' },
            content: [{ type: 'text', text: '记住：后台作业状态快照' }],
          },
        }),
        JSON.stringify({
          seq: 4,
          time: 1003,
          type: 'user/message',
          data: {
            source: { kind: 'custom-sys', form: 'snapshot' },
            content: [{ type: 'text', text: '记住：其他快照内容' }],
          },
        }),
        JSON.stringify({
          seq: 5,
          time: 1004,
          type: 'user/message',
          data: {
            source: { kind: 'user' },
            content: [{ type: 'text', text: '记住：本地回填应使用 test-user 账号' }],
          },
        }),
      ];

      fs.writeFileSync(sessionFile, lines.join('\n') + '\n', 'utf8');

      const stats = runBackfill(db, {
        filePaths: [sessionFile],
        dryRun: false,
      });

      expect(stats.rawEvents).toBe(5);
      expect(stats.filteredEvents).toBe(4);
      expect(stats.newEventsAdded).toBe(1);
      expect(stats.memoriesCreated).toBe(1);
      const rawRows = db.all<{ seq: number; text: string }>('SELECT seq, text FROM raw_events');
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].seq).toBe(5);
    });

    it('supports RFC 8878 skippable frames, preserves frames 0..K-1 on corrupt frame K, and rejects cumulative zstd bombs', () => {
      const data1 = Buffer.from('{"version":4,"cwd":"C:\\\\Projects\\\\MyApp"}\n');
      const data2 = Buffer.from('{"seq":1,"type":"user/message","data":{"source":{"kind":"user"},"text":"hello"}}\n');
      const frame1 = (zlib as any).zstdCompressSync(data1);
      const frame2 = (zlib as any).zstdCompressSync(data2);

      // RFC 8878 skippable frame (magic 0x184D2A50 + 4-byte LE size + payload)
      const skipPayload = Buffer.from('metadata');
      const skipFrame = Buffer.alloc(8 + skipPayload.length);
      skipFrame.writeUInt32LE(0x184d2a50, 0);
      skipFrame.writeUInt32LE(skipPayload.length, 4);
      skipPayload.copy(skipFrame, 8);

      const scanned = scanZstdFrames(Buffer.concat([frame1, skipFrame, frame2]));
      expect(scanned.frames).toHaveLength(2);
      expect(scanned.tornStart).toBeUndefined();
      expect(scanned.frames[0].contentSize).toBe(data1.length);

      // Single corrupt frame K (valid header framing with corrupted checksum) preserves frames 0..K-1
      const badFrame3 = Buffer.from((zlib as any).zstdCompressSync(
        Buffer.from('{"seq":2,"type":"assistant/message","data":{"text":"corrupt me"}}\n'),
        { params: { [(zlib as any).constants.ZSTD_c_checksumFlag]: 1 } }
      ));
      // Flip last byte of checksum so scanZstdFrames sees a framed block, but decompression fails
      badFrame3[badFrame3.length - 1] ^= 0xff;
      const corruptFile = path.join(tmpDir, 'partial_corrupt.jsonl.zstd');
      fs.writeFileSync(corruptFile, Buffer.concat([frame1, frame2, badFrame3]));
      const partial = readSessionFile(corruptFile);
      expect(partial).not.toBeNull();
      expect(partial!.rawLines).toHaveLength(1);
      expect(partial!.rawLines[0]).toContain('"hello"');

      // Cumulative output budget enforcement across frames (zstd bomb defense)
      const bigPayload = Buffer.from('A'.repeat(4096) + '\n');
      const bigFrame = (zlib as any).zstdCompressSync(bigPayload);
      const bombFile = path.join(tmpDir, 'bomb.jsonl.zstd');
      fs.writeFileSync(bombFile, Buffer.concat([frame1, bigFrame, bigFrame]));
      const rejected = readSessionFile(bombFile, { maxDecompressedBytes: 2048 });
      expect(rejected).toBeNull();

      // Streaming fzstd.Decompress fallback also enforces cumulative output budget (never unbounded fzstd.decompress)
      const origNative = (zlib as any).zstdDecompressSync;
      (zlib as any).zstdDecompressSync = undefined;
      try {
        const okViaFzstd = readSessionFile(
          (() => {
            const p = path.join(tmpDir, 'fzstd_ok.jsonl.zstd');
            fs.writeFileSync(p, Buffer.concat([frame1, frame2]));
            return p;
          })(),
          { maxDecompressedBytes: 4096 }
        );
        expect(okViaFzstd).not.toBeNull();
        expect(okViaFzstd!.rawLines).toHaveLength(1);

        // Bomb without contentSize header (streamed block overflow caught by fzstd.Decompress ondata budget guard)
        expect(readSessionFile(bombFile, { maxDecompressedBytes: 2048 })).toBeNull();

        // Also test a zstd frame produced with pledgedSize omitted (no Frame_Content_Size in header)
        const noSizeFrame = (zlib as any).zstdCompressSync(Buffer.from('B'.repeat(4096) + '\n'), {
          params: { [(zlib as any).constants.ZSTD_c_contentSizeFlag]: 0 },
        });
        expect(scanZstdFrames(noSizeFrame).frames[0].contentSize).toBeUndefined();
        const streamBombFile = path.join(tmpDir, 'stream_bomb.jsonl.zstd');
        fs.writeFileSync(streamBombFile, Buffer.concat([frame1, noSizeFrame]));
        expect(readSessionFile(streamBombFile, { maxDecompressedBytes: 2048 })).toBeNull();
      } finally {
        (zlib as any).zstdDecompressSync = origNative;
      }
    });

    it('checks excludeWorkspaces on frame 0 BEFORE decompressing subsequent zstd frames and preserves trailing whitespace JSONL', () => {
      const excludedCwd = 'C:\\Projects\\TopSecret';
      const frame0 = (zlib as any).zstdCompressSync(
        Buffer.from(JSON.stringify({ version: 4, cwd: excludedCwd }) + '\n')
      );
      // Frame 1 exceeds budget if decompressed, proving frame 0 stopped before touching frame 1
      const hugeFrame1 = (zlib as any).zstdCompressSync(Buffer.from('X'.repeat(8192) + '\n'));
      const excludedZstd = path.join(tmpDir, 'excluded.jsonl.zstd');
      fs.writeFileSync(excludedZstd, Buffer.concat([frame0, hugeFrame1]));

      const excludedRes = readSessionFile(excludedZstd, {
        excludeWorkspaces: [excludedCwd],
        maxDecompressedBytes: 1024,
      });
      expect(excludedRes).toBeNull();

      // Trailing whitespace after last '\n' must NOT drop the final valid event
      const wsFile = path.join(tmpDir, 'trailing_ws.jsonl');
      fs.writeFileSync(
        wsFile,
        JSON.stringify({ version: 4, cwd: testCwd }) +
          '\n' +
          JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, text: 'keep me' } }) +
          '\n   \t  ',
        'utf8'
      );
      const parsedWs = readSessionFile(wsFile);
      expect(parsedWs).not.toBeNull();
      expect(parsedWs!.rawLines).toHaveLength(1);
      expect(parsedWs!.rawLines[0]).toContain('keep me');
    });

    it('defaults enqueueOfflineJobs to false, deduplicates projcache against primary logs, fixes adjacent seq collisions, and checkpoints files', () => {
      const primaryDir = path.join(tmpDir, 'sessions');
      fs.mkdirSync(primaryDir, { recursive: true });

      const f1 = path.join(primaryDir, 'alpha.jsonl');
      const f2 = path.join(primaryDir, 'beta.jsonl');
      const dupProjCache = path.join(primaryDir, 'session_alpha.json');
      const nonMatchingBak = path.join(primaryDir, 'alpha.jsonl.bak');

      // f1 has explicit id + R3 correction + R5 fail-to-fix pair (must NOT enqueue jobs by default!)
      fs.writeFileSync(
        f1,
        [
          JSON.stringify({ version: 4, id: 'sess-alpha', cwd: testCwd }),
          JSON.stringify({
            seq: 1,
            time: 1000,
            type: 'tool/result',
            data: { turn: 1, name: 'bash', isError: true, text: 'failed' },
          }),
          JSON.stringify({
            seq: 2,
            time: 1001,
            type: 'tool/result',
            data: { turn: 1, name: 'bash', isError: false, text: 'fixed' },
          }),
          JSON.stringify({
            seq: 3,
            time: 1002,
            type: 'user/message',
            data: { turn: 2, source: { kind: 'user' }, text: '不对，搞错了' },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      // f2 has NO header.id -> fallback must include stem + hash (never bare 'sessions')
      fs.writeFileSync(
        f2,
        [
          JSON.stringify({ version: 4, cwd: testCwd }),
          JSON.stringify({
            seq: 1,
            time: 2000,
            type: 'user/message',
            data: { source: { kind: 'user' }, text: 'Discuss Subagent architecture cleanly' },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      // Duplicate projcache JSON for sess-alpha -> must be skipped because primary log already covered sess-alpha
      fs.writeFileSync(
        dupProjCache,
        JSON.stringify({
          version: 2,
          record: {
            sessionId: 'sess-alpha',
            identity: { formatVersion: 4, createdAt: 1000, cwd: testCwd },
            rows: {
              turnOutline: {
                val: {
                  turns: [
                    { turn: 1, seq: 1, prompt: 'duplicate prompt', response: 'duplicate resp' },
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      );

      // .jsonl.bak must be ignored by tightened findSessionFiles
      fs.writeFileSync(nonMatchingBak, JSON.stringify({ version: 4, cwd: testCwd }) + '\n', 'utf8');

      // Separate projcache file with adjacent t.seq=10, t.seq=11 to test monotonic nextSeq collision fix
      const projUnique = path.join(primaryDir, 'session_unique.json');
      fs.writeFileSync(
        projUnique,
        JSON.stringify({
          version: 2,
          record: {
            sessionId: 'sess-unique-proj',
            identity: { formatVersion: 4, createdAt: 3000, cwd: testCwd },
            rows: {
              turnOutline: {
                val: {
                  turns: [
                    { turn: 1, seq: 10, prompt: 'Question about Subagent design', response: 'Answer 1' },
                    { turn: 2, seq: 11, prompt: 'Follow up question', response: 'Answer 2' },
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      );

      const firstRun = runBackfill(db, { sessionsDir: primaryDir });
      expect(firstRun.processedFiles).toBe(3); // f1, f2, projUnique
      expect(firstRun.skippedFiles).toBe(1); // dupProjCache
      expect(db.all('SELECT * FROM jobs')).toHaveLength(0); // enqueueOfflineJobs defaulted to false!

      // f2 fallback session_id must NOT be bare parent dir 'sessions'
      const betaEvent = db.get<{ session_id: string }>(
        "SELECT session_id FROM raw_events WHERE text LIKE '%Subagent architecture%'"
      );
      expect(betaEvent?.session_id).toBeDefined();
      expect(betaEvent!.session_id).not.toBe('sessions');
      expect(betaEvent!.session_id).toMatch(/^beta_[0-9a-f]{10}$/);

      // Adjacent t.seq=10,11 in projUnique must produce 4 distinct strictly increasing seq rows (10,11,12,13)
      const projSeqs = db
        .all<{ seq: number }>("SELECT seq FROM raw_events WHERE session_id = 'sess-unique-proj' ORDER BY seq")
        .map((r) => r.seq);
      expect(projSeqs).toEqual([10, 11, 12, 13]);

      // Incremental checkpoint: 2nd run skips all unchanged files
      const secondRun = runBackfill(db, { sessionsDir: primaryDir });
      expect(secondRun.processedFiles).toBe(0);
      expect(secondRun.skippedFiles).toBe(4);

      // force: true re-reads files despite checkpoint (still idempotent on raw_events)
      const forcedRun = runBackfill(db, { sessionsDir: primaryDir, force: true });
      expect(forcedRun.processedFiles).toBe(2); // f1 & f2 (projcache files skipped because sessions already in DB)
      expect(forcedRun.newEventsAdded).toBe(0);
    });

    it('does not increment stats when per-file DB transaction rolls back and exports shared tool call ID helpers', () => {
      expect(extractToolCallId({ callId: 'c1', id: 'x' })).toBe('c1');
      expect(extractToolCallId({ toolCallId: 'c2' })).toBe('c2');
      expect(extractToolCallId({ id: 'c3' })).toBe('c3');
      expect(extractToolCallId(null)).toBeNull();

      expect(extractToolResultCallId({ message: { toolCallId: 'r1' } })).toBe('r1');
      expect(extractToolResultCallId({ source: { callId: 'r2' } })).toBe('r2');
      expect(extractToolResultCallId({ toolCallId: 'r3' })).toBe('r3');
      expect(extractToolResultCallId(undefined)).toBeNull();

      const sessionFile = path.join(tmpDir, 'tx_fail.jsonl');
      fs.writeFileSync(
        sessionFile,
        JSON.stringify({ version: 4, cwd: testCwd }) +
          '\n' +
          JSON.stringify({ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, text: 'hi' } }) +
          '\n',
        'utf8'
      );

      const txSpy = vi.spyOn(db, 'transaction').mockImplementation(() => {
        throw new Error('simulated_tx_failure');
      });
      const failedStats = runBackfill(db, { filePaths: [sessionFile] });
      txSpy.mockRestore();

      expect(failedStats.processedFiles).toBe(0);
      expect(failedStats.skippedFiles).toBe(1);
      expect(failedStats.newEventsAdded).toBe(0);
      expect(failedStats.rawEvents).toBe(0);
    });
  });
});
