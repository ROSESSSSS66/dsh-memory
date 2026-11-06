import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import {
  scanZstdFrames,
  readSessionFile,
  runBackfill,
  ZSTD_MAGIC,
} from '../../src/ingest/backfill.js';

describe('History Backfill (backfill.ts)', () => {
  let db: Db;
  let tmpDir: string;
  const testCwd = 'C:\\Projects\\MyApp';
  const testWsId = workspaceId(testCwd);

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backfill-test-'));
  });

  afterEach(() => {
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
      expect(stats.memoriesCreated).toBe(1);
    });
  });
});
