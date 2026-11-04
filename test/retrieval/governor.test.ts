import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../../src/types.js';
import type { ScoredCandidate } from '../../src/retrieval/fuse.js';
import { govern } from '../../src/retrieval/governor.js';
import { render } from '../../src/retrieval/render.js';
import { budgetTokens } from '../../src/core/tokens.js';

function createScored(mem: Partial<MemoryRecord>, score = 0.8): ScoredCandidate {
  const fullMem: MemoryRecord = {
    id: 'm_' + Math.random().toString(36).slice(2, 18),
    type: 'semantic',
    status: 'active',
    content: '测试内容',
    summary: '测试摘要',
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
    success_count: 1,
    fail_count: 0,
    token_cost: 30,
    summary_cost: 15,
    hash: 'hash_' + Math.random().toString(36).slice(2, 10),
    version: 1,
    content_rev: 1,
    pinned: 0,
    valid_from: null,
    valid_to: null,
    created_at: 1000,
    updated_at: 1000,
    ...mem,
  };

  return {
    memory: fullMem,
    score,
    relevance: 1.0,
    fusedRrf: 0.05,
  };
}

describe('Token Governor (governor.ts)', () => {
  it('should filter out alreadyInjected id@content_rev and allow updated revisions (验收项 4)', () => {
    const cand = createScored({
      id: 'm_fixed000000001',
      content_rev: 1,
    });

    // 第一次调用：已注入列表中包含了 m_fixed000000001@1
    const res1 = govern([cand], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(['m_fixed000000001@1']),
    });
    // 不应重复返回旧版
    expect(res1.length).toBe(0);

    // 正文修改后 content_rev 递增为 2
    const candRev2 = createScored({
      id: 'm_fixed000000001',
      content_rev: 2,
    });
    const res2 = govern([candRev2], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(['m_fixed000000001@1']),
    });
    // 应该允许返回新版
    expect(res2.length).toBe(1);
    expect(res2[0].memory.content_rev).toBe(2);
  });

  it('should resolve slot conflicts and keep the newest valid record', () => {
    const candOld = createScored(
      {
        id: 'm_slot_old_00001',
        slot_key: 'project.database',
        content: '项目数据库是 MySQL 8',
        valid_from: 1000,
        updated_at: 1000,
      },
      0.9
    );

    const candNew = createScored(
      {
        id: 'm_slot_new_00002',
        slot_key: 'project.database',
        content: '项目数据库是 PostgreSQL 16',
        valid_from: 2000,
        updated_at: 2000,
      },
      0.85
    );

    const res = govern([candOld, candNew], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(),
    });

    expect(res.length).toBe(1);
    expect(res[0].memory.id).toBe(candNew.memory.id);
    expect(res[0].memory.content).toContain('PostgreSQL 16');
  });

  it('should deduplicate candidates with identical normalized content hash', () => {
    const cand1 = createScored(
      {
        id: 'm_dup1_000000001',
        hash: 'same_hash_123',
        content: '相同的配置内容',
      },
      0.7
    );

    const cand2 = createScored(
      {
        id: 'm_dup2_000000002',
        hash: 'same_hash_123',
        content: '相同的配置内容',
      },
      0.95
    );

    const res = govern([cand1, cand2], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(),
    });

    // 仅保留更高分的那一条
    expect(res.length).toBe(1);
    expect(res[0].memory.id).toBe(cand2.memory.id);
  });

  it('should degrade to summary when content does not fit budget', () => {
    // 构造一条长内容的记忆
    const longContent = '非常详细的配置说明：' + '长文本详细步骤内容。'.repeat(15);
    const shortSummary = '配置说明摘要';

    const cand = createScored(
      {
        id: 'm_long_000000001',
        content: longContent,
        summary: shortSummary,
        token_cost: budgetTokens(longContent),
        summary_cost: budgetTokens(shortSummary),
      },
      0.9
    );

    // 预算刚好放得下 summary 加上 XML 标签，但放不下 content
    const summaryRenderTokens = budgetTokens(
      render([{ memory: cand.memory, form: 'summary' }])
    );
    const contentRenderTokens = budgetTokens(
      render([{ memory: cand.memory, form: 'content' }])
    );

    expect(contentRenderTokens).toBeGreaterThan(summaryRenderTokens);

    const res = govern([cand], {
      budget: summaryRenderTokens + 10,
      maxItems: 6,
      alreadyInjected: new Set(),
    });

    expect(res.length).toBe(1);
    expect(res[0].form).toBe('summary');
  });

  it('should strictly guarantee actual budgetTokens <= budget (验收项 3)', () => {
    // 构造多条记忆
    const cands: ScoredCandidate[] = [];
    for (let i = 1; i <= 10; i++) {
      const content = `步骤 ${i}：执行详细的部署与优化检查，确保每个服务运行稳定并且正确监听指定端口。`;
      cands.push(
        createScored(
          {
            id: `m_budget_${String(i).padStart(8, '0')}`,
            content,
            summary: `步骤 ${i} 摘要`,
            token_cost: budgetTokens(content),
            summary_cost: 20,
          },
          1.0 - i * 0.05
        )
      );
    }

    const budget = 300;
    const res = govern(cands, {
      budget,
      maxItems: 10,
      alreadyInjected: new Set(),
    });

    const rendered = render(res.map((r) => ({ memory: r.memory, form: r.form })));
    const actualTokens = budgetTokens(rendered);

    // 验收项 3 要求：budget=300 时完整渲染 budgetTokens <= 300
    expect(actualTokens).toBeLessThanOrEqual(budget);
    if (res.length > 0) {
      expect(rendered).toContain('<memory_context');
    }
  });

  it('should return empty array if budget is too small to even fit block header', () => {
    const cand = createScored({ content: '简短事实' });
    const res = govern([cand], {
      budget: 20, // 20 字节甚至放不下 <memory_context> 标签
      maxItems: 6,
      alreadyInjected: new Set(),
    });

    expect(res).toEqual([]);
    const rendered = render(res.map((r) => ({ memory: r.memory, form: r.form })));
    expect(rendered).toBe('');
  });
});
