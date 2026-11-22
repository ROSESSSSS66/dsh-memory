import type { Db, Scope } from '../types.js';
import type { PluginConfig } from '../config.js';
import { CJK_SEGMENT_REGEX, segment, extractEntities, stemToken } from './text.js';
import { workspaceId } from './scope.js';
import {
  isWorkspaceExcluded,
  memoryPrivacyFilterSQL,
  redactSecrets,
  type LookupFn,
} from './privacy.js';
import {
  invalidateVectorIndex,
  removeVectorIndexEntry,
  syncVectorInLoadedIndex,
  upsertVectorIndexBatch,
  type VectorIndexEntryMeta,
} from './vector-index.js';
import {
  fetchRemoteEmbeddings,
  getActiveEmbeddingMeta,
  isRemoteEmbeddingEnabled,
} from './embedding-client.js';

export const DEFAULT_LOCAL_VECTOR_DIM = 128;

/**
 * FNV-1a 32-bit hash for deterministic feature hashing.
 * 当字符码点 > 0xff（如 CJK/非拉丁 BMP 字符）时拆分为低/高字节分别混入，改善雪崩分布。
 */
function fnv1a32(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code > 0xff) {
      h ^= code & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (code >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    } else {
      h ^= code;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

const ASCII_ALPHA_REGEX = /^[a-z]+$/;

/**
 * 纯本地零外部依赖的 128 维确定性特征哈希嵌入 (Signed Feature Hashing / Weinberger et al.)
 * 结合 CJK/代码分词 token、FastText 风格英文 3-4 字子词、相邻 token 二元组、CJK 三元组与代码实体权重，
 * L2 归一化为 Float32Array。
 */
export function computeLocalEmbedding(
  text: string,
  dim: number = DEFAULT_LOCAL_VECTOR_DIM
): Float32Array {
  const vec = new Float32Array(dim);
  if (!text || dim <= 0) return vec;

  const tokens = segment(text);
  const entities = extractEntities(text);

  if (tokens.length === 0 && entities.length === 0) {
    return vec;
  }

  const addFeature = (feature: string, weight: number) => {
    const h1 = fnv1a32(feature, 0x811c9dc5);
    const h2 = fnv1a32(feature, 0x9e3779b9);
    const idx = h1 % dim;
    const sign = (h2 & 1) === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };

  // 1. 词元特征 (Unigrams) + 词干归一化 + FastText 风格英文字符 3-4 gram 子词特征
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    addFeature(`u:${tok}`, 1.0);

    if (tok.length >= 5 && ASCII_ALPHA_REGEX.test(tok)) {
      const stem = stemToken(tok);
      if (stem !== tok && stem.length >= 3) {
        addFeature(`u:${stem}`, 0.35);
      }

      // FastText-style 3-4 char n-grams with boundary markers; L2 energy normalized (~0.35x relative to whole word)
      const word = tok.length > 24 ? tok.slice(0, 24) : tok;
      const padded = `<${word}>`;
      const triCount = padded.length - 2;
      const quadCount = padded.length - 3;
      const totalSubwords = triCount + quadCount;
      const subWeight = Math.min(0.35, 0.7 / Math.sqrt(Math.max(1, totalSubwords)));

      for (let j = 0; j < triCount; j++) {
        addFeature(`s3:${padded.slice(j, j + 3)}`, subWeight);
      }
      for (let j = 0; j < quadCount; j++) {
        addFeature(`s4:${padded.slice(j, j + 4)}`, subWeight);
      }
    }

    // 2. 局部词序特征 (Token Bigrams)
    if (i + 1 < tokens.length) {
      addFeature(`b:${tok}_${tokens[i + 1]}`, 0.6);
    }
  }

  // 3. 代码/路径/标识符实体增强权重 + 层级路径目录前缀特征 (Hierarchical Path Prefixes)
  for (const ent of entities) {
    addFeature(`e:${ent}`, 2.0);
    if (ent.includes('/')) {
      const normPath = ent.replace(/^\.?\//, '');
      const parts = normPath.split('/').filter(Boolean);
      for (let d = 1; d < parts.length; d++) {
        addFeature(`dir:${parts.slice(0, d).join('/')}`, 0.9);
      }
    }
  }

  // 4. CJK (Han + Ext A-G + Hiragana + Katakana + Hangul) 复合词三元组语义特征
  const cjkRuns = text.match(CJK_SEGMENT_REGEX);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      const chars = Array.from(run);
      if (chars.length >= 3) {
        for (let i = 0; i + 3 <= chars.length; i++) {
          addFeature(`c3:${chars[i]}${chars[i + 1]}${chars[i + 2]}`, 0.35);
        }
      }
    }
  }

  // L2 归一化
  let normSq = 0;
  for (let i = 0; i < dim; i++) {
    normSq += vec[i] * vec[i];
  }
  if (normSq > 1e-12) {
    const invNorm = 1 / Math.sqrt(normSq);
    for (let i = 0; i < dim; i++) {
      vec[i] *= invNorm;
    }
  }

  return vec;
}

