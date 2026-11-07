import type { Db } from '../types.js';
import { segment, extractEntities, stemToken } from './text.js';

export const DEFAULT_LOCAL_VECTOR_DIM = 128;

/**
 * FNV-1a 32-bit hash for deterministic feature hashing
 */
function fnv1a32(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 纯本地零外部依赖的 128 维确定性特征哈希嵌入 (Signed Feature Hashing / Weinberger et al.)
 * 结合 CJK/代码分词 token、相邻 token 二元组与代码实体权重，L2 归一化为 Float32Array。
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

  // 1. 词元特征 (Unigrams) + FastText 词干归一化特征 (Morphological Stems)
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    addFeature(`u:${tok}`, 1.0);
    if (tok.length >= 5 && /^[a-z]+$/.test(tok)) {
      const stem = stemToken(tok);
      if (stem !== tok && stem.length >= 3) {
        addFeature(`u:${stem}`, 0.35);
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

  // 4. 中文复合词三元组语义特征 (CJK Trigram Context)
  const cjkRuns = text.match(/[\u4e00-\u9fff]{3,}/g);
  if (cjkRuns) {
    for (const run of cjkRuns) {
      for (let i = 0; i + 3 <= run.length; i++) {
        addFeature(`c3:${run.slice(i, i + 3)}`, 0.35);
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
 * 从 SQLite BLOB (Uint8Array / Buffer) 解码为 Float32Array
 */
export function decodeEmbeddingBlob(
  blob: Uint8Array | Buffer | null | undefined,
  expectedDim?: number
): Float32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
    return null;
  }
  const dim = blob.byteLength / 4;
  if (expectedDim !== undefined && dim !== expectedDim) {
    return null;
  }
  const aligned = new Uint8Array(blob.byteLength);
  aligned.set(new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength));
  return new Float32Array(aligned.buffer);
}

/**
 * 计算两个向量的余弦相似度 (Cosine Similarity)
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;

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

const MAX_RUNTIME_VECTOR_CACHE = 4096;
const runtimeVectorCache = new Map<string, Float32Array>();

export function clearRuntimeVectorCache(): void {
  runtimeVectorCache.clear();
}

export function primeRuntimeVectorCache(
  id: string,
  hashOrKey: string | number,
  vec: Float32Array
): void {
  const cacheKey = `${id}:${hashOrKey}`;
  if (runtimeVectorCache.size >= MAX_RUNTIME_VECTOR_CACHE) {
    const oldestKey = runtimeVectorCache.keys().next().value;
    if (oldestKey) runtimeVectorCache.delete(oldestKey);
  }
  runtimeVectorCache.set(cacheKey, vec);
}

/**
 * 获取或在线计算记忆的 128 维本地向量（支持外部缓存、SQLite BLOB 解码与内存 LRU 即时回退）
 */
export function getOrComputeEmbedding(
  row: {
    id: string;
    summary?: string | null;
    content?: string | null;
    slot_key?: string | null;
    hash?: string | null;
    embedding?: Uint8Array | Buffer | null;
  },
  externalCache?: Map<string, Float32Array>,
  dim: number = DEFAULT_LOCAL_VECTOR_DIM
): Float32Array | null {
  const cachedExt = externalCache?.get(row.id);
  if (cachedExt) return cachedExt;

  const decoded = decodeEmbeddingBlob(row.embedding, dim);
  if (decoded) return decoded;

  const text = `${row.summary || ''}\n${row.content || ''}${row.slot_key ? `\n${row.slot_key}` : ''}`.trim();
  if (!text) return null;

  const cacheKey = `${row.id}:${row.hash || text.length}`;
  const cachedRt = runtimeVectorCache.get(cacheKey);
  if (cachedRt) return cachedRt;

  const computed = computeLocalEmbedding(text, dim);
  if (runtimeVectorCache.size >= MAX_RUNTIME_VECTOR_CACHE) {
    const oldestKey = runtimeVectorCache.keys().next().value;
    if (oldestKey) runtimeVectorCache.delete(oldestKey);
  }
  runtimeVectorCache.set(cacheKey, computed);
  return computed;
}

/**
 * 为尚未生成 embedding 的记忆补充本地特征哈希向量
 */
export function backfillMissingEmbeddings(
  db: Db,
  options: { workspaceId?: string; limit?: number; dim?: number } = {}
): number {
  const limit = options.limit ?? 200;
  const dim = options.dim ?? DEFAULT_LOCAL_VECTOR_DIM;

  const rows = options.workspaceId
    ? db.all<{
        id: string;
        summary: string;
        content: string;
        slot_key: string | null;
      }>(
        `SELECT id, summary, content, slot_key FROM memories
         WHERE status IN ('active', 'frozen')
           AND (workspace_id = ? OR scope = 'global')
           AND embedding IS NULL
         LIMIT ?`,
        [options.workspaceId, limit]
      )
    : db.all<{
        id: string;
        summary: string;
        content: string;
        slot_key: string | null;
      }>(
        `SELECT id, summary, content, slot_key FROM memories
         WHERE status IN ('active', 'frozen')
           AND embedding IS NULL
         LIMIT ?`,
        [limit]
      );

  if (rows.length === 0) return 0;

  let updated = 0;
  db.transaction(() => {
    for (const row of rows) {
      const text = `${row.summary}\n${row.content}${row.slot_key ? `\n${row.slot_key}` : ''}`;
      const vec = computeLocalEmbedding(text, dim);
      db.run(`UPDATE memories SET embedding = ? WHERE id = ?`, [
        encodeEmbeddingBlob(vec),
        row.id,
      ]);
      updated++;
    }
  });

  return updated;
}
