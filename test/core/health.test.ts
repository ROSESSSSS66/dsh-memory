import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { auditMemoryHealth } from '../../src/core/health.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { workspaceId } from '../../src/core/scope.js';

describe('Memory Health & Conflict Doctor (src/core/health.ts)', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-health');
  const now = 1762400000000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns A+ score on a clean, consistent memory database', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '后端 API 服务监听在 8080 端口',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const report = auditMemoryHealth(db, { workspaceId: ws, now });
    expect(report.score).toBeGreaterThanOrEqual(95);
    expect(report.grade).toBe('A+');
    expect(report.ftsConsistent).toBe(true);
    expect(report.duplicatePairs).toHaveLength(0);
    expect(report.contradictions).toHaveLength(0);
  });

  it('detects near-duplicate / shared slot_key pairs, contradictions, and stale memories', () => {
    const r1 = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '包管理器统一使用 pnpm 进行依赖安装与脚本执行',
        slot_key: 'pkg_manager',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const id1 = (r1 as any).id;

    // Insert a second active memory with normalized equivalent slot_key ('pkg-manager' vs 'pkg_manager') and high lexical overlap
    const r2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目包管理器统一使用 pnpm 进行依赖安装与构建脚本执行',
        slot_key: 'pkg-manager',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const id2 = (r2 as any).id;

    // Add an explicit contradiction relation and lower utility on id2
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [id1, id2, now]
    );
    db.run(`UPDATE memories SET utility = 0.25, created_at = ? WHERE id = ?`, [
      now - 10 * 86_400_000,
      id2,
    ]);

    const report = auditMemoryHealth(db, { workspaceId: ws, now });
    expect(report.duplicatePairs.length).toBeGreaterThanOrEqual(1);
    expect(report.duplicatePairs[0].reason).toBe('same_slot_key');
    expect(report.contradictions).toHaveLength(1);
    expect(report.staleMemories.some((s) => s.id === id2)).toBe(true);
    expect(report.score).toBeLessThan(95);
    expect(report.recommendations.length).toBeGreaterThanOrEqual(2);
  });
});
