import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import {
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  decodeEmbeddingBlob,
  cosineSimilarity,
  dotProductUnit,
  backfillMissingEmbeddings,
  getOrComputeEmbedding,
  clearRuntimeVectorCache,
  primeRuntimeVectorCache,
  getCachedRuntimeEmbedding,
  removeCachedRuntimeEmbedding,
  DEFAULT_LOCAL_VECTOR_DIM,
} from '../../src/core/vector.js';
import { searchWorkspaceVectors } from '../../src/core/vector-index.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { buildQueryPlan } from '../../src/retrieval/query.js';
import { recallVector } from '../../src/retrieval/channels.js';
import { workspaceId } from '../../src/core/scope.js';

describe('Local Feature-Hashing Vector Engine (src/core/vector.ts)', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-vector');

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('computes deterministic L2-normalized embeddings and round-trips BLOB encoding', () => {
    const v1 = computeLocalEmbedding('数据库连接池配置在 src/core/db.ts，默认超时 30s');
    const v2 = computeLocalEmbedding('数据库连接池配置在 src/core/db.ts，默认超时 30s');
    const vUnrelated = computeLocalEmbedding('前端 Glassmorphism 毛玻璃暗色主题切换组件');

    expect(v1.length).toBe(DEFAULT_LOCAL_VECTOR_DIM);
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
    expect(dotProductUnit(v1, v2)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(v1, vUnrelated)).toBeLessThan(0.35);

    const blob = encodeEmbeddingBlob(v1);
    const decoded = decodeEmbeddingBlob(blob, DEFAULT_LOCAL_VECTOR_DIM);
    expect(decoded).not.toBeNull();
    expect(cosineSimilarity(v1, decoded!)).toBeCloseTo(1.0, 5);
  });

  it('supports zero-copy aligned decode and aligned-copy fallback for unaligned BLOB views', () => {
    const vec = computeLocalEmbedding('zero-copy alignment check for Float32Array BLOB');
    const alignedBlob = encodeEmbeddingBlob(vec);

    // byteOffset % 4 === 0 -> zero-copy view sharing exact ArrayBuffer
    const decodedAligned = decodeEmbeddingBlob(alignedBlob, DEFAULT_LOCAL_VECTOR_DIM);
    expect(decodedAligned).not.toBeNull();
    expect(decodedAligned!.buffer).toBe(alignedBlob.buffer);
    expect(decodedAligned!.byteOffset).toBe(alignedBlob.byteOffset);
    expect(cosineSimilarity(vec, decodedAligned!)).toBeCloseTo(1.0, 6);

    // Unaligned view (byteOffset = 1) -> safe copy into aligned Float32Array
    const padded = new Uint8Array(alignedBlob.byteLength + 1);
    padded.set(alignedBlob, 1);
    const unalignedBlob = new Uint8Array(padded.buffer, 1, alignedBlob.byteLength);
    expect(unalignedBlob.byteOffset % 4).toBe(1);

    const decodedUnaligned = decodeEmbeddingBlob(unalignedBlob, DEFAULT_LOCAL_VECTOR_DIM);
    expect(decodedUnaligned).not.toBeNull();
    expect(decodedUnaligned!.buffer).not.toBe(unalignedBlob.buffer);
    expect(cosineSimilarity(vec, decodedUnaligned!)).toBeCloseTo(1.0, 6);

    // Invalid inputs
    expect(decodeEmbeddingBlob(null)).toBeNull();
    expect(decodeEmbeddingBlob(new Uint8Array(0))).toBeNull();
    expect(decodeEmbeddingBlob(new Uint8Array(5))).toBeNull();
    expect(decodeEmbeddingBlob(alignedBlob, 64)).toBeNull();
  });

  it('strictly returns 0 on dimension mismatch or empty vectors in cosineSimilarity and dotProductUnit', () => {
    const a = new Float32Array(128).fill(1 / Math.sqrt(128));
    const b = new Float32Array(64).fill(1 / Math.sqrt(64));
    const empty = new Float32Array(0);

    // Must NOT silently truncate to min(128, 64)
    expect(cosineSimilarity(a, b)).toBe(0);
    expect(dotProductUnit(a, b)).toBe(0);
    expect(cosineSimilarity(empty, empty)).toBe(0);
    expect(dotProductUnit(empty, empty)).toBe(0);

    // Same-dim unit vectors match closely
    const v1 = computeLocalEmbedding('postgresql connection pool timeout');
    const v2 = computeLocalEmbedding('postgresql connection pool settings');
    expect(dotProductUnit(v1, v2)).toBeCloseTo(cosineSimilarity(v1, v2), 5);
  });

  it('improves CJK avalanche (Han/Kana/Hangul/Ext-A) and English morphological recall via 3-4 gram subwords', () => {
    // Multilingual CJK scripts via CJK_SEGMENT_REGEX
    const jp1 = computeLocalEmbedding('データベース接続プールのタイムアウト設定');
    const jp2 = computeLocalEmbedding('データベース接続プール設定確認');
    const jpOther = computeLocalEmbedding('フロントエンドのダークモード切替ボタン');
    expect(cosineSimilarity(jp1, jp2)).toBeGreaterThan(0.35);
    expect(cosineSimilarity(jp1, jp2)).toBeGreaterThan(cosineSimilarity(jp1, jpOther) + 0.15);

    const ko1 = computeLocalEmbedding('데이터베이스 연결 풀 타임아웃 설정');
    const ko2 = computeLocalEmbedding('데이터베이스 연결 풀 설정');
    expect(cosineSimilarity(ko1, ko2)).toBeGreaterThan(0.45);

    // CJK Ext A trigrams
    const extA = computeLocalEmbedding('㐀㐁㐂㐃㐄');
    expect(dotProductUnit(extA, extA)).toBeCloseTo(1.0, 5);

    // Characters sharing the same low byte (0x01) should avalanche into distinct vectors
    const c1 = computeLocalEmbedding('丁丁丁');
    const c2 = computeLocalEmbedding('企企企');
    expect(cosineSimilarity(c1, c2)).toBeLessThan(0.5);

    // FastText-style 3-4 gram English morphological subwords
    const morphA = computeLocalEmbedding('configure authentication deployment');
    const morphB = computeLocalEmbedding('configuration authenticating deployments');
    const unrelated = computeLocalEmbedding('submarine keyboard pineapple');
    expect(cosineSimilarity(morphA, morphB)).toBeGreaterThan(0.25);
    expect(cosineSimilarity(morphA, unrelated)).toBeLessThan(0.2);
  });

  it('isolates runtime LRU vector cache per Db, refreshes recency on hit, and avoids eviction on in-place update', () => {
    const db1 = openDb(':memory:');
    const db2 = openDb(':memory:');
    const v1 = computeLocalEmbedding('db1 specific vector');
    const v2 = computeLocalEmbedding('db2 specific vector');

    primeRuntimeVectorCache('m_shared_id', 'hash_a', v1, db1);
    primeRuntimeVectorCache('m_shared_id', 'hash_b', v2, db2);

    expect(getCachedRuntimeEmbedding('m_shared_id', 'hash_a', db1)).toBe(v1);
    expect(getCachedRuntimeEmbedding('m_shared_id', 'hash_a', db2)).toBeNull();
    expect(getCachedRuntimeEmbedding('m_shared_id', 'hash_b', db2)).toBe(v2);

    clearRuntimeVectorCache(db1);
    expect(getCachedRuntimeEmbedding('m_shared_id', 'hash_a', db1)).toBeNull();
    expect(getCachedRuntimeEmbedding('m_shared_id', 'hash_b', db2)).toBe(v2);

    // True LRU eviction test on db1 (capacity = 4096)
    const unitVec = new Float32Array(DEFAULT_LOCAL_VECTOR_DIM);
    unitVec[0] = 1;
    for (let i = 0; i < 4096; i++) {
      primeRuntimeVectorCache(`k_${i}`, `h_${i}`, unitVec, db1);
    }

    // Touch k_0 so k_1 becomes the least recently used entry
    expect(getCachedRuntimeEmbedding('k_0', 'h_0', db1)).toBe(unitVec);

    // In-place update of k_2 at capacity must NOT evict k_1
    const updatedVec = new Float32Array(DEFAULT_LOCAL_VECTOR_DIM);
    updatedVec[1] = 1;
    primeRuntimeVectorCache('k_2', 'h_2_new', updatedVec, db1);
    expect(getCachedRuntimeEmbedding('k_1', 'h_1', db1)).toBe(unitVec);
    expect(getCachedRuntimeEmbedding('k_2', 'h_2_new', db1)).toBe(updatedVec);
    // Now k_3 is the oldest (since k_0, k_2, k_1 were refreshed)
    primeRuntimeVectorCache('k_4096', 'h_4096', unitVec, db1);
    expect(getCachedRuntimeEmbedding('k_3', 'h_3', db1)).toBeNull();
    expect(getCachedRuntimeEmbedding('k_0', 'h_0', db1)).toBe(unitVec);
    expect(getCachedRuntimeEmbedding('k_1', 'h_1', db1)).toBe(unitVec);
    expect(getCachedRuntimeEmbedding('k_4096', 'h_4096', db1)).toBe(unitVec);

    // O(1) remove also removes from loaded WorkspaceVectorIndex
    removeCachedRuntimeEmbedding('k_0', db1);
    expect(getCachedRuntimeEmbedding('k_0', 'h_0', db1)).toBeNull();

    db1.close();
    db2.close();
  });

  it('backfills missing embeddings (both legacy options and detailed numeric limit) and respects transaction rollback', () => {
    const ids: string[] = [];
    const samples = [
      '项目 PostgreSQL 生产库连接池配置位于 src/core/db.ts，最大连接数 50',
      '前端组件统一使用 TypeScript 严格模式与 2 空格缩进',
      'Redis 缓存默认 TTL 设为 300 秒并启用 LRU 淘汰策略',
      'Nginx 反向代理超时参数 proxy_read_timeout 设为 60s',
    ];

    for (let i = 0; i < samples.length; i++) {
      const res = upsertCandidate(db, {
        type: 'semantic',
        content: samples[i],
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: i + 1, kind: 'user' }],
        actor: 'user',
      });
      expect(res.action).toBe('inserted');
      ids.push((res as any).id);
    }

    // Legacy options overload returns number
    expect(backfillMissingEmbeddings(db, { workspaceId: ws })).toBe(0);
    db.run('UPDATE memories SET embedding = NULL');
    clearRuntimeVectorCache(db);

    // Transaction rollback must NOT pollute per-Db cache or DB
    expect(() => {
      db.transaction(() => {
        backfillMissingEmbeddings(db, 2);
        throw new Error('force_rollback');
      });
    }).toThrow('force_rollback');

    const row0 = db.get<{ hash: string; embedding: Uint8Array | null }>(
      'SELECT hash, embedding FROM memories WHERE id = ?',
      [ids[0]]
    );
    expect(row0?.embedding).toBeNull();
    expect(getCachedRuntimeEmbedding(ids[0], row0?.hash, db)).toBeNull();

    // Numeric limit overload returns { updated, remaining }
    const step1 = backfillMissingEmbeddings(db, 2);
    expect(step1).toEqual({ updated: 2, remaining: 2 });

    // Legacy options overload finishes remaining rows and returns number
    const step2 = backfillMissingEmbeddings(db, { workspaceId: ws, limit: 10 });
    expect(step2).toBe(2);

    // Search via both recallVector and WorkspaceVectorIndex
    const plan = buildQueryPlan({
      userText: 'PostgreSQL 生产库连接池 src/core/db.ts 最大连接数',
    });
    const hits = recallVector(db, plan, { workspaceId: ws, sessionId: 's1' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].id).toBe(ids[0]);
    expect(hits[0].channel).toBe('vector');
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.65);

    const matrixHits = searchWorkspaceVectors(
      db,
      { workspaceId: ws, sessionId: 's1' },
      computeLocalEmbedding(plan.text),
      { limit: 5, minScore: 0.65 }
    );
    expect(matrixHits[0]?.id).toBe(ids[0]);
  });

  it('recalls newly inserted memories immediately via in-memory LRU fallback before SQLite backfill', () => {
    clearRuntimeVectorCache();
    const res = upsertCandidate(db, {
      type: 'procedural',
      content: '排查 Kubernetes Pod OOMKilled 故障时先执行 kubectl describe pod 查看退出码 137',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: 's2', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    const id = (res as any).id;

    // Without calling backfillMissingEmbeddings, recallVector should still hit via getOrComputeEmbedding
    const plan = buildQueryPlan({
      userText: 'Kubernetes Pod OOMKilled kubectl describe pod 退出码 137',
    });
    const hits = recallVector(db, plan, { workspaceId: ws, sessionId: 's2' });
    expect(hits.some((h) => h.id === id)).toBe(true);

    // And getOrComputeEmbedding should return a cached Float32Array (both legacy and per-Db forms)
    const vec = getOrComputeEmbedding({
      id,
      content: '排查 Kubernetes Pod OOMKilled 故障时先执行 kubectl describe pod 查看退出码 137',
      embedding: null,
    });
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(DEFAULT_LOCAL_VECTOR_DIM);

    const vecWithDb = getOrComputeEmbedding(
      {
        id,
        content: '排查 Kubernetes Pod OOMKilled 故障时先执行 kubectl describe pod 查看退出码 137',
        embedding: null,
      },
      db
    );
    expect(vecWithDb).not.toBeNull();
    expect(cosineSimilarity(vec!, vecWithDb!)).toBeCloseTo(1.0, 6);
  });
});
