import type { Db, Scope } from '../types.js';
import { computeLocalEmbedding, DEFAULT_LOCAL_VECTOR_DIM, decodeEmbeddingBlob } from './vector.js';

export interface VectorIndexEntryMeta {
  id: string;
  scope: Scope;
  workspace_id?: string | null;
  session_id?: string | null;
  status: string;
  type: string;
  rowid_?: number;
  updated_at?: number;
}

export interface VectorSearchScope {
  workspaceId: string;
  sessionId?: string;
}

export interface VectorSearchOptions {
  limit?: number;
  minScore?: number;
  allowedTypes?: Set<string>;
  excludeIds?: Set<string>;
  providerDim?: number;
}

export interface VectorSearchHit {
  id: string;
  score: number;
}

interface DimMatrix {
  dim: number;
  ids: string[];
  types: string[];
  idToSlot: Map<string, number>;
  data: Float32Array;
  count: number;
  capacity: number;
}

interface PartitionStamp {
  count: number;
  maxRowid: number;
  maxUpdatedAt: number;
  missingEmbeddings: number;
}

interface PartitionMatrix {
  key: string;
  scopeKind: 'shared' | 'workspace' | 'session';
  workspaceId: string;
  sessionId: string;
  matrices: Map<number, DimMatrix>;
  dataVersion: number;
  totalChanges: number;
  stamp: PartitionStamp;
}

interface WorkspaceVectorIndexManager {
  partitions: Map<string, PartitionMatrix>;
  idToLocation: Map<string, { partitionKey: string; dim: number }>;
}

const INITIAL_MATRIX_CAPACITY = 64;
const indexByDb = new WeakMap<Db, WorkspaceVectorIndexManager>();

function getOrCreateManager(db: Db): WorkspaceVectorIndexManager {
  let mgr = indexByDb.get(db);
  if (!mgr) {
    mgr = {
      partitions: new Map(),
      idToLocation: new Map(),
    };
    indexByDb.set(db, mgr);
  }
  return mgr;
}

function getPartitionKey(
  scope: Scope,
  workspaceId?: string | null,
  sessionId?: string | null
): string | null {
  if (scope === 'user' || scope === 'global') return '__shared__';
  if (scope === 'workspace') {
    const ws = workspaceId || '';
    return ws ? `ws:${ws}` : null;
  }
  if (scope === 'session') {
    const ws = workspaceId || '';
    const sid = (sessionId || '').trim();
    return ws && sid ? `sess:${ws}:${sid}` : null;
  }
  return null;
}

function isIndexableEntry(meta: { status: string; type: string }): boolean {
  return (meta.status === 'active' || meta.status === 'frozen') && meta.type !== 'meta';
}

function createDimMatrix(dim: number, initialCapacity = INITIAL_MATRIX_CAPACITY): DimMatrix {
  const capacity = Math.max(INITIAL_MATRIX_CAPACITY, initialCapacity);
  return {
    dim,
    ids: [],
    types: [],
    idToSlot: new Map(),
    data: new Float32Array(capacity * dim),
    count: 0,
    capacity,
  };
}

function ensureMatrixCapacity(matrix: DimMatrix, needed: number): void {
  if (needed <= matrix.capacity) return;
  let nextCap = matrix.capacity;
  while (nextCap < needed) {
    nextCap *= 2;
  }
  const nextData = new Float32Array(nextCap * matrix.dim);
  nextData.set(matrix.data.subarray(0, matrix.count * matrix.dim));
  matrix.data = nextData;
  matrix.capacity = nextCap;
}

function copyNormalizedInto(src: Float32Array, dst: Float32Array, offset: number): boolean {
  const dim = src.length;
  if (dim === 0) return false;
  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    const v = src[i];
    if (!Number.isFinite(v)) return false;
    normSq += v * v;
  }
  if (normSq <= 1e-12) return false;
  if (Math.abs(normSq - 1.0) <= 1e-5) {
    dst.set(src, offset);
  } else {
    const inv = 1 / Math.sqrt(normSq);
    for (let i = 0; i < dim; i++) {
      dst[offset + i] = src[i] * inv;
    }
  }
  return true;
}