/**
 * 将 Float32Array 编码为 SQLite BLOB 可存储的 Uint8Array
 */
export function encodeEmbeddingBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * 从 SQLite BLOB (Uint8Array / ArrayBufferView) 解码为 Float32Array。
 * 当 byteOffset 满足 4 字节对齐时零拷贝构造视图，仅在未对齐时执行对齐拷贝。
 */
export function decodeEmbeddingBlob(
  blob: Uint8Array | ArrayBufferView | null | undefined,
  expectedDim?: number
): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
    return null;
  }
  const dim = blob.byteLength / 4;
  if (expectedDim !== undefined && dim !== expectedDim) {
    return null;
  }
  if (blob.byteOffset % 4 === 0) {
    return new Float32Array(blob.buffer, blob.byteOffset, dim);
  }
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength));
  return new Float32Array(aligned.buffer, 0, dim);
}

/**
 * 计算两个向量的余弦相似度 (Cosine Similarity)。
 * 严格要求维度一致且非空：a.length !== b.length || a.length === 0 时直接返回 0（不做静默截断）。
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 1e-12 || normB <= 1e-12) return 0;
  return dot / Math.sqrt(normA * normB);
}

/**
 * 面向已 L2 归一化单位向量的高速点积（a.length !== b.length || a.length === 0 时返回 0）。
 */
