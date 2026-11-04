import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { MemoryTools } from '../../src/dsh/tools.js';
import { upsertCandidate } from '../../src/core/writer.js';

describe('Model-Visible Tools (tools.ts)', () => {
  let db: Db;
  let tools: MemoryTools;
  const ws1 = workspaceId('test-ws-tools');
  const sess1 = 'sess_tools_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
    tools = new MemoryTools({ db });
  });

  describe('memory_search', () => {
    it('should search memories and format output with [TAG id] summary (c=, u=)', () => {
      upsertCandidate(
        db,
        {
          type: 'procedural',
          content: 'Nginx 负载均衡配置与反向代理调优步骤',
          summary: 'Nginx 负载均衡配置',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );

      const res = tools.search(
        { query: 'Nginx 负载均衡' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );

      expect(res).toContain('[PROC m_');
      expect(res).toContain('Nginx 负载均衡配置');
      expect(res).toContain('c=0.90');

      // 验证写入了 layer='tool' 的 injections 记录
      const inj = db.get<{ layer: string }>(
        `SELECT layer FROM injections WHERE session_id = ? AND layer = 'tool'`,
        [sess1]
      );
      expect(inj?.layer).toBe('tool');
    });

    it('should return helpful message when no matches found', () => {
      const res = tools.search(
        { query: '量子纠缠计算机架构' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(res).toBe('No relevant memories found.');
    });
  });

  describe('memory_expand', () => {
    it('should expand memory with content and sources, supporting short codes', () => {
      const insertRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'PostgreSQL 生产环境集群采用 1 主 2 从流复制架构。',
          summary: 'PostgreSQL 集群架构',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.95,
          origin_kinds: ['user'],
          sources: [
            { session_id: 'sess_historical_12345', seq: 42, kind: 'user', excerpt: '采用 1 主 2 从架构' },
          ],
          actor: 'user',
        },
        fixedNow
      );
      const memId = (insertRes as any).id;
      const shortId = memId.slice(0, 6); // e.g. m_ab12

      // 完整 ID 展开
      const fullRes = tools.expand({ id: memId }, { workspaceId: ws1, sessionId: sess1 });
      expect(fullRes).toContain('PostgreSQL 生产环境集群');
      expect(fullRes).toContain('sess_his');
      expect(fullRes).toContain('seq 42');

      // 短码展开
      const shortRes = tools.expand({ id: shortId }, { workspaceId: ws1, sessionId: sess1 });
      expect(shortRes).toContain('PostgreSQL 生产环境集群');
    });

    it('should reject ambiguous short codes', () => {
      db.run(`INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES (
        'm_dup011111111111', 'semantic', 'active', '内容 1', '摘要 1', 'workspace', ?,
        '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 30, 15, 'hash1', 1, 1, 0, 1000, 1000
      )`, [ws1]);

      db.run(`INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES (
        'm_dup022222222222', 'semantic', 'active', '内容 2', '摘要 2', 'workspace', ?,
        '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 30, 15, 'hash2', 1, 1, 0, 1000, 1000
      )`, [ws1]);

      const res = tools.expand({ id: 'm_dup0' }, { workspaceId: ws1, sessionId: sess1 });
      expect(res).toContain('Error: Ambiguous short id');
    });
  });

  describe('memory_feedback', () => {
    it('should update utility when memory was referenced and contentRev matches', () => {
      const insertRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: 'Docker Compose 网络模式配置',
          summary: '网络配置',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      const memId = (insertRes as any).id;

      // 模拟本 session 的注入记录
      db.run(
        `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at)
         VALUES (?, 1, ?, 1, 'dynamic', 1, 30, 'content', 1, ?)`,
        [sess1, memId, fixedNow]
      );

      const res = tools.feedback(
        { id: memId, contentRev: 1, helpful: true, note: '非常有帮助' },
        { sessionId: sess1, turn: 1 }
      );
      expect(res).toBe('ok');

      // 验证 utility 得到提升，且 success_count 增加
      const mem = db.get<{ utility: number; success_count: number }>(
        'SELECT utility, success_count FROM memories WHERE id = ?',
        [memId]
      );
      expect(mem?.success_count).toBe(1);
      expect(mem?.utility).toBeGreaterThan(0.5);

      // 验证 injections 表中的 outcome 记入
      const inj = db.get<{ outcome: number; used: number }>(
        'SELECT outcome, used FROM injections WHERE session_id = ? AND memory_id = ?',
        [sess1, memId]
      );
      expect(inj?.outcome).toBe(1);
      expect(inj?.used).toBe(1);
    });

    it('should reject feedback if memory was not referenced in session or contentRev mismatches', () => {
      const res = tools.feedback(
        { id: 'm_nonexist0000001', contentRev: 1, helpful: true },
        { sessionId: sess1, turn: 1 }
      );
      expect(res).toContain('Error: memory');
    });
  });

  describe('memory_note', () => {
    it('should create candidate memory with status=candidate and limit to 3 calls per turn', () => {
      // 第 1 次调用
      const res1 = tools.note(
        { content: '用户提到希望在单元测试中使用 vitest', kind: 'preference' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(res1).toContain('saved as candidate m_');

      // 检查插入记录必须为 candidate 状态
      const candId = res1.replace('saved as candidate ', '').trim();
      const mem = db.get<{ status: string; source_kind: string }>(
        'SELECT status, source_kind FROM memories WHERE id = ?',
        [candId]
      );
      expect(mem?.status).toBe('candidate');
      expect(mem?.source_kind).toBe('assistant');

      // 第 2 次调用
      const res2 = tools.note(
        { content: '项目部署端口固定为 8080 端口', kind: 'fact' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(res2).toContain('saved as candidate m_');

      // 第 3 次调用
      const res3 = tools.note(
        { content: '构建流程需要先执行 npm run build', kind: 'procedure' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(res3).toContain('saved as candidate m_');

      // 第 4 次调用超限 (同一个 turn 最多 3 次)
      const res4 = tools.note(
        { content: '尝试第四次记录备忘内容', kind: 'fact' },
        { workspaceId: ws1, sessionId: sess1, turn: 1 }
      );
      expect(res4).toContain('Error: memory_note call limit reached');
    });
  });
});
