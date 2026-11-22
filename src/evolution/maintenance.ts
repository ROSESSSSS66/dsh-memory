import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hydrateMemoryRow, type Db, type MemoryRecord, type MemoryRow } from '../types.js';
import type { PluginConfig } from '../config.js';
import { ftsText, contentHash } from '../core/text.js';
import { workspaceId, resolveWorkspaceCwd } from '../core/scope.js';
import { CURRENT_SCHEMA_VERSION, openDb } from '../core/db.js';
import {
  backfillMissingEmbeddings,
  clearRuntimeVectorCache,
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from '../core/vector.js';
import { saveVersionSnapshot, editContent, addRelation } from '../core/writer.js';
import { PROMPT_CURATE, packPromptWithinBudget } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { memoryPrivacyFilterSQL, memoryWorkspaceIds } from '../core/privacy.js';
import { hasUntrustedOrigin, hasUserEvidence } from '../core/trust.js';
import {
  getUnchangedReviewedMemory,
  isProtectedFromModelDiscard,
  sameMemoryOwner,
} from './review-snapshot.js';

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
 * 仅 active 且未置顶、效用低、长时间未使用的记录改 archived；frozen 与 superseded 绝不改动。
 * 同步写入 valid_to 与 invalidated_at，并在事务提交后淘汰向量缓存。
 */
export function archiveColdMemories(
  db: Db,
  cfg: PluginConfig,
  now: number = Date.now()
): number {
  const coldDays = cfg.coldDays ?? 60;
  const cutoffTime = now - coldDays * 24 * 3600 * 1000;

  const coldMemories = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status = 'active'
         AND pinned = 0
         AND utility < 0.35
         AND COALESCE(last_used_at, created_at) < ?`,
      [cutoffTime]
    )
    .map((r) => hydrateMemoryRow(r));

  if (coldMemories.length === 0) return 0;

  db.transaction(() => {
    for (const mem of coldMemories) {
      saveVersionSnapshot(db, mem, 'archived_cold', 'maintenance', now);
      db.run(
        `UPDATE memories
         SET status = 'archived', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [now, now, now, mem.id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(mem.id, db));
    }
  });

  return coldMemories.length;
}

/**
 * 候选与修复提案过期处理 (§5.15)
 * - candidate 超过 30 天未晋升 -> rejected
 * - repair_proposals 超过 expires_at -> rejected，同时拒绝其绑定的候选记忆
 */
