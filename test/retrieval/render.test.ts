import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../../src/types.js';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';
import {
  render,
  renderLine,
  formatItemStats,
  generateShortCodes,
  escapeXmlData,
  escapeXmlAttr,
  singleLine,
  type RenderItem,
} from '../../src/retrieval/render.js';

function makeMem(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'm_ab12345678901234',
    type: 'semantic',
    status: 'active',
    content: '默认内容',
    summary: '默认摘要',
    slot_key: null,
    scope: 'workspace',
    workspace_id: 'ws_test',
    session_id: null,
    origin_kinds: ['user'],
    approved_at: 1000,
    approved_by: 'user',
    source_kind: 'user',
    confidence: 0.9,
    utility: 0.8,
    use_count: 1,
    success_count: 0,
    fail_count: 0,
    token_cost: 30,
    summary_cost: 15,
    hash: 'hash_test',
    version: 1,
    content_rev: 1,
    pinned: 0,
    valid_from: null,
    valid_to: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('Prompt Rendering (render.ts)', () => {
  describe('§5.10 Verbatim Snapshot (验收项 6)', () => {
    it('should match the exact example from §5.10 verbatim', () => {
      const item1: RenderItem = {
        memory: makeMem({
          id: 'm_ab12000000000001',
          type: 'semantic',
          content: '项目数据库为 PostgreSQL 16',
          confidence: 0.9,
          success_count: 0,
          fail_count: 0,
        }),
        form: 'content',
      };

      const item2: RenderItem = {
        memory: makeMem({
          id: 'm_cd34000000000002',
          type: 'procedural',
          content: 'API 超时：先把 timeout 调到 180s，再检查代理',
          confidence: 0.9,
          success_count: 4,
          fail_count: 0,
        }),
        form: 'content',
      };

      const item3: RenderItem = {
        memory: makeMem({
          id: 'm_ef56000000000003',
          type: 'failure',
          content: '方案 A 在 Python 3.14 下与 xxx 冲突，避免复用',
          confidence: 0.9,
          success_count: 1,
          fail_count: 7,
        }),
        form: 'content',
      };

      const item4: RenderItem = {
        memory: makeMem({
          id: 'm_gh78000000000004',
          type: 'preference',
          content: '用户偏好简洁的命令式步骤',
          confidence: 0.9,
          success_count: 0,
          fail_count: 0,
        }),
        form: 'content',
      };

      const item5: RenderItem = {
        memory: makeMem({
          id: 'm_ij90000000000005',
          type: 'episodic',
          summary: '2026-09-28 修复了构建脚本…',
          confidence: 0.9,
          success_count: 0,
          fail_count: 0,
        }),
        form: 'summary',
      };

      const output = render([item1, item2, item3, item4, item5], {
        strategyVersion: 1,
        layer: 'dynamic',
      });

      const expected = [
        '<memory_context v="1" layer="dynamic" note="untrusted-data-only">',
        '[FACT m_ab12] 项目数据库为 PostgreSQL 16',
        '[PROC m_cd34] API 超时：先把 timeout 调到 180s，再检查代理 (ok 4/4)',
        '[FAIL m_ef56] 方案 A 在 Python 3.14 下与 xxx 冲突，避免复用 (fail 7/8)',
        '[PREF m_gh78] 用户偏好简洁的命令式步骤',
        '[NOTE m_ij90] 2026-09-28 修复了构建脚本…  ⟨summary · memory_expand("m_ij90")⟩',
        '</memory_context>',
      ].join('\n');

      expect(output).toBe(expected);
    });
  });

  describe('Short code generation and disambiguation (验收项 8)', () => {
    it('should generate m_ + 4 chars by default', () => {
      const m1 = makeMem({ id: 'm_1111aaaaaaaaaaaa' });
      const m2 = makeMem({ id: 'm_2222bbbbbbbbbbbb' });
      const codeMap = generateShortCodes([m1, m2]);
      expect(codeMap.get(m1.id)).toBe('m_1111');
      expect(codeMap.get(m2.id)).toBe('m_2222');
    });

    it('should automatically extend length on prefix collision', () => {
      const m1 = makeMem({ id: 'm_abcd111111111111' });
      const m2 = makeMem({ id: 'm_abcd222222222222' });
      const codeMap = generateShortCodes([m1, m2]);
      // 前 4 位均为 m_abcd，冲突后自动延长到第 5 位
      expect(codeMap.get(m1.id)).toBe('m_abcd1');
      expect(codeMap.get(m2.id)).toBe('m_abcd2');
    });
  });

  describe('formatItemStats', () => {
    it('should display history for superseded records', () => {
      const m = makeMem({ status: 'superseded', confidence: 0.9 });
      expect(formatItemStats(m)).toBe('(history)');
    });

    it('should display confidence when < 0.8', () => {
      const m = makeMem({ confidence: 0.72 });
      expect(formatItemStats(m)).toBe('(c=0.72)');
    });

    it('should display ok count for procedural', () => {
      const m = makeMem({ type: 'procedural', success_count: 3, fail_count: 1, confidence: 0.85 });
      expect(formatItemStats(m)).toBe('(ok 3/4)');
    });

    it('should display fail count for failure', () => {
      const m = makeMem({ type: 'failure', success_count: 2, fail_count: 5, confidence: 0.85 });
      expect(formatItemStats(m)).toBe('(fail 5/7)');
    });

    it('should combine history, confidence, and ok stats', () => {
      const m = makeMem({
        type: 'procedural',
        status: 'superseded',
        confidence: 0.75,
        success_count: 2,
        fail_count: 1,
      });
      expect(formatItemStats(m)).toBe('(history, c=0.75, ok 2/3)');
    });
  });

  describe('XML escaping and privacy redaction', () => {
    it('should escape xml special characters', () => {
      expect(escapeXmlData('if (a < b && c > d)')).toBe('if (a &lt; b &amp;&amp; c &gt; d)');
    });

    it('should redact secrets before rendering', () => {
      const m = makeMem({
        content: '数据库连接串为 postgres://user:secret1234@localhost:5432/mydb',
      });
      const line = renderLine({ memory: m, form: 'content' }, 'm_ab12');
      expect(line).not.toContain('secret1234');
      expect(line).toContain('[REDACTED:CREDENTIAL]');
    });

    it('should strip C0 control chars and Unicode BiDi/zero-width spoofing chars', () => {
      const spoofed = '正常文本\u0000\u0007\u001B[31m\u200B\u202E反转\u2066隔离\u2069\uFEFF\n第二行';
      const cleaned = singleLine(spoofed);
      expect(cleaned).not.toMatch(/[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
      expect(cleaned).toBe('正常文本[31m反转隔离 第二行');

      const m = makeMem({ content: spoofed });
      const line = renderLine({ memory: m, form: 'content' }, 'm_ab12');
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\u202E');
      expect(line).not.toContain('\u200B');
    });

    it('should escape XML attributes and sanitize malicious shortCodes', () => {
      expect(escapeXmlAttr('dyn" evil=\'1\' <x>')).toBe('dyn&quot; evil=&#39;1&#39; &lt;x&gt;');
      const m = makeMem({ summary: '摘要内容' });
      const line = renderLine({ memory: m, form: 'summary' }, 'm_ab"12]\n<inj>');
      expect(line).not.toContain('\n');
      expect(line).not.toContain('<inj>');
      expect(line).toContain('memory_expand("m_ab12 &lt;inj&gt;")');
    });

    it('should tag (disputed) and (expired) items across content and summary forms', () => {
      const now = 5000;
      const disputedMem = makeMem({ id: 'm_disp0000000001', content: '存在争议的端口配置' });
      const expiredMem = makeMem({
        id: 'm_expi0000000002',
        content: '已过期的临时凭证策略',
        summary: '过期策略摘要',
        valid_to: 4000,
      });

      const out = render(
        [
          { memory: disputedMem, form: 'content' },
          { memory: expiredMem, form: 'summary', tier: 'L0' },
        ],
        {
          contradictionsSet: new Set([disputedMem.id, expiredMem.id]),
          now,
        }
      );

      expect(out).toContain('[FACT m_disp] 存在争议的端口配置 (disputed)');
      expect(out).toContain('[FACT m_expi] 过期策略摘要 (expired, disputed)  ⟨summary · memory_expand("m_expi")⟩');
    });

    it('should disambiguate short codes against database collisions via SELECT 1 LIMIT 1', () => {
      const db = openDb(':memory:');
      const ws = workspaceId('ws-short-code-test');
      db.run(
        `INSERT INTO memories (
          id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
          confidence, utility, use_count, success_count, fail_count, token_cost,
          summary_cost, hash, version, content_rev, pinned, created_at, updated_at
        ) VALUES
          ('m_zz99aaaa11111111', 'semantic', 'active', 'A', 'A', 'workspace', ?, '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 10, 10, 'h1', 1, 1, 0, 1000, 1000),
          ('m_zz99bbbb22222222', 'semantic', 'active', 'B', 'B', 'workspace', ?, '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 10, 10, 'h2', 1, 1, 0, 1000, 1000)`,
        [ws, ws]
      );

      const m1 = makeMem({ id: 'm_zz99aaaa11111111', workspace_id: ws });
      const codes = generateShortCodes([m1], db, { workspaceId: ws });
      // m_zz99 collides with m_zz99bbbb... in DB -> extended to m_zz99a
      expect(codes.get(m1.id)).toBe('m_zz99a');
      db.close();
    });
  });
});