export function dotProductUnit(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;

  let dot = 0;
  let i = 0;
  const len4 = len & ~3;
  for (; i < len4; i += 4) {
    dot +=
      a[i] * b[i] +
      a[i + 1] * b[i + 1] +
      a[i + 2] * b[i + 2] +
      a[i + 3] * b[i + 3];
  }
  for (; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

const MAX_RUNTIME_VECTOR_CACHE = 4096;

interface RuntimeCacheEntry {
  hash: string;
  vec: Float32Array;
}

const perDbVectorCache = new WeakMap<Db, Map<string, RuntimeCacheEntry>>();
const fallbackVectorCache = new Map<string, RuntimeCacheEntry>();

function isDbInstance(val: unknown): val is Db {
  return (
    Boolean(val) &&
    typeof val === 'object' &&
    !(val instanceof Map) &&
    typeof (val as Db).prepare === 'function' &&
    typeof (val as Db).all === 'function'
  );
}

function getCacheMap(db?: Db): Map<string, RuntimeCacheEntry> {
  if (!db) return fallbackVectorCache;
  let map = perDbVectorCache.get(db);
  if (!map) {
    map = new Map<string, RuntimeCacheEntry>();
    perDbVectorCache.set(db, map);
  }
  return map;
}

function setLruEntry(
  map: Map<string, RuntimeCacheEntry>,
  id: string,
  hash: string,
  vec: Float32Array
): void {
  if (map.has(id)) {
    map.delete(id);
  } else if (map.size >= MAX_RUNTIME_VECTOR_CACHE) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(id, { hash, vec });
}

export function clearRuntimeVectorCache(db?: Db): void {
  if (db) {
    perDbVectorCache.get(db)?.clear();
    invalidateVectorIndex(db);
    return;
  }
  fallbackVectorCache.clear();
}

export function removeCachedRuntimeEmbedding(id: string, db?: Db): void {
  const map = getCacheMap(db);
  map.delete(id);
  if (db) {
    removeVectorIndexEntry(db, id);
  }
}

export function primeRuntimeVectorCache(
  id: string,
  hashOrKey: string | number,
  vec: Float32Array,
  db?: Db
): void {
  const map = getCacheMap(db);
  setLruEntry(map, id, String(hashOrKey), vec);
  if (db) {
    syncVectorInLoadedIndex(db, id, vec);
  }
}

export function getCachedRuntimeEmbedding(
  id: string,
  hashOrKey?: string | number | null,
  db?: Db
): Float32Array | null {
  if (hashOrKey === undefined || hashOrKey === null || hashOrKey === '') {
    return null;
  }
  const map = getCacheMap(db);
  const entry = map.get(id);
  if (!entry || entry.hash !== String(hashOrKey)) {
    return null;
  }
  // True LRU recency refresh on cache hit
  map.delete(id);
  map.set(id, entry);
  return entry.vec;
}

export interface EmbeddingRowInput {
  id: string;
  summary?: string | null;
  content?: string | null;
  slot_key?: string | null;
  hash?: string | null;
  embedding?: Uint8Array | ArrayBufferView | null;
}

function buildMemoryEmbeddingText(row: {
  summary?: string | null;
  content?: string | null;
  slot_key?: string | null;
}): string {
  return `${row.summary || ''}\n${row.content || ''}${row.slot_key ? `\n${row.slot_key}` : ''}`.trim();
}

/**
 * 获取或在线计算记忆向量（支持外部缓存、按 Db 隔离真 LRU、SQLite BLOB 零拷贝解码与本地 128D 即时回退）。
 * 兼容旧签名 `(row, externalCache?, dim?)` 与新签名 `(row, db?)`。
 */
export function getOrComputeEmbedding(
  row: EmbeddingRowInput,
  cacheOrDb?: Map<string, Float32Array> | Db,
  dimOrDb?: number | Db,
  maybeDb?: Db
): Float32Array | null {
  let externalCache: Map<string, Float32Array> | undefined;
  let explicitDim: number | undefined;
  let db: Db | undefined;

  if (cacheOrDb instanceof Map) {
    externalCache = cacheOrDb;
  } else if (isDbInstance(cacheOrDb)) {
    db = cacheOrDb;
  }

  if (typeof dimOrDb === 'number') {
    explicitDim = dimOrDb;
  } else if (isDbInstance(dimOrDb)) {
    db = dimOrDb;
  }

  if (isDbInstance(maybeDb)) {
    db = maybeDb;
  }

  const cachedExt = externalCache?.get(row.id);
  if (cachedExt && (explicitDim === undefined || cachedExt.length === explicitDim)) {
    return cachedExt;
  }

  const map = getCacheMap(db);
  const rowHash = row.hash ? String(row.hash) : '';

  if (rowHash) {
    const cached = getCachedRuntimeEmbedding(row.id, rowHash, db);
    if (cached && (explicitDim === undefined || cached.length === explicitDim)) {
      return cached;
    }
  }

  const decoded = decodeEmbeddingBlob(row.embedding, explicitDim);
  if (decoded) {
    if (rowHash) {
      setLruEntry(map, row.id, rowHash, decoded);
    }
    return decoded;
  }

  const text = buildMemoryEmbeddingText(row);
  if (!text) return null;

  const targetDim = explicitDim ?? DEFAULT_LOCAL_VECTOR_DIM;
  const fallbackHash = rowHash
    ? targetDim === DEFAULT_LOCAL_VECTOR_DIM
      ? rowHash
      : `${rowHash}:d${targetDim}`
    : `len:${text.length}:d${targetDim}`;

  const cachedFallback = getCachedRuntimeEmbedding(row.id, fallbackHash, db);
  if (cachedFallback && cachedFallback.length === targetDim) {
    return cachedFallback;
  }

  const computed = computeLocalEmbedding(text, targetDim);
  setLruEntry(map, row.id, fallbackHash, computed);
  return computed;
}

interface BackfillRow {
  rowid_: number;
  id: string;
  type: string;
  status: string;
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
  summary: string;
  content: string;
  slot_key: string | null;
  hash: string;
  updated_at: number;
}

export interface BackfillLocalResult {
  updated: number;
  remaining: number;
}

/**
 * 为尚未生成 embedding 的记忆补充本地特征哈希向量，返回 `{ updated, remaining }`。
 * 利用 Schema v3 的 `ix_mem_missing_embedding` 部分索引，在循环外预编译 UPDATE，并通过 `db.afterCommit` 更新缓存与向量矩阵。
 */
export function backfillMissingEmbeddingsDetailed(
  db: Db,
  options: { workspaceId?: string; limit?: number; dim?: number } = {}
): BackfillLocalResult {
  const limit = Math.max(1, options.limit ?? 500);
  const dim = options.dim ?? DEFAULT_LOCAL_VECTOR_DIM;
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;

  const selectMissingRows = (useIndexHint: boolean): BackfillRow[] => {
    const hint = useIndexHint ? ' INDEXED BY ix_mem_missing_embedding' : '';
    return wsFilter
      ? db.all<BackfillRow>(
          `SELECT rowid_, id, type, status, scope, workspace_id, session_id,
                  summary, content, slot_key, hash, updated_at
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL
             AND (workspace_id = ? OR scope IN ('user', 'global'))
           LIMIT ?`,
          [wsFilter, limit]
        )
      : db.all<BackfillRow>(
          `SELECT rowid_, id, type, status, scope, workspace_id, session_id,
                  summary, content, slot_key, hash, updated_at
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL
           LIMIT ?`,
          [limit]
        );
  };

  let rows: BackfillRow[];
  try {
    rows = selectMissingRows(true);
  } catch {
    rows = selectMissingRows(false);
  }

  if (rows.length === 0) {
    return { updated: 0, remaining: 0 };
  }

  const committed: Array<{ row: BackfillRow; vec: Float32Array }> = [];

  db.transaction(() => {
    const updateStmt = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const text = buildMemoryEmbeddingText(row);
      const vec = computeLocalEmbedding(text, dim);
      updateStmt.run(encodeEmbeddingBlob(vec), row.id);
      committed.push({ row, vec });
    }

    db.afterCommit(() => {
      const map = getCacheMap(db);
      const indexEntries: Array<{ meta: VectorIndexEntryMeta; vec: Float32Array }> = [];
      for (let i = 0; i < committed.length; i++) {
        const { row, vec } = committed[i];
        if (row.hash) {
          setLruEntry(map, row.id, row.hash, vec);
        }
        indexEntries.push({
          meta: {
            id: row.id,
            scope: row.scope,
            workspace_id: row.workspace_id,
            session_id: row.session_id,
            status: row.status,
            type: row.type,
            rowid_: row.rowid_,
            updated_at: row.updated_at,
          },
          vec,
        });
      }
      upsertVectorIndexBatch(db, indexEntries);
    });
  });

  const countRemaining = (useIndexHint: boolean): number => {
    const hint = useIndexHint ? ' INDEXED BY ix_mem_missing_embedding' : '';
    const row = wsFilter
      ? db.get<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL
             AND (workspace_id = ? OR scope IN ('user', 'global'))`,
          [wsFilter]
        )
      : db.get<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM memories${hint}
           WHERE status IN ('active', 'frozen')
             AND embedding IS NULL`
        );
    return row?.cnt ?? 0;
  };

  let remaining: number;
  try {
    remaining = countRemaining(true);
  } catch {
    remaining = countRemaining(false);
  }

  return {
    updated: committed.length,
    remaining,
  };
}

