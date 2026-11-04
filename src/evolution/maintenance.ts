import fs from 'node:fs';
import path from 'node:path';
import type { Db, MemoryRecord } from '../types.js';
import type { PluginConfig } from '../config.js';
import { ftsText } from '../core/text.js';
import { openDb } from '../core/db.js';

export function getBackupTimestamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

/**
 * 冷记忆归档 (§5.15)
 * 仅 active 且未置顶、效用低、长时间未使用的记录改 archived；frozen 与 superseded 绝不改动
 */
export function archiveColdMemories(
  db: Db,
  cfg: PluginConfig,
  now: number = Date.now()
): number {
  const coldDays = cfg.coldDays ?? 60;
  const cutoffTime = now - coldDays * 24 * 3600 * 1000;

  const coldMemories = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE status = 'active'
       AND pinned = 0
       AND utility < 0.35
       AND COALESCE(last_used_at, created_at) < ?`,
    [cutoffTime]
  );

  if (coldMemories.length === 0) return 0;

  db.transaction(() => {
    for (const mem of coldMemories) {
      const { embedding, rowid_, ...snapshotObj } = mem;
      // 保存快照
      db.run(
        `INSERT OR REPLACE INTO memory_versions (
          memory_id, version, snapshot, reason, actor, created_at
        ) VALUES (?, ?, ?, 'archived_cold', 'maintenance', ?)`,
        [mem.id, mem.version, JSON.stringify(snapshotObj), now]
      );

      // 改为 archived
      db.run(
        `UPDATE memories
         SET status = 'archived', updated_at = ?
         WHERE id = ?`,
        [now, mem.id]
      );
    }
  });

  return coldMemories.length;
}

/**
 * 候选与修复提案过期处理 (§5.15)
 * candidate 超过 30 天未晋升 -> rejected
 * repair_proposals 超过 expires_at -> rejected
 */
export function expireCandidates(
  db: Db,
  now: number = Date.now()
): { expiredCandidates: number; expiredProposals: number } {
  const thirtyDaysMs = 30 * 24 * 3600 * 1000;
  const candidateCutoff = now - thirtyDaysMs;

  const res1 = db.run(
    `UPDATE memories
     SET status = 'rejected', updated_at = ?
     WHERE status = 'candidate' AND created_at < ?`,
    [now, candidateCutoff]
  );

  const res2 = db.run(
    `UPDATE repair_proposals
     SET status = 'rejected'
     WHERE status = 'candidate' AND expires_at <= ?`,
    [now]
  );

  return {
    expiredCandidates: Number(res1.changes),
    expiredProposals: Number(res2.changes),
  };
}

/**
 * 自动置顶稳定记忆 (§5.10 / §5.15)
 * 1. type ∈ {preference, goal} 且 utility ≥ 0.6 且 confidence ≥ 0.8
 * 2. type = 'semantic' 且 use_count ≥ 5 且 utility ≥ 0.7
 */
export function autoPinMemories(db: Db, now: number = Date.now()): number {
  const res = db.run(
    `UPDATE memories
     SET pinned = 1, updated_at = ?
     WHERE pinned = 0 AND status = 'active' AND (
       (type IN ('preference', 'goal') AND utility >= 0.6 AND confidence >= 0.8)
       OR (type = 'semantic' AND use_count >= 5 AND utility >= 0.7)
     )`,
    [now]
  );

  return Number(res.changes);
}

/**
 * FTS 全文索引一致性检查与修复
 */
export function checkAndRepairFts(db: Db): { consistent: boolean; rebuilt: boolean } {
  // 检查 rowid 一一对应及 count
  const memRows = db.all<{ rowid_: number; content: string; summary: string }>(
    'SELECT rowid_, content, summary FROM memories ORDER BY rowid_ ASC'
  );
  const ftsRows = db.all<{ rowid: number; fts_text: string }>(
    'SELECT rowid, fts_text FROM memory_fts ORDER BY rowid ASC'
  );

  let isConsistent = memRows.length === ftsRows.length;
  if (isConsistent) {
    for (let i = 0; i < memRows.length; i++) {
      if (memRows[i].rowid_ !== ftsRows[i].rowid) {
        isConsistent = false;
        break;
      }
      const expectedText = ftsText(memRows[i].content + ' ' + memRows[i].summary);
      if (ftsRows[i].fts_text !== expectedText) {
        isConsistent = false;
        break;
      }
    }
  }

  if (isConsistent) {
    return { consistent: true, rebuilt: false };
  }

  // 重建 FTS 索引
  db.transaction(() => {
    db.run('DELETE FROM memory_fts');
    for (const row of memRows) {
      const text = ftsText(row.content + ' ' + row.summary);
      db.run('INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)', [row.rowid_, text]);
    }
  });

  return { consistent: false, rebuilt: true };
}

/**
 * 清理过期事件与指标数据 (§5.15)
 */
export function cleanOldTelemetry(
  db: Db,
  now: number = Date.now()
): { deletedEvents: number; deletedMetrics: number } {
  const thirtyDaysMs = 30 * 24 * 3600 * 1000;
  const ninetyDaysMs = 90 * 24 * 3600 * 1000;

  const resEvents = db.run(
    `DELETE FROM raw_events
     WHERE processed = 2 AND time < ?`,
    [now - thirtyDaysMs]
  );

  const resMetrics = db.run(
    `DELETE FROM turn_metrics
     WHERE created_at < ?`,
    [now - ninetyDaysMs]
  );

  return {
    deletedEvents: Number(resEvents.changes),
    deletedMetrics: Number(resMetrics.changes),
  };
}

/**
 * 数据库安全热备与轮换 (只保留最近 7 份) (§10)
 */
export function backupDatabase(
  db: Db,
  dbFilePath: string,
  backupDir: string,
  now: number = Date.now()
): string {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const ts = getBackupTimestamp(new Date(now));
  const finalName = `memory-${ts}.db`;
  const finalPath = path.join(backupDir, finalName);
  const tempPath = path.join(backupDir, `temp-${ts}-${Math.random().toString(36).slice(2, 8)}.db`);

  // 使用 SQLite 备份命令 VACUUM INTO
  try {
    db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
  } catch {
    // 回退到文件流拷贝
    if (fs.existsSync(dbFilePath)) {
      fs.copyFileSync(dbFilePath, tempPath);
    } else {
      throw new Error(`cannot backup non-existent file: ${dbFilePath}`);
    }
  }

  // PRAGMA integrity_check 校验
  try {
    const checkDb = openDb(tempPath);
    const integrity = checkDb.get<{ integrity_check: string }>('PRAGMA integrity_check');
    checkDb.close();
    if (integrity?.integrity_check !== 'ok') {
      try { fs.unlinkSync(tempPath); } catch {}
      throw new Error('Backup failed integrity check');
    }
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }

  // 原子改名
  fs.renameSync(tempPath, finalPath);

  // 轮换：保留最近 7 份
  const files = fs
    .readdirSync(backupDir)
    .filter(f => /^memory-\d{8}-\d{6}\.db$/.test(f))
    .sort();

  if (files.length > 7) {
    const toRemove = files.slice(0, files.length - 7);
    for (const f of toRemove) {
      try {
        fs.unlinkSync(path.join(backupDir, f));
      } catch {
        // ignore
      }
    }
  }

  return finalPath;
}

/**
 * 导出数据库到 .db 文件 (§10)
 * 按临时文件 -> 完整性校验 -> 原子改名流程导出一个 .db 文件；目标已存在时拒绝覆盖。
 */
export function exportDatabaseFile(
  db: Db,
  dbFilePath: string,
  targetPath: string
): { success: boolean; path: string; error?: string } {
  const resolvedTarget = path.resolve(targetPath);
  if (fs.existsSync(resolvedTarget)) {
    return {
      success: false,
      path: resolvedTarget,
      error: `Target file already exists: ${resolvedTarget}. Refusing to overwrite.`,
    };
  }

  const targetDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const tempName = `.tmp-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`;
  const tempPath = path.join(targetDir, tempName);

  try {
    try {
      db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    } catch {
      if (fs.existsSync(dbFilePath)) {
        fs.copyFileSync(dbFilePath, tempPath);
      } else {
        return {
          success: false,
          path: resolvedTarget,
          error: `Cannot export in-memory or non-existent file database without VACUUM: ${dbFilePath}`,
        };
      }
    }

    // 校验临时库
    const checkDb = openDb(tempPath);
    const integrity = checkDb.get<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') {
      checkDb.close();
      try { fs.unlinkSync(tempPath); } catch {}
      return { success: false, path: resolvedTarget, error: 'Exported database failed PRAGMA integrity_check' };
    }

    const tables = checkDb.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).map(t => t.name);
    for (const req of ['memories', 'memory_versions', 'injections', 'meta']) {
      if (!tables.includes(req)) {
        checkDb.close();
        try { fs.unlinkSync(tempPath); } catch {}
        return { success: false, path: resolvedTarget, error: `Exported database missing required table: ${req}` };
      }
    }
    checkDb.close();

    // 原子改名
    fs.renameSync(tempPath, resolvedTarget);
    return { success: true, path: resolvedTarget };
  } catch (err: any) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    return { success: false, path: resolvedTarget, error: err.message };
  }
}

/**
 * 从 .db 文件导入数据库 (§10)
 * 在只读连接检查 schema_version, integrity_check, 必需表等。通过后导入数据，并保留 .bak 备份。
 */
export function importDatabaseFile(
  currentDb: Db,
  currentDbFilePath: string,
  sourcePath: string
): { success: boolean; importedRecords: number; error?: string } {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    return { success: false, importedRecords: 0, error: `Source database file not found: ${resolvedSource}` };
  }

  // 1. 在只读临时连接检查
  let sourceDb: Db;
  try {
    sourceDb = openDb(resolvedSource);
  } catch (err: any) {
    return { success: false, importedRecords: 0, error: `Cannot open source database: ${err.message}` };
  }

  try {
    const integrity = sourceDb.get<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') {
      sourceDb.close();
      return { success: false, importedRecords: 0, error: 'Source database failed integrity check' };
    }

    const metaRow = sourceDb.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'schema_version'"
    );
    if (!metaRow || !metaRow.value) {
      sourceDb.close();
      return { success: false, importedRecords: 0, error: 'Source database missing schema_version in meta' };
    }

    const tables = sourceDb.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).map(t => t.name);
    for (const req of ['memories', 'memory_versions', 'injections']) {
      if (!tables.includes(req)) {
        sourceDb.close();
        return { success: false, importedRecords: 0, error: `Source database missing required table: ${req}` };
      }
    }

    // 2. 如果存在本地文件库，保留 .bak 备份
    if (currentDbFilePath && currentDbFilePath !== ':memory:' && fs.existsSync(currentDbFilePath)) {
      try {
        fs.copyFileSync(currentDbFilePath, `${currentDbFilePath}.bak`);
      } catch {
        // ignore backup notice
      }
    }

    // 3. 读取 sourceDb 的全部有效记忆并在事务内导入到 currentDb
    const memories = sourceDb.all<MemoryRecord>('SELECT * FROM memories');
    const versions = sourceDb.all<any>('SELECT * FROM memory_versions');

    currentDb.transaction(() => {
      for (const m of memories) {
        currentDb.run(
          `INSERT OR REPLACE INTO memories (
            id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
            origin_kinds, source_kind, confidence, utility, use_count, success_count, fail_count,
            token_cost, summary_cost, hash, version, content_rev, pinned, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id, m.type, m.status, m.content, m.summary, m.slot_key, m.scope, m.workspace_id, m.session_id,
            typeof m.origin_kinds === 'string' ? m.origin_kinds : JSON.stringify(m.origin_kinds),
            m.source_kind, m.confidence, m.utility, m.use_count, m.success_count, m.fail_count,
            m.token_cost, m.summary_cost, m.hash, m.version, m.content_rev, m.pinned, m.created_at, m.updated_at
          ]
        );
      }

      for (const v of versions) {
        currentDb.run(
          `INSERT OR REPLACE INTO memory_versions (
            memory_id, version, snapshot, reason, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [v.memory_id, v.version, v.snapshot, v.reason, v.actor, v.created_at]
        );
      }
    });

    // 4. 重建 FTS 索引
    checkAndRepairFts(currentDb);

    sourceDb.close();
    return { success: true, importedRecords: memories.length };
  } catch (err: any) {
    try { sourceDb.close(); } catch {}
    return { success: false, importedRecords: 0, error: err.message };
  }
}
