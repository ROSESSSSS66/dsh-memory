import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { upsertCandidate, editContent } from '../../src/core/writer.js';
import { get, list, history, sources, stats } from '../../src/core/store.js';
import { workspaceId } from '../../src/core/scope.js';

describe('M1-T4: store.ts Read Queries Tests', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
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

  it('should hydrate origin_kinds, support non-m_ IDs, cap ambiguous prefix matches, and isolate session scope in list/stats', () => {
    const ws = workspaceId('C:/ws-store-iso');
    const wsRes = upsertCandidate(db, {
      type: 'semantic',
      content: '工作区共享记忆',
      scope: 'workspace',
      workspaceId: ws,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 'sess_1', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });
    const sess1Res = upsertCandidate(db, {
      type: 'episodic',
      content: '会话 1 私有记忆',
      scope: 'session',
      workspaceId: ws,
      sessionId: 'sess_1',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 'sess_1', seq: 2, kind: 'user_msg' }],
      actor: 'user',
    });
    const sess2Res = upsertCandidate(db, {
      type: 'episodic',
      content: '会话 2 私有记忆',
      scope: 'session',
      workspaceId: ws,
      sessionId: 'sess_2',
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: 'sess_2', seq: 1, kind: 'user_msg' }],
      actor: 'user',
    });

    const wsMem = get(db, (wsRes as any).id)!;
    expect(wsMem.origin_kinds).toEqual(['user']);
    expect(wsMem.embedding).toBeUndefined();

    // Non-m_ custom ID lookup (exact + prefix)
    db.run(
      `INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost, summary_cost,
        hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES ('custom_legacy_999', 'semantic', 'active', '自定义ID记录', '自定义', 'workspace', ?, '["system"]', 'system', 0.8, 0.5, 0, 0, 0, 5, 2, 'hcustom', 1, 1, 0, 1, 1)`,
      [ws]
    );
    expect(get(db, 'custom_legacy_999')?.origin_kinds).toEqual(['system']);
    expect(get(db, 'custom_leg')?.id).toBe('custom_legacy_999');

    // list() without sessionId must exclude ALL scope='session' rows
    const listNoSess = list(db, { workspaceId: ws });
    const idsNoSess = listNoSess.map((m) => m.id);
    expect(idsNoSess).toContain((wsRes as any).id);
    expect(idsNoSess).toContain('custom_legacy_999');
    expect(idsNoSess).not.toContain((sess1Res as any).id);
    expect(idsNoSess).not.toContain((sess2Res as any).id);
    expect(listNoSess.every((m) => Array.isArray(m.origin_kinds) && m.embedding === undefined)).toBe(true);

    // list() with sessionId includes ONLY own session rows
    const listSess1 = list(db, { workspaceId: ws, sessionId: 'sess_1' });
    expect(listSess1.map((m) => m.id)).toContain((sess1Res as any).id);
    expect(listSess1.map((m) => m.id)).not.toContain((sess2Res as any).id);

    // list() supports offset without limit
    const allUnscoped = list(db);
    const offsetOnly = list(db, { offset: 2 });
    expect(offsetOnly).toHaveLength(allUnscoped.length - 2);

    // stats() excludes session rows when workspaceId provided without sessionId
    const stNoSess = stats(db, ws);
    expect(stNoSess.total).toBe(2);
    const stSess1 = stats(db, ws, 'sess_1');
    expect(stSess1.total).toBe(3);

    // Ambiguous short id prefix is bounded to LIMIT 6 matches
    for (let i = 0; i < 8; i++) {
      db.run(
        `INSERT INTO memories (
          id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
          confidence, utility, use_count, success_count, fail_count, token_cost, summary_cost,
          hash, version, content_rev, pinned, created_at, updated_at
        ) VALUES (?, 'semantic', 'active', 'amb', 'amb', 'workspace', ?, '["user"]', 'user', 0.8, 0.5, 0, 0, 0, 5, 2, ?, 1, 1, 0, 1, 1)`,
        [`m_captest_${i}000000`, ws, `hcap_${i}`]
      );
    }
    try {
      get(db, 'm_captest_');
      expect.unreachable('should throw ambiguous short id');
    } catch (err: any) {
      const listedIds = String(err.message).split('matches: ')[1].split(', ');
      expect(listedIds).toHaveLength(6);
    }
  });
});
