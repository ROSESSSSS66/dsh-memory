import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  afterEach(() => {
    db.close();
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

  it('v0.5.0 Zep/Graphiti canonical slot inference reconciles database evolution without explicit slot_key', () => {
    const first: CandidateInput = {
      type: 'semantic',
      content: '项目数据库使用 MySQL 8.0',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
      actor: 'user',
    };
    const r1 = reconcileAndUpsert(db, first, now);
    expect(r1.action).toBe('inserted');

    const second: CandidateInput = {
      type: 'semantic',
      content: '项目数据库已迁移到 PostgreSQL 16',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
      actor: 'user',
    };
    const r2 = reconcileAndUpsert(db, second, now + 5000);
    expect(r2.decision.action).toBe('UPDATE');
    expect(r2.action).toBe('superseded');
    expect(second.slot_key).toBeUndefined(); // MUST NOT mutate candidate.slot_key in place
  });

  it('requires minimum similarity alongside shared entity and enforces owner/pinned/savepoint/taint guards', () => {
    const existingRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '部署流水线在 GitHub Actions 里检查 package.json 的脚本并打包前端资源。',
        scope: 'workspace',
        workspaceId: ws1,
        sessionId: sess1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const existingId = (existingRes as any).id;

    // Only shares 'package.json' entity with very low overall similarity -> must ADD, NOT UPDATE/DELETE!
    const lowSimNegation: CandidateInput = {
      type: 'semantic',
      content: '不再使用旧的 eslint 规则检查 package.json 版本号字段。',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
      actor: 'user',
    };
    const dec = reconcileCandidate(db, lowSimNegation);
    expect(dec.action).toBe('ADD');

    // NOOP without targetId returns rejected instead of fake 'noop_duplicate'
    const noopRes = applyReconciliation(
      db,
      lowSimNegation,
      { action: 'NOOP', reason: 'empty_content', confidence: 1.0 },
      now
    );
    expect(noopRes).toMatchObject({ action: 'rejected' });

    // Pinned memory cannot be deleted or updated by reconciliation
    db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [existingId]);
    const pinnedDel = applyReconciliation(
      db,
      lowSimNegation,
      { action: 'DELETE', targetId: existingId, reason: 'slot_negated', confidence: 0.95 },
      now + 100
    );
    expect(pinnedDel).toEqual({ action: 'rejected', reason: 'target_is_pinned' });
    db.run('UPDATE memories SET pinned = 0 WHERE id = ?', [existingId]);

    // Untrusted source kind inside sources[] demotes UPDATE to conflict_pending
    const taintedUpdate: CandidateInput = {
      type: 'semantic',
      content: '部署流水线已迁移到 GitLab CI 检查 package.json。',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 3, kind: 'tool_result', excerpt: 'gitlab ci' }],
      actor: 'user',
    };
    const taintedRes = applyReconciliation(
      db,
      taintedUpdate,
      { action: 'UPDATE', targetId: existingId, reason: 'semantic_evolution_detected', confidence: 0.85 },
      now + 200
    );
    expect(taintedRes.action).toBe('conflict_pending');
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [existingId])?.status).toBe('active');

    // Nested SAVEPOINT rollback: if upsertCandidate rejects (e.g. sensitive content), oldMem AND memory_versions are fully reverted
    const versionsBefore = db.all('SELECT * FROM memory_versions WHERE memory_id = ?', [existingId]);
    const badUpdate: CandidateInput = {
      type: 'semantic',
      content: '部署密钥为 sk-abcdefghijklmnopqrstuvwxyz123456',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.9,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 4, kind: 'user' }],
      actor: 'user',
    };
    const badRes = applyReconciliation(
      db,
      badUpdate,
      { action: 'UPDATE', targetId: existingId, reason: 'semantic_evolution_detected', confidence: 0.85 },
      now + 300
    );
    expect(badRes).toEqual({ action: 'rejected', reason: 'sensitive_content_detected' });
    expect(db.get<MemoryRecord>('SELECT status FROM memories WHERE id = ?', [existingId])?.status).toBe('active');
    expect(db.all('SELECT * FROM memory_versions WHERE memory_id = ?', [existingId])).toEqual(versionsBefore);
  });

  it('uses FTS/entity retrieval to reconcile against memories beyond the latest 40 rows', () => {
    const targetRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '网关鉴权服务使用 Keycloak 24 进行 OIDC 登录验证。',
        scope: 'workspace',
        workspaceId: ws1,
        sessionId: sess1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const targetId = (targetRes as any).id;

    // Insert 45 newer unrelated memories so targetId is pushed past LIMIT 40
    for (let i = 1; i <= 45; i++) {
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: `不相关的业务模块记录编号 ${i} 使用独立队列 worker-${i}。`,
          scope: 'workspace',
          workspaceId: ws1,
          sessionId: sess1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 10 + i, kind: 'user' }],
          actor: 'user',
        },
        now + i * 1000
      );
    }

    const evolved: CandidateInput = {
      type: 'semantic',
      content: '网关鉴权服务已升级到 Keycloak 26 进行 OIDC 登录验证。',
      scope: 'workspace',
      workspaceId: ws1,
      sessionId: sess1,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: sess1, seq: 100, kind: 'user' }],
      actor: 'user',
    };
    const dec = reconcileCandidate(db, evolved);
    expect(dec.action).toBe('UPDATE');
    expect(dec.targetId).toBe(targetId);

    const applied = applyReconciliation(db, evolved, dec, now + 60000);
    expect(applied.action).toBe('superseded');
    const oldRow = db.get<MemoryRecord>('SELECT status, invalidated_at FROM memories WHERE id = ?', [targetId]);
    expect(oldRow?.status).toBe('superseded');
    expect(oldRow?.invalidated_at).toBe(now + 60000);
  });
});
