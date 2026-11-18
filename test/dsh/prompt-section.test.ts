import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { renderStableLayer, PromptSectionManager } from '../../src/dsh/prompt-section.js';
import plugin from '../../src/dsh/plugin.js';
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

  it('syncs memory-stable on startup agents, agent/created, and system-prompt/assemble without requiring webServer upfront', async () => {
    expect(plugin.inject).toEqual(['agents', 'sessionProjections', 'systemPrompt', 'tools', 'commands']);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-prompt-'));
    const dbPath = path.join(tmpDir, 'mem.db');
    const wsPath = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsPath, { recursive: true });

    // Seed a pinned memory before plugin startup
    const seedDb = openDb(dbPath);
    upsertCandidate(
      seedDb,
      {
        type: 'semantic',
        content: 'Pinned workspace fact for system-prompt/assemble verification.',
        scope: 'workspace',
        workspaceId: workspaceId(wsPath),
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.95,
        actor: 'user',
        sources: [{ session_id: 's_init', seq: 1, kind: 'user' }],
      },
      fixedNow
    );
    seedDb.run(`UPDATE memories SET pinned = 1 WHERE content LIKE '%system-prompt/assemble%'`);
    seedDb.close();

    const listeners = new Map<string, Function[]>();
    const injectCallbacks: Array<{ deps: string[]; cb: Function }> = [];
    const registeredCommands: any[] = [];
    const registeredWebRoutes: any[] = [];
    const registeredSections = new Map<string, string>();

    const makeAgent = (id: string) => ({
      id,
      cwd: wsPath,
      session: { id: `sess_${id}`, header: { cwd: wsPath } },
      ctx: {
        systemPrompt: {
          section: (opts: any) => {
            registeredSections.set(`${id}:${opts.name}`, opts.text);
            return () => {
              registeredSections.delete(`${id}:${opts.name}`);
            };
          },
        },
      },
    });

    const startupAgent = makeAgent('agent_startup');
    const createdAgent = makeAgent('agent_created');
    const assembleAgent = {
      id: 'agent_assemble',
      cwd: wsPath,
      session: { id: 'sess_assemble', header: { cwd: wsPath } },
    };

    const mockCtx: any = {
      agents: {
        list: () => [startupAgent],
      },
      sessionProjections: {
        register: () => () => {},
        stateOf: () => ({ visibleInjections: [] }),
      },
      systemPrompt: {
        section: () => () => {},
      },
      tools: {
        register: () => () => {},
      },
      commands: {
        register: (cmd: any) => {
          registeredCommands.push(cmd);
          return () => {};
        },
      },
      inject: (deps: string[], cb: Function) => {
        injectCallbacks.push({ deps, cb });
        return () => {};
      },
      on: (event: string, fn: Function, opts?: { prepend?: boolean }) => {
        const list = listeners.get(event) || [];
        if (opts?.prepend) list.unshift(fn);
        else list.push(fn);
        listeners.set(event, list);
        return () => {
          const cur = listeners.get(event) || [];
          const idx = cur.indexOf(fn);
          if (idx >= 0) cur.splice(idx, 1);
        };
      },
    };

    try {
      await plugin.apply(mockCtx, { dbPath, autoBootstrap: false });

      // 1. Existing agent receives memory-stable at startup
      expect(registeredSections.get('agent_startup:memory-stable')).toContain(
        'Pinned workspace fact for system-prompt/assemble verification.'
      );

      // 2. agent/created syncs newly created agent before any pre-step fires
      for (const fn of listeners.get('agent/created') || []) {
        await fn({ agent: createdAgent });
      }
      expect(registeredSections.get('agent_created:memory-stable')).toContain(
        'Pinned workspace fact for system-prompt/assemble verification.'
      );

      // 3. system-prompt/assemble updates assembly.sections BEFORE agent/pre-step
      const assembly: any = {
        sections: [
          { name: 'harness:identity', text: 'You are an AI agent.' },
          { name: 'deployment:persona-suffix', text: 'Suffix' },
        ],
        contexts: [],
        variables: {},
      };
      const assembleListeners = listeners.get('system-prompt/assemble') || [];
      expect(assembleListeners.length).toBeGreaterThan(0);
      await assembleListeners[0](
        assembly,
        { agent: assembleAgent, scope: assembleAgent },
        async () => assembly
      );
      const memSectionIdx = assembly.sections.findIndex((s: any) => s.name === 'memory-stable');
      const suffixIdx = assembly.sections.findIndex((s: any) => s.name === 'deployment:persona-suffix');
      expect(memSectionIdx).toBeGreaterThanOrEqual(0);
      expect(memSectionIdx).toBeLessThan(suffixIdx);
      expect(assembly.sections[memSectionIdx].interpolate).toBe(false);
      expect(assembly.sections[memSectionIdx].text).toContain(
        'Pinned workspace fact for system-prompt/assemble verification.'
      );

      // 4. Required commands registered directly & deferred optional webServer registered via ctx.inject
      expect(registeredCommands.some((c) => c.name === 'memory')).toBe(true);
      expect(injectCallbacks.map((i) => i.deps)).toEqual([['webServer']]);
      for (const entry of injectCallbacks) {
        if (entry.deps[0] === 'webServer') {
          entry.cb({
            webServer: {
              register: (route: any) => {
                registeredWebRoutes.push(route);
                return () => {};
              },
            },
          });
        }
      }
      expect(registeredWebRoutes.some((r) => r.path === '/api/dsh-memory')).toBe(true);

      // Dispose plugin cleanly
      for (const fn of listeners.get('dispose') || []) {
        await fn();
      }
      expect(registeredSections.size).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