function normalizeQueryVector(queryVec: Float32Array): Float32Array | null {
  const dim = queryVec.length;
  if (dim === 0) return null;
  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    const v = queryVec[i];
    if (!Number.isFinite(v)) return null;
    normSq += v * v;
  }
  if (normSq <= 1e-12) return null;
  if (Math.abs(normSq - 1.0) <= 1e-5) {
    return queryVec;
  }
  const inv = 1 / Math.sqrt(normSq);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = queryVec[i] * inv;
  }
  return out;
}

function readDbVersionSnapshot(db: Db): { dv: number; tc: number } {
  try {
    const row = db.get<{ dv: number; tc: number }>(
      'SELECT (SELECT data_version FROM pragma_data_version) AS dv, total_changes() AS tc'
    );
    return {
      dv: typeof row?.dv === 'number' ? row.dv : 0,
      tc: typeof row?.tc === 'number' ? row.tc : 0,
    };
  } catch {
    return { dv: -1, tc: -1 };
  }
}

function readPartitionMissingCount(
  db: Db,
  scopeKind: 'shared' | 'workspace' | 'session',
  workspaceId: string,
  sessionId: string
): number {
  const runCount = (useIndexHint: boolean): number => {
    const hint = useIndexHint ? ' INDEXED BY ix_mem_missing_embedding' : '';
    if (scopeKind === 'shared') {
      return (
        db.get<{ missing: number }>(
          `SELECT COUNT(*) AS missing
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL
             AND scope IN ('user', 'global')`
        )?.missing ?? 0
      );
    }
    if (scopeKind === 'workspace') {
      return (
        db.get<{ missing: number }>(
          `SELECT COUNT(*) AS missing
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL
             AND scope = 'workspace'
             AND workspace_id = ?`,
          [workspaceId]
        )?.missing ?? 0
      );
    }
    return (
      db.get<{ missing: number }>(
        `SELECT COUNT(*) AS missing
         FROM memories${hint}
         WHERE status IN ('active', 'frozen')
           AND embedding IS NULL
           AND scope = 'session'
           AND workspace_id = ?
           AND session_id = ?`,
        [workspaceId, sessionId]
      )?.missing ?? 0
    );
  };

  try {
    return runCount(true);
  } catch {
    return runCount(false);
  }
}

function readPartitionStamp(
  db: Db,
  scopeKind: 'shared' | 'workspace' | 'session',
  workspaceId: string,
  sessionId: string
): PartitionStamp {
  let row: { cnt: number; max_rid: number; max_upd: number } | undefined;

  if (scopeKind === 'shared') {
    // Hits COVERING INDEX ix_mem_weave(scope, workspace_id, status, utility, updated_at) — zero table heap reads
    row = db.get<{ cnt: number; max_rid: number; max_upd: number }>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(MAX(rowid_), 0) AS max_rid,
              COALESCE(MAX(updated_at), 0) AS max_upd
       FROM memories
       WHERE scope IN ('user', 'global')
         AND workspace_id IS NULL
         AND status IN ('active', 'frozen')`
    );
  } else if (scopeKind === 'workspace') {
    // Hits COVERING INDEX ix_mem_weave(scope, workspace_id, status, utility, updated_at) — zero table heap reads
    row = db.get<{ cnt: number; max_rid: number; max_upd: number }>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(MAX(rowid_), 0) AS max_rid,
              COALESCE(MAX(updated_at), 0) AS max_upd
       FROM memories
       WHERE scope = 'workspace'
         AND workspace_id = ?
         AND status IN ('active', 'frozen')`,
      [workspaceId]
    );
  } else {
    row = db.get<{ cnt: number; max_rid: number; max_upd: number }>(
      `SELECT COUNT(*) AS cnt,
              COALESCE(MAX(rowid_), 0) AS max_rid,
              COALESCE(MAX(updated_at), 0) AS max_upd
       FROM memories
       WHERE scope = 'session'
         AND workspace_id = ?
         AND status IN ('active', 'frozen')
         AND session_id = ?`,
      [workspaceId, sessionId]
    );
  }

  const missingEmbeddings = readPartitionMissingCount(db, scopeKind, workspaceId, sessionId);

  return {
    count: row?.cnt ?? 0,
    maxRowid: row?.max_rid ?? 0,
    maxUpdatedAt: row?.max_upd ?? 0,
    missingEmbeddings,
  };
}

