import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DEFAULTS, validateConfig, loadConfigFromDb, type PluginConfig } from '../config.js';
import { openDb } from '../core/db.js';
import { IngestQueue } from '../ingest/queue.js';
import { registerSessionListener } from './session-listener.js';
import { PromptSectionManager } from './prompt-section.js';
import { registerPreStep } from './pre-step.js';
import { registerMemoryVisibility, type MemoryVisibilityReader } from './memory-visibility.js';
import { MemoryTools } from './tools.js';
import { MemoryCommands } from './commands.js';
import { workspaceId } from '../core/scope.js';
import { isWorkspaceExcluded } from '../core/privacy.js';
import { JobScheduler, recoverJobsOnStartup } from '../jobs/scheduler.js';
import { registerJobHandler, unregisterJobHandler } from '../jobs/runner.js';
import { jobFailure } from '../jobs/types.js';
import {
  distillSession,
  findEligibleDistillSession,
} from '../evolution/extractor.js';
import { runReflectJob } from '../evolution/reflector.js';
import {
  findConsolidationClusters,
  consolidateCluster,
} from '../evolution/consolidator.js';
import { executeRepair } from '../evolution/repair.js';
import { runStrategyEvolution, checkSentinelAndRollback } from '../evolution/lab.js';
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  checkAndRepairFts,
  cleanOldTelemetry,
  pruneInvalidMemories,
  curateMemoriesWithLLM,
} from '../evolution/maintenance.js';
import { registerWebRoutes } from './web.js';
import { backfillMissingEmbeddings } from '../core/vector.js';
import { weaveZettelkastenLinks, autoHealMemoryHealth } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import type { Db } from '../types.js';

export const name = 'dsh-memory';
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'commands', 'webServer'];

function extractSessionCwd(session: any): string {
  if (!session || typeof session !== 'object') return '';
  const direct = typeof session.cwd === 'string' ? session.cwd.trim() : '';
  if (direct) return direct;
  const headerCwd = typeof session.header?.cwd === 'string' ? session.header.cwd.trim() : '';
  if (headerCwd) return headerCwd;
  const ws = typeof session.workspaceId === 'string' ? session.workspaceId.trim() : '';
  return ws;
}

function extractAgentCwd(agent: any): string {
  if (!agent || typeof agent !== 'object') return '';
  const direct = typeof agent.cwd === 'string' ? agent.cwd.trim() : '';
  if (direct) return direct;
  return extractSessionCwd(agent.session);
}

function resolveCtxAgentCwd(ctx: any, sessionId?: string): string {
  try {
    const list = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : undefined;
    if (Array.isArray(list) && list.length > 0) {
      if (sessionId) {
        const matched = list.find((a: any) => a?.session?.id === sessionId);
        const matchedCwd = extractAgentCwd(matched);
        if (matchedCwd) return matchedCwd;
      }
      for (const a of list) {
        const c = extractAgentCwd(a);
        if (c) return c;
      }
    }
  } catch {}
  return '';
}

function resolveSessionWorkspaceId(db: Db, sessionId?: string): string {
  if (!sessionId) return '';
  try {
    const owner = db.get<{ workspace_id: string }>(
      "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != '' LIMIT 1",
      [sessionId]
    );
    if (owner?.workspace_id) return owner.workspace_id;
    const raw = db.get<{ workspace_id: string }>(
      "SELECT workspace_id FROM raw_events WHERE session_id = ? AND workspace_id != '' LIMIT 1",
      [sessionId]
    );
    return raw?.workspace_id || '';
  } catch {
    return '';
  }
}

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-memory',
    validate(val: unknown) {
      try {
        const value = validateConfig((val ?? {}) as Partial<PluginConfig>);
        return { value };
      } catch (err: any) {
        return { issues: [{ message: err?.message || String(err) }] };
      }
    },
  },
  type: 'object',
  default: DEFAULTS,
};

