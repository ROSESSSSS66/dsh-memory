import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, inject } from '../../src/dsh/plugin.js';
import { openDb } from '../../src/core/db.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { enqueueJob } from '../../src/jobs/scheduler.js';
import { runNextJob } from '../../src/jobs/runner.js';
import { memoryVisibilityProjection } from '../../src/dsh/memory-visibility.js';
import type { Db } from '../../src/types.js';

describe('DSH live smoke regressions (strict Cordis inject & real session shape)', () => {
  let tempDir: string;
  let db: Db | undefined;
  let dispose: (() => Promise<void>) | undefined;

  const projectCwd = path.join(os.tmpdir(), 'dsh-live-smoke-repo-fwq');
  const projectWsId = workspaceId(projectCwd);
  const sessId = 'session-live-smoke-001';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-smoke-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await dispose?.();
    dispose = undefined;
    db?.close();
    db = undefined;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('survives strict Cordis inject proxy, resolves session.header.cwd, filters synthetic snapshots, and executes tools/commands/jobs cleanly', async () => {
    const dbPath = path.join(tempDir, 'memory.db');
    const listeners = new Map<string, Array<(...args: any[]) => any>>();
    const registeredTools = new Map<string, any>();
    const registeredCommands = new Map<string, any>();
    let webHandler: any;

    let projectionState = memoryVisibilityProjection.init();
    const sessionObj = {
      id: sessId,
      header: { cwd: projectCwd },
    };

    const liveAgent = {
      id: 'agent-live-1',
      session: sessionObj,
      position: { turn: 2 },
      ctx: {
        systemPrompt: {
          section: () => () => {},
        },
      },
    };

    const allowedProps = new Set<string>([
      ...inject,
      'on',
      'emit',
      'then',
      'catch',
      'finally',
    ]);

    const rawCtx: Record<string, any> = {
      agents: {
        list: () => [liveAgent],
      },
      sessionProjections: {
        register: async () => () => {},
        stateOf: (session: any, key: string) =>
          session?.id === sessId && key === memoryVisibilityProjection.key
            ? projectionState
            : undefined,
      },
      systemPrompt: {
        section: () => () => {},
      },
      tools: {
        register: (def: any) => {
          registeredTools.set(def.name, def);
          return () => registeredTools.delete(def.name);
        },
      },
      commands: {
        register: (def: any) => {
          registeredCommands.set(def.name, def);
          return () => registeredCommands.delete(def.name);
        },
      },
      webServer: {
        register: (def: any) => {
          webHandler = def;
          return () => {};
        },
      },
      on: (event: string, fn: (...args: any[]) => any) => {
        const list = listeners.get(event) || [];
        list.push(fn);
        listeners.set(event, list);
        if (event === 'dispose') {
          dispose = fn;
        }
        return () => {
          const cur = listeners.get(event) || [];
          listeners.set(
            event,
            cur.filter(item => item !== fn)
          );
        };
      },
      emit: (event: string, ...args: any[]) => {
        for (const fn of listeners.get(event) || []) {
          fn(...args);
        }
      },
    };

    const strictCordisCtx = new Proxy(rawCtx, {
      get(target, prop, receiver) {
        if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
        if (!allowedProps.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const cfgOverride: Partial<PluginConfig> & { autoBootstrap?: boolean } = {
      dbPath,
      autoBootstrap: false,
      distillMinEvents: 40,
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
        apiKey: 'sk-test-smoke-key-1234567890',
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.deepseek.com'],
      },
    };

    await apply(strictCordisCtx, cfgOverride);
    db = openDb(dbPath);

    // 预置两条 workspace 专属记忆，确认 pre-step 命中真实 projectWsId 而非 process.cwd()
    const seedRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'fwq 网关服务默认监听在 8080 端口。',
        summary: 'fwq 网关默认端口 8080',
        scope: 'workspace',
        workspaceId: projectWsId,
        slot_key: 'fwq.gateway.port',
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.95,
        sources: [{ session_id: 'seed-sess', seq: 1, kind: 'user', excerpt: '8080' }],
        actor: 'user',
      },
      1000
    );
    expect(seedRes.action).toBe('inserted');
    const seedMemId = (seedRes as any).id as string;

    const mergeSrcRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'fwq API 网关旧端口曾经临时设为 8081。',
        summary: 'fwq 网关旧端口 8081',
        scope: 'workspace',
        workspaceId: projectWsId,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        sources: [{ session_id: 'seed-sess', seq: 2, kind: 'user', excerpt: '8081' }],
        actor: 'user',
      },
      1001
    );
    const mergeSrcId = (mergeSrcRes as any).id as string;

    // 1. 模拟真实 DSH session/event（只有 session.header.cwd，没有 session.cwd；且包含 synthetic snapshots）
    const emitSessionEvent = (event: any) => {
      for (const fn of listeners.get('session/event') || []) {
        fn(sessionObj, event);
      }
    };

    emitSessionEvent({
      type: 'user/message',
      seq: 1,
      time: 2000,
      data: {
        source: { kind: 'skill-catalog', form: 'catalog' },
        content: [{ type: 'text', text: '记住：这是系统技能目录快照，不应写入记忆。' }],
      },
    });
    emitSessionEvent({
      type: 'user/message',
      seq: 2,
      time: 2001,
      data: {
        source: { kind: 'time-context', form: 'snapshot' },
        content: [{ type: 'text', text: '记住：当前系统时间上下文快照，不应写入记忆。' }],
      },
    });
    emitSessionEvent({
      type: 'user/message',
      seq: 3,
      time: 2002,
      data: {
        source: { kind: 'tool-jobs', form: 'snapshot' },
        content: [{ type: 'text', text: '记住：后台作业状态快照，不应写入记忆。' }],
      },
    });
    emitSessionEvent({
      type: 'user/message',
      seq: 4,
      time: 2003,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: '记住：fwq 发布前必须先运行 npm run build。' }],
      },
    });
    emitSessionEvent({
      type: 'tool/call',
      seq: 5,
      time: 2004,
      data: { turn: 2, callId: 'call_read_1', name: 'read', arguments: '{"path":"a.ts"}' },
    });
    emitSessionEvent({
      type: 'tool/result',
      seq: 6,
      time: 2005,
      data: {
        turn: 2,
        isError: true,
        toolCallId: 'call_read_1',
        message: { content: [{ type: 'text', text: 'ENOENT: no such file' }] },
      },
    });
    emitSessionEvent({
      type: 'tool/result',
      seq: 7,
      time: 2006,
      data: {
        turn: 2,
        isError: false,
        toolCallId: 'call_read_1',
        message: { content: [{ type: 'text', text: 'file content ok' }] },
      },
    });

    // 2. 触发 pre-step：无 agent.cwd / session.cwd，仅 session.header.cwd，并混入 synthetic snapshots
    const preStepFn = (listeners.get('agent/pre-step') || [])[0];
    expect(preStepFn).toBeTypeOf('function');

    const decision = await preStepFn(
      {
        sessionId: sessId,
        turn: 2,
        step: 1,
        agent: liveAgent,
      },
      async () => ({
        kind: 'enter',
        messages: [
          {
            id: 'msg-skill',
            role: 'user',
            source: { kind: 'skill-catalog', form: 'catalog' },
            content: [{ type: 'text', text: '技能列表：a11y-debugging' }],
          },
          {
            id: 'msg-user',
            role: 'user',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'fwq 网关默认端口和发布步骤是什么？' }],
          },
        ],
      })
    );

    expect(decision.kind).toBe('enter');
    expect(decision.messages.length).toBe(3);
    const injectedMsg = decision.messages[2];
    expect(injectedMsg.source).toMatchObject({ kind: 'dsh-memory', plugin: 'dsh-memory' });
    expect(injectedMsg.content[0].text).toContain('8080');
    expect(injectedMsg.source.memoryRefs.some((r: any) => r.id === seedMemId)).toBe(true);

    // 验证 raw_events / session_workspace_owners / R5 fixpair 入队全部使用真实 projectWsId 且无 synthetic 污染
    const storedEvents = db.all<{ seq: number; workspace_id: string; origin_kind: string; text: string }>(
      'SELECT seq, workspace_id, origin_kind, text FROM raw_events WHERE session_id = ? ORDER BY seq ASC',
      [sessId]
    );
    expect(storedEvents.map(e => e.seq)).toEqual([4, 5, 6, 7]);
    expect(storedEvents.every(e => e.workspace_id === projectWsId)).toBe(true);
    expect(
      db.get<{ workspace_id: string }>(
        'SELECT workspace_id FROM session_workspace_owners WHERE session_id = ?',
        [sessId]
      )?.workspace_id
    ).toBe(projectWsId);
    expect(
      db.all<{ content: string }>('SELECT content FROM memories WHERE content LIKE ?', ['%不应写入记忆%'])
    ).toHaveLength(0);

    const r5Job = db.get<{ kind: string; key: string; payload: string }>(
      "SELECT kind, key, payload FROM jobs WHERE key = ?",
      [`fixpair:${sessId}:2`]
    );
    expect(r5Job).toBeDefined();
    expect(JSON.parse(r5Job!.payload).workspaceId).toBe(projectWsId);

    // 3. 在严格 Proxy 下运行 fixpair distill / curate / maintain，确认不再抛出 cannot get property "agent" without inject
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
      const systemText = String(parsedBody?.messages?.[0]?.content || '');
      const content = systemText.includes('CURATOR') || systemText.includes('审阅')
        ? JSON.stringify({ discard_ids: [], updates: [] })
        : JSON.stringify({ items: [] });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200 }
      );
    });

    const fullCfg: PluginConfig = {
      ...DEFAULTS,
      ...cfgOverride,
    } as PluginConfig;

    expect(await runNextJob(db, fullCfg)).toBe(true);
    const finishedDistill = db.get<{ status: string; error: string | null }>(
      'SELECT status, error FROM jobs WHERE key = ?',
      [`fixpair:${sessId}:2`]
    );
    expect(finishedDistill).toEqual({ status: 'done', error: null });

    enqueueJob(db, { kind: 'maintain', key: 'smoke-maintain', payload: { auto: true } });
    expect(await runNextJob(db, fullCfg)).toBe(true);
    const finishedMaintain = db.get<{ status: string; error: string | null }>(
      'SELECT status, error FROM jobs WHERE key = ?',
      ['smoke-maintain']
    );
    expect(finishedMaintain).toEqual({ status: 'done', error: null });

    enqueueJob(db, { kind: 'curate', key: 'smoke-curate', payload: { sessionId: sessId } });
    expect(await runNextJob(db, fullCfg)).toBe(true);
    const finishedCurate = db.get<{ status: string; error: string | null }>(
      'SELECT status, error FROM jobs WHERE key = ?',
      ['smoke-curate']
    );
    expect(finishedCurate).toEqual({ status: 'done', error: null });
    expect(fetchSpy).toHaveBeenCalled();

    // 4. 触发 memory/context-pressure 与 agent/turn-stopping：不能抛 ctx.agent 错
    rawCtx.emit('memory/context-pressure', {
      sessionId: sessId,
      cwd: projectCwd,
      ratio: 0.9,
    });
    expect(() =>
      rawCtx.emit('agent/turn-stopping', {
        sessionId: sessId,
        agent: liveAgent,
      })
    ).not.toThrow();

    const maintainJobs = db.all<{ payload: string }>(
      "SELECT payload FROM jobs WHERE kind = 'maintain' AND key LIKE 'auto_maintain:%'"
    );
    expect(maintainJobs.length).toBe(1);
    expect(JSON.parse(maintainJobs[0].payload)).toMatchObject({
      auto: true,
      workspaceId: projectWsId,
      cwd: projectCwd,
    });

    // 5. 测试全部 8 个已注册工具在无 agent.cwd 及无 exec.agent 下均不访问 ctx.agent 且命中真实 workspace
    const minimalExec = { session: { id: sessId } };
    const agentHeaderExec = { agent: liveAgent };

    const searchOut = await registeredTools
      .get('memory_search')
      .execute({ query: '8080', limit: 3 }, minimalExec);
    expect(searchOut).toContain('8080');

    const expandOut = await registeredTools
      .get('memory_expand')
      .execute({ id: seedMemId }, agentHeaderExec);
    expect(expandOut).toContain('8080');

    const feedbackOut = await registeredTools
      .get('memory_feedback')
      .execute({ id: seedMemId, contentRev: 1, helpful: true }, agentHeaderExec);
    expect(feedbackOut).not.toContain('Error:');

    const noteOut = await registeredTools
      .get('memory_note')
      .execute({ content: 'fwq 测试备注：本地冒烟验证已通过。', kind: 'fact' }, agentHeaderExec);
    expect(noteOut).not.toContain('Error:');

    const confirmOut = await registeredTools
      .get('memory_confirm')
      .execute({ id: seedMemId }, minimalExec);
    expect(confirmOut).not.toContain('Error:');

    const mergeOut = await registeredTools
      .get('memory_merge')
      .execute({ sourceId: mergeSrcId, targetId: seedMemId, reason: '整合端口配置' }, agentHeaderExec);
    expect(mergeOut).not.toContain('Error:');

    const unifiedOut = await registeredTools
      .get('memory')
      .execute({ action: 'search', query: '8080' }, minimalExec);
    expect(unifiedOut).toContain('8080');

    const coreOut = await registeredTools
      .get('memory_core')
      .execute({ action: 'read', block: 'project' }, minimalExec);
    expect(coreOut).not.toContain('without inject');

    // 6. 测试 /memory 命令使用 agent.session.header.cwd
    const cmdRes = registeredCommands.get('memory').handler({
      agent: liveAgent,
      rawInput: 'stats',
    });
    expect(cmdRes.kind).toBe('success');
    expect(cmdRes.text).toContain('记忆总数');
    expect(webHandler).toBeDefined();
  });
});
