import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import {
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  decodeEmbeddingBlob,
  cosineSimilarity,
  backfillMissingEmbeddings,
  DEFAULT_LOCAL_VECTOR_DIM,
} from '../../src/core/vector.js';
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

  it('computes deterministic L2-normalized embeddings and round-trips BLOB encoding', () => {
    const v1 = computeLocalEmbedding('数据库连接池配置在 src/core/db.ts，默认超时 30s');
    const v2 = computeLocalEmbedding('数据库连接池配置在 src/core/db.ts，默认超时 30s');
    const vUnrelated = computeLocalEmbedding('前端 Glassmorphism 毛玻璃暗色主题切换组件');

    expect(v1.length).toBe(DEFAULT_LOCAL_VECTOR_DIM);
    expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0, 5);
    expect(cosineSimilarity(v1, vUnrelated)).toBeLessThan(0.35);

    const blob = encodeEmbeddingBlob(v1);
    const decoded = decodeEmbeddingBlob(blob, DEFAULT_LOCAL_VECTOR_DIM);
    expect(decoded).not.toBeNull();
    expect(cosineSimilarity(v1, decoded!)).toBeCloseTo(1.0, 5);
  });

  it('backfills missing embeddings and retrieves candidates via recallVector', () => {
    const res1 = upsertCandidate(db, {
      type: 'semantic',
      content: '项目 PostgreSQL 生产库连接池配置位于 src/core/db.ts，最大连接数 50',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      actor: 'user',
    });
    expect(res1.action).toBe('inserted');

    upsertCandidate(db, {
      type: 'preference',
      content: '前端组件统一使用 TypeScript 严格模式与 2 空格缩进',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
      actor: 'user',
    });

    // Backfill embeddings
    const updated = backfillMissingEmbeddings(db, { workspaceId: ws });
    expect(updated).toBe(2);

    const plan = buildQueryPlan({
      userText: 'PostgreSQL 生产库连接池 src/core/db.ts 最大连接数',
    });
    const hits = recallVector(db, plan, { workspaceId: ws, sessionId: 's1' });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].id).toBe((res1 as any).id);
    expect(hits[0].channel).toBe('vector');
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.65);
  });
});
