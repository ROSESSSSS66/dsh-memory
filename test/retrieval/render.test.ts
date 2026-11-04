import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../../src/types.js';
import {
  render,
  renderLine,
  formatItemStats,
  generateShortCodes,
  escapeXmlData,
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
        '<memory_context v="1" layer="dynamic">',
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
  });
});