/**
 * 为尚未生成 embedding 的记忆补充本地特征哈希向量。
 * - 传入选项对象 `{ workspaceId?, limit?, dim? }` 或省略第二参数时，保持历史兼容返回 `number`（更新条数）。
 * - 传入数字 `limit` 时，返回 `{ updated, remaining }`。
 */
export function backfillMissingEmbeddings(
  db: Db,
  options?: { workspaceId?: string; limit?: number; dim?: number }
): number;
export function backfillMissingEmbeddings(
  db: Db,
  limit: number
): BackfillLocalResult;
export function backfillMissingEmbeddings(
  db: Db,
  optionsOrLimit?: { workspaceId?: string; limit?: number; dim?: number } | number
): number | BackfillLocalResult {
  if (typeof optionsOrLimit === 'number') {
    return backfillMissingEmbeddingsDetailed(db, { limit: optionsOrLimit });
  }
  return backfillMissingEmbeddingsDetailed(db, optionsOrLimit).updated;
}

const META_PROVIDER_SIG_KEY = 'embedding_provider_sig';
const META_MIGRATING_SIG_KEY = 'embedding_migrating_sig';
const META_MIGRATING_ROWID_KEY = 'embedding_migrating_rowid';

/**
 * 异步远程 OpenAI-compatible Embedding 增量回填与模型切换迁移：
 * - 校验 `cfg.embedding.provider === 'openai-compatible'`、隐私授权、排除工作区及端点安全
 * - 对比 `meta['embedding_provider_sig']` 自动识别首次启用或模型/维度切换并断点续迁
 * - 批量请求远程 Embedding（每批发送前执行 `redactSecrets` 脱敏），在事务中写回 L2 归一化 BLOB 并通过 `db.afterCommit` 刷新缓存与向量矩阵
 * - 当未启用、未授权或远程不可达时优雅跳过，保留既有本地向量不受破坏
 */
