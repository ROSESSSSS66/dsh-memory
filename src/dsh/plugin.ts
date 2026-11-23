import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfigFromDb, type PluginConfig, validateConfig } from '../config.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import { openDb } from '../core/db.js';
import { findEligibleDistillSession } from '../evolution/extractor.js';
import { IngestQueue } from '../ingest/queue.js';
import { JobRunner } from '../jobs/runner.js';
import { JobScheduler, recoverJobsOnStartup } from '../jobs/scheduler.js';
import type { Db } from '../types.js';
import { getMemoryCommandHint, MemoryCommands } from './commands.js';
import { registerPluginJobHandlers } from './job-handlers.js';
import { type MemoryVisibilityReader, registerMemoryVisibility } from './memory-visibility.js';
import { registerPreStep } from './pre-step.js';
import { PromptSectionManager } from './prompt-section.js';
import {
  extractAgentCwd,
  isResolvedScopeExcluded,
  isWorkspaceOrMappedExcluded,
  observeWorkspacePath,
  resolveRuntimeScope,
  resolveSessionWorkspaceId,
} from './scope-resolver.js';
import { registerSessionListener } from './session-listener.js';
import { registerMemoryTools } from './tool-registry.js';
import { MemoryTools } from './tools.js';
import { registerWebRoutes } from './web.js';

export const name = 'dsh-memory';
// P0 修复：移除 top-level 'commands' 强依赖，使 headless / CLI / ACP 宿主可通过延迟 ctx.inject(['commands'], ...) 正常加载插件
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools'];

const LIVE_CONFIG_CACHE_TTL_MS = 2000;
const DEFERRED_STARTUP_DELAY_MS = 1500;

type WebRouteOptions = {
  scheduler?: JobScheduler;
  initialCfg?: PluginConfig;
  getLiveCfg?: () => PluginConfig;
  onConfigUpdated?: (nextCfg: PluginConfig) => void;
  activeWorkspaces?: () => string[];
};

type RegisterWebRoutesFn = (
  webCtx: any,
  db: Db,
  cfg: PluginConfig,
  options?: WebRouteOptions
) => () => void | Promise<void>;

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

