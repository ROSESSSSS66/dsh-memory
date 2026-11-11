import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { renderStableLayer, PromptSectionManager } from '../../src/dsh/prompt-section.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { budgetTokens } from '../../src/core/tokens.js';
import { DEFAULTS } from '../../src/config.js';

describe('Prompt Section (prompt-section.ts)', () => {
  let db: Db;
  const ws1 = workspaceId('test-ws-stable-1');
  const ws2 = workspaceId('test-ws-stable-2');
  const sess1 = 'sess_stable_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('keeps 500 pinned records within the online latency budget and preserves highest utility', () => {
    for (let i = 0; i < 500; i++) {
      const result = upsertCandidate(db, {
        type: 'semantic', content: `Pinned architecture rule ${i}: validate each release.`,
        scope: 'workspace', workspaceId: ws1, source_kind: 'user', actor: 'user',
        origin_kinds: ['user'], confidence: 0.9,
        sources: [{ session_id: sess1, seq: i, kind: 'user' }],
      });
      if (!('id' in result)) throw new Error(JSON.stringify(result));
      db.run('UPDATE memories SET pinned = 1, utility = ? WHERE id = ?', [i / 500, result.id]);
    }
    const start = performance.now();
    const result = renderStableLayer(db, { workspaceId: ws1, sessionId: sess1 }, DEFAULTS);
    const elapsed = performance.now() - start;
    console.log(`[Stable layer benchmark] 500 pinned memories: ${elapsed.toFixed(2)}ms`);
    expect(result.text).toContain('rule 499:');
    expect(result.text).not.toContain('rule 0:');
    expect(result.visibleRefs.size).toBeGreaterThan(0);
    expect(budgetTokens(result.text)).toBeLessThanOrEqual(DEFAULTS.stableBudgetTokens);
    expect(elapsed).toBeLessThan(DEFAULTS.onlineBudgetMs);
  });

  it('does not mark stable refs visible when registration fails and retries after recovery', () => {
    const result = upsertCandidate(db, {
      type: 'semantic', content: 'Pinned rule awaiting prompt registration.',
      scope: 'workspace', workspaceId: ws1, source_kind: 'user', actor: 'user',
      origin_kinds: ['user'], confidence: 0.9,
      sources: [{ session_id: sess1, seq: 1, kind: 'user' }],
    });
    if (!('id' in result)) throw new Error(JSON.stringify(result));
    db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [result.id]);
    const section = vi.fn().mockImplementationOnce(() => { throw new Error('host unavailable'); })
      .mockReturnValue(() => {});
    const manager = new PromptSectionManager(db);
    const agent = { id: 'retry-agent', ctx: { systemPrompt: { section } } };
    manager.updateSection(agent, { workspaceId: ws1 });
    expect(manager.getVisibleRefs(agent.id).size).toBe(0);
    expect(manager.getStableTokens(agent.id)).toBe(0);
    manager.updateSection(agent, { workspaceId: ws1 });
    expect(manager.getVisibleRefs(agent.id).has(`${result.id}@1`)).toBe(true);
    manager.disposeAll();
  });

  it('should only render pinned=1 and active/frozen records in scope ordered by id ASC', () => {
    // 插入两条 pinned 记录与一条未 pinned 记录
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库是 PostgreSQL 16',
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
    db.run(`UPDATE memories SET pinned = 1 WHERE content LIKE '%PostgreSQL 16%'`);

    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '用户偏好使用 2 空格缩进',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    db.run(`UPDATE memories SET pinned = 1 WHERE content LIKE '%2 空格%'`);

    // 未 pinned 的记录
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '普通未置顶事实',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 3, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    const { text, visibleRefs, stableTokens } = renderStableLayer(
      db,
      { workspaceId: ws1, sessionId: sess1 }
    );

    expect(text).toContain('layer="stable"');
    expect(text).toContain('PostgreSQL 16');
    expect(text).toContain('2 空格缩进');
    expect(text).not.toContain('普通未置顶事实');
    expect(visibleRefs.size).toBe(2);
    expect(stableTokens).toBeGreaterThan(0);
    expect(stableTokens).toBeLessThanOrEqual(600);
  });

  it('should prune lowest utility items when exceeding stableBudgetTokens', () => {
    // 插入多条长记录，使得总 token 超过 300 预算
    for (let i = 1; i <= 6; i++) {
      const content = `重要置顶规则 ${i}：在当前工作区中详细阐述长期系统架构准则与高可用配置约束第 ${i} 项。`;
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content,
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sess1, seq: i, kind: 'user' }],
          actor: 'user',
        },
        fixedNow + i
      );
      // 分配递增 utility
      db.run(
        `UPDATE memories SET pinned = 1, utility = ? WHERE content LIKE ?`,
        [0.2 + i * 0.1, `%规则 ${i}%`]
      );
    }

    const { text, stableTokens } = renderStableLayer(
      db,
      { workspaceId: ws1, sessionId: sess1 },
      { ...({} as any), stableBudgetTokens: 300 }
    );

    expect(budgetTokens(text)).toBeLessThanOrEqual(300);
    expect(stableTokens).toBeLessThanOrEqual(300);
    // 高 utility 的规则 6 应该被保留，低 utility 的规则 1 应该最先被剔除
    expect(text).toContain('规则 6');
  });

  it('PromptSectionManager should isolate different workspaces for subagents (验收项 7)', () => {
    // ws1 有置顶记忆
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '工作区 1 的私有专属记忆',
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
    db.run(`UPDATE memories SET pinned = 1 WHERE content LIKE '%工作区 1%'`);

    const mgr = new PromptSectionManager(db);

    // Mock parent agent in ws1
    let parentSectionContent = '';
    const parentAgent = {
      id: 'agent_parent_ws1',
      cwd: ws1,
      ctx: {
        systemPrompt: {
          section: (opts: any) => {
            parentSectionContent = opts.text;
            expect(opts.interpolate).toBe(false); // 必须为 false
            return () => { parentSectionContent = ''; };
          },
        },
      },
    };

    // Mock subagent in ws2 (子代理运行在不同 workspace)
    let subagentSectionContent = 'initial';
    const subAgent = {
      id: 'agent_sub_ws2',
      cwd: ws2,
      ctx: {
        systemPrompt: {
          section: (opts: any) => {
            subagentSectionContent = opts.text;
            expect(opts.interpolate).toBe(false);
            return () => { subagentSectionContent = ''; };
          },
        },
      },
    };

    mgr.updateSection(parentAgent, { workspaceId: ws1, sessionId: sess1 });
    mgr.updateSection(subAgent, { workspaceId: ws2, sessionId: 'sess_sub' });

    // 父 agent 包含 ws1 专属记忆
    expect(parentSectionContent).toContain('工作区 1 的私有专属记忆');
    // 子 agent 在 ws2，绝对不能继承或泄漏 ws1 的记忆
    expect(subagentSectionContent).toBe('');
    expect(mgr.getVisibleRefs(subAgent.id).size).toBe(0);

    // 清理
    mgr.disposeAll();
    expect(parentSectionContent).toBe('');
  });
});