export async function backfillRemoteEmbeddingsAsync(
  db: Db,
  cfg: PluginConfig,
  options: {
    limit?: number;
    workspaceId?: string;
    signal?: AbortSignal;
    fetchFn?: typeof fetch;
    lookupFn?: LookupFn;
    skipDnsLookup?: boolean;
  } = {}
): Promise<{ updated: number; skipped: boolean; reason?: string }> {
  if (!cfg || !cfg.embedding || cfg.embedding.provider !== 'openai-compatible') {
    return { updated: 0, skipped: true, reason: 'provider_disabled' };
  }
  if (!cfg.privacy?.offlineConsent) {
    return { updated: 0, skipped: true, reason: 'offline_consent_required' };
  }
  if (!isRemoteEmbeddingEnabled(cfg)) {
    return { updated: 0, skipped: true, reason: 'remote_embedding_not_enabled' };
  }
  if (options.workspaceId && isWorkspaceExcluded(options.workspaceId, cfg.excludeWorkspaces)) {
    return { updated: 0, skipped: true, reason: 'workspace_excluded' };
  }
  if (options.signal?.aborted) {
    return { updated: 0, skipped: true, reason: 'aborted' };
  }

  const providerMeta = getActiveEmbeddingMeta(cfg);
  const expectedBytes = providerMeta.dim * 4;
  const limit = Math.max(1, options.limit ?? 200);
  const batchSize = Math.max(1, Math.min(256, cfg.embedding.batchSize ?? 32));
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;

  const prevSig =
    db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [META_PROVIDER_SIG_KEY])
      ?.value || '';
  const needsFullMigration = prevSig !== providerMeta.signature;

  let cursorRowid = 0;
  if (needsFullMigration && !wsFilter) {
    const migratingSig =
      db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [META_MIGRATING_SIG_KEY])
        ?.value || '';
    if (migratingSig === providerMeta.signature) {
      const rawCursor = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
        META_MIGRATING_ROWID_KEY,
      ])?.value;
      const parsedCursor = rawCursor ? parseInt(rawCursor, 10) : 0;
      if (Number.isInteger(parsedCursor) && parsedCursor > 0) {
        cursorRowid = parsedCursor;
      }
    }
  }

  const privacyFilter = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
  const whereClauses: string[] = [
    "memories.status IN ('active', 'frozen')",
    "memories.type != 'meta'",
    privacyFilter.sql,
  ];
  const params: unknown[] = [...privacyFilter.params];

  if (wsFilter) {
    whereClauses.push("(memories.workspace_id = ? OR memories.scope IN ('user', 'global'))");
    params.push(wsFilter);
  }

  if (needsFullMigration) {
    if (!wsFilter && cursorRowid > 0) {
      whereClauses.push('memories.rowid_ > ?');
      params.push(cursorRowid);
    }
  } else {
    whereClauses.push('(memories.embedding IS NULL OR length(memories.embedding) != ?)');
    params.push(expectedBytes);
  }

  params.push(limit);

  const rows = db.all<BackfillRow>(
    `SELECT rowid_, id, type, status, scope, workspace_id, session_id,
            summary, content, slot_key, hash, updated_at
     FROM memories
     WHERE ${whereClauses.join(' AND ')}
     ORDER BY rowid_ ASC
     LIMIT ?`,
    params
  );

  if (rows.length === 0) {
    if (needsFullMigration && !wsFilter) {
      db.transaction(() => {
        db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
          META_PROVIDER_SIG_KEY,
          providerMeta.signature,
        ]);
        db.run('DELETE FROM meta WHERE key IN (?, ?)', [
          META_MIGRATING_SIG_KEY,
          META_MIGRATING_ROWID_KEY,
        ]);
      });
    }
    return { updated: 0, skipped: false };
  }

  let totalUpdated = 0;
  let lastCommittedRowid = cursorRowid;

  for (let start = 0; start < rows.length; start += batchSize) {
    if (options.signal?.aborted) {
      return {
        updated: totalUpdated,
        skipped: totalUpdated === 0,
        reason: 'aborted',
      };
    }

    const batchRows = rows.slice(start, start + batchSize);
    const batchTexts = batchRows.map((r) => redactSecrets(buildMemoryEmbeddingText(r)).text);

    const remoteRes = await fetchRemoteEmbeddings(batchTexts, cfg, {
      signal: options.signal,
      fetchFn: options.fetchFn,
      lookupFn: options.lookupFn,
      skipDnsLookup: options.skipDnsLookup,
    });

    if (!remoteRes.ok) {
      return {
        updated: totalUpdated,
        skipped: totalUpdated === 0,
        reason: remoteRes.reason,
      };
    }

    if (remoteRes.vectors.length !== batchRows.length) {
      return {
        updated: totalUpdated,
        skipped: totalUpdated === 0,
        reason: 'invalid_response_count',
      };
    }

    const batchLastRowid = batchRows[batchRows.length - 1].rowid_;

    db.transaction(() => {
      const updateStmt = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?');
      for (let i = 0; i < batchRows.length; i++) {
        updateStmt.run(encodeEmbeddingBlob(remoteRes.vectors[i]), batchRows[i].id);
      }

      if (needsFullMigration && !wsFilter) {
        db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
          META_MIGRATING_SIG_KEY,
          providerMeta.signature,
        ]);
        db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
          META_MIGRATING_ROWID_KEY,
          String(batchLastRowid),
        ]);
      }

      db.afterCommit(() => {
        const map = getCacheMap(db);
        const indexEntries: Array<{ meta: VectorIndexEntryMeta; vec: Float32Array }> = [];
        for (let i = 0; i < batchRows.length; i++) {
          const row = batchRows[i];
          const vec = remoteRes.vectors[i];
          if (row.hash) {
            setLruEntry(map, row.id, row.hash, vec);
          }
          indexEntries.push({
            meta: {
              id: row.id,
              scope: row.scope,
              workspace_id: row.workspace_id,
              session_id: row.session_id,
              status: row.status,
              type: row.type,
              rowid_: row.rowid_,
              updated_at: row.updated_at,
            },
            vec,
          });
        }
        upsertVectorIndexBatch(db, indexEntries);
      });
    });

    totalUpdated += batchRows.length;
    lastCommittedRowid = batchLastRowid;
  }

  // 若本次已迁完全部符合条件的记忆，持久化最新 provider 签名并清理断点游标
  if (needsFullMigration && !wsFilter) {
    const moreRows = db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM memories
       WHERE memories.status IN ('active', 'frozen')
         AND memories.type != 'meta'
         AND ${privacyFilter.sql}
         AND memories.rowid_ > ?`,
      [...privacyFilter.params, lastCommittedRowid]
    );
    if ((moreRows?.cnt ?? 0) === 0) {
      db.transaction(() => {
        db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
          META_PROVIDER_SIG_KEY,
          providerMeta.signature,
        ]);
        db.run('DELETE FROM meta WHERE key IN (?, ?)', [
          META_MIGRATING_SIG_KEY,
          META_MIGRATING_ROWID_KEY,
        ]);
      });
    }
  }

  return { updated: totalUpdated, skipped: false };
}