export async function apply(
  ctx: any,
  config?: Partial<PluginConfig> & { autoBootstrap?: boolean }
) {
  let db: Db | undefined;
  let promptSections: PromptSectionManager | undefined;
  let queue: IngestQueue | undefined;
  let scheduler: JobScheduler | undefined;
  let unregisterJobHandlers: (() => void) | undefined;
  let unlistenSession: (() => void) | undefined;
  let unlistenPressure: (() => void) | undefined;
  let unlistenAgentDisposed: (() => void) | undefined;
  let visibility: MemoryVisibilityReader | undefined;
  let unlistenPreStep: (() => void) | undefined;
  let unlistenTurnStopping: (() => void) | undefined;
  let unlistenWeb: (() => void | Promise<void>) | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const regDisposers: Array<() => void | Promise<void>> = [];
  let disposed = false;
  let cleanupPromise: Promise<void> | undefined;

  const addDisp = (d: unknown) => {
    if (typeof d === 'function') {
      regDisposers.push(d as () => void | Promise<void>);
    }
  };

  const cleanup = (logClean = false): Promise<void> => {
    disposed = true;
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        // 1. 取消延迟启动任务，停止接收新请求与新事件
        if (startupTimer !== undefined) {
          clearTimeout(startupTimer);
          startupTimer = undefined;
        }

        const webUnlisten = unlistenWeb;
        unlistenWeb = undefined;
        if (webUnlisten) {
          try {
            await Promise.resolve(webUnlisten());
          } catch {}
        }

        for (const disp of regDisposers.splice(0, regDisposers.length)) {
          try {
            await Promise.resolve(disp());
          } catch {}
        }

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
        try {
          promptSections?.disposeAll();
        } catch {}

        // 2. 等待实例级 JobScheduler 优雅收敛并注销实例级任务处理器
        if (scheduler) {
          try {
            await scheduler.stopAndWait();
          } catch {}
          scheduler = undefined;
        }
        try {
          unregisterJobHandlers?.();
        } catch {}
        unregisterJobHandlers = undefined;

        // 3. 落盘并关闭摄入队列（必须在关闭 DB 之前完成）
        if (queue) {
          try {
            await queue.flush();
          } catch {}
          try {
            await queue.close();
          } catch {}
          queue = undefined;
        }

        // 4. 所有异步写路径全部停止后才关闭 SQLite
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
      // 验收项 5: 数据库无法打开时优雅降级，不阻断 DSH 对话
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

    // 动态配置共享引用 + 短 TTL 缓存 + onConfigUpdated 即时失效
    const cfg: PluginConfig = loadConfigFromDb(currentDb, initialCfg);
    let lastCfgLoadAt = Date.now();

    const syncSharedCfg = (nextCfg: PluginConfig): PluginConfig => {
      Object.assign(cfg, nextCfg);
      lastCfgLoadAt = Date.now();
      return cfg;
    };

    const getLiveCfg = (): PluginConfig => {
      const now = Date.now();
      if (now - lastCfgLoadAt < LIVE_CONFIG_CACHE_TTL_MS) {
        return cfg;
      }
      const loaded = loadConfigFromDb(currentDb, initialCfg);
      return syncSharedCfg(loaded);
    };

    const onConfigUpdated = (nextCfg: PluginConfig): void => {
      syncSharedCfg(nextCfg);
    };

    console.log('[dsh-memory] Plugin initialized with database at:', dbPath);

    // 1.1 启动恢复：只做轻量僵尸任务恢复，绝不在启动主路径同步运行全局 autoHeal / 重型 backfill
    recoverJobsOnStartup(currentDb);

    // 1.2 实例隔离的离线任务执行器与调度器（绝不污染全局 defaultJobRunner）
    const localRunner = new JobRunner();
    const localScheduler = new JobScheduler(currentDb, cfg, { runner: localRunner });
    scheduler = localScheduler;
    unregisterJobHandlers = registerPluginJobHandlers(localRunner, {
      db: currentDb,
      ctx,
      getLiveCfg,
      scheduler: localScheduler,
      dbPath,
    });

    // 1.3 冷启动自动初始化：
    // - 显式 autoBootstrap: true（例如测试或首次初始化）同步执行轻量 seed（不阻塞全盘回填），重型回填交由后台任务
    // - 默认路径自动冷启动延迟至 .unref() 定时器后台触发，避免拖慢插件冷启动
    const resolveStartupWsPath = (): string => {
      try {
        const rawBase = typeof ctx?.get === 'function' ? ctx.get('baseDir') : ctx?.baseDir;
        if (typeof rawBase === 'string' && rawBase.trim() && fs.existsSync(rawBase.trim())) {
          return rawBase.trim();
        }
      } catch {}
      return process.cwd();
    };
    const startupWsPath = resolveStartupWsPath();
    const isDefaultDbPath = !initialCfg.dbPath && !initialCfg.dataDir;

    const runLightweightBootstrap = (wsPath: string) => {
      try {
        const liveCfg = getLiveCfg();
        if (isWorkspaceOrMappedExcluded(wsPath, liveCfg.excludeWorkspaces, currentDb)) {
          return;
        }
        const bootRes = autoBootstrapMemory(currentDb, {
          workspacePath: wsPath,
          cfg: liveCfg,
          includeBackfill: false,
        });
        if (!bootRes.alreadyInitialized) {
          console.log(
            `[dsh-memory] Auto-initialized workspace memory (core=${
              bootRes.coreBlocksInitialized.join(',') || 'ready'
            }, seeded=${bootRes.workspaceMemoriesSeeded}, links=${bootRes.linksWeaved})`
          );
          const hasBackfillWatermark = Boolean(
            currentDb.get<{ value: string }>(
              "SELECT value FROM meta WHERE key = 'bootstrap_backfill_v1'"
            )
          );
          if (!hasBackfillWatermark) {
            localScheduler.enqueue('backfill', `auto_bootstrap_backfill:${bootRes.workspaceId}`, {
              auto: true,
              workspaceId: bootRes.workspaceId,
            });
          }
        }
      } catch {}
    };

    if (config?.autoBootstrap === true) {
      runLightweightBootstrap(startupWsPath);
    } else if (isDefaultDbPath && config?.autoBootstrap !== false) {
      startupTimer = setTimeout(() => {
        startupTimer = undefined;
        if (disposed) return;
        runLightweightBootstrap(startupWsPath);
      }, DEFERRED_STARTUP_DELAY_MS);
      startupTimer.unref?.();
    }

    // 2. 初始化摄入队列（携带 onJobEnqueued 主动唤醒本地调度器）与 Session 事件监听器
    const localQueue = new IngestQueue(currentDb, cfg, {
      onJobEnqueued: () => localScheduler.notifyPending(),
    });
    queue = localQueue;
    unlistenSession = registerSessionListener(ctx, localQueue, getLiveCfg, currentDb);

    // 2.1 监听上下文压力事件，自适应触发后台抽取
    unlistenPressure =
      typeof ctx.on === 'function'
        ? ctx.on('memory/context-pressure', (evt: any) => {
            if (!evt?.sessionId) return;
            try {
              const liveCfg = getLiveCfg();
              const scope = resolveRuntimeScope(
                ctx,
                currentDb,
                {
                  agent: evt?.agent,
                  session: evt?.session,
                  sessionId: evt.sessionId,
                  cwd: evt?.cwd,
                  workspaceId: evt?.workspaceId,
                },
                { allowCwdFallback: false }
              );
              if (
                scope.resolved &&
                isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, currentDb)
              ) {
                return;
              }
              const eligible = findEligibleDistillSession(currentDb, liveCfg, true, evt.sessionId);
              const minSeq = eligible?.minSeq ?? 1;
              const rawCwd = scope.workspacePath || scope.cwd || eligible?.workspaceId || '';
              if (
                rawCwd &&
                isWorkspaceOrMappedExcluded(rawCwd, liveCfg.excludeWorkspaces, currentDb)
              ) {
                return;
              }
              localScheduler.enqueue('distill', `${evt.sessionId}:seq:${minSeq}`, {
                sessionId: evt.sessionId,
                ...(rawCwd ? { cwd: rawCwd } : {}),
                ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
              });
            } catch {}
          })
        : undefined;

    // 3. 初始化稳定层 Prompt Section 管理器（支持实时配置与快速 SQL 指纹缓存）
    promptSections = new PromptSectionManager(currentDb, cfg, getLiveCfg);
    unlistenAgentDisposed =
      typeof ctx.on === 'function'
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
      getCfg: getLiveCfg,
      getVisibleRefs: (session) => visibility?.getVisibleRefs(session) ?? null,
      flushIngest: () => localQueue.flush(),
    });

    // 4.1 预同步当前已存活 agent、后续 agent/created 及 system-prompt/assemble 时的稳定层 section
    const syncAgentPromptSection = (agent: any) => {
      if (!agent || !promptSections) return undefined;
      const liveCfg = getLiveCfg();
      const scope = resolveRuntimeScope(ctx, currentDb, { agent }, { allowCwdFallback: false });
      if (!scope.resolved || isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, currentDb)) {
        if (typeof agent.id === 'string' && agent.id) {
          promptSections.disposeAgent(agent.id);
        }
        return undefined;
      }
      return promptSections.updateSection(agent, {
        workspaceId: scope.workspaceId,
        sessionId: scope.sessId,
      });
    };

    try {
      const liveAgents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
      if (Array.isArray(liveAgents)) {
        for (const agent of liveAgents) {
          try {
            syncAgentPromptSection(agent);
          } catch {}
        }
      }
    } catch {}

    if (typeof ctx.on === 'function') {
      addDisp(
        ctx.on('agent/created', (evt: any) => {
          try {
            const agent = evt?.agent ?? (evt?.id ? evt : undefined);
            syncAgentPromptSection(agent);
          } catch (err: any) {
            console.warn('[dsh-memory] agent/created section sync failed:', err?.message || err);
          }
        })
      );

      addDisp(
        ctx.on(
          'system-prompt/assemble',
          async (assembly: any, assembleCtx: any, next: () => Promise<any>) => {
            try {
              const scopeObj =
                assembleCtx?.scope && typeof assembleCtx.scope === 'object'
                  ? assembleCtx.scope
                  : undefined;
              const agent =
                assembleCtx?.agent ??
                (scopeObj?.ctx?.systemPrompt ||
                scopeObj?.session ||
                typeof scopeObj?.id === 'string'
                  ? scopeObj
                  : undefined) ??
                (typeof assembleCtx?.agentId === 'string' && typeof ctx.agents?.get === 'function'
                  ? ctx.agents.get(assembleCtx.agentId)
                  : undefined);

              if (agent && promptSections && Array.isArray(assembly?.sections)) {
                const liveCfg = getLiveCfg();
                const scope = resolveRuntimeScope(
                  ctx,
                  currentDb,
                  { agent },
                  { allowCwdFallback: false }
                );
                const existingIdx = assembly.sections.findIndex(
                  (s: any) => s && s.name === 'memory-stable'
                );

                if (
                  !scope.resolved ||
                  isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, currentDb)
                ) {
                  if (existingIdx >= 0) {
                    assembly.sections.splice(existingIdx, 1);
                  }
                } else {
                  // 在 assemble 瀑布中仅更新缓存状态并修补 assembly.sections，绝不重复修改全局 section() 注册
                  const synced = promptSections.syncAssemblyState(agent, {
                    workspaceId: scope.workspaceId,
                    sessionId: scope.sessId,
                  });
                  const stableText = synced.text || '';
                  if (stableText) {
                    const entry = {
                      name: 'memory-stable',
                      text: stableText,
                      interpolate: false,
                    };
                    if (existingIdx >= 0) {
                      assembly.sections[existingIdx] = {
                        ...assembly.sections[existingIdx],
                        ...entry,
                      };
                    } else {
                      const trailingIdx = assembly.sections.findIndex(
                        (s: any) =>
                          s &&
                          (s.name === 'mcp:servers' ||
                            s.name === 'harness:source' ||
                            s.name === 'web-surface' ||
                            s.name === 'deployment:persona-suffix')
                      );
                      if (trailingIdx >= 0) {
                        assembly.sections.splice(trailingIdx, 0, entry);
                      } else {
                        assembly.sections.push(entry);
                      }
                    }
                  } else if (existingIdx >= 0) {
                    assembly.sections.splice(existingIdx, 1);
                  }
                }
              }
            } catch {}

            if (typeof next === 'function') {
              const result = await next();
              return result ?? assembly;
            }
            return assembly;
          },
          { prepend: true }
        )
      );
    }

    // 5. 初始化并注册 4 个精简 LLM 工具（Option A：memory_search / memory_expand / memory_feedback / memory_note）
    const tools = new MemoryTools({ db: currentDb, cfg, getCfg: getLiveCfg });
    addDisp(
      registerMemoryTools(ctx, {
        db: currentDb,
        tools,
        getLiveCfg,
      })
    );

    // 6. 初始化并延迟注册用户命令 /memory（无 commands 服务的 CLI/headless/ACP 宿主安全降级）
    const commands = new MemoryCommands(currentDb, cfg, getLiveCfg);
    const mountCommands = (cmdCtx: any): (() => void) => {
      if (!cmdCtx?.commands?.register) return () => {};
      let cmdDisposed = false;
      let regDisp: unknown;
      try {
        regDisp = cmdCtx.commands.register({
          name: 'memory',
          description: '长期记忆系统管理与状态检查',
          input: {
            hint: getMemoryCommandHint(),
          },
          handler: ({ agent, session, rawInput }: any) => {
            const scope = resolveRuntimeScope(
              cmdCtx,
              currentDb,
              { agent, session },
              { allowCwdFallback: true }
            );
            return commands.handleCommand(rawInput, {
              workspaceId: scope.cwd,
              ...(scope.workspacePath ? { cwd: scope.workspacePath } : {}),
              sessionId: scope.explicitSessionId,
            });
          },
        });
      } catch (err: any) {
        console.warn('[dsh-memory] Failed to register /memory command:', err?.message || err);
      }
      return () => {
        if (cmdDisposed) return;
        cmdDisposed = true;
        try {
          if (typeof regDisp === 'function') regDisp();
        } catch {}
      };
    };

    if (typeof ctx.inject === 'function') {
      addDisp(
        ctx.inject(['commands'], (cmdCtx: any) => {
          const disp = mountCommands(cmdCtx);
          addDisp(disp);
          try {
            if (typeof cmdCtx?.effect === 'function') {
              cmdCtx.effect(() => disp);
            }
          } catch {}
        })
      );
    } else {
      try {
        if (typeof ctx.commands?.register === 'function') {
          addDisp(mountCommands(ctx));
        }
      } catch {}
    }

    // 6.2 注册极速非阻塞 turn-stopping 调度监听器 (< 1ms，仅入队后台任务，严禁同步清理/反思/织网/同步目录树)
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
              const scope = resolveRuntimeScope(
                ctx,
                currentDb,
                {
                  agent: evt?.agent,
                  session,
                  sessionId: sessId,
                  cwd: evt?.cwd,
                  workspaceId: evt?.workspaceId,
                },
                { allowCwdFallback: false }
              );
              if (
                !scope.resolved ||
                isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, currentDb)
              ) {
                return;
              }
              const wsId = scope.workspaceId;
              const rawCwd = scope.workspacePath || scope.cwd;

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
                  if (
                    !isWorkspaceOrMappedExcluded(distillCwd, liveCfg.excludeWorkspaces, currentDb)
                  ) {
                    localScheduler.enqueue(
                      'distill',
                      `${eligible.sessionId}:seq:${eligible.minSeq}`,
                      {
                        sessionId: eligible.sessionId,
                        cwd: distillCwd,
                      }
                    );
                  }
                }
              }

              const bucket1h = Math.floor(now / 3600_000);
              localScheduler.enqueue('consolidate', `auto_consolidate:${wsId}:${bucket1h}`, {
                workspaceId: wsId,
              });

              const bucket10m = Math.floor(now / 600_000);
              localScheduler.enqueue('maintain', `auto_maintain:${wsId}:${bucket10m}`, {
                auto: true,
                workspaceId: wsId,
                cwd: rawCwd,
              });

              localScheduler.scheduleTurnStopping();
            } catch {}
          })
        : () => {};

    // 6.3 注册 Web 端点（传入 scheduler / initialCfg / getLiveCfg / onConfigUpdated / activeWorkspaces 契约）
    const activeWorkspaces = (): string[] => {
      const wsSet = new Set<string>();
      try {
        const liveCfg = getLiveCfg();
        const liveAgents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
        if (Array.isArray(liveAgents)) {
          for (const agent of liveAgents) {
            const rawCwd = extractAgentCwd(agent);
            if (!rawCwd) continue;
            if (isWorkspaceOrMappedExcluded(rawCwd, liveCfg.excludeWorkspaces, currentDb)) continue;
            const wsId = observeWorkspacePath(currentDb, rawCwd);
            if (wsId) wsSet.add(wsId);
          }
        }
      } catch {}
      return Array.from(wsSet);
    };

    const webRouteOptions: WebRouteOptions = {
      scheduler: localScheduler,
      initialCfg,
      getLiveCfg,
      onConfigUpdated,
      activeWorkspaces,
    };
    const registerWeb: RegisterWebRoutesFn = registerWebRoutes;

    if (typeof ctx.inject === 'function') {
      unlistenWeb = ctx.inject(['webServer'], (webCtx: any) => {
        const disp = registerWeb(webCtx, currentDb, cfg, webRouteOptions);
        addDisp(disp);
        try {
          if (typeof webCtx?.effect === 'function') {
            webCtx.effect(() => disp);
          }
        } catch {}
      });
    } else {
      try {
        if (typeof ctx.webServer?.register === 'function') {
          unlistenWeb = registerWeb(ctx, currentDb, cfg, webRouteOptions);
        }
      } catch {}
    }

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
