import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Db, MemoryRecord } from '../types.js';
import type { PluginConfig } from '../config.js';
import { ftsText, contentHash } from '../core/text.js';
import { workspaceId } from '../core/scope.js';
import { openDb } from '../core/db.js';
import {
  backfillMissingEmbeddings,
  clearRuntimeVectorCache,
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from '../core/vector.js';
import { saveVersionSnapshot, editContent, addRelation } from '../core/writer.js';
import { PROMPT_CURATE } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { memoryPrivacyFilterSQL, memoryWorkspaceIds } from '../core/privacy.js';
import { hasUserEvidence } from '../core/trust.js';
import { getUnchangedReviewedMemory, isProtectedFromModelDiscard, sameMemoryOwner } from './review-snapshot.js';

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
         SET status = 'archived', version = version + 1, updated_at = ?
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

function writeDatabaseSnapshot(db: Db, targetPath: string, overwrite = true, stripConfig = false): void {
  const tempPath = path.join(path.dirname(targetPath), `.tmp-snapshot-${randomUUID()}.db`);
  try {
    // VACUUM INTO includes committed WAL pages. A plain main-file copy does not.
    db.exec(`VACUUM INTO '${tempPath.replace(/'/g, "''")}'`);
    if (stripConfig) {
      // 导出文件会被分享：控制台保存的配置覆盖层里有明文 API 密钥，不随文件带出
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
  writeDatabaseSnapshot(db, finalPath);

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

  try {
    writeDatabaseSnapshot(db, resolvedTarget, false, true);
    return { success: true, path: resolvedTarget };
  } catch (err: any) {
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
    if (currentDbFilePath && currentDbFilePath !== ':memory:') {
      writeDatabaseSnapshot(currentDb, `${currentDbFilePath}.bak`);
    }

    // 3. 读取 sourceDb 的全部有效记忆、版本历史及关联图谱/证据并在事务内无损导入到 currentDb
    const memories = sourceDb.all<MemoryRecord>('SELECT * FROM memories');
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
            "SELECT DISTINCT session_id, workspace_id FROM raw_events WHERE workspace_id != ''")
        : [];
    const relations = tables.includes('memory_relations')
      ? sourceDb.all<any>('SELECT from_id, to_id, rel, metadata, created_at FROM memory_relations')
      : [];

    currentDb.transaction(() => {
      for (const owner of sourceOwners) {
        currentDb.run(
          'INSERT OR IGNORE INTO session_workspace_owners (session_id, workspace_id) VALUES (?, ?)',
          [owner.session_id, owner.workspace_id]
        );
      }
      for (const m of memories) {
        // INSERT OR REPLACE 也会在槽位唯一索引上触发替换：本地另一条占用同槽位的记录会被直接删除且不留快照。
        // 改为显式处理：本地占用者被冻结时导入项降为 superseded，否则本地占用者留快照后转 superseded。
        let importStatus = m.status;
        if (m.slot_key && (m.status === 'active' || m.status === 'frozen')) {
          const holder = currentDb.get<MemoryRecord>(
            `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
             AND COALESCE(session_id, '') = ? AND slot_key = ?
             AND status IN ('active', 'frozen') AND id != ?`,
            [m.scope, m.workspace_id || '', m.session_id || '', m.slot_key, m.id]
          );
          if (holder?.status === 'frozen') {
            importStatus = 'superseded';
          } else if (holder) {
            const importedAt = Date.now();
            saveVersionSnapshot(currentDb, holder, 'import_slot_supersede', 'system', importedAt);
            currentDb.run(
              `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
              [importedAt, importedAt, holder.id]
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
            m.version ?? 1,
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
      }

      for (const v of versions) {
        currentDb.run(
          `INSERT OR REPLACE INTO memory_versions (
            memory_id, version, snapshot, reason, actor, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [v.memory_id, v.version, v.snapshot, v.reason, v.actor, v.created_at]
        );
      }

      for (const ent of entities) {
        currentDb.run(
          `INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)`,
          [ent.memory_id, ent.entity]
        );
      }

      for (const s of sourcesRows) {
        currentDb.run(
          `INSERT OR IGNORE INTO memory_sources (
            memory_id, content_rev, session_id, seq, kind, excerpt, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [s.memory_id, s.content_rev ?? 1, s.session_id, s.seq ?? 0, s.kind || 'manual', s.excerpt ?? null, s.created_at || Date.now()]
        );
      }

      for (const rel of relations) {
        currentDb.run(
          `INSERT OR REPLACE INTO memory_relations (
            from_id, to_id, rel, metadata, created_at
          ) VALUES (?, ?, ?, ?, ?)`,
          [rel.from_id, rel.to_id, rel.rel, rel.metadata || '{}', rel.created_at || Date.now()]
        );
      }
    });

    // 4. 清空内存向量缓存、重建 FTS 索引并补齐旧版备份缺失的 128D 本地向量
    clearRuntimeVectorCache();
    checkAndRepairFts(currentDb);
    backfillMissingEmbeddings(currentDb, { limit: 1000 });

    sourceDb.close();
    return { success: true, importedRecords: memories.length };
  } catch (err: any) {
    try { sourceDb.close(); } catch {}
    return { success: false, importedRecords: 0, error: err.message };
  }
}

const TRANSIENT_NOISE_REGEX =
  /^(?:请\s*)?(?:帮我|给我|替我)?\s*(?:创建一个|写一个|生成一个|画一个|绘制一个|制作一个|看看这段|运行一下|执行一下|测试一下)/i;

const DURABLE_RULE_REGEX =
  /(?:以后|今后|总是|一律|永远|每次都|统一使用|必须使用|严禁|切勿|绝不|from now on|always|never|must always)/i;

/**
 * 本地确定性无效记忆清理 (无需等待 60 天冷期，即时淘汰已被证伪、遮蔽或明显属于一次性噪音的记忆)
 * 严格保护 frozen=1、pinned=1 与 core:* 核心块
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

  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE status IN ('active', 'candidate')
       AND pinned = 0
       AND type != 'meta'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       ${wsFilter}`,
    params
  );

  if (rows.length === 0) {
    return { prunedCount: 0, prunedIds: [] };
  }

  // 构建同槽位更高优先级 active 记忆索引，用于淘汰被遮蔽的过时 candidate
  const activeSlotMap = new Map<string, MemoryRecord>();
  for (const m of rows) {
    if (m.status === 'active' && m.slot_key) {
      const key = `${m.scope}:${m.workspace_id || ''}:${m.slot_key}`;
      const prev = activeSlotMap.get(key);
      if (!prev || m.updated_at > prev.updated_at) {
        activeSlotMap.set(key, m);
      }
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

      // 3. 候选记忆对应的规范槽位已有更新的 active 记忆生效
      if (!reason && mem.status === 'candidate' && mem.slot_key) {
        const key = `${mem.scope}:${mem.workspace_id || ''}:${mem.slot_key}`;
        const activeHolder = activeSlotMap.get(key);
        // updated_at 会被效用归因、自动置顶等操作刷新，不代表正文更新；以生效时间判断新旧
        const holderEffectiveAt = activeHolder ? activeHolder.approved_at ?? activeHolder.created_at : 0;
        if (
          activeHolder &&
          activeHolder.id !== mem.id &&
          holderEffectiveAt >= mem.created_at &&
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
        removeCachedRuntimeEmbedding(mem.id);
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

/**
 * 通过离线 LLM 全自动审阅、舍弃无效/噪音/过时记忆，并原地合并更新存量记忆 (curate-v1)
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

  // 2. 选取待 LLM 审阅的存量非冻结记忆 (优先审阅 candidate、有负反馈、低效用或近期未审阅记录)
  const wsFilter = options.workspaceId
    ? `AND (workspace_id = ? OR scope IN ('user', 'global'))`
    : '';
  const params: unknown[] = options.workspaceId ? [workspaceId(options.workspaceId)] : [];

  const privacy = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
  const candidates = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE status IN ('active', 'candidate')
       AND pinned = 0
       AND type != 'meta'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       ${wsFilter}
       AND ${privacy.sql}
     ORDER BY
       (CASE WHEN status = 'candidate' THEN 0 ELSE 1 END) ASC,
       (CASE WHEN fail_count > 0 THEN 0 ELSE 1 END) ASC,
       utility ASC,
       updated_at DESC
     LIMIT 20`,
    [...params, ...privacy.params]
  );

  if (candidates.length === 0) {
    return {
      ok: true,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
    };
  }

  const reviewedMap = new Map<string, MemoryRecord>();
  const lines: string[] = [];
  for (const m of candidates) {
    reviewedMap.set(m.id, m);
    lines.push(
      `[${m.id}] type=${m.type} status=${m.status}${m.slot_key ? ` slot=${m.slot_key}` : ''} utility=${m.utility.toFixed(2)} use=${m.use_count} ok=${m.success_count} fail=${m.fail_count}: ${m.content}`
    );
  }

  const wsId = options.workspaceId || candidates[0].workspace_id || '';
  const realCwd =
    options.cwd && options.cwd.trim() && !/^[0-9a-f]{16}$/i.test(options.cwd.trim())
      ? options.cwd.trim()
      : process.cwd();

  const userPrompt = PROMPT_CURATE.buildUser({
    cwd: wsId || 'global',
    memoriesList: lines.join('\n'),
  });

  // 同一批记忆未发生任何变化时提示词逐字相同：维护任务每 10 分钟一个桶，重复送审只会耗尽当日配额
  const fingerprintKey = `curate:last:${wsId || 'global'}`;
  const fingerprint = createHash('sha256').update(`${PROMPT_CURATE.version}\n${userPrompt}`).digest('hex');
  if (db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [fingerprintKey])?.value === fingerprint) {
    return {
      ok: true,
      deterministicPruned: localPrune.prunedCount,
      llmDiscarded: 0,
      llmUpdated: 0,
      discardedIds,
      updatedIds,
    };
  }

  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'curate',
      promptVersion: PROMPT_CURATE.version,
      systemPrompt: PROMPT_CURATE.system,
      userPrompt,
      maxOutputTokens: PROMPT_CURATE.maxOutputTokens,
      cwd: realCwd,
      workspaceId: wsId,
      dataWorkspaceIds: memoryWorkspaceIds(db, candidates),
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

  // 模型已对这批输入作答（即便输出无法解析），同一输入不再重发
  db.run(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [fingerprintKey, fingerprint]
  );

  const parseRes = parseOutput(llmRes.content, {
    taskKind: 'curate',
    evidenceLedger: new Map(),
    workspaceId: wsId,
  });

  if (!parseRes.success || !parseRes.curateResult) {
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

  const { discard_ids, updates } = parseRes.curateResult;
  let llmDiscarded = 0;
  let llmUpdated = 0;

  db.transaction(() => {
    // 3.1 执行 LLM 判定的无效记忆舍弃
    for (const id of discard_ids) {
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
      removeCachedRuntimeEmbedding(target.id);
      if (!discardedIds.includes(target.id)) {
        discardedIds.push(target.id);
      }
      llmDiscarded++;
    }

    // 3.2 执行 LLM 判定的记忆原地更新与冗余吸收
    for (const upd of updates) {
      if (discard_ids.includes(upd.target_id)) continue;
      const target = getUnchangedReviewedMemory(db, reviewedMap, upd.target_id);
      if (!target) continue;

      // Validate the entire update before editing any of its dependencies.
      const absorbed = [...new Set(upd.absorb_ids || [])]
        .filter(id => id !== target.id)
        .map(id => getUnchangedReviewedMemory(db, reviewedMap, id));
      if (absorbed.some(m => !m || !sameMemoryOwner(target, m))) continue;
      const nextSlot = upd.slot_key !== undefined ? upd.slot_key : target.slot_key;
      const slotConflict = nextSlot ? db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
         AND COALESCE(session_id, '') = ? AND slot_key = ?
         AND status IN ('active', 'frozen') AND id != ?`,
        [target.scope, target.workspace_id || '', target.session_id || '', nextSlot, target.id]
      ) : undefined;
      if (slotConflict && !getUnchangedReviewedMemory(db, reviewedMap, slotConflict.id)) continue;
      const canActivate = target.status === 'active' || hasUserEvidence(db, target);
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
          if (slotConflict && !absorbed.some(m => m?.id === slotConflict.id)) {
            saveVersionSnapshot(db, slotConflict, 'llm_curate_slot_supersede', 'llm', now);
            db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, [now, now, now, slotConflict.id]);
            addRelation(db, target.id, slotConflict.id, 'supersedes', now);
          }

          const nextType = upd.type || target.type;
          const savedSummary =
            db.get<{ summary: string }>('SELECT summary FROM memories WHERE id = ?', [target.id])?.summary ||
            upd.text.slice(0, 80);
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
          if (absMem) removeCachedRuntimeEmbedding(absMem.id);
        }
        if (slotConflict && !absorbed.some(m => m?.id === slotConflict.id)) {
          removeCachedRuntimeEmbedding(slotConflict.id);
        }
        removeCachedRuntimeEmbedding(target.id);
        primeRuntimeVectorCache(target.id, applied.newHash, applied.newVec);
        updatedIds.push(target.id);
        llmUpdated++;
      } catch {
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
