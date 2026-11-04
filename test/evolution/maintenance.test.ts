import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  backupDatabase,
  checkAndRepairFts,
  exportDatabaseFile,
  importDatabaseFile,
} from '../../src/evolution/maintenance.js';
import { upsertCandidate } from '../../src/core/writer.js';
import type { Db, MemoryRecord } from '../../src/types.js';

describe('Maintenance (M3-T5)', () => {
  let db: Db;
  let tempBackupDir: string;
  const cfg: PluginConfig = { ...DEFAULTS, coldDays: 60 };

  beforeEach(() => {
    db = openDb(':memory:');
    tempBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-backup-test-'));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (fs.existsSync(tempBackupDir)) {
      try {
        fs.rmSync(tempBackupDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('archives cold active memories while preserving frozen, superseded, and pinned records (冷归档)', () => {
    const now = 1000000000;
    const seventyDaysAgo = now - 70 * 24 * 3600 * 1000;

    // 1. 冷的普通 active 记忆 (应被归档)
    const m1 = upsertCandidate(db, {
      type: 'semantic',
      content: '普通的临时配置事实。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const id1 = (m1 as any).id;
    db.run(
      "UPDATE memories SET status = 'active', utility = 0.2, pinned = 0, created_at = ?, last_used_at = ? WHERE id = ?",
      [seventyDaysAgo, seventyDaysAgo, id1]
    );

    // 2. 冷但 utility 较高的 active 记忆 (不归档)
    const m2 = upsertCandidate(db, {
      type: 'semantic',
      content: '高价值事实内容。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'user',
    });
    const id2 = (m2 as any).id;
    db.run(
      "UPDATE memories SET status = 'active', utility = 0.6, pinned = 0, created_at = ?, last_used_at = ? WHERE id = ?",
      [seventyDaysAgo, seventyDaysAgo, id2]
    );

    // 3. 冷但被用户置顶 pinned=1 的记忆 (不归档)
    const m3 = upsertCandidate(db, {
      type: 'semantic',
      content: '用户置顶的关键事实。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
      actor: 'user',
    });
    const id3 = (m3 as any).id;
    db.run(
      "UPDATE memories SET status = 'active', utility = 0.2, pinned = 1, created_at = ?, last_used_at = ? WHERE id = ?",
      [seventyDaysAgo, seventyDaysAgo, id3]
    );

    // 4. 冷但处于 frozen 状态的记忆 (永不自动归档)
    const m4 = upsertCandidate(db, {
      type: 'semantic',
      content: '已冻结的重要配置。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 4, kind: 'user' }],
      actor: 'user',
    });
    const id4 = (m4 as any).id;
    db.run(
      "UPDATE memories SET status = 'frozen', utility = 0.2, pinned = 0, created_at = ?, last_used_at = ? WHERE id = ?",
      [seventyDaysAgo, seventyDaysAgo, id4]
    );

    // 5. 处于 superseded 状态的记忆 (不破坏历史链，不自动归档)
    const m5 = upsertCandidate(db, {
      type: 'semantic',
      content: '已被取代的历史旧事实。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 5, kind: 'user' }],
      actor: 'user',
    });
    const id5 = (m5 as any).id;
    db.run(
      "UPDATE memories SET status = 'superseded', utility = 0.2, pinned = 0, created_at = ?, last_used_at = ? WHERE id = ?",
      [seventyDaysAgo, seventyDaysAgo, id5]
    );

    const archivedCount = archiveColdMemories(db, cfg, now);
    expect(archivedCount).toBe(1);

    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id1])?.status).toBe('archived');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id2])?.status).toBe('active');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id3])?.status).toBe('active');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id4])?.status).toBe('frozen');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id5])?.status).toBe('superseded');
  });

  it('expires candidates older than 30 days and expired repair proposals (候选过期与提案过期)', () => {
    const now = 1000000000;
    const thirtyOneDaysAgo = now - 31 * 24 * 3600 * 1000;
    const fiveDaysAgo = now - 5 * 24 * 3600 * 1000;

    // 超过 30 天未晋升的 candidate
    const m1 = upsertCandidate(db, {
      type: 'semantic',
      content: '三十天前的旧候选。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'llm_extract',
      confidence: 0.8,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'llm',
    });
    const id1 = (m1 as any).id;
    db.run("UPDATE memories SET status = 'candidate', created_at = ? WHERE id = ?", [thirtyOneDaysAgo, id1]);

    // 5 天前的 candidate (未过期)
    const m2 = upsertCandidate(db, {
      type: 'semantic',
      content: '五天前的新候选。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'llm_extract',
      confidence: 0.8,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'llm',
    });
    const id2 = (m2 as any).id;
    db.run("UPDATE memories SET status = 'candidate', created_at = ? WHERE id = ?", [fiveDaysAgo, id2]);

    // 过期的 repair_proposal
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
       VALUES (1, 'm_target', 1, 'revise', '[]', 'test', 'candidate', ?, ?)`,
      [thirtyOneDaysAgo, now - 1000]
    );

    const { expiredCandidates, expiredProposals } = expireCandidates(db, now);
    expect(expiredCandidates).toBe(1);
    expect(expiredProposals).toBe(1);

    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id1])?.status).toBe('rejected');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id2])?.status).toBe('candidate');
  });

  it('automatically pins high utility preference, goal, and semantic memories (自动pin)', () => {
    // 1. preference: utility >= 0.6 且 confidence >= 0.8 -> 自动 pin
    const m1 = upsertCandidate(db, {
      type: 'preference',
      content: '用户偏好使用 TypeScript 编写脚本。',
      scope: 'user',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const id1 = (m1 as any).id;
    db.run("UPDATE memories SET status = 'active', utility = 0.7, confidence = 0.9, pinned = 0 WHERE id = ?", [id1]);

    // 2. semantic: use_count >= 5 且 utility >= 0.7 -> 自动 pin
    const m2 = upsertCandidate(db, {
      type: 'semantic',
      content: '项目构建命令是 pnpm build。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'user',
    });
    const id2 = (m2 as any).id;
    db.run("UPDATE memories SET status = 'active', use_count = 6, utility = 0.8, pinned = 0 WHERE id = ?", [id2]);

    // 3. semantic 但 use_count 仅为 2 -> 不 pin
    const m3 = upsertCandidate(db, {
      type: 'semantic',
      content: '测试覆盖率目标为 80%。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
      actor: 'user',
    });
    const id3 = (m3 as any).id;
    db.run("UPDATE memories SET status = 'active', use_count = 2, utility = 0.8, pinned = 0 WHERE id = ?", [id3]);

    const pinnedCount = autoPinMemories(db);
    expect(pinnedCount).toBe(2);

    expect(db.get<MemoryRecord>('SELECT pinned FROM memories WHERE id = ?', [id1])?.pinned).toBe(1);
    expect(db.get<MemoryRecord>('SELECT pinned FROM memories WHERE id = ?', [id2])?.pinned).toBe(1);
    expect(db.get<MemoryRecord>('SELECT pinned FROM memories WHERE id = ?', [id3])?.pinned).toBe(0);
  });

  it('generates backups and rotates retaining only the latest 7 files (备份生成与轮换)', () => {
    // 生成 9 份不同时间戳的备份文件
    const baseTime = Date.now();
    for (let i = 0; i < 9; i++) {
      const backupTime = baseTime + i * 2000;
      backupDatabase(db, ':memory:', tempBackupDir, backupTime);
    }

    const files = fs
      .readdirSync(tempBackupDir)
      .filter(f => /^memory-\d{8}-\d{6}\.db$/.test(f))
      .sort();

    // 严格轮换：仅保留最近 7 份
    expect(files).toHaveLength(7);
  });

  it('verifies and repairs FTS consistency if desynchronized', () => {
    upsertCandidate(db, {
      type: 'semantic',
      content: '用于 FTS 测试的初始内容。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    const check1 = checkAndRepairFts(db);
    expect(check1.consistent).toBe(true);
    expect(check1.rebuilt).toBe(false);

    // 人为破坏 FTS 索引
    db.run('DELETE FROM memory_fts');

    const check2 = checkAndRepairFts(db);
    expect(check2.consistent).toBe(false);
    expect(check2.rebuilt).toBe(true);

    const check3 = checkAndRepairFts(db);
    expect(check3.consistent).toBe(true);
    expect(check3.rebuilt).toBe(false);
  });

  it('exports and imports .db files with integrity validation and overwriting protection (§10)', () => {
    // 插入一条待导出的数据
    upsertCandidate(db, {
      type: 'semantic',
      content: '需要导出备份的重要事实。',
      scope: 'workspace',
      workspaceId: 'ws_export',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_exp', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    const exportPath = path.join(tempBackupDir, 'exported.db');

    // 1. 成功导出
    const expRes = exportDatabaseFile(db, ':memory:', exportPath);
    expect(expRes.success).toBe(true);
    expect(fs.existsSync(exportPath)).toBe(true);

    // 2. 目标已存在时拒绝覆盖
    const expDup = exportDatabaseFile(db, ':memory:', exportPath);
    expect(expDup.success).toBe(false);
    expect(expDup.error).toContain('Refusing to overwrite');

    // 3. 导入到另一个新数据库
    const newDb = openDb(':memory:');
    const impRes = importDatabaseFile(newDb, ':memory:', exportPath);
    expect(impRes.success).toBe(true);
    expect(impRes.importedRecords).toBeGreaterThan(0);

    const importedMem = newDb.get<MemoryRecord>(
      "SELECT * FROM memories WHERE content LIKE '%需要导出备份%'"
    );
    expect(importedMem).toBeDefined();
    expect(importedMem?.content).toBe('需要导出备份的重要事实。');

    // 4. 尝试导入非法的损坏文件
    const corruptPath = path.join(tempBackupDir, 'corrupt.db');
    fs.writeFileSync(corruptPath, 'corrupted binary content');
    const impCorrupt = importDatabaseFile(newDb, ':memory:', corruptPath);
    expect(impCorrupt.success).toBe(false);

    newDb.close();
  });
});
