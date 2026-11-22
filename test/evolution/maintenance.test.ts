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
  cleanOldTelemetry,
  curateMemoriesWithLLM,
  exportDatabaseFile,
  importDatabaseFile,
  pruneInvalidMemories,
} from '../../src/evolution/maintenance.js';
import { upsertCandidate, freeze } from '../../src/core/writer.js';
import { saveConfigToDb } from '../../src/config.js';
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

  it('strips plaintext API keys from backups, prunes all 10 telemetry tables, sets valid_to/invalidated_at on cold archive, and rejects bound expired repair candidates', () => {
    const now = 2_000_000_000_000;
    const day = 86_400_000;

    // 1. Backup must strip meta.config_override (plaintext API keys)
    saveConfigToDb(db, {
      offlineLLM: {
        ...DEFAULTS.offlineLLM,
        apiKey: 'sk-backup-plaintext-secret-1234567890',
      },
      embedding: {
        ...DEFAULTS.embedding,
        apiKey: 'sk-embed-plaintext-secret-1234567890',
      },
    });
    const backupFile = backupDatabase(db, ':memory:', tempBackupDir, now);
    const bakDb = openDb(backupFile, { readOnly: true });
    try {
      expect(bakDb.get("SELECT value FROM meta WHERE key = 'config_override'")).toBeUndefined();
    } finally {
      bakDb.close();
    }

    // 2. archiveColdMemories sets valid_to and invalidated_at
    const coldRes = upsertCandidate(db, {
      type: 'semantic',
      content: '冷数据测试记忆。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_cold', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const coldId = (coldRes as any).id;
    db.run(
      'UPDATE memories SET utility = 0.2, created_at = ?, last_used_at = ? WHERE id = ?',
      [now - 70 * day, now - 70 * day, coldId]
    );
    expect(archiveColdMemories(db, cfg, now)).toBe(1);
    const coldRow = db.get<MemoryRecord>('SELECT status, valid_to, invalidated_at FROM memories WHERE id = ?', [
      coldId,
    ]);
    expect(coldRow).toEqual({ status: 'archived', valid_to: now, invalidated_at: now });

    // 3. expireCandidates rejects candidates bound to expired repair_proposals even if < 30 days old
    const boundCand = upsertCandidate(db, {
      type: 'semantic',
      content: '绑定在过期修复提案上的较新候选。',
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'llm_extract',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's_rep', seq: 1, kind: 'assistant' }],
      actor: 'llm',
    }, now - 2 * day);
    const boundCandId = (boundCand as any).id;
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
       VALUES (501, 'm_orig', 1, 'revise', ?, 'expired prop', 'candidate', ?, ?)`,
      [JSON.stringify([boundCandId]), now - 31 * day, now - 1000]
    );
    const expRes = expireCandidates(db, now);
    expect(expRes.expiredProposals).toBe(1);
    expect(expRes.expiredCandidates).toBeGreaterThanOrEqual(1);
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [boundCandId])?.status).toBe('rejected');

    // 4. 10-table cleanOldTelemetry retention
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, origin_kind, processed)
       VALUES ('s_old_proc', 1, 'ws1', 'user', ?, 'user', 2), ('s_old_unproc', 2, 'ws1', 'user', ?, 'user', 0)`,
      [now - 35 * day, now - 65 * day]
    );
    db.run(
      `INSERT INTO turn_metrics (session_id, turn, strategy_v, created_at) VALUES ('s_tm', 1, 1, ?)`,
      [now - 95 * day]
    );
    db.run(
      `INSERT INTO jobs (kind, key, status, created_at, finished_at) VALUES ('distill', 'old_job', 'done', ?, ?)`,
      [now - 20 * day, now - 16 * day]
    );
    db.run(
      `INSERT INTO llm_ledger (day, job_kind, model, prompt_version, reserved_tokens, status, ok, created_at)
       VALUES ('2025-01-01', 'distill', 'm', 'v2', 100, 'succeeded', 1, ?)`,
      [now - 95 * day]
    );
    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
       VALUES ('s_inj', 1, 'm_x', 1, 'dynamic', 1, 10, 'content', 1, ?)`,
      [now - 95 * day]
    );
    db.run(
      `INSERT INTO repair_proposals (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at, approved_at)
       VALUES (502, 'm_orig', 1, 'invalidate', '[]', 'old', 'approved', ?, ?, ?)`,
      [now - 40 * day, now - 10 * day, now - 35 * day]
    );
    db.run(
      `INSERT INTO failure_sigs (sig, workspace_id, count, sessions, updated_at)
       VALUES ('bash:old', 'ws1', 1, '["s1"]', ?)`,
      [now - 95 * day]
    );
    for (let i = 0; i < 105; i++) {
      db.run(
        `INSERT INTO eval_cases (id, suite, payload, critical, created_at) VALUES (?, 'harvested', '{}', 0, ?)`,
        [`harv_${i}`, now - (200 - i) * 1000]
      );
    }
    for (let v = 1; v <= 25; v++) {
      db.run(
        `INSERT INTO memory_versions (memory_id, version, snapshot, reason, actor, created_at)
         VALUES ('m_ver_test', ?, '{}', 'edit', 'user', ?)`,
        [v, now - (30 - v) * 1000]
      );
    }
    db.run(
      `INSERT INTO meta (key, value) VALUES ('distill:s_stale', ?), ('job_skip_count:99999', '3')`,
      [JSON.stringify({ lastSeq: 1, updatedAt: now - 35 * day })]
    );

    const cleanRes = cleanOldTelemetry(db, now, { ...cfg, privacy: { offlineConsent: false, allowedOfflineEndpoints: [] } });
    expect(cleanRes.deletedEvents).toBe(2);
    expect(cleanRes.deletedMetrics).toBe(1);
    expect(cleanRes.deletedJobs).toBe(1);
    expect(cleanRes.deletedLedger).toBe(1);
    expect(cleanRes.deletedInjections).toBe(1);
    // Proposal 501 (expired/rejected >30d) + proposal 502 (approved >30d)
    expect(cleanRes.deletedProposals).toBe(2);
    expect(cleanRes.deletedFailureSigs).toBe(1);
    expect(cleanRes.deletedEvalCases).toBe(5);
    expect(cleanRes.deletedVersions).toBe(5);
    expect(cleanRes.deletedMeta).toBe(2);
  });

  it('scopes pruneInvalidMemories slot map by session_id, honors frozen slot holders, validates import schema_version & preserves local frozen records', () => {
    const now = Date.now();
    // 1. Session-scoped candidate in session A must NOT be pruned by active slot in session B
    upsertCandidate(db, {
      type: 'semantic',
      content: 'Session B active slot value.',
      slot_key: 'session.mode',
      scope: 'session',
      workspaceId: 'ws_s',
      sessionId: 'sess_B',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 'sess_B', seq: 1, kind: 'user' }],
      actor: 'user',
    }, now);
    const sessACand = upsertCandidate(db, {
      type: 'semantic',
      content: 'Session A candidate slot value.',
      slot_key: 'session.mode',
      scope: 'session',
      workspaceId: 'ws_s',
      sessionId: 'sess_A',
      source_kind: 'llm_extract',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 'sess_A', seq: 1, kind: 'assistant' }],
      actor: 'llm',
    }, now - 1000);
    const sessACandId = (sessACand as any).id;

    // 2. Candidate shadowed by a FROZEN slot holder in same workspace MUST be pruned
    const frozenHolder = upsertCandidate(db, {
      type: 'semantic',
      content: 'Frozen database engine setting.',
      slot_key: 'project.db',
      scope: 'workspace',
      workspaceId: 'ws_s',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    }, now - 5000);
    const frozenId = (frozenHolder as any).id;
    freeze(db, frozenId, 'user', now - 4000);
    const shadowedCand = upsertCandidate(db, {
      type: 'semantic',
      content: 'Candidate database engine setting.',
      slot_key: 'project.db',
      scope: 'workspace',
      workspaceId: 'ws_s',
      source_kind: 'llm_extract',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's2', seq: 1, kind: 'assistant' }],
      actor: 'llm',
    }, now);
    const shadowedId = (shadowedCand as any).id;

    const pruneRes = pruneInvalidMemories(db, { workspaceId: 'ws_s', now });
    expect(pruneRes.prunedIds).toContain(shadowedId);
    expect(pruneRes.prunedIds).not.toContain(sessACandId);
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [frozenId])?.status).toBe('frozen');

    // 3. importDatabaseFile rejects future schema_version and protects local frozen record on ID collision
    const exportPath = path.join(tempBackupDir, 'future.db');
    expect(exportDatabaseFile(db, ':memory:', exportPath).success).toBe(true);
    const futureDb = openDb(exportPath);
    futureDb.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '999')");
    futureDb.close();
    const targetDb = openDb(':memory:');
    try {
      const impFuture = importDatabaseFile(targetDb, ':memory:', exportPath);
      expect(impFuture.success).toBe(false);
    } finally {
      targetDb.close();
    }

    // Local frozen protection on import
    const srcPath = path.join(tempBackupDir, 'collision.db');
    expect(exportDatabaseFile(db, ':memory:', srcPath).success).toBe(true);
    const localDb = openDb(':memory:');
    try {
      // Import once, then freeze frozenId with custom content, then modify srcPath and re-import
      expect(importDatabaseFile(localDb, ':memory:', srcPath).success).toBe(true);
      localDb.run("UPDATE memories SET content = 'LOCAL_FROZEN_CONTENT', status = 'frozen' WHERE id = ?", [frozenId]);
      const impAgain = importDatabaseFile(localDb, ':memory:', srcPath);
      expect(impAgain.success).toBe(true);
      expect(localDb.get<MemoryRecord>('SELECT content, status FROM memories WHERE id = ?', [frozenId])).toEqual({
        content: 'LOCAL_FROZEN_CONTENT',
        status: 'frozen',
      });
    } finally {
      localDb.close();
    }
  });

  it('persists curate:last only after parse success, deduplicates absorb_ids from discard_ids, and advances rotating cursor', async () => {
    const curateCfg: PluginConfig = {
      ...DEFAULTS,
      privacy: { offlineConsent: true, allowedOfflineEndpoints: ['https://api.deepseek.com'] },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
      },
    };
    const c1 = upsertCandidate(db, {
      type: 'semantic',
      content: '候选记忆条目一：项目构建输出在 dist 目录。',
      scope: 'workspace',
      workspaceId: 'ws_curate',
      source_kind: 'llm_extract',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 'sc1', seq: 1, kind: 'assistant' }],
      actor: 'llm',
    });
    const c2 = upsertCandidate(db, {
      type: 'semantic',
      content: '候选记忆条目二：项目构建输出位于 dist/。',
      scope: 'workspace',
      workspaceId: 'ws_curate',
      source_kind: 'llm_extract',
      confidence: 0.7,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 'sc2', seq: 2, kind: 'assistant' }],
      actor: 'llm',
    });
    const id1 = (c1 as any).id;
    const id2 = (c2 as any).id;

    // 1. Parse failure must NOT persist curate:last fingerprint
    const badRes = await curateMemoriesWithLLM(db, curateCfg, {
      workspaceId: 'ws_curate',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"unrelated": true}' } }],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          }),
          { status: 200 }
        ),
    });
    expect(badRes.ok).toBe(false);
    expect(db.get("SELECT value FROM meta WHERE key LIKE 'curate:last:%'")).toBeUndefined();

    // 2. Subsequent valid call succeeds, deduplicates id2 from discard_ids so id1 absorbs id2's source!
    const okRes = await curateMemoriesWithLLM(db, curateCfg, {
      workspaceId: 'ws_curate',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    discard_ids: [id2],
                    updates: [
                      {
                        target_id: id1,
                        absorb_ids: [id2],
                        type: 'semantic',
                        text: '项目构建产物统一输出在 dist 目录中。',
                        confidence: 0.85,
                      },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 80, completion_tokens: 40 },
          }),
          { status: 200 }
        ),
    });
    expect(okRes.ok).toBe(true);
    expect(okRes.llmDiscarded).toBe(0);
    expect(okRes.llmUpdated).toBe(1);
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [id2])?.status).toBe('superseded');
    expect(db.get("SELECT value FROM meta WHERE key LIKE 'curate:last:%'")).toBeDefined();
    expect(db.get("SELECT value FROM meta WHERE key LIKE 'curate:cursor:%'")).toBeDefined();
  });
});