function stampsEqual(a: PartitionStamp, b: PartitionStamp): boolean {
  return (
    a.count === b.count &&
    a.maxRowid === b.maxRowid &&
    a.maxUpdatedAt === b.maxUpdatedAt &&
    a.missingEmbeddings === b.missingEmbeddings
  );
}

function detachPartitionLocations(
  mgr: WorkspaceVectorIndexManager,
  partition: PartitionMatrix
): void {
  for (const matrix of partition.matrices.values()) {
    for (let i = 0; i < matrix.count; i++) {
      const id = matrix.ids[i];
      const loc = mgr.idToLocation.get(id);
      if (loc && loc.partitionKey === partition.key) {
        mgr.idToLocation.delete(id);
      }
    }
  }
}

function removeFromDimMatrix(matrix: DimMatrix, id: string): boolean {
  const slot = matrix.idToSlot.get(id);
  if (slot === undefined) return false;

  const lastSlot = matrix.count - 1;
  const dim = matrix.dim;

  if (slot !== lastSlot) {
    const lastId = matrix.ids[lastSlot];
    const lastType = matrix.types[lastSlot];
    matrix.ids[slot] = lastId;
    matrix.types[slot] = lastType;
    matrix.data.copyWithin(slot * dim, lastSlot * dim, (lastSlot + 1) * dim);
    matrix.idToSlot.set(lastId, slot);
  }

  matrix.ids.pop();
  matrix.types.pop();
  matrix.idToSlot.delete(id);
  matrix.count = lastSlot;
  return true;
}

function upsertIntoPartition(
  mgr: WorkspaceVectorIndexManager,
  partition: PartitionMatrix,
  id: string,
  type: string,
  vec: Float32Array
): boolean {
  const dim = vec.length;
  if (dim <= 0) return false;

  let matrix = partition.matrices.get(dim);
  if (!matrix) {
    matrix = createDimMatrix(dim);
    partition.matrices.set(dim, matrix);
  }

  const existingSlot = matrix.idToSlot.get(id);
  if (existingSlot !== undefined) {
    if (!copyNormalizedInto(vec, matrix.data, existingSlot * dim)) {
      removeFromDimMatrix(matrix, id);
      mgr.idToLocation.delete(id);
      return false;
    }
    matrix.types[existingSlot] = type;
    mgr.idToLocation.set(id, { partitionKey: partition.key, dim });
    return true;
  }

  ensureMatrixCapacity(matrix, matrix.count + 1);
  const slot = matrix.count;
  if (!copyNormalizedInto(vec, matrix.data, slot * dim)) {
    return false;
  }
  matrix.ids.push(id);
  matrix.types.push(type);
  matrix.idToSlot.set(id, slot);
  matrix.count = slot + 1;
  mgr.idToLocation.set(id, { partitionKey: partition.key, dim });
  return true;
}

interface PartitionLoadRow {
  id: string;
  type: string;
  summary: string | null;
  content: string | null;
  slot_key: string | null;
  embedding: Uint8Array | ArrayBufferView | null;
  rowid_: number;
  updated_at: number;
}

