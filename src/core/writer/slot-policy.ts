import {
  type Db,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type OriginKind,
  parseOriginKinds,
  type Scope,
} from '../../types.js';
import { primeRuntimeVectorCache, removeCachedRuntimeEmbedding } from '../vector.js';
import type { PreparedCandidate } from './validate.js';

export interface SupersedeSlotParams {
  scope: Scope;
  workspaceId: string | null;
  sessionId: string | null;
  slotKey: string;
  newOwnerId: string;
  excludeId?: string;
  actor: string;
  now: number;
  reason?: string;
  rejectIfPinned?: boolean;
}

export type SupersedeSlotResult =
  | { ok: true; supersededId?: string; occupant?: MemoryRecord }
  | { ok: false; reason: 'slot_is_frozen' | 'slot_is_pinned'; occupant: MemoryRecord };

export function schedulePrimeVectorCache(
  db: Db,
  id: string,
  hash: string,
  vec: Float32Array
): void {
  db.afterCommit(() => primeRuntimeVectorCache(id, hash, vec, db));
}

export function scheduleRemoveVectorCache(db: Db, id: string): void {
  db.afterCommit(() => removeCachedRuntimeEmbedding(id, db));
}

export function scheduleReplaceVectorCache(
  db: Db,
  id: string,
  hash: string,
  vec: Float32Array
): void {
  db.afterCommit(() => {
    removeCachedRuntimeEmbedding(id, db);
    primeRuntimeVectorCache(id, hash, vec, db);
  });
}

export function addRelation(
  db: Db,
  from_id: string,
  to_id: string,
  rel: string,
  now: number
): void {
  db.run(
    `INSERT OR IGNORE INTO memory_relations(from_id, to_id, rel, metadata, created_at) VALUES (?, ?, ?, '{}', ?)`,
    [from_id, to_id, rel, now]
  );
}

export function saveVersionSnapshot(
  db: Db,
  record: MemoryRecord | MemoryRow,
  reason: string,
  actor: string,
  now: number
): void {
  const { embedding: _embedding, rowid_: _rowid, ...rest } = record;
  const snapshotObj = {
    ...rest,
    origin_kinds: parseOriginKinds(record.origin_kinds),
  };
  db.run(
    `INSERT OR REPLACE INTO memory_versions(memory_id, version, snapshot, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [record.id, record.version, JSON.stringify(snapshotObj), reason, actor, now]
  );
}

/**
 * 查找同 (scope, workspace_id, session_id, slot_key) 下当前生效的 active / frozen 占位记录
 */
export function findActiveSlotOccupant(
  db: Db,
  scope: Scope,
  workspaceId: string | null,
  sessionId: string | null,
  slotKey: string,
  excludeId?: string
): MemoryRecord | undefined {
  const row = excludeId
    ? db.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE scope = ?
           AND COALESCE(workspace_id, '') = ?
           AND COALESCE(session_id, '') = ?
           AND slot_key = ?
           AND status IN ('active', 'frozen')
           AND id != ?
         LIMIT 1`,
        [scope, workspaceId || '', sessionId || '', slotKey, excludeId]
      )
    : db.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE scope = ?
           AND COALESCE(workspace_id, '') = ?
           AND COALESCE(session_id, '') = ?
           AND slot_key = ?
           AND status IN ('active', 'frozen')
         LIMIT 1`,
        [scope, workspaceId || '', sessionId || '', slotKey]
      );

  return hydrateMemoryRow(row);
}

/**
 * 统一槽位取代策略：检查 frozen 不可变性与可选 pinned 保护，
 * 记录版本快照，将旧记录置为 superseded 并写入 valid_to/invalidated_at，
 * 建立 supersedes 关系，并在事务提交后淘汰旧记录向量缓存。
 */
export function supersedeActiveSlot(db: Db, params: SupersedeSlotParams): SupersedeSlotResult {
  const {
    scope,
    workspaceId,
    sessionId,
    slotKey,
    newOwnerId,
    excludeId,
    actor,
    now,
    reason = 'supersede',
    rejectIfPinned = false,
  } = params;

  const occupant = findActiveSlotOccupant(db, scope, workspaceId, sessionId, slotKey, excludeId);
  if (!occupant) {
    return { ok: true };
  }

  if (occupant.status === 'frozen') {
    return { ok: false, reason: 'slot_is_frozen', occupant };
  }

  if (rejectIfPinned && occupant.pinned) {
    return { ok: false, reason: 'slot_is_pinned', occupant };
  }

  saveVersionSnapshot(db, occupant, reason, actor, now);
  db.run(
    `UPDATE memories
     SET status = 'superseded',
         valid_to = ?,
         invalidated_at = ?,
         version = version + 1,
         updated_at = ?
     WHERE id = ?`,
    [now, now, now, occupant.id]
  );
  addRelation(db, newOwnerId, occupant.id, 'supersedes', now);
  scheduleRemoveVectorCache(db, occupant.id);

  return { ok: true, supersededId: occupant.id, occupant };
}

/**
 * 查找同 (type, scope, workspace_id, session_id, slot_key, hash) 下已存在的冲突候选记忆，
 * 避免对同一冲突提案重复写入无限多条 candidate 行。
 */
export function findExistingConflictCandidate(
  db: Db,
  prepared: PreparedCandidate
): MemoryRecord | undefined {
  if (!prepared.slotKey) return undefined;
  const row = db.get<MemoryRow>(
    `SELECT * FROM memories
     WHERE type = ?
       AND scope = ?
       AND COALESCE(workspace_id, '') = ?
       AND COALESCE(session_id, '') = ?
       AND slot_key = ?
       AND hash = ?
       AND status = 'candidate'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [
      prepared.c.type,
      prepared.scope,
      prepared.workspace_id || '',
      prepared.session_id || '',
      prepared.slotKey,
      prepared.hash,
    ]
  );
  return hydrateMemoryRow(row);
}