export function expireCandidates(
  db: Db,
  now: number = Date.now()
): { expiredCandidates: number; expiredProposals: number } {
  const thirtyDaysMs = 30 * 24 * 3600 * 1000;
  const candidateCutoff = now - thirtyDaysMs;

  return db.transaction(() => {
    const staleCandRows = db.all<{ id: string }>(
      `SELECT id FROM memories WHERE status = 'candidate' AND created_at < ?`,
      [candidateCutoff]
    );
    const res1 = db.run(
      `UPDATE memories
       SET status = 'rejected', valid_to = ?, invalidated_at = ?, updated_at = ?
       WHERE status = 'candidate' AND created_at < ?`,
      [now, now, now, candidateCutoff]
    );
    for (const r of staleCandRows) {
      db.afterCommit(() => removeCachedRuntimeEmbedding(r.id, db));
    }

    const expiredPropRows = db.all<{ id: number; memory_id: string; candidate_ids: string }>(
      `SELECT id, memory_id, candidate_ids
       FROM repair_proposals
       WHERE status = 'candidate' AND expires_at <= ?`,
      [now]
    );

    const res2 = db.run(
      `UPDATE repair_proposals
       SET status = 'rejected'
       WHERE status = 'candidate' AND expires_at <= ?`,
      [now]
    );

    let boundRejected = 0;
    for (const prop of expiredPropRows) {
      let candIds: string[] = [];
      try {
        const parsed = JSON.parse(prop.candidate_ids);
        if (Array.isArray(parsed)) {
          candIds = parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
        }
      } catch {}
      for (const cid of candIds) {
        const r = db.run(
          `UPDATE memories
           SET status = 'rejected', valid_to = ?, invalidated_at = ?, updated_at = ?
           WHERE id = ? AND status = 'candidate'`,
          [now, now, now, cid]
        );
        if (Number(r.changes) > 0) {
          boundRejected += Number(r.changes);
          db.afterCommit(() => removeCachedRuntimeEmbedding(cid, db));
        }
        db.run(
          `DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = 'derived_from'`,
          [cid, prop.memory_id]
        );
      }
    }

    return {
      expiredCandidates: Number(res1.changes) + boundRejected,
      expiredProposals: Number(res2.changes),
    };
  });
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
 * FTS 全文索引一致性检查与增量修复：
 * 先通过 SQL COUNT(*) + NOT EXISTS 差集快速检测缺失/孤儿/空文本行，
 * 一致时零正文加载直接返回，不一致时仅增量修复差异行，避免每次维护将全表拉入 JS 内存。
 */
export function checkAndRepairFts(db: Db): { consistent: boolean; rebuilt: boolean } {
  const memCount = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM memories')?.cnt ?? 0;
  const ftsCount = db.get<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM memory_fts')?.cnt ?? 0;

  const missingRowids = db
    .all<{ rowid_: number }>(
      `SELECT m.rowid_
       FROM memories m
       WHERE NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.rowid = m.rowid_)`
    )
    .map((r) => r.rowid_);

  const orphanRowids = db
    .all<{ rowid: number }>(
      `SELECT f.rowid
       FROM memory_fts f
       WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.rowid_ = f.rowid)`
    )
    .map((r) => r.rowid);

  const emptyFtsRowids = db
    .all<{ rowid_: number }>(
      `SELECT m.rowid_
       FROM memories m
       JOIN memory_fts f ON f.rowid = m.rowid_
       WHERE (f.fts_text IS NULL OR f.fts_text = '')
         AND (TRIM(m.content) != '' OR TRIM(m.summary) != '')`
    )
    .map((r) => r.rowid_);

  if (
    memCount === ftsCount &&
    missingRowids.length === 0 &&
    orphanRowids.length === 0 &&
    emptyFtsRowids.length === 0
  ) {
    return { consistent: true, rebuilt: false };
  }

  db.transaction(() => {
    const deleteStmt = db.prepare('DELETE FROM memory_fts WHERE rowid = ?');
    const selectStmt = db.prepare('SELECT rowid_, content, summary FROM memories WHERE rowid_ = ?');
    const insertStmt = db.prepare('INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)');

    // 1. 删除孤儿 FTS 行
    for (const rid of orphanRowids) {
      deleteStmt.run(rid);
    }

    // 2. 增量重建缺失或空索引行
    const toRebuild = Array.from(new Set<number>([...missingRowids, ...emptyFtsRowids]));
    for (const rid of toRebuild) {
      deleteStmt.run(rid);
      const row = selectStmt.get(rid) as { rowid_: number; content: string; summary: string } | undefined;
      if (row) {
        insertStmt.run(row.rowid_, ftsText(row.content + ' ' + row.summary));
      }
    }
  });

  return { consistent: false, rebuilt: true };
}

export interface CleanTelemetryResult {
  deletedEvents: number;
  deletedMetrics: number;
  deletedJobs: number;
  deletedLedger: number;
  deletedInjections: number;
  deletedProposals: number;
  deletedFailureSigs: number;
  deletedEvalCases: number;
  deletedVersions: number;
  deletedMeta: number;
}

/**
 * 清理过期遥测与全量 10 张有界留存表 (§5.15)：
 * 1) raw_events: processed=2 >30d，或在 offlineConsent=false 时未处理事件 >60d
 * 2) turn_metrics: >90d
 * 3) jobs: done/failed >14d
 * 4) llm_ledger: >90d
 * 5) injections: >90d
 * 6) repair_proposals: approved/rejected >30d
 * 7) failure_sigs: >90d
 * 8) eval_cases: harvested 仅保留最新 100 条
 * 9) memory_versions: 每条记忆仅保留最新 20 个版本快照
 * 10) meta: 清理 >30d 的陈旧 distill/batch_cap 与已终态/孤儿 job_skip_count 键
 */
export function cleanOldTelemetry(
  db: Db,
  now: number = Date.now(),
  cfg?: PluginConfig
): CleanTelemetryResult {
  const fourteenDaysMs = 14 * 24 * 3600 * 1000;
  const thirtyDaysMs = 30 * 24 * 3600 * 1000;
  const sixtyDaysMs = 60 * 24 * 3600 * 1000;
  const ninetyDaysMs = 90 * 24 * 3600 * 1000;
  const offlineConsent = cfg?.privacy?.offlineConsent ?? false;

  return db.transaction(() => {
    // 1. raw_events
    const resEvents = offlineConsent
      ? db.run(`DELETE FROM raw_events WHERE processed = 2 AND time < ?`, [now - thirtyDaysMs])
      : db.run(
          `DELETE FROM raw_events
           WHERE (processed = 2 AND time < ?)
              OR (processed < 2 AND time < ?)`,
          [now - thirtyDaysMs, now - sixtyDaysMs]
        );

    // 2. turn_metrics
    const resMetrics = db.run(`DELETE FROM turn_metrics WHERE created_at < ?`, [now - ninetyDaysMs]);

    // 3. jobs (done/failed > 14d)
    const resJobs = db.run(
      `DELETE FROM jobs
       WHERE status IN ('done', 'failed')
         AND COALESCE(finished_at, created_at) < ?`,
      [now - fourteenDaysMs]
    );

    // 4. llm_ledger (> 90d)
    const resLedger = db.run(`DELETE FROM llm_ledger WHERE created_at < ?`, [now - ninetyDaysMs]);

    // 5. injections (> 90d)
    const resInjections = db.run(`DELETE FROM injections WHERE created_at < ?`, [now - ninetyDaysMs]);

    // 6. repair_proposals (approved/rejected > 30d)
    const resProposals = db.run(
      `DELETE FROM repair_proposals
       WHERE status IN ('approved', 'rejected')
         AND COALESCE(approved_at, created_at) < ?`,
      [now - thirtyDaysMs]
    );

    // 7. failure_sigs (> 90d)
    const resFailureSigs = db.run(`DELETE FROM failure_sigs WHERE updated_at < ?`, [
      now - ninetyDaysMs,
    ]);

    // 8. eval_cases (keep latest 100 harvested)
    const resEvalCases = db.run(
      `DELETE FROM eval_cases
       WHERE suite = 'harvested'
         AND id NOT IN (
           SELECT id FROM eval_cases
           WHERE suite = 'harvested'
           ORDER BY created_at DESC, id DESC
           LIMIT 100
         )`
    );

    // 9. memory_versions (keep latest 20 per memory)
    const resVersions = db.run(
      `DELETE FROM memory_versions
       WHERE (memory_id, version) NOT IN (
         SELECT memory_id, version FROM (
           SELECT memory_id, version,
                  ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY version DESC) AS rn
           FROM memory_versions
         )
         WHERE rn <= 20
       )`
    );

    // 10. stale meta keys (> 30d)
    let deletedMeta = 0;
    const staleCutoff = now - thirtyDaysMs;
    const metaCandidates = db.all<{ key: string; value: string }>(
      `SELECT key, value FROM meta
       WHERE key LIKE 'distill:%'
          OR key LIKE 'distill_batch_cap:%'
          OR key LIKE 'distill_parse_fail:%'
          OR key LIKE 'job_skip_count:%'`
    );
    const deleteMetaStmt = db.prepare('DELETE FROM meta WHERE key = ?');
    for (const row of metaCandidates) {
      if (row.key.startsWith('job_skip_count:')) {
        const jobId = parseInt(row.key.slice('job_skip_count:'.length), 10);
        const activeJob = Number.isInteger(jobId)
          ? db.get<{ id: number }>(
              "SELECT id FROM jobs WHERE id = ? AND status IN ('queued', 'running', 'skipped') LIMIT 1",
              [jobId]
            )
          : undefined;
        if (!activeJob) {
          deletedMeta += Number(deleteMetaStmt.run(row.key).changes);
        }
        continue;
      }

      if (row.key.startsWith('distill_parse_fail:')) {
        // 遗留旧版无时间戳失败计数键：若无对应未蒸馏事件则清理
        const parts = row.key.split(':');
        const sessId = parts[1] || '';
        const hasPending = sessId
          ? db.get<{ cnt: number }>(
              'SELECT COUNT(*) as cnt FROM raw_events WHERE session_id = ? AND processed < 2',
              [sessId]
            )?.cnt
          : 0;
        if (!hasPending) {
          deletedMeta += Number(deleteMetaStmt.run(row.key).changes);
        }
        continue;
      }

      try {
        const parsed = JSON.parse(row.value);
        if (typeof parsed?.updatedAt === 'number' && parsed.updatedAt < staleCutoff) {
          deletedMeta += Number(deleteMetaStmt.run(row.key).changes);
        }
      } catch {}
    }

    return {
      deletedEvents: Number(resEvents.changes),
      deletedMetrics: Number(resMetrics.changes),
      deletedJobs: Number(resJobs.changes),
      deletedLedger: Number(resLedger.changes),
      deletedInjections: Number(resInjections.changes),
      deletedProposals: Number(resProposals.changes),
      deletedFailureSigs: Number(resFailureSigs.changes),
      deletedEvalCases: Number(resEvalCases.changes),
      deletedVersions: Number(resVersions.changes),
      deletedMeta,
    };
  });
}

function writeDatabaseSnapshot(
  db: Db,
  targetPath: string,
  overwrite = true,
  stripConfig = false
): void {
  const tempPath = path.join(path.dirname(targetPath), `.tmp-snapshot-${randomUUID()}.db`);
  try {
    // VACUUM INTO includes committed WAL pages. A plain main-file copy does not.
    db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    if (stripConfig) {
      // 备份与导出快照严禁携带控制台保存的明文 offlineLLM.apiKey / embedding.apiKey
      const scrubDb = openDb(tempPath);
      try {
        scrubDb.exec('PRAGMA secure_delete = ON;');
        scrubDb.run("DELETE FROM meta WHERE key = 'config_override'");
        scrubDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } finally {
        scrubDb.close();
      }
    }
    const checkDb = openDb(tempPath, { readOnly: true });
    try {
      const integrity = checkDb.get<{ integrity_check: string }>('PRAGMA integrity_check');
      if (integrity?.integrity_check !== 'ok') throw new Error('Snapshot failed integrity check');
      for (const name of ['memories', 'memory_versions', 'injections', 'meta']) {
        if (!checkDb.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])) {
          throw new Error(`Snapshot missing required table: ${name}`);
        }
      }
    } finally {
      checkDb.close();
    }
    if (overwrite) fs.renameSync(tempPath, targetPath);
    else {
      try {
        fs.linkSync(tempPath, targetPath);
      } catch (err: any) {
        if (err?.code === 'EXDEV' || err?.code === 'ENOTSUP' || err?.code === 'EPERM') {
          fs.copyFileSync(tempPath, targetPath, fs.constants.COPYFILE_EXCL);
        } else {
          throw err;
        }
      }
    }
  } finally {
    for (const leftover of [tempPath, `${tempPath}-wal`, `${tempPath}-shm`]) {
      if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
    }
  }
}