export async function apply(ctx: any, config?: Partial<PluginConfig> & { autoBootstrap?: boolean }) {
  let db: Db | undefined;
  let promptSections: PromptSectionManager | undefined;
  let queue: IngestQueue | undefined;
  let scheduler: JobScheduler | undefined;
  let unlistenSession: (() => void) | undefined;
  let unlistenPressure: (() => void) | undefined;
  let unlistenAgentDisposed: (() => void) | undefined;
  let visibility: MemoryVisibilityReader | undefined;
  let unlistenPreStep: (() => void) | undefined;
  let unlistenTurnStopping: (() => void) | undefined;
  let unlistenWeb: (() => void) | undefined;
  const regDisposers: Array<() => void> = [];
  let handlersRegistered = false;
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (logClean = false): Promise<void> => {
    disposed = true;
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        for (const disp of regDisposers.splice(0, regDisposers.length)) {
          try {
            disp();
          } catch {}
        }
        try {
          unlistenWeb?.();
        } catch {}
        unlistenWeb = undefined;
        try {
          unlistenTurnStopping?.();
        } catch {}
        unlistenTurnStopping = undefined;
        try {
          unlistenSession?.();
        } catch {}
        unlistenSession = undefined;
        try {
          unlistenPressure?.();
        } catch {}
        unlistenPressure = undefined;
        try {
          unlistenAgentDisposed?.();
        } catch {}
        unlistenAgentDisposed = undefined;
        try {
          unlistenPreStep?.();
        } catch {}
        unlistenPreStep = undefined;
        try {
          visibility?.dispose();
        } catch {}
        visibility = undefined;

        const stopSchedPromise = scheduler ? scheduler.stopAndWait() : Promise.resolve();
        if (handlersRegistered) {
          for (const kind of ['distill', 'reflect', 'consolidate', 'maintain', 'curate', 'repair', 'evolve']) {
            unregisterJobHandler(kind);
          }
          handlersRegistered = false;
        }
        try {
          promptSections?.disposeAll();
        } catch {}
        await Promise.allSettled([queue ? queue.close() : Promise.resolve(), stopSchedPromise]);
        try {
          db?.close();
        } catch {}
        db = undefined;
        if (logClean) {
          console.log('[dsh-memory] Plugin disposed cleanly');
        }
      } catch {}
    })();
    return cleanupPromise;
  };

  try {
    const initialCfg = validateConfig(config);
    if (!initialCfg.enabled) {
      console.log('[dsh-memory] Plugin is disabled by configuration');
      return;
    }

    // 1. 打开数据库（支持配置 dbPath，默认 ~/.dsh/storages/dsh-memory/memory.db）
    const defaultDataDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory');
    const dataDir = initialCfg.dataDir || defaultDataDir;
    const dbPath = initialCfg.dbPath || path.join(dataDir, 'memory.db');
    try {
      const parentDir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      db = openDb(dbPath);
      (db as any).filePath = dbPath;
    } catch (dbErr: any) {
      // 验收项 5: 临时把数据库文件改名，让插件无法打开 → DSH 照常对话，日志中出现降级提示
      console.warn(
        '[dsh-memory] Database open failed (gracefully degraded to disabled state):',
        dbErr?.message || dbErr
      );
      return;
    }

    if (!db) return;
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => cleanup(true));
    }
    if (disposed) {
      await cleanup();
      return;
    }
    const currentDb: Db = db;

    // 合并存储中的用户自定义动态配置 (LLM 配置、风控与隐私选项)，并保持全局共享 cfg 引用实时同步
    const cfg = loadConfigFromDb(currentDb, initialCfg);
    const getLiveCfg = (): PluginConfig => {
      const loaded = loadConfigFromDb(currentDb, initialCfg);
      Object.assign(cfg, loaded);
      return cfg;
    };

    console.log('[dsh-memory] Plugin initialized with database at:', dbPath);

    // 1.1 启动恢复与首次安装冷启动自动记忆初始化 (v0.6.0 Autonomous Bootstrap & Auto-Heal)
    recoverJobsOnStartup(currentDb);
    try {
      const isDefaultDbPath = !initialCfg.dbPath && !initialCfg.dataDir;
      const shouldAutoBootstrap =
        config?.autoBootstrap === true ||
        (isDefaultDbPath && config?.autoBootstrap !== false);
      if (shouldAutoBootstrap) {
        const bootRes = autoBootstrapMemory(currentDb, {
          workspacePath: process.cwd(),
          cfg,
        });
        if (!bootRes.alreadyInitialized) {
          console.log(
            `[dsh-memory] Auto-initialized workspace memory (core=${
              bootRes.coreBlocksInitialized.join(',') || 'ready'
            }, seeded=${bootRes.workspaceMemoriesSeeded}, backfill=${
              bootRes.backfillMemoriesCreated
            }, links=${bootRes.linksWeaved})`
          );
        }
        autoHealMemoryHealth(currentDb);
      }
      backfillMissingEmbeddings(currentDb, { limit: 200 });
    } catch {}

    // 1.2 初始化离线任务调度器与全自动处理器
    const localScheduler = new JobScheduler(currentDb, cfg);
    scheduler = localScheduler;
    handlersRegistered = true;

    registerJobHandler('distill', async (job, signal) => {
      const liveCfg = getLiveCfg();
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const payloadCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      const payloadWsId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
      const cwd =
        payloadCwd ||
        resolveCtxAgentCwd(ctx, payload.sessionId) ||
        payloadWsId ||
        resolveSessionWorkspaceId(currentDb, payload.sessionId) ||
        process.cwd();
      const res = await distillSession(currentDb, liveCfg, { sessionId: payload.sessionId, cwd, signal });
      if (!res.success) {
        return jobFailure(res.error || 'distill_failed');
      }
      if (res.sessionId && res.consumedCount > 0) {
        const nextBatch = findEligibleDistillSession(currentDb, liveCfg, true, res.sessionId);
        if (nextBatch) {
          localScheduler.enqueue('distill', `${nextBatch.sessionId}:seq:${nextBatch.minSeq}`, {
            sessionId: nextBatch.sessionId,
            cwd,
          });
        }
      }
      return { action: 'done' };
    });

    registerJobHandler('reflect', async (job, signal) => {
      const liveCfg = getLiveCfg();
      return runReflectJob(currentDb, liveCfg, job, signal);
    });

    registerJobHandler('consolidate', async (job, signal) => {
      const liveCfg = getLiveCfg();
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const payloadCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      const payloadWsId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
      const wsId = payloadWsId
        ? workspaceId(payloadWsId)
        : resolveSessionWorkspaceId(currentDb, payload.sessionId) ||
          workspaceId(payloadCwd || resolveCtxAgentCwd(ctx, payload.sessionId) || process.cwd());
      const clusters = findConsolidationClusters(currentDb, wsId, liveCfg);
      for (const c of clusters) {
        const res = await consolidateCluster(currentDb, liveCfg, c, { signal });
        if (!res.success) {
          return jobFailure(res.error || 'consolidate_failed');
        }
      }
      return { action: 'done' };
    });

    registerJobHandler('maintain', async (job, signal) => {
      const liveCfg = getLiveCfg();
      const payload = job?.payload ? JSON.parse(job.payload) : {};
      const payloadCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      const payloadWsId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
      const rawCwd =
        payloadCwd ||
        resolveCtxAgentCwd(ctx, payload.sessionId) ||
        process.cwd();
      const maintainWsId = payloadWsId
        ? workspaceId(payloadWsId)
        : resolveSessionWorkspaceId(currentDb, payload.sessionId) || workspaceId(rawCwd);
      pruneInvalidMemories(currentDb, { workspaceId: maintainWsId });
      archiveColdMemories(currentDb, liveCfg);
      expireCandidates(currentDb);
      autoPinMemories(currentDb);
      checkAndRepairFts(currentDb);
      backfillMissingEmbeddings(currentDb, { limit: 500 });
      const curateResult = await curateMemoriesWithLLM(currentDb, liveCfg, {
        workspaceId: maintainWsId,
        cwd: rawCwd,
        signal,
      });
      autoHealMemoryHealth(currentDb, { workspaceId: maintainWsId });
      weaveZettelkastenLinks(currentDb, { maxNewLinks: 25 });
      cleanOldTelemetry(currentDb);
      checkSentinelAndRollback(currentDb);

      // 若线上自动收割样本 (eval_cases.suite = 'harvested') 新增达到阈值，全自动排队策略进化任务
      try {
        const sampleCnt =
          currentDb.get<{ cnt: number }>(
            "SELECT COUNT(*) as cnt FROM eval_cases WHERE suite = 'harvested'"
          )?.cnt || 0;
        const lastRow = currentDb.get<{ value: string }>(
          "SELECT value FROM meta WHERE key = 'lab.last_evolved_harvest_count'"
        );
        const lastCnt = lastRow ? Number(lastRow.value) || 0 : 0;
        if (sampleCnt >= 5 && sampleCnt >= lastCnt + 5) {
          const bucket6h = Math.floor(Date.now() / (6 * 3600_000));
          localScheduler.enqueue('evolve', `auto_evolve:${bucket6h}:n${sampleCnt}`, { auto: true });
        }
      } catch {}

      return curateResult.ok ? { action: 'done' } : jobFailure(curateResult.error || 'curate_failed');
    });

    registerJobHandler('curate', async (job, signal) => {
      const liveCfg = getLiveCfg();
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const payloadCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
      const payloadWsId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : '';
      const rawCwd =
        payloadCwd ||
        resolveCtxAgentCwd(ctx, payload.sessionId) ||
        process.cwd();
      const wsId = payloadWsId
        ? workspaceId(payloadWsId)
        : resolveSessionWorkspaceId(currentDb, payload.sessionId) || workspaceId(rawCwd);
      const res = await curateMemoriesWithLLM(currentDb, liveCfg, {
        workspaceId: wsId,
        cwd: rawCwd,
        signal,
      });
      if (!res.ok) return jobFailure(res.error || 'curate_failed');
      return { action: 'done' };
    });

    registerJobHandler('repair', async (job, signal) => {
      const liveCfg = getLiveCfg();
      return executeRepair(
        currentDb,
        { id: job.id, key: job.key, payload: job.payload || '{}' },
        { signal },
        liveCfg
      );
    });

    registerJobHandler('evolve', async () => {
      const liveCfg = getLiveCfg();
      runStrategyEvolution(currentDb, {}, liveCfg);
      try {
        const sampleCnt =
          currentDb.get<{ cnt: number }>(
            "SELECT COUNT(*) as cnt FROM eval_cases WHERE suite = 'harvested'"
          )?.cnt || 0;
        currentDb.run(
          `INSERT INTO meta (key, value) VALUES ('lab.last_evolved_harvest_count', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [String(sampleCnt)]
        );
      } catch {}
      return { action: 'done' };
    });

    // 2. 初始化摄入队列与 Session 事件监听器
    const localQueue = new IngestQueue(currentDb, cfg);
    queue = localQueue;
    unlistenSession = registerSessionListener(ctx, localQueue, cfg);

    // 2.1 监听上下文压力事件，自适应触发后台抽取 (汲取自 creativedswork/dsh-expmem)
    unlistenPressure = ctx.on
      ? ctx.on('memory/context-pressure', (evt: any) => {
          if (evt?.sessionId) {
            const liveCfg = getLiveCfg();
            const eligible = findEligibleDistillSession(currentDb, liveCfg, true, evt.sessionId);
            const minSeq = eligible?.minSeq ?? 1;
            const rawCwd =
              extractAgentCwd(evt?.agent) ||
              extractSessionCwd(evt?.session) ||
              (typeof evt?.cwd === 'string' ? evt.cwd.trim() : '') ||
              resolveCtxAgentCwd(ctx, evt.sessionId) ||
              (typeof evt?.workspaceId === 'string' ? evt.workspaceId.trim() : '') ||
              resolveSessionWorkspaceId(currentDb, evt.sessionId) ||
              process.cwd();
            if (isWorkspaceExcluded(rawCwd, liveCfg.excludeWorkspaces)) return;
            localScheduler.enqueue('distill', `${evt.sessionId}:seq:${minSeq}`, {
              sessionId: evt.sessionId,
              cwd: rawCwd,
            });
          }
        })
      : undefined;

    // 3. 初始化稳定层 Prompt Section 管理器
    promptSections = new PromptSectionManager(currentDb, cfg);
    unlistenAgentDisposed = typeof ctx.on === 'function'
      ? ctx.on('agent/disposed', (evt: any) => {
          const agentId = evt?.agent?.id || evt?.id || evt?.agentId;
          if (typeof agentId === 'string' && agentId) {
            promptSections?.disposeAgent(agentId);
          }
        })
      : undefined;

    // Register before publishing consumers; the host rebuilds visibility from committed session logs.
    const registeredVisibility = await registerMemoryVisibility(ctx);
    if (disposed) {
      try {
        registeredVisibility.dispose();
      } catch {}
      await cleanup();
      return;
    }
    visibility = registeredVisibility;

    // 4. 注册 pre-step 动态注入瀑布监听器
    unlistenPreStep = registerPreStep(ctx, {
      db: currentDb,
      promptSections,
      cfg,
      getVisibleRefs: session => visibility?.getVisibleRefs(session) ?? null,
      flushIngest: () => localQueue.flush(),
    });

    // 5. 初始化模型工具
    const tools = new MemoryTools({ db: currentDb, cfg });
    const addDisp = (d: any) => {
      if (typeof d === 'function') regDisposers.push(d);
    };
    const resolveRuntimeScope = (input?: {
      agent?: any;
      session?: any;
      sessionId?: string;
      cwd?: string;
      workspaceId?: string;
      turn?: number;
      position?: { turn?: number };
    }) => {
      const agent = input?.agent;
      const session = input?.session || agent?.session;
      const rawSessionId =
        (typeof input?.sessionId === 'string' && input.sessionId.trim()) ||
        (typeof session?.id === 'string' && session.id.trim()) ||
        '';
      const sessId = rawSessionId || 'default_session';
      const cwd =
        extractAgentCwd(agent) ||
        extractSessionCwd(session) ||
        (typeof input?.cwd === 'string' ? input.cwd.trim() : '') ||
        resolveCtxAgentCwd(ctx, rawSessionId || undefined) ||
        (typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : '') ||
        resolveSessionWorkspaceId(currentDb, rawSessionId || undefined) ||
        process.cwd();
      const turn =
        typeof input?.turn === 'number'
          ? input.turn
          : (input?.position?.turn ?? agent?.position?.turn ?? 0);
      return { cwd, sessId, explicitSessionId: rawSessionId || undefined, turn };
    };

    if (ctx.tools?.register) {
      // tool 1: memory_search
      addDisp(
        ctx.tools.register({
          name: 'memory_search',
          description:
            '在长期记忆库中检索历史事实、配置与经验规则。注意：只有在当前系统提供的 memory_context 中找不到所需信息时才调用此工具。',
          parameters: {
            query: { type: 'string', required: true, description: '搜索关键词或问题' },
            limit: { type: 'number', description: '最多返回结果数 (1-8)' },
            types: { type: 'array', items: { type: 'string' }, description: '过滤的记忆类型' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, sessId, turn } = resolveRuntimeScope(exec);
            return tools.search(args, { workspaceId: cwd, sessionId: sessId, turn });
          },
        })
      );

      // tool 2: memory_expand
      addDisp(
        ctx.tools.register({
          name: 'memory_expand',
          description: '展开某条记忆的完整正文与来源证据详情。',
          parameters: {
            id: { type: 'string', required: true, description: '记忆 ID 或 4 位短码 (如 m_ab12)' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, sessId, turn } = resolveRuntimeScope(exec);
            return tools.expand(args, { workspaceId: cwd, sessionId: sessId, turn });
          },
        })
      );

      // tool 3: memory_feedback
      addDisp(
        ctx.tools.register({
          name: 'memory_feedback',
          description: '向记忆系统反馈某条引用的有用程度。',
          parameters: {
            id: { type: 'string', required: true, description: '记忆完整 ID' },
            contentRev: { type: 'integer', required: true, description: '当前引用的正文修订号' },
            helpful: { type: 'boolean', required: true, description: '是否有帮助' },
            note: { type: 'string', description: '反馈说明' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, sessId, turn } = resolveRuntimeScope(exec);
            return tools.feedback(args, { workspaceId: cwd, sessionId: sessId, turn });
          },
        })
      );

      // tool 4: memory_note
      addDisp(
        ctx.tools.register({
          name: 'memory_note',
          description: '记录一条待审批的候选记忆备忘 (每轮最多调用 3 次)。',
          parameters: {
            content: { type: 'string', required: true, description: '记忆内容 (8-400字符)' },
            kind: {
              type: 'string',
              required: true,
              description: '类型: fact (事实), preference (偏好), procedure (步骤/流程)',
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, sessId, turn } = resolveRuntimeScope(exec);
            return tools.note(args, { workspaceId: cwd, sessionId: sessId, turn });
          },
        })
      );

      // tool 5: memory_confirm (汲取自 tr1v3r/dsh-ltm)
      addDisp(
        ctx.tools.register({
          name: 'memory_confirm',
          description: '显式确认某条记忆的事实依然正确有效，强化其可信度与效用。',
          parameters: {
            id: { type: 'string', required: true, description: '记忆完整 ID 或短码' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, explicitSessionId } = resolveRuntimeScope(exec);
            return tools.confirm(args, { workspaceId: cwd, sessionId: explicitSessionId });
          },
        })
      );

      // tool 6: memory_merge (汲取自 tr1v3r/dsh-ltm)
      addDisp(
        ctx.tools.register({
          name: 'memory_merge',
          description: '将两条重复或相关的记忆合并为一条规范记录，旧记忆自动被取代。',
          parameters: {
            sourceId: { type: 'string', required: true, description: '待合并/被取代的记忆 ID' },
            targetId: { type: 'string', required: true, description: '保留并吸收证据的目标记忆 ID' },
            reason: { type: 'string', description: '合并原因说明' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, explicitSessionId } = resolveRuntimeScope(exec);
            return tools.merge(args, { workspaceId: cwd, sessionId: explicitSessionId });
          },
        })
      );

      // tool 7: memory (统一工具，汲取自 LZMW/dsh-memory 单工具设计，极大节省提示词空间)
      addDisp(
        ctx.tools.register({
          name: 'memory',
          description:
            '长期记忆统一集成工具 (支持 search, expand, note, feedback, confirm, merge, core_read, core_set, core_append, reconcile, doctor, heal, init)。',
          parameters: {
            action: {
              type: 'string',
              required: true,
              description:
                '操作类型: search | expand | note | feedback | confirm | merge | core_read | core_set | core_append | reconcile | doctor | heal | init',
            },
            query: { type: 'string', description: '搜索关键词 (action=search 时使用)' },
            id: { type: 'string', description: '记忆 ID (action=expand/feedback/confirm 时使用)' },
            sourceId: { type: 'string', description: '待合并的源记忆 ID (action=merge 时使用)' },
            targetId: { type: 'string', description: '目标记忆 ID (action=merge 时使用)' },
            content: {
              type: 'string',
              description: '备忘/核心块/调和正文 (action=note/core_set/reconcile 时使用)',
            },
            kind: {
              type: 'string',
              description: '备忘类型: fact | preference | procedure (action=note 时使用)',
            },
            contentRev: { type: 'integer', description: '正文修订号 (action=feedback 时使用)' },
            helpful: { type: 'boolean', description: '是否有帮助 (action=feedback 时使用)' },
            limit: { type: 'number', description: '返回结果数量限制' },
            block: {
              type: 'string',
              description: '核心块名称 (human | persona | project, action=core_* 时使用)',
            },
            text: { type: 'string', description: '追加文本 (action=core_append 时使用)' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, sessId, turn } = resolveRuntimeScope(exec);
            return tools.unified(args, { workspaceId: cwd, sessionId: sessId, turn });
          },
        })
      );

      // tool 8: memory_core (汲取自 Letta/MemGPT 核心工作区自编辑)
      addDisp(
        ctx.tools.register({
          name: 'memory_core',
          description:
            '读取核心记忆块，或提出等待用户审批的修改 (human 用户画像, persona 智能体准则, project 项目规则)。',
          parameters: {
            action: { type: 'string', required: true, description: '操作: read | set | append' },
            block: {
              type: 'string',
              description: '核心块名称: human | persona | project (默认 project)',
            },
            content: { type: 'string', description: '设置的内容 (action=set 时使用)' },
            text: { type: 'string', description: '追加的内容 (action=append 时使用)' },
          },
          output: {
            schema: { type: 'string' },
            render: (_args: any, value: string) => [{ type: 'text', text: value }],
          },
          execute: async (args: any, exec: any) => {
            const { cwd, explicitSessionId } = resolveRuntimeScope(exec);
            if (args.action === 'read') return tools.coreRead({ block: args.block }, { workspaceId: cwd });
            if (args.action === 'set')
              return tools.coreSet(
                { block: args.block || 'project', content: args.content || '' },
                { workspaceId: cwd, sessionId: explicitSessionId }
              );
            if (args.action === 'append')
              return tools.coreAppend(
                { block: args.block || 'project', text: args.text || args.content || '' },
                { workspaceId: cwd, sessionId: explicitSessionId }
              );
            return `Error: unknown action '${args.action}'. Supported: read, set, append`;
          },
        })
      );
    }

    // 6. 初始化并注册用户命令 /memory
    const commands = new MemoryCommands(currentDb, cfg);

    if (ctx.commands?.register) {
      addDisp(
        ctx.commands.register({
          name: 'memory',
          description: '长期记忆系统管理与状态检查',
          input: {
            hint: 'init | stats | doctor | heal | inspect <id> | list [page] | confirm <id> | merge <src> <tgt> | restore <id> | core [block] [text] | reconcile <text> | graph [id|limit] | export-md <dir> | import-md <dir> | export-bank [dir] | import-bank [dir] | migrate <fmt> <path> | history <id> | rollback <id> <v> | forget <id> | pin <id> | unpin <id> | freeze <id> | unfreeze <id> | approve <id> | pending | approve-repair <id> | reject-repair <id> | evolve | strategy [list|rollback <v>] | backfill [--dry-run] | eval [suite] | budget | export <path> | import <path>',
          },
          handler: ({ agent, session, rawInput }: any) => {
            const { cwd, sessId } = resolveRuntimeScope({ agent, session });
            return commands.handleCommand(rawInput, {
              workspaceId: cwd,
              sessionId: sessId,
            });
          },
        })
      );
    }

    // 6.2 注册 turn-stopping 全自动闭环调度监听器
    let lastTurnWeaveAt = 0;
    unlistenTurnStopping =
      typeof ctx.on === 'function'
        ? ctx.on('agent/turn-stopping', (evt: any) => {
            try {
              const now = Date.now();
              const liveCfg = getLiveCfg();
              const session = evt?.session || evt?.agent?.session;
              const sessId =
                (typeof evt?.sessionId === 'string' && evt.sessionId.trim()) ||
                (typeof session?.id === 'string' && session.id.trim()) ||
                undefined;
              const { cwd: rawCwd } = resolveRuntimeScope({
                agent: evt?.agent,
                session,
                sessionId: sessId,
                cwd: evt?.cwd,
                workspaceId: evt?.workspaceId,
              });
              if (isWorkspaceExcluded(rawCwd, liveCfg.excludeWorkspaces)) return;
              const wsId =
                (typeof evt?.workspaceId === 'string' && evt.workspaceId.trim()
                  ? workspaceId(evt.workspaceId.trim())
                  : '') || workspaceId(rawCwd);

              if (sessId) {
                const eligible =
                  findEligibleDistillSession(currentDb, liveCfg, true, sessId) ||
                  findEligibleDistillSession(currentDb, liveCfg, true);
                if (eligible) {
                  const distillCwd =
                    eligible.sessionId === sessId
                      ? rawCwd
                      : eligible.workspaceId ||
                        resolveSessionWorkspaceId(currentDb, eligible.sessionId) ||
                        rawCwd;
                  if (!isWorkspaceExcluded(distillCwd, liveCfg.excludeWorkspaces)) {
                    localScheduler.enqueue('distill', `${eligible.sessionId}:seq:${eligible.minSeq}`, {
                      sessionId: eligible.sessionId,
                      cwd: distillCwd,
                    });
                  }
                }
              }
              const clusters = findConsolidationClusters(currentDb, wsId, liveCfg);
              if (clusters.length > 0) {
                const bucket1h = Math.floor(now / 3600_000);
                localScheduler.enqueue('consolidate', `auto_consolidate:${wsId}:${bucket1h}`, {
                  workspaceId: wsId,
                });
              }

              // 节流执行本地无效记忆清理与 A-Mem 双链织网 (至少间隔 60s)，每 10 分钟时间桶自动排队一次后台自愈与 LLM 记忆审阅淘汰
              if (now - lastTurnWeaveAt >= 60_000) {
                lastTurnWeaveAt = now;
                pruneInvalidMemories(currentDb, { workspaceId: wsId, now });
                weaveZettelkastenLinks(currentDb, { workspaceId: wsId, maxNewLinks: 15, now });
              }
              const bucket10m = Math.floor(now / 600_000);
              localScheduler.enqueue('maintain', `auto_maintain:${bucket10m}`, {
                auto: true,
                workspaceId: wsId,
                cwd: rawCwd,
              });

              localScheduler.scheduleTurnStopping();
            } catch {}
          })
        : () => {};

    // 6.3 注册 Web 端点（供 DSH 前端侧栏面板访问）
    unlistenWeb = registerWebRoutes(ctx, currentDb, cfg);
    if (disposed) {
      await cleanup(true);
    }
  } catch (err: any) {
    console.warn('[dsh-memory] Initialization failed (gracefully degraded):', err?.message || err);
    await cleanup();
  }
}

export default {
  name,
  inject,
  Config,
  apply,
};