/**
 * 将重复到达的槽位冲突提案幂等合并到既有 candidate 中（合并来源、并集 origin_kinds、聚合置信度并保持污点上限 <= 0.5）
 */
export function mergeIntoConflictCandidate(
  db: Db,
  existingCand: MemoryRecord,
  existingSlotId: string,
  prepared: PreparedCandidate,
  now: number
): string {
  const existingOrigins = parseOriginKinds(existingCand.origin_kinds);
  const mergedOrigins = Array.from(
    new Set<OriginKind>([...existingOrigins, ...prepared.originKinds])
  );
  const mergedTainted =
    mergedOrigins.includes('tool') ||
    mergedOrigins.includes('web') ||
    existingCand.source_kind === 'web' ||
    existingCand.source_kind === 'tool' ||
    prepared.isTainted;

  const hasMissingSource = prepared.sanitizedSources.some(
    (s) =>
      !db.get(
        `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ? AND session_id = ? AND seq = ?`,
        [existingCand.id, existingCand.content_rev, s.session_id, s.seq]
      )
  );

  if (hasMissingSource) {
    for (const s of prepared.sanitizedSources) {
      db.run(
        `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [existingCand.id, existingCand.content_rev, s.session_id, s.seq, s.kind, s.excerpt, now]
      );
    }
    let newConf = 1 - (1 - existingCand.confidence) * (1 - prepared.confidence);
    if (mergedTainted) {
      newConf = Math.min(newConf, 0.5);
    }
    db.run(
      `UPDATE memories
       SET confidence = ?,
           origin_kinds = ?,
           updated_at = ?
       WHERE id = ?`,
      [newConf, JSON.stringify(mergedOrigins), now, existingCand.id]
    );
  } else if (mergedOrigins.length !== existingOrigins.length) {
    const clampedConf = mergedTainted
      ? Math.min(existingCand.confidence, 0.5)
      : existingCand.confidence;
    db.run(
      `UPDATE memories
       SET confidence = ?,
           origin_kinds = ?,
           updated_at = ?
       WHERE id = ?`,
      [clampedConf, JSON.stringify(mergedOrigins), now, existingCand.id]
    );
  }

  addRelation(db, existingCand.id, existingSlotId, 'contradicts', now);
  return existingCand.id;
}