function loadPartition(
  db: Db,
  mgr: WorkspaceVectorIndexManager,
  key: string,
  scopeKind: 'shared' | 'workspace' | 'session',
  workspaceId: string,
  sessionId: string
): PartitionMatrix {
  const prev = mgr.partitions.get(key);
  if (prev) {
    detachPartitionLocations(mgr, prev);
  }

  const versionSnap = readDbVersionSnapshot(db);

  let rows: PartitionLoadRow[];
  if (scopeKind === 'shared') {
    rows = db.all<PartitionLoadRow>(
      `SELECT id, type, summary, content, slot_key, embedding, rowid_, updated_at
       FROM memories
       WHERE scope IN ('user', 'global')
         AND workspace_id IS NULL
         AND status IN ('active', 'frozen')`
    );
  } else if (scopeKind === 'workspace') {
    rows = db.all<PartitionLoadRow>(
      `SELECT id, type, summary, content, slot_key, embedding, rowid_, updated_at
       FROM memories
       WHERE scope = 'workspace'
         AND workspace_id = ?
         AND status IN ('active', 'frozen')`,
      [workspaceId]
    );
  } else {
    rows = db.all<PartitionLoadRow>(
      `SELECT id, type, summary, content, slot_key, embedding, rowid_, updated_at
       FROM memories
       WHERE scope = 'session'
         AND workspace_id = ?
         AND status IN ('active', 'frozen')
         AND session_id = ?`,
      [workspaceId, sessionId]
    );
  }

  let maxRowid = 0;
  let maxUpdatedAt = 0;
  let missingEmbeddings = 0;
  const matrices = new Map<number, DimMatrix>();

  // Pre-size default matrix capacity when many rows are loaded to avoid repeated reallocs
  const estCap = rows.length > INITIAL_MATRIX_CAPACITY ? rows.length : INITIAL_MATRIX_CAPACITY;

  const partition: PartitionMatrix = {
    key,
    scopeKind,
    workspaceId,
    sessionId,
    matrices,
    dataVersion: versionSnap.dv,
    totalChanges: versionSnap.tc,
    stamp: {
      count: rows.length,
      maxRowid: 0,
      maxUpdatedAt: 0,
      missingEmbeddings: 0,
    },
  };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.rowid_ > maxRowid) maxRowid = row.rowid_;
    if (row.updated_at > maxUpdatedAt) maxUpdatedAt = row.updated_at;
    if (row.embedding === null || row.embedding === undefined) {
      missingEmbeddings++;
    }
    if (row.type === 'meta') {
      continue;
    }

    let vec = decodeEmbeddingBlob(row.embedding);
    if (!vec) {
      const text =
        `${row.summary || ''}\n${row.content || ''}${row.slot_key ? `\n${row.slot_key}` : ''}`.trim();
      if (!text) continue;
      vec = computeLocalEmbedding(text, DEFAULT_LOCAL_VECTOR_DIM);
    }

    const dim = vec.length;
    if (dim <= 0) continue;

    let matrix = matrices.get(dim);
    if (!matrix) {
      matrix = createDimMatrix(dim, estCap);
      matrices.set(dim, matrix);
    }
    ensureMatrixCapacity(matrix, matrix.count + 1);
    const slot = matrix.count;
    if (!copyNormalizedInto(vec, matrix.data, slot * dim)) {
      continue;
    }
    matrix.ids.push(row.id);
    matrix.types.push(row.type);
    matrix.idToSlot.set(row.id, slot);
    matrix.count = slot + 1;
    mgr.idToLocation.set(row.id, { partitionKey: key, dim });
  }

  partition.stamp.maxRowid = maxRowid;
  partition.stamp.maxUpdatedAt = maxUpdatedAt;
  partition.stamp.missingEmbeddings = missingEmbeddings;
  mgr.partitions.set(key, partition);
  return partition;
}

function getFreshPartition(
  db: Db,
  mgr: WorkspaceVectorIndexManager,
  key: string,
  scopeKind: 'shared' | 'workspace' | 'session',
  workspaceId: string,
  sessionId: string,
  versionSnap: { dv: number; tc: number }
): PartitionMatrix {
  const existing = mgr.partitions.get(key);
  if (!existing) {
    return loadPartition(db, mgr, key, scopeKind, workspaceId, sessionId);
  }

  // External connection write detected via PRAGMA data_version -> reload immediately
  if (versionSnap.dv !== existing.dataVersion) {
    return loadPartition(db, mgr, key, scopeKind, workspaceId, sessionId);
  }

  // Zero writes on same or other connections -> ultra-fast path, zero table reads
  if (versionSnap.tc === existing.totalChanges) {
    return existing;
  }

  // Same-connection write occurred without matching hook -> verify cheap partition stamp
  const currentStamp = readPartitionStamp(db, scopeKind, workspaceId, sessionId);
  if (stampsEqual(existing.stamp, currentStamp)) {
    existing.totalChanges = versionSnap.tc;
    return existing;
  }

  return loadPartition(db, mgr, key, scopeKind, workspaceId, sessionId);
}