/**
 * 数据库安全热备与轮换 (只保留最近 7 份，强制剥离明文 API 密钥配置) (§10)
 */
export function backupDatabase(
  db: Db,
  _dbFilePath: string,
  backupDir: string,
  now: number = Date.now()
): string {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const ts = getBackupTimestamp(new Date(now));
  const finalName = `memory-${ts}.db`;
  const finalPath = path.join(backupDir, finalName);
  // stripConfig = true: 备份文件不保存 meta.config_override 中的明文 API Key
  writeDatabaseSnapshot(db, finalPath, true, true);

  // 轮换：保留最近 7 份
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => /^memory-\d{8}-\d{6}\.db$/.test(f))
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
  _dbFilePath: string,
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

  try {
    writeDatabaseSnapshot(db, resolvedTarget, false, true);
    return { success: true, path: resolvedTarget };
  } catch (err: any) {
    return { success: false, path: resolvedTarget, error: err.message };
  }
}

/**
 * 从 .db 文件导入数据库 (§10)
 * 在只读连接校验 schema_version 兼容性 (<= CURRENT_SCHEMA_VERSION)、integrity_check、必需表；
 * 导入时尊重本地 frozen 记录并为被覆盖的本地记录留存版本快照，同时保留 .bak 备份。
 */
