import fs from 'node:fs';
import path from 'node:path';
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
    const relations = tables.includes('memory_relations')
      ? sourceDb.all<any>('SELECT from_id, to_id, rel, metadata, created_at FROM memory_relations')
      : [];

    currentDb.transaction(() => {
      for (const m of memories) {
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
            m.status,
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
      if (mem.fail_count >= 2 && mem.success_count === 0 && mem.utility <= 0.38) {
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
        if (activeHolder && activeHolder.id !== mem.id && activeHolder.updated_at >= mem.created_at) {
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

  const candidates = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE status IN ('active', 'candidate')
       AND pinned = 0
       AND type != 'meta'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       ${wsFilter}
     ORDER BY
       (CASE WHEN status = 'candidate' THEN 0 ELSE 1 END) ASC,
       (CASE WHEN fail_count > 0 THEN 0 ELSE 1 END) ASC,
       utility ASC,
       updated_at DESC
     LIMIT 20`,
    params
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
      const target = reviewedMap.get(id);
      if (!target || target.status === 'frozen' || target.pinned === 1) continue;
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
      const target = reviewedMap.get(upd.target_id);
      if (!target || target.status === 'frozen') continue;

      const editRes = editContent(db, target.id, upd.text, undefined, 'llm', now);
      if (!editRes.ok) continue;

      let nextSlot = upd.slot_key !== undefined ? upd.slot_key : target.slot_key;
      // 先吸收并取代被合并的冗余兄弟记忆，释放潜在槽位占用
      for (const absId of upd.absorb_ids || []) {
        const absMem = reviewedMap.get(absId);
        if (!absMem || absMem.id === target.id || absMem.status === 'frozen') continue;
        saveVersionSnapshot(db, absMem, 'llm_curate_merged', 'llm', now);
        db.run(
          `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [now, now, now, absMem.id]
        );
        removeCachedRuntimeEmbedding(absMem.id);
        addRelation(db, target.id, absMem.id, 'supersedes', now);
      }
      if (nextSlot) {
        const slotConflict = db.get<MemoryRecord>(
          `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id != ?`,
          [target.scope, target.workspace_id || '', target.session_id || '', nextSlot, target.id]
        );
        if (slotConflict) {
          if (slotConflict.status === 'frozen') {
            nextSlot = target.slot_key === nextSlot ? null : target.slot_key;
          } else {
            saveVersionSnapshot(db, slotConflict, 'llm_curate_slot_supersede', 'llm', now);
            db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, [now, now, now, slotConflict.id]);
            removeCachedRuntimeEmbedding(slotConflict.id);
            addRelation(db, target.id, slotConflict.id, 'supersedes', now);
          }
        }
      }
      const nextType = upd.type || target.type;
      const newHash = contentHash(nextType, upd.text);
      const newVec = computeLocalEmbedding(
        `${upd.text.slice(0, 80)}\n${upd.text}${nextSlot ? `\n${nextSlot}` : ''}`
      );

      db.run(
        `UPDATE memories
         SET type = ?, slot_key = ?, confidence = ?, status = 'active',
             approved_at = COALESCE(approved_at, ?), approved_by = COALESCE(approved_by, 'llm-curator'),
             hash = ?, embedding = ?, updated_at = ?
         WHERE id = ?`,
        [
          nextType,
          nextSlot,
          upd.confidence,
          now,
          newHash,
          encodeEmbeddingBlob(newVec),
          now,
          target.id,
        ]
      );
      removeCachedRuntimeEmbedding(target.id);
      primeRuntimeVectorCache(target.id, newHash, newVec);
      updatedIds.push(target.id);
      llmUpdated++;

      // 吸收并取代被合并的冗余兄弟记忆
      for (const absId of ([] as string[])) {
        const absMem = reviewedMap.get(absId);
        if (!absMem || absMem.id === target.id || absMem.status === 'frozen') continue;
        saveVersionSnapshot(db, absMem, 'llm_curate_merged', 'llm', now);
        db.run(
          `UPDATE memories
           SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [now, now, now, absMem.id]
        );
        removeCachedRuntimeEmbedding(absMem.id);
        addRelation(db, target.id, absMem.id, 'supersedes', now);
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