/**
 * 在按工作区懒加载的全量内存向量矩阵中执行高速余弦检索（无 Top-400 截断）。
 * 扫描 `__shared__` (user/global)、`ws:<workspaceId>` 以及可选的 `sess:<workspaceId>:<sessionId>` 分区。
 */
export function searchWorkspaceVectors(
  db: Db,
  scopeCtx: VectorSearchScope,
  queryVec: Float32Array,
  options: VectorSearchOptions = {}
): VectorSearchHit[] {
  const qNorm = normalizeQueryVector(queryVec);
  if (!qNorm) return [];

  const qDim = qNorm.length;
  if (options.providerDim && options.providerDim > 0 && options.providerDim !== qDim) {
    return [];
  }

  const limit = Math.max(1, options.limit ?? 20);
  const minScore = options.minScore ?? -Infinity;
  const allowedTypes =
    options.allowedTypes && options.allowedTypes.size > 0 ? options.allowedTypes : undefined;
  const excludeIds =
    options.excludeIds && options.excludeIds.size > 0 ? options.excludeIds : undefined;

  const mgr = getOrCreateManager(db);
  const versionSnap = readDbVersionSnapshot(db);

  const partitionsToScan: PartitionMatrix[] = [];
  partitionsToScan.push(getFreshPartition(db, mgr, '__shared__', 'shared', '', '', versionSnap));

  const ws = (scopeCtx.workspaceId || '').trim();
  if (ws) {
    partitionsToScan.push(getFreshPartition(db, mgr, `ws:${ws}`, 'workspace', ws, '', versionSnap));
    const sid = typeof scopeCtx.sessionId === 'string' ? scopeCtx.sessionId.trim() : '';
    if (sid) {
      partitionsToScan.push(
        getFreshPartition(db, mgr, `sess:${ws}:${sid}`, 'session', ws, sid, versionSnap)
      );
    }
  }

  // Bounded Top-K maintenance to avoid O(N) heap allocations and full sort
  const top: VectorSearchHit[] = [];
  let cutoff = minScore;
  const dim8 = qDim & ~7;
  const hasFilters = Boolean(allowedTypes || excludeIds);

  const insertTop = (id: string, dot: number) => {
    let pos = top.length;
    if (pos < limit) {
      top.push({ id, score: dot });
    } else {
      pos = limit - 1;
      const slotObj = top[pos];
      slotObj.id = id;
      slotObj.score = dot;
    }
    while (pos > 0 && top[pos].score > top[pos - 1].score) {
      const tmp = top[pos - 1];
      top[pos - 1] = top[pos];
      top[pos] = tmp;
      pos--;
    }
    if (top.length >= limit) {
      cutoff = Math.max(minScore, top[limit - 1].score);
    }
  };

  for (let p = 0; p < partitionsToScan.length; p++) {
    const matrix = partitionsToScan[p].matrices.get(qDim);
    if (!matrix || matrix.count === 0) continue;

    const { data, ids, types, count } = matrix;

    if (!hasFilters) {
      let base = 0;
      for (let i = 0; i < count; i++, base += qDim) {
        let s0 = 0;
        let s1 = 0;
        let k = 0;
        let j = base;
        for (; k < dim8; k += 8, j += 8) {
          s0 +=
            data[j] * qNorm[k] +
            data[j + 1] * qNorm[k + 1] +
            data[j + 2] * qNorm[k + 2] +
            data[j + 3] * qNorm[k + 3];
          s1 +=
            data[j + 4] * qNorm[k + 4] +
            data[j + 5] * qNorm[k + 5] +
            data[j + 6] * qNorm[k + 6] +
            data[j + 7] * qNorm[k + 7];
        }
        let dot = s0 + s1;
        for (; k < qDim; k++, j++) {
          dot += data[j] * qNorm[k];
        }

        if (dot < cutoff) continue;
        if (top.length >= limit && dot <= top[limit - 1].score) continue;
        insertTop(ids[i], dot);
      }
    } else {
      let base = 0;
      for (let i = 0; i < count; i++, base += qDim) {
        if (allowedTypes && !allowedTypes.has(types[i])) continue;
        if (excludeIds && excludeIds.has(ids[i])) continue;

        let s0 = 0;
        let s1 = 0;
        let k = 0;
        let j = base;
        for (; k < dim8; k += 8, j += 8) {
          s0 +=
            data[j] * qNorm[k] +
            data[j + 1] * qNorm[k + 1] +
            data[j + 2] * qNorm[k + 2] +
            data[j + 3] * qNorm[k + 3];
          s1 +=
            data[j + 4] * qNorm[k + 4] +
            data[j + 5] * qNorm[k + 5] +
            data[j + 6] * qNorm[k + 6] +
            data[j + 7] * qNorm[k + 7];
        }
        let dot = s0 + s1;
        for (; k < qDim; k++, j++) {
          dot += data[j] * qNorm[k];
        }

        if (dot < cutoff) continue;
        if (top.length >= limit && dot <= top[limit - 1].score) continue;
        insertTop(ids[i], dot);
      }
    }
  }

  for (let i = 0; i < top.length; i++) {
    if (top[i].score > 1) top[i].score = 1;
    else if (top[i].score < -1) top[i].score = -1;
  }

  return top;
}