export function importDatabaseFile(
  currentDb: Db,
  currentDbFilePath: string,
  sourcePath: string
): { success: boolean; importedRecords: number; error?: string } {
  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    return {
      success: false,
      importedRecords: 0,
      error: `Source database file not found: ${resolvedSource}`,
    };
  }

  // 1. 在只读临时连接检查
  let sourceDb: Db;
  try {
    sourceDb = openDb(resolvedSource, { readOnly: true });
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
    const sourceSchemaVersion = parseInt(metaRow.value, 10);
    if (
      !Number.isInteger(sourceSchemaVersion) ||
      sourceSchemaVersion < 1 ||
      sourceSchemaVersion > CURRENT_SCHEMA_VERSION
    ) {
      sourceDb.close();
      return {
        success: false,
        importedRecords: 0,
        error: `Incompatible source schema_version=${metaRow.value} (max supported=${CURRENT_SCHEMA_VERSION})`,
      };
    }

    const tables = sourceDb
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((t) => t.name);
    for (const req of ['memories', 'memory_versions', 'injections']) {
      if (!tables.includes(req)) {
        sourceDb.close();
        return {
          success: false,
          importedRecords: 0,
          error: `Source database missing required table: ${req}`,
        };
      }
    }

    // 2. 如果存在本地文件库，保留 .bak 备份（同时剥离明文密钥配置）
    if (currentDbFilePath && currentDbFilePath !== ':memory:') {
      writeDatabaseSnapshot(currentDb, `${currentDbFilePath}.bak`, true, true);
    }

    // 3. 读取 sourceDb 的全部有效记忆、版本历史及关联图谱/证据并在事务内无损导入到 currentDb
    const memories = sourceDb.all<MemoryRow>('SELECT * FROM memories');
    const versions = sourceDb.all<any>('SELECT * FROM memory_versions');
    const entities = tables.includes('memory_entities')
      ? sourceDb.all<{ memory_id: string; entity: string }>('SELECT memory_id, entity FROM memory_entities')
      : [];
    const sourcesRows = tables.includes('memory_sources')
      ? sourceDb.all<any>(
          'SELECT memory_id, content_rev, session_id, seq, kind, excerpt, created_at FROM memory_sources'
        )
      : [];
    const sourceOwners = tables.includes('session_workspace_owners')
      ? sourceDb.all<{ session_id: string; workspace_id: string }>('SELECT * FROM session_workspace_owners')
      : tables.includes('raw_events')
        ? sourceDb.all<{ session_id: string; workspace_id: string }>(
            "SELECT DISTINCT session_id, workspace_id FROM raw_events WHERE workspace_id != ''"
          )
        : [];
    const relations = tables.includes('memory_relations')
      ? sourceDb.all<any>('SELECT from_id, to_id, rel, metadata, created_at FROM memory_relations')
      : [];

    let importedCount = 0;
    const importedAt = Date.now();
    const skippedFrozenIds = new Set<string>();

    currentDb.transaction(() => {
      for (const owner of sourceOwners) {
        currentDb.run(
          'INSERT OR IGNORE INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
          [owner.session_id, owner.workspace_id]
        );
      }
      for (const m of memories) {
        // 尊重本地已 frozen 的同 ID 记录，禁止导入静默覆写；覆盖非 frozen 本地行前留存版本快照
        const localExisting = currentDb.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [m.id]);
        if (localExisting?.status === 'frozen') {
          skippedFrozenIds.add(m.id);
          continue;
        }

        let importVersion = m.version ?? 1;
        if (localExisting) {
          saveVersionSnapshot(currentDb, localExisting, 'import_overwrite', 'system', importedAt);
          importVersion = Math.max(importVersion, localExisting.version + 1);
        }

        // INSERT OR REPLACE 也会在槽位唯一索引上触发替换：显式处理槽位冲突
        let importStatus = m.status;
        if (m.slot_key && (m.status === 'active' || m.status === 'frozen')) {
          const holder = currentDb.get<MemoryRow>(
            `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
             AND COALESCE(session_id, '') = ? AND slot_key = ?
             AND status IN ('active', 'frozen') AND id != ?`,
            [m.scope, m.workspace_id || '', m.session_id || '', m.slot_key, m.id]
          );
          if (holder?.status === 'frozen') {
            importStatus = 'superseded';
          } else if (holder) {
            saveVersionSnapshot(currentDb, holder, 'import_slot_supersede', 'system', importedAt);
            currentDb.run(
              `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
              [importedAt, importedAt, importedAt, holder.id]
            );
          }
        }
        currentDb.run(
          `INSERT OR REPLACE INTO memories (
            id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
            origin_kinds, approved_at, approved_by, source_kind, confidence, utility,
            use_count, success_count, fail_count, token_cost, summary_cost, hash,
            version, content_rev, pinned, valid_from, valid_to, created_at, updated_at,
            importance, invalidated_at, last_used_at, last_repair_at, embedding
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            m.type,
            importStatus,
            m.content,
            m.summary,
            m.slot_key ?? null,
            m.scope,
            m.workspace_id ?? null,
            m.session_id ?? null,
            typeof m.origin_kinds === 'string' ? m.origin_kinds : JSON.stringify(m.origin_kinds || []),
            m.approved_at ?? null,
            m.approved_by ?? null,
            m.source_kind,
            m.confidence,
            m.utility,
            m.use_count ?? 0,
            m.success_count ?? 0,
            m.fail_count ?? 0,
            m.token_cost,
            m.summary_cost,
            m.hash,
            importVersion,
            m.content_rev ?? 1,
            m.pinned ?? 0,
            m.valid_from ?? null,
            m.valid_to ?? null,
            m.created_at,
            m.updated_at,
            m.importance ?? 5,
            m.invalidated_at ?? null,
            m.last_used_at ?? null,
            m.last_repair_at ?? null,
            m.embedding ?? null,
          ]
        );
        importedCount++;
      }

      for (const v of versions) {
        if (skippedFrozenIds.has(v.memory_id)) continue;
        currentDb.run(
          `INSERT OR IGNORE INTO memory_versions (
            memory_id, version, snapshot, reason, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [v.memory_id, v.version, v.snapshot, v.reason, v.actor, v.created_at]
        );
      }

      for (const ent of entities) {
        if (skippedFrozenIds.has(ent.memory_id)) continue;
        currentDb.run(
          `INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)`,
          [ent.memory_id, ent.entity]
        );
      }

      for (const s of sourcesRows) {
        if (skippedFrozenIds.has(s.memory_id)) continue;
        currentDb.run(
          `INSERT OR IGNORE INTO memory_sources (
            memory_id, content_rev, session_id, seq, kind, excerpt, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            s.memory_id,
            s.content_rev ?? 1,
            s.session_id,
            s.seq ?? 0,
            s.kind || 'manual',
            s.excerpt ?? null,
            s.created_at || importedAt,
          ]
        );
      }

      for (const rel of relations) {
        currentDb.run(
          `INSERT OR REPLACE INTO memory_relations (
            from_id, to_id, rel, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [rel.from_id, rel.to_id, rel.rel, rel.metadata || '{}', rel.created_at || importedAt]
        );
      }
    });

    // 4. 清空内存向量缓存、重建 FTS 索引并补齐旧版备份缺失的 128D 本地向量
    clearRuntimeVectorCache(currentDb);
    checkAndRepairFts(currentDb);
    backfillMissingEmbeddings(currentDb, { limit: 1000 });

    sourceDb.close();
    return { success: true, importedRecords: importedCount };
  } catch (err: any) {
    try {
      sourceDb.close();
    } catch {}
    return { success: false, importedRecords: 0, error: err.message };
  }
}

const TRANSIENT_NOISE_REGEX =
  /^(?:请\s*)?(?:帮我|给我|替我)?\s*(?:创建一个|写一个|生成一个|画一个|绘制一个|制作一个|看看这段|运行一下|执行一下|测试一下)/i;

const DURABLE_RULE_REGEX =
  /(?:以后|今后|总是|一律|永远|每次都|统一使用|必须使用|严禁|切勿|绝不|from now on|always|never|must always)/i;

/**
 * 本地确定性无效记忆清理 (无需等待 60 天冷期，即时淘汰已被证伪、遮蔽或明显属于一次性噪音的记忆)
 * 严格保护 frozen、pinned=1 与 core:* 核心块；槽位索引包含 session_id 并囊括 frozen/pinned 占位者。
 */
export function pruneInvalidMemories(
  db: Db,
  options: { workspaceId?: string; now?: number } = {}
): { prunedCount: number; prunedIds: string[] } {
  const now = options.now ?? Date.now();
  const wsFilter = options.workspaceId
    ? `AND (workspace_id = ? OR scope IN ('user', 'global'))`
    : '';
  const params: unknown[] = options.workspaceId ? [workspaceId(options.workspaceId)] : [];

  const rows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status IN ('active', 'candidate')
         AND pinned = 0
         AND type != 'meta'
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         ${wsFilter}`,
      params
    )
    .map((r) => hydrateMemoryRow(r));

  if (rows.length === 0) {
    return { prunedCount: 0, prunedIds: [] };
  }

  // 构建同槽位 active/frozen（含 pinned）占位索引，key 严格包含 session_id，防止跨会话误判与忽略 frozen 占位
  const slotHolders = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status IN ('active', 'frozen')
         AND slot_key IS NOT NULL
         AND slot_key != ''
         AND type != 'meta'
         ${wsFilter}`,
      params
    )
    .map((r) => hydrateMemoryRow(r));

  const activeSlotMap = new Map<string, MemoryRecord>();
  for (const m of slotHolders) {
    if (!m.slot_key) continue;
    const key = `${m.scope}:${m.workspace_id || ''}:${m.session_id || ''}:${m.slot_key}`;
    const prev = activeSlotMap.get(key);
    const mEff = m.approved_at ?? m.created_at;
    const prevEff = prev ? prev.approved_at ?? prev.created_at : -1;
    if (!prev || m.status === 'frozen' || mEff > prevEff) {
      activeSlotMap.set(key, m);
    }
  }

  const prunedIds: string[] = [];

  db.transaction(() => {
    for (const mem of rows) {
      let reason: string | null = null;

      // 1. 实战多次被证伪且零正反馈的负效用记忆
      // 用户批准的记忆不因负反馈计数被自动归档（计数可由模型的 memory_feedback 产生），改走修复提案
      if (
        mem.fail_count >= 2 &&
        mem.success_count === 0 &&
        mem.utility <= 0.38 &&
        mem.approved_by !== 'user'
      ) {
        reason = 'repeated_negative_outcome';
      }

      // 2. 一次性临时指令噪音 (且不含持久规则词、未被正向验证)
      if (
        !reason &&
        mem.success_count === 0 &&
        (mem.status === 'candidate' || (mem.use_count === 0 && mem.utility <= 0.45)) &&
        TRANSIENT_NOISE_REGEX.test(mem.content.trim()) &&
        !DURABLE_RULE_REGEX.test(mem.content)
      ) {
        reason = 'transient_one_off_noise';
      }

      // 3. 候选记忆对应的规范槽位已有更新的 active/frozen 记忆生效
      if (!reason && mem.status === 'candidate' && mem.slot_key) {
        const key = `${mem.scope}:${mem.workspace_id || ''}:${mem.session_id || ''}:${mem.slot_key}`;
        const activeHolder = activeSlotMap.get(key);
        const holderEffectiveAt = activeHolder ? activeHolder.approved_at ?? activeHolder.created_at : 0;
        if (
          activeHolder &&
          activeHolder.id !== mem.id &&
          (activeHolder.status === 'frozen' || holderEffectiveAt >= mem.created_at) &&
          // 待审批修复提案的候选须保留，否则提案将永远无法批准
          !db.get(
            `SELECT 1 FROM repair_proposals WHERE status = 'candidate' AND candidate_ids LIKE ?`,
            [`%"${mem.id}"%`]
          )
        ) {
          reason = 'shadowed_by_active_slot';
        }
      }

      if (reason) {
        saveVersionSnapshot(db, mem, reason, 'maintenance', now);
        const nextStatus = mem.status === 'candidate' ? 'rejected' : 'archived';
        db.run(
          `UPDATE memories
           SET status = ?, valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [nextStatus, now, now, now, mem.id]
        );
        db.afterCommit(() => removeCachedRuntimeEmbedding(mem.id, db));
        prunedIds.push(mem.id);
      }
    }
  });

  return { prunedCount: prunedIds.length, prunedIds };
}

