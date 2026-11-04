import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { upsertCandidate, editContent } from '../../src/core/writer.js';
import { get, list, history, sources, stats } from '../../src/core/store.js';

describe('M1-T4: store.ts Read Queries Tests', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should get record by full id and short id', () => {
    const res = upsertCandidate(db, {
      type: 'semantic',
      content: '测试获取功能',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const fullId = (res as any).id;
    const shortId = fullId.slice(0, 6);

    const byFull = get(db, fullId);
    expect(byFull?.id).toBe(fullId);

    const byShort = get(db, shortId);
    expect(byShort?.id).toBe(fullId);

    const notFound = get(db, 'm_nonexistent');
    expect(notFound).toBeUndefined();
  });

  it('should list records with various filters', () => {
    upsertCandidate(db, {
      type: 'semantic',
      content: '语义记忆1',
      scope: 'workspace',
      workspaceId: 'C:/ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });

    upsertCandidate(db, {
      type: 'preference',
      content: '用户偏好1',
      scope: 'user',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
      actor: 'user',
    });

    const semList = list(db, { type: 'semantic' });
    expect(semList).toHaveLength(1);

    const prefList = list(db, { type: 'preference' });
    expect(prefList).toHaveLength(1);

    const allList = list(db, { limit: 10 });
    expect(allList).toHaveLength(2);
  });

  it('should retrieve version history and sources', () => {
    const res = upsertCandidate(db, {
      type: 'procedural',
      content: '初始部署流程步骤',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [
        { session_id: 'sess_hist_1', seq: 10, kind: 'user_msg', excerpt: '最初说明' },
      ],
      actor: 'user',
    });
    const id = (res as any).id;

    editContent(db, id, '修改后的部署流程步骤 V2');

    const hist = history(db, id);
    expect(hist).toHaveLength(1); // 1 snapshot created before edit
    expect(hist[0].version).toBe(1);
    expect(hist[0].snapshot.content).toBe('初始部署流程步骤');

    const srcs = sources(db, id);
    expect(srcs).toHaveLength(1);
    expect(srcs[0].session_id).toBe('sess_hist_1');
    expect(srcs[0].excerpt).toBe('最初说明');
  });

  it('should compute aggregated stats properly', () => {
    upsertCandidate(db, {
      type: 'semantic',
      content: '事实 1',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    upsertCandidate(db, {
      type: 'failure',
      content: '失败排查 1',
      source_kind: 'assistant',
      confidence: 0.4,
      origin_kinds: ['assistant'],
      sources: [{ session_id: 's1', seq: 2, kind: 'assistant_msg' }],
      actor: 'llm',
    });

    const st = stats(db);
    expect(st.total).toBe(2);
    expect(st.byType['semantic']).toBe(1);
    expect(st.byType['failure']).toBe(1);
    expect(st.byStatus['active']).toBe(1);
    expect(st.byStatus['candidate']).toBe(1);
    expect(st.avgConfidence).toBeCloseTo(0.61);
  });
});