function syncPartitionAfterHook(
  db: Db,
  partition: PartitionMatrix,
  entryId?: string,
  meta?: { rowid_?: number; updated_at?: number },
  deltaCount: number = 0
): void {
  const versionSnap = readDbVersionSnapshot(db);
  partition.dataVersion = versionSnap.dv;
  partition.totalChanges = versionSnap.tc;

  if (deltaCount !== 0) {
    partition.stamp.count = Math.max(0, partition.stamp.count + deltaCount);
  }

  let rowid = meta?.rowid_;
  let updatedAt = meta?.updated_at;

  if (entryId && (rowid === undefined || updatedAt === undefined)) {
    try {
      const row = db.get<{ rowid_: number; updated_at: number }>(
        'SELECT rowid_, updated_at FROM memories WHERE id = ?',
        [entryId]
      );
      if (row) {
        rowid = row.rowid_;
        updatedAt = row.updated_at;
      }
    } catch {}
  }

  if (rowid !== undefined && rowid > partition.stamp.maxRowid) {
    partition.stamp.maxRowid = rowid;
  }
  if (updatedAt !== undefined && updatedAt > partition.stamp.maxUpdatedAt) {
    partition.stamp.maxUpdatedAt = updatedAt;
  }

  try {
    partition.stamp.missingEmbeddings = readPartitionMissingCount(
      db,
      partition.scopeKind,
      partition.workspaceId,
      partition.sessionId
    );
  } catch {}
}

/**
 * 批量增量写入多条向量到已加载分区，每个受影响分区仅刷新一次元数据印记。
 */