export interface CurateResult {
  ok: boolean;
  deterministicPruned: number;
  llmDiscarded: number;
  llmUpdated: number;
  discardedIds: string[];
  updatedIds: string[];
  error?: string;
}

function formatCurateLine(m: MemoryRecord): string {
  return `[${m.id}] type=${m.type} status=${m.status}${m.slot_key ? ` slot=${m.slot_key}` : ''} utility=${m.utility.toFixed(2)} use=${m.use_count} ok=${m.success_count} fail=${m.fail_count}: ${m.content}`;
}

/**
 * 通过离线 LLM 全自动审阅、舍弃无效/噪音/过时记忆，并治理非受保护记忆 (curate-v1)：
 * - P0 安全边界：绝不原地改写、吸收或淘汰受用户保护的 active 记忆 (isProtectedFromModelDiscard)
 * - P0 信任隔离：绝不将不可信 candidate/污点记忆 与 active 用户记忆混入同一审阅提示词
 * - 预算与游标：使用 packPromptWithinBudget 与轮转游标 (curate:cursor:<wsId>) 覆盖全部存量记忆
 * - 仅在 parseRes.success 后才持久化去重指纹 (curate:last:<wsId>)
 */
export async function curateMemoriesWithLLM(
  db: Db,
  cfg: PluginConfig,
  options: {
    workspaceId?: string;
    cwd?: string;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
    now?: number;
  } = {}
): Promise<CurateResult> {
  const now = options.now ?? Date.now();

  // 1. 先执行本地确定性无效记忆清理
  const localPrune = pruneInvalidMemories(db, { workspaceId: options.workspaceId, now });
  const discardedIds = [...localPrune.prunedIds];
  const updatedIds: string[] = [];

  // 2. 基于轮转游标选取待 LLM 审阅的记忆池，避免永远卡在前 20 条
  const wsFilter = options.workspaceId
    ? `AND (workspace_id = ? OR scope IN ('user', 'global'))`
    : '';
  const params: unknown[] = options.workspaceId ? [workspaceId(options.workspaceId)] : [];

  const privacy = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
  const wsKey = options.workspaceId ? workspaceId(options.workspaceId) : 'global';
  const cursorKey = `curate:cursor:${wsKey}`;
  const rawCursor = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [cursorKey])?.value;
  const cursorRowId = rawCursor ? parseInt(rawCursor, 10) || 0 : 0;

  // 先取 rowid_ > cursorRowId 的批次，再回绕补齐早期行
  const afterCursorRows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status IN ('active', 'candidate')
         AND pinned = 0
         AND type != 'meta'
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         ${wsFilter}
         AND ${privacy.sql}
         AND rowid_ > ?
       ORDER BY rowid_ ASC
       LIMIT 80`,
      [...params, ...privacy.params, cursorRowId]
    )
    .map((r) => hydrateMemoryRow(r));

  const wrappedRows =
    cursorRowId > 0 && afterCursorRows.length < 80
      ? db
          .all<MemoryRow>(
            `SELECT * FROM memories
             WHERE status IN ('active', 'candidate')
               AND pinned = 0
               AND type != 'meta'
               AND COALESCE(slot_key, '') NOT LIKE 'core:%'
               ${wsFilter}
               AND ${privacy.sql}
               AND rowid_ <= ?
             ORDER BY rowid_ ASC
             LIMIT ?`,
            [...params, ...privacy.params, cursorRowId, 80 - afterCursorRows.length]
          )
          .map((r) => hydrateMemoryRow(r))
      : [];

  const allEligible = [...afterCursorRows, ...wrappedRows];

  if (allEligible.length === 0) {
    return {
      ok: true,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
    };
  }

  // P0 信任分层隔离：绝不把含 web/tool 污点记忆或 candidate 记忆与 active 用户记忆混入同一提示词
  const untrustedPool = allEligible.filter((m) => hasUntrustedOrigin(m));
  const cleanCandidatePool = allEligible.filter(
    (m) => m.status === 'candidate' && !hasUntrustedOrigin(m)
  );
  const cleanActivePool = allEligible.filter(
    (m) => m.status === 'active' && !hasUntrustedOrigin(m)
  );

  const wsId = options.workspaceId || allEligible[0].workspace_id || '';
  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  const fingerprintKey = `curate:last:${wsId || 'global'}`;
  const lastFingerprint = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    fingerprintKey,
  ])?.value;

  const pools = [
    { name: 'untrusted', items: untrustedPool },
    { name: 'clean_candidates', items: cleanCandidatePool },
    { name: 'clean_active', items: cleanActivePool },
  ];

  let selectedCandidates: MemoryRecord[] = [];
  let selectedUserPrompt = '';
  let selectedFingerprint = '';

  for (const pool of pools) {
    if (pool.items.length === 0) continue;
    const packed = packPromptWithinBudget(
      PROMPT_CURATE.system,
      (sel) =>
        PROMPT_CURATE.buildUser({
          cwd: wsId || 'global',
          memoriesList: sel.map(formatCurateLine).join('\n'),
        }),
      pool.items,
      maxInputTokens,
      250
    );
    if (packed.selected.length === 0) continue;

    // 使用不含随机 XML nonce 的规范内容计算指纹
    const canonicalBody = packed.selected.map(formatCurateLine).join('\n');
    const fp = createHash('sha256')
      .update(`${PROMPT_CURATE.version}\n${pool.name}\n${wsId || 'global'}\n${canonicalBody}`)
      .digest('hex');

    if (fp === lastFingerprint) {
      // 该信任池自上次成功治理以来未发生变化，继续检查下一池
      continue;
    }

    selectedCandidates = packed.selected;
    selectedUserPrompt = packed.userPrompt;
    selectedFingerprint = fp;
    break;
  }

  if (selectedCandidates.length === 0) {
    return {
      ok: true,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
    };
  }

  const reviewedMap = new Map<string, MemoryRecord>(selectedCandidates.map((m) => [m.id, m]));
  const realCwd =
    (options.cwd && options.cwd.trim() && !/^[0-9a-f]{16}$/i.test(options.cwd.trim())
      ? options.cwd.trim()
      : resolveWorkspaceCwd(db, wsId)) || '';

  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'curate',
      promptVersion: PROMPT_CURATE.version,
      systemPrompt: PROMPT_CURATE.system,
      userPrompt: selectedUserPrompt,
      maxOutputTokens: PROMPT_CURATE.maxOutputTokens,
      cwd: realCwd,
      workspaceId: wsId,
      dataWorkspaceIds: memoryWorkspaceIds(db, selectedCandidates),
      signal: options.signal,
      fetchFn: options.fetchFn,
    },
    cfg
  );

  if (!llmRes.ok) {
    return {
      ok: false,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
      error: llmRes.error,
    };
  }

  const parseRes = parseOutput(llmRes.content, {
    taskKind: 'curate',
    evidenceLedger: new Map(),
    workspaceId: wsId,
  });

  if (!parseRes.success || !parseRes.curateResult) {
    // 解析失败时不写入 curate:last 指纹，允许后续重试
    return {
      ok: false,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
      error: !parseRes.success ? parseRes.error : 'missing_curate_result',
    };
  }

  // 仅在解析成功后持久化去重指纹与轮转游标
  const maxReviewedRowId = selectedCandidates.reduce(
    (max, m) => Math.max(max, m.rowid_ ?? 0),
    0
  );
  const nextCursorValue =
    afterCursorRows.length < 80 && wrappedRows.length > 0 ? 0 : maxReviewedRowId;

  const { discard_ids, updates } = parseRes.curateResult;
  // 从 discard_ids 中扣除将被 updates.absorb_ids 吸收合并的条目，防止提前丢弃丢失来源证据
  const absorbedIdSet = new Set<string>();
  for (const upd of updates) {
    for (const absId of upd.absorb_ids || []) {
      absorbedIdSet.add(absId);
    }
  }

  let llmDiscarded = 0;
  let llmUpdated = 0;

  db.transaction(() => {
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [fingerprintKey, selectedFingerprint]
    );
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cursorKey, String(nextCursorValue)]
    );

    // 3.1 执行 LLM 判定的无效记忆舍弃
    for (const id of discard_ids) {
      if (absorbedIdSet.has(id)) continue;
      const target = getUnchangedReviewedMemory(db, reviewedMap, id);
      if (!target || isProtectedFromModelDiscard(db, target)) continue;
      saveVersionSnapshot(db, target, 'llm_curate_discard', 'llm', now);
      const nextStatus = target.status === 'candidate' ? 'rejected' : 'archived';
      db.run(
        `UPDATE memories
         SET status = ?, valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [nextStatus, now, now, now, target.id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(target.id, db));
      if (!discardedIds.includes(target.id)) {
        discardedIds.push(target.id);
      }
      llmDiscarded++;
    }

    // 3.2 执行 LLM 判定的非受保护记忆原地更新与冗余吸收
    for (const upd of updates) {
      if (discard_ids.includes(upd.target_id) && !absorbedIdSet.has(upd.target_id)) continue;
      const target = getUnchangedReviewedMemory(db, reviewedMap, upd.target_id);
      // P0: 绝不原地改写用户批准或带有用户证据的 active 记忆
      if (!target || isProtectedFromModelDiscard(db, target)) continue;

      // Validate the entire update before editing any of its dependencies.
      const absorbed = [...new Set(upd.absorb_ids || [])]
        .filter((id) => id !== target.id)
        .map((id) => getUnchangedReviewedMemory(db, reviewedMap, id));
      if (
        absorbed.some(
          (m) => !m || !sameMemoryOwner(target, m) || isProtectedFromModelDiscard(db, m)
        )
      ) {
        continue;
      }

      const nextSlot = upd.slot_key !== undefined ? upd.slot_key : target.slot_key;
      const slotConflict = nextSlot
        ? hydrateMemoryRow(
            db.get<MemoryRow>(
              `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
               AND COALESCE(session_id, '') = ? AND slot_key = ?
               AND status IN ('active', 'frozen') AND id != ?`,
              [target.scope, target.workspace_id || '', target.session_id || '', nextSlot, target.id]
            )
          )
        : undefined;
      if (
        slotConflict &&
        (!getUnchangedReviewedMemory(db, reviewedMap, slotConflict.id) ||
          isProtectedFromModelDiscard(db, slotConflict))
      ) {
        continue;
      }

      // 污点隔离：携带 web/tool 污点的目标或被吸收记忆均不得自动激活
      const canActivate =
        !hasUntrustedOrigin(target) &&
        !absorbed.some((m) => !!m && hasUntrustedOrigin(m)) &&
        (target.status === 'active' || hasUserEvidence(db, target));

      const absorbedHasActiveOrUserEvidence = absorbed.some(
        (m) => !!m && (m.status === 'active' || hasUserEvidence(db, m))
      );
      if (!canActivate && (absorbedHasActiveOrUserEvidence || slotConflict)) continue;

      try {
        const applied = db.transaction(() => {
          const prevContentRev = target.content_rev;
          const editRes = editContent(db, target.id, upd.text, undefined, 'llm', now);
          if (!editRes.ok) return null;

          // 继承并保留目标记忆与被吸收冗余记忆的来源证据至新 content_rev
          db.run(
            `INSERT OR IGNORE INTO memory_sources
             (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
             SELECT ?, ?, session_id, seq, kind, excerpt, created_at
             FROM memory_sources
             WHERE memory_id = ? AND content_rev = ?`,
            [target.id, editRes.content_rev, target.id, prevContentRev]
          );

          // 先吸收并取代被合并的冗余兄弟记忆，释放潜在槽位占用
          for (const absMem of absorbed) {
            if (!absMem) continue;
            db.run(
              `INSERT OR IGNORE INTO memory_sources
               (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
               SELECT ?, ?, session_id, seq, kind, excerpt, created_at
               FROM memory_sources
               WHERE memory_id = ? AND content_rev = ?`,
              [target.id, editRes.content_rev, absMem.id, absMem.content_rev]
            );
            saveVersionSnapshot(db, absMem, 'llm_curate_merged', 'llm', now);
            db.run(
              `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
              [now, now, now, absMem.id]
            );
            addRelation(db, target.id, absMem.id, 'supersedes', now);
          }
          if (slotConflict && !absorbed.some((m) => m?.id === slotConflict.id)) {
            saveVersionSnapshot(db, slotConflict, 'llm_curate_slot_supersede', 'llm', now);
            db.run(
              `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
              [now, now, now, slotConflict.id]
            );
            addRelation(db, target.id, slotConflict.id, 'supersedes', now);
          }

          const nextType = upd.type || target.type;
          const savedSummary =
            db.get<{ summary: string }>('SELECT summary FROM memories WHERE id = ?', [target.id])
              ?.summary || upd.text.slice(0, 80);
          const newHash = contentHash(nextType, upd.text);
          const newVec = computeLocalEmbedding(
            `${savedSummary}\n${upd.text}${nextSlot ? `\n${nextSlot}` : ''}`
          );

          db.run(
            `UPDATE memories
             SET type = ?, slot_key = ?, confidence = ?, status = ?,
                 approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, ?),
                 hash = ?, embedding = ?, updated_at = ?
             WHERE id = ?`,
            [
              nextType,
              nextSlot,
              upd.confidence,
              canActivate ? 'active' : 'candidate',
              canActivate ? now : null,
              canActivate ? 'llm-curator' : null,
              newHash,
              encodeEmbeddingBlob(newVec),
              now,
              target.id,
            ]
          );
          return { newHash, newVec };
        });

        if (!applied) continue;

        for (const absMem of absorbed) {
          if (absMem) db.afterCommit(() => removeCachedRuntimeEmbedding(absMem.id, db));
        }
        if (slotConflict && !absorbed.some((m) => m?.id === slotConflict.id)) {
          db.afterCommit(() => removeCachedRuntimeEmbedding(slotConflict.id, db));
        }
        db.afterCommit(() => {
          removeCachedRuntimeEmbedding(target.id, db);
          primeRuntimeVectorCache(target.id, applied.newHash, applied.newVec, db);
        });
        updatedIds.push(target.id);
        llmUpdated++;
      } catch (err) {
        console.warn(
          `[dsh-memory] curate update skipped for ${target.id}:`,
          err instanceof Error ? err.message : String(err)
        );
        continue;
      }
    }
  });

  return {
    ok: true,
    deterministicPruned: localPrune.prunedCount,
    llmDiscarded,
    llmUpdated,
    discardedIds,
    updatedIds,
  };
}
