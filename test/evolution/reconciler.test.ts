import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, CandidateInput, MemoryRecord } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { reconcileCandidate, applyReconciliation, reconcileAndUpsert } from '../../src/evolution/reconciler.js';
import { upsertCandidate } from '../../src/core/writer.js';

describe('Mem0-Inspired Memory Reconciler (reconciler.ts)', () => {
  let db: Db;
  const ws1 = workspaceId('test-ws-reconcile');
  const sess1 = 'sess_rec_001';
  const now = 1000000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('Action ADD: should recognize orthogonal novel knowledge', () => {
    const candidate: CandidateInput = {
      type: 'semantic',
      content: '前端构建采用 Vite 5 作为打包工具',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };

    const decision = reconcileCandidate(db, candidate);
    expect(decision.action).toBe('ADD');

    const res = applyReconciliation(db, candidate, decision, now);
    expect(res.action).toBe('inserted');
  });

  it('Action NOOP: should identify near-duplicate knowledge and avoid token bloating', () => {
    const candidate1: CandidateInput = {
      type: 'semantic',
      content: '前端构建采用 Vite 5 作为打包工具',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };
    upsertCandidate(db, candidate1, now);

    // 几乎一模一样的表述
    const candidate2: CandidateInput = {
      ...candidate1,
      content: '前端构建采用 Vite 5 作为打包工具。',
    };

    const decision = reconcileCandidate(db, candidate2);
    expect(decision.action).toBe('NOOP');
    expect(decision.reason).toMatch(/subsumed|identical/);
  });

  it('Action UPDATE: should detect evolution and upgrade memory (supersede)', () => {
    const candidate1: CandidateInput = {
      type: 'semantic',
      content: '项目当前使用 Node 18 运行时',
      slot_key: 'project.node_version',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };
    const res1 = upsertCandidate(db, candidate1, now);
    const id1 = (res1 as any).id;

    // 升级更迭
    const candidate2: CandidateInput = {
      type: 'semantic',
      content: '项目已升级到 Node 22 运行时',
      slot_key: 'project.node_version',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
      actor: 'user',
    };

    const decision = reconcileCandidate(db, candidate2);
    expect(decision.action).toBe('UPDATE');
    expect(decision.targetId).toBe(id1);

    const res2 = applyReconciliation(db, candidate2, decision, now + 1000);
    expect(res2.action).toBe('superseded');

    // 校验旧记录置为 superseded
    const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1]);
    expect(oldMem?.status).toBe('superseded');
    expect(oldMem?.valid_to).toBe(now + 1000);

    // 校验 supersedes 关系
    const rel = db.get<{ rel: string }>('SELECT * FROM memory_relations WHERE to_id = ?', [id1]);
    expect(rel?.rel).toBe('supersedes');
  });

  it('Action DELETE: should detect explicit negation / deprecation', () => {
    const candidate1: CandidateInput = {
      type: 'semantic',
      content: '测试框架使用 Jest',
      slot_key: 'test.framework',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };
    const res1 = upsertCandidate(db, candidate1, now);
    const id1 = (res1 as any).id;

    // 显式废弃
    const candidate2: CandidateInput = {
      type: 'semantic',
      content: '废弃 Jest 测试框架，不再使用',
      slot_key: 'test.framework',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
      actor: 'user',
    };

    const decision = reconcileCandidate(db, candidate2);
    expect(decision.action).toBe('DELETE');
    expect(decision.targetId).toBe(id1);

    applyReconciliation(db, candidate2, decision, now + 2000);
    const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1]);
    expect(oldMem?.status).toBe('archived');
    expect(oldMem?.invalidated_at).toBe(now + 2000);
  });

  it('reconcileAndUpsert convenience method', () => {
    const candidate: CandidateInput = {
      type: 'semantic',
      content: '采用 Turborepo 管理 monorepo',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };

    const res = reconcileAndUpsert(db, candidate, now);
    expect(res.decision.action).toBe('ADD');
    expect(res.action).toBe('inserted');
  });
});