export function upsertVectorIndexBatch(
  db: Db,
  entries: Array<{ meta: VectorIndexEntryMeta; vec: Float32Array }>
): void {
  if (entries.length === 0) return;
  const mgr = indexByDb.get(db);
  if (!mgr || mgr.partitions.size === 0) return;

  const touchedPartitions = new Set<PartitionMatrix>();

  for (let i = 0; i < entries.length; i++) {
    const { meta, vec } = entries[i];
    if (!isIndexableEntry(meta)) {
      const existingLoc = mgr.idToLocation.get(meta.id);
      if (existingLoc) {
        const oldPart = mgr.partitions.get(existingLoc.partitionKey);
        const oldMat = oldPart?.matrices.get(existingLoc.dim);
        if (oldPart && oldMat && removeFromDimMatrix(oldMat, meta.id)) {
          oldPart.stamp.count = Math.max(0, oldPart.stamp.count - 1);
          touchedPartitions.add(oldPart);
        }
        mgr.idToLocation.delete(meta.id);
      }
      continue;
    }

    const targetPartKey = getPartitionKey(meta.scope, meta.workspace_id, meta.session_id);
    const existingLoc = mgr.idToLocation.get(meta.id);
    let wasInTargetPartition = false;

    if (existingLoc) {
      if (existingLoc.partitionKey === targetPartKey) {
        wasInTargetPartition = true;
        if (existingLoc.dim !== vec.length) {
          const oldPart = mgr.partitions.get(existingLoc.partitionKey);
          const oldMat = oldPart?.matrices.get(existingLoc.dim);
          if (oldMat) removeFromDimMatrix(oldMat, meta.id);
          mgr.idToLocation.delete(meta.id);
        }
      } else {
        const oldPart = mgr.partitions.get(existingLoc.partitionKey);
        const oldMat = oldPart?.matrices.get(existingLoc.dim);
        if (oldPart && oldMat && removeFromDimMatrix(oldMat, meta.id)) {
          oldPart.stamp.count = Math.max(0, oldPart.stamp.count - 1);
          touchedPartitions.add(oldPart);
        }
        mgr.idToLocation.delete(meta.id);
      }
    }

    if (!targetPartKey) continue;
    const targetPartition = mgr.partitions.get(targetPartKey);
    if (!targetPartition) continue;

    if (upsertIntoPartition(mgr, targetPartition, meta.id, meta.type, vec)) {
      if (!wasInTargetPartition) {
        targetPartition.stamp.count += 1;
      }
      if (meta.rowid_ !== undefined && meta.rowid_ > targetPartition.stamp.maxRowid) {
        targetPartition.stamp.maxRowid = meta.rowid_;
      }
      if (meta.updated_at !== undefined && meta.updated_at > targetPartition.stamp.maxUpdatedAt) {
        targetPartition.stamp.maxUpdatedAt = meta.updated_at;
      }
      touchedPartitions.add(targetPartition);
    }
  }

  if (touchedPartitions.size > 0) {
    const versionSnap = readDbVersionSnapshot(db);
    for (const part of touchedPartitions) {
      part.dataVersion = versionSnap.dv;
      part.totalChanges = versionSnap.tc;
      try {
        part.stamp.missingEmbeddings = readPartitionMissingCount(
          db,
          part.scopeKind,
          part.workspaceId,
          part.sessionId
        );
      } catch {}
    }
  }
}

/**
 * 增量写入或更新单条记忆到已加载的 WorkspaceVectorIndex 分区中（O(1)）。
 * 若目标分区尚未懒加载，则不做额外加载（等待首次检索时统一拉取）。
 */
export function upsertVectorIndexEntry(
  db: Db,
  meta: VectorIndexEntryMeta,
  vec: Float32Array
): void {
  const mgr = indexByDb.get(db);
  if (!mgr || mgr.partitions.size === 0) return;

  if (!isIndexableEntry(meta)) {
    removeVectorIndexEntry(db, meta.id);
    return;
  }

  const targetPartKey = getPartitionKey(meta.scope, meta.workspace_id, meta.session_id);
  const existingLoc = mgr.idToLocation.get(meta.id);

  // If moving across partitions or dims, remove from previous matrix first
  let wasInTargetPartition = false;
  if (existingLoc) {
    if (existingLoc.partitionKey === targetPartKey) {
      wasInTargetPartition = true;
      if (existingLoc.dim !== vec.length) {
        const oldPart = mgr.partitions.get(existingLoc.partitionKey);
        const oldMat = oldPart?.matrices.get(existingLoc.dim);
        if (oldMat) removeFromDimMatrix(oldMat, meta.id);
        mgr.idToLocation.delete(meta.id);
      }
    } else {
      removeVectorIndexEntry(db, meta.id);
    }
  }

  if (!targetPartKey) return;
  const targetPartition = mgr.partitions.get(targetPartKey);
  if (!targetPartition) {
    // Partition not lazily loaded yet; keep lazy behavior
    return;
  }

  const inserted = upsertIntoPartition(mgr, targetPartition, meta.id, meta.type, vec);
  if (inserted) {
    syncPartitionAfterHook(db, targetPartition, meta.id, meta, wasInTargetPartition ? 0 : 1);
  }
}

