import { describe, it, expect } from 'vitest';
import type { MemoryRecord } from '../../src/types.js';
import type { ScoredCandidate } from '../../src/retrieval/fuse.js';
import {
  govern,
  governWithResult,
  computeMmrMarginalScore,
} from '../../src/retrieval/governor.js';
import { render } from '../../src/retrieval/render.js';
import { budgetTokens } from '../../src/core/tokens.js';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';

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

  it('v0.5.0 LightMem Submodular MMR prioritizes diverse candidates over near-duplicate paraphrases', () => {
    expect(computeMmrMarginalScore(0.02, 0.3)).toBe(0.02);
    expect(computeMmrMarginalScore(0.02, 0.85)).toBeLessThan(0.02);

    const anchor = createScored(
      {
        id: 'm_mmr_anchor_001',
        hash: 'h_anchor',
        content: '项目核心关系型数据库使用 PostgreSQL 16 服务实例并启用连接池',
        summary: '项目核心关系型数据库使用 PostgreSQL 16 服务实例并启用连接池',
        token_cost: 30,
      },
      0.92
    );
    const redundant = createScored(
      {
        id: 'm_mmr_redund_002',
        hash: 'h_redund',
        content: '项目核心关系型数据库使用 PostgreSQL 16 服务实例且启用连接池',
        summary: '项目核心关系型数据库使用 PostgreSQL 16 服务实例且启用连接池',
        token_cost: 30,
      },
      0.88
    );
    const orthogonal = createScored(
      {
        id: 'm_mmr_ortho_0003',
        hash: 'h_ortho',
        content: '异步消息队列缓存集群采用 Redis 7 与 BullMQ 调度器',
        summary: '异步消息队列缓存集群采用 Redis 7 与 BullMQ 调度器',
        token_cost: 30,
      },
      0.82
    );

    const res = govern([anchor, redundant, orthogonal], {
      budget: 1000,
      maxItems: 2,
      alreadyInjected: new Set(),
    });

    expect(res.map((r) => r.memory.id)).toEqual(['m_mmr_anchor_001', 'm_mmr_ortho_0003']);
  });

  it('governWithResult returns renderedBlock, totalTokens, droppedReasons and bypasses slot collapse in temporalBrowse', () => {
    const oldSlot = createScored(
      {
        id: 'm_tb_old_0000001',
        status: 'superseded',
        slot_key: 'project.database',
        content: '旧版数据库使用 MySQL 8',
        summary: '旧版 MySQL 8',
        valid_from: 1000,
        updated_at: 1000,
      },
      0.85
    );
    const newSlot = createScored(
      {
        id: 'm_tb_new_0000002',
        status: 'active',
        slot_key: 'project.database',
        content: '新版数据库迁移至 PostgreSQL 16',
        summary: '新版 PostgreSQL 16',
        valid_from: 2000,
        updated_at: 2000,
      },
      0.92
    );

    // Normal mode collapses slot -> drops oldSlot
    const normalRes = governWithResult([oldSlot, newSlot], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(),
      temporalBrowse: false,
    });
    expect(normalRes.items).toHaveLength(1);
    expect(normalRes.droppedReasons[oldSlot.memory.id]).toBe('slot_superseded');
    expect(normalRes.renderedBlock).toContain('PostgreSQL 16');
    expect(normalRes.totalTokens).toBe(budgetTokens(normalRes.renderedBlock));

    // temporalBrowse mode preserves BOTH historical superseded and active records!
    const browseRes = governWithResult([oldSlot, newSlot], {
      budget: 1000,
      maxItems: 6,
      alreadyInjected: new Set(),
      temporalBrowse: true,
    });
    expect(browseRes.items).toHaveLength(2);
    expect(browseRes.renderedBlock).toContain('(history)');
    expect(browseRes.renderedBlock).toContain('MySQL 8');
    expect(browseRes.renderedBlock).toContain('PostgreSQL 16');
  });

  it('Step 6 downgrades L2 -> L1 -> L0 before popping when DB short-code expansion pushes block over budget', () => {
    const db = openDb(':memory:');
    const ws = workspaceId('ws-gov-step6');
    // Insert colliding IDs sharing the first 12 chars so DB disambiguation expands m_coll -> m_coll11111111a
    const idTarget = 'm_coll11111111aa';
    const idOther = 'm_coll11111111bb';
    const longContent =
      '生产集群灰度发布操作规程：第一步核验 Prometheus 告警零触发与错误率低于 0.1%；第二步将 Canary 流量切换至 10% 并持续监控 P99 延迟十五分钟；第三步执行全链路自动化冒烟回归验证核心支付接口；第四步逐步放通全量流量并清理历史镜像。';
    const shortSummary = '生产灰度发布四步规程';

    db.run(
      `INSERT INTO memories (
        id, type, status, content, summary, slot_key, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES
        (?, 'procedural', 'active', ?, ?, 'ops.canary', 'workspace', ?, '["user"]', 'user', 0.95, 0.9, 1, 0, 0, 120, 20, 'h_t', 1, 1, 0, 1000, 1000),
        (?, 'semantic', 'active', '干扰碰撞记录', '碰撞', NULL, 'workspace', ?, '["user"]', 'user', 0.5, 0.5, 1, 0, 0, 10, 10, 'h_o', 1, 1, 0, 1000, 1000)`,
      [idTarget, longContent, shortSummary, ws, idOther, ws]
    );

    const cand = createScored(
      {
        id: idTarget,
        type: 'procedural',
        content: longContent,
        summary: shortSummary,
        slot_key: 'ops.canary',
        workspace_id: ws,
        token_cost: budgetTokens(longContent),
        summary_cost: budgetTokens(shortSummary),
      },
      0.95
    );

    // Pick a budget that fits L2 with short 4-char code (m_coll) but overflows once DB expands to m_coll11111111a
    const l2ShortBudget = budgetTokens(render([{ memory: cand.memory, form: 'content', tier: 'L2' }]));
    const l2LongBudget = budgetTokens(
      render([{ memory: cand.memory, form: 'content', tier: 'L2' }], {
        db,
        scopeCtx: { workspaceId: ws },
      })
    );
    expect(l2LongBudget).toBeGreaterThan(l2ShortBudget);

    const res = governWithResult([cand], {
      budget: l2ShortBudget,
      maxItems: 4,
      alreadyInjected: new Set(),
      db,
      scopeCtx: { workspaceId: ws },
    });

    // Must downgrade to L1 or L0 instead of popping to empty!
    expect(res.items).toHaveLength(1);
    expect(res.items[0].form).toBe('summary');
    expect(['L1', 'L0']).toContain(res.items[0].tier);
    expect(res.totalTokens).toBeLessThanOrEqual(l2ShortBudget);
    db.close();
  });
});