/**
 * O(1) swap-with-last 从已加载的内存向量矩阵中移除指定记忆。
 */
export function removeVectorIndexEntry(db: Db, id: string): void {
  const mgr = indexByDb.get(db);
  if (!mgr) return;

  const loc = mgr.idToLocation.get(id);
  if (!loc) return;

  const partition = mgr.partitions.get(loc.partitionKey);
  if (partition) {
    const matrix = partition.matrices.get(loc.dim);
    if (matrix) {
      const removed = removeFromDimMatrix(matrix, id);
      if (removed) {
        syncPartitionAfterHook(db, partition, undefined, undefined, -1);
      }
    }
  }
  mgr.idToLocation.delete(id);
}

/**
 * 当外部仅持有 (id, vec) 且 WorkspaceVectorIndex 已加载时，自动同步该向量到矩阵。
 * 若该 Db 从未加载过任何分区，则是零开销 O(1) 空操作。
 */
export function syncVectorInLoadedIndex(db: Db, id: string, vec: Float32Array): void {
  const mgr = indexByDb.get(db);
  if (!mgr || mgr.partitions.size === 0) return;

  const existingLoc = mgr.idToLocation.get(id);
  if (existingLoc) {
    const partition = mgr.partitions.get(existingLoc.partitionKey);
    if (partition) {
      const oldMat = partition.matrices.get(existingLoc.dim);
      const existingSlot = oldMat?.idToSlot.get(id);
      const existingType =
        existingSlot !== undefined && oldMat ? oldMat.types[existingSlot] : 'semantic';
      if (existingLoc.dim !== vec.length && oldMat) {
        removeFromDimMatrix(oldMat, id);
        mgr.idToLocation.delete(id);
      }
      if (upsertIntoPartition(mgr, partition, id, existingType, vec)) {
        syncPartitionAfterHook(db, partition, id, undefined, 0);
      }
      return;
    }
  }

  // Entry not currently in loaded matrices: check DB row once to see if its partition is loaded
  try {
    const row = db.get<{
      id: string;
      scope: Scope;
      workspace_id: string | null;
      session_id: string | null;
      status: string;
      type: string;
      rowid_: number;
      updated_at: number;
    }>(
      `SELECT id, scope, workspace_id, session_id, status, type, rowid_, updated_at
       FROM memories WHERE id = ?`,
      [id]
    );
    if (row) {
      upsertVectorIndexEntry(db, row, vec);
    }
  } catch {}
}

/**
 * 清空指定 Db 实例关联的全部内存向量矩阵，下次查询时按需懒加载。
 */
export function invalidateVectorIndex(db: Db): void {
  const mgr = indexByDb.get(db);
  if (!mgr) return;
  mgr.partitions.clear();
  mgr.idToLocation.clear();
}

/**
 * 诊断统计接口：返回当前 Db 已加载分区数、总向量数与维度分布。
 */
export function getVectorIndexStats(db: Db): {
  loadedPartitions: string[];
  totalVectors: number;
  dims: Record<number, number>;
} {
  const mgr = indexByDb.get(db);
  if (!mgr) {
    return { loadedPartitions: [], totalVectors: 0, dims: {} };
  }
  const loadedPartitions: string[] = [];
  const dims: Record<number, number> = {};
  let totalVectors = 0;

  for (const [key, part] of mgr.partitions) {
    loadedPartitions.push(key);
    for (const [dim, mat] of part.matrices) {
      if (mat.count > 0) {
        totalVectors += mat.count;
        dims[dim] = (dims[dim] ?? 0) + mat.count;
      }
    }
  }

  return { loadedPartitions, totalVectors, dims };
}
