import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DEFAULTS, validateConfig, loadConfigFromDb, type PluginConfig } from '../config.js';
import { openDb } from '../core/db.js';
import { IngestQueue } from '../ingest/queue.js';
import { registerSessionListener } from './session-listener.js';
import { PromptSectionManager } from './prompt-section.js';
import { registerPreStep } from './pre-step.js';
import { registerTurnStopping } from './turn-stopping.js';
import { MemoryTools } from './tools.js';
import { MemoryCommands } from './commands.js';
import { workspaceId } from '../core/scope.js';
import { JobScheduler, recoverJobsOnStartup } from '../jobs/scheduler.js';
import { registerJobHandler } from '../jobs/runner.js';
import { distillSession } from '../evolution/extractor.js';
import { runReflectJob } from '../evolution/reflector.js';
import { findConsolidationClusters, consolidateCluster } from '../evolution/consolidator.js';
import { executeRepair } from '../evolution/repair.js';
import { runStrategyEvolution, checkSentinelAndRollback } from '../evolution/lab.js';
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  checkAndRepairFts,
  cleanOldTelemetry,
} from '../evolution/maintenance.js';
import { registerWebRoutes } from './web.js';
import { backfillMissingEmbeddings } from '../core/vector.js';
import { weaveZettelkastenLinks } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import type { Db } from '../types.js';

export const name = 'dsh-memory';
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'commands', 'webServer'];

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

export function apply(ctx: any, config?: Partial<PluginConfig> & { autoBootstrap?: boolean }) {
  let db: Db | undefined;
  let promptSections: PromptSectionManager | undefined;
  let queue: IngestQueue | undefined;

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
    const currentDb: Db = db;

    // 合并存储中的用户自定义动态配置 (LLM 配置、风控与隐私选项)
    const cfg = loadConfigFromDb(currentDb, initialCfg);

    console.log('[dsh-memory] Plugin initialized with database at:', dbPath);

    // 1.1 启动恢复与首次安装冷启动自动记忆初始化 (v0.4.0 Auto-Bootstrap)
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
      }
      backfillMissingEmbeddings(currentDb, { limit: 200 });
    } catch {}

    // 1.2 初始化离线任务调度器与处理器
    const scheduler = new JobScheduler(currentDb, cfg);

    registerJobHandler('distill', async (job, signal) => {
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const res = await distillSession(currentDb, cfg, { sessionId: payload.sessionId, signal });
      if (!res.success) {
        return { action: 'failed', error: res.error || 'distill_failed', nonRetryable: true };
      }
      return { action: 'done' };
    });

    registerJobHandler('reflect', async (job, signal) => {
      return runReflectJob(currentDb, cfg, job, signal);
    });

    registerJobHandler('consolidate', async (job, signal) => {
      const payload = job.payload ? JSON.parse(job.payload) : {};
      const wsId = payload.workspaceId || workspaceId(process.cwd());
      const clusters = findConsolidationClusters(currentDb, wsId, cfg);
      for (const c of clusters) {
        const res = await consolidateCluster(currentDb, cfg, c, { signal });
        if (!res.success) {
          return { action: 'failed', error: res.error || 'consolidate_failed', nonRetryable: true };
        }
      }
      return { action: 'done' };
    });

    registerJobHandler('maintain', async () => {
      archiveColdMemories(currentDb, cfg);
      expireCandidates(currentDb);
      autoPinMemories(currentDb);
      checkAndRepairFts(currentDb);
      backfillMissingEmbeddings(currentDb, { limit: 500 });
      weaveZettelkastenLinks(currentDb, { maxNewLinks: 25 });
      cleanOldTelemetry(currentDb);
      checkSentinelAndRollback(currentDb);
      return { action: 'done' };
    });

    registerJobHandler('repair', async (job, signal) => {
      return executeRepair(
        currentDb,
        { id: job.id, key: job.key, payload: job.payload || '{}' },
        { signal },
        cfg
      );
    });

    registerJobHandler('evolve', async () => {
      runStrategyEvolution(currentDb, {}, cfg);
      return { action: 'done' };
    });

    // 2. 初始化摄入队列与 Session 事件监听器
    queue = new IngestQueue(currentDb, cfg);
    const unlistenSession = registerSessionListener(ctx, queue, cfg);

    // 2.1 监听上下文压力事件，自适应触发后台抽取 (汲取自 creativedswork/dsh-expmem)
    const unlistenPressure = ctx.on ? ctx.on('memory/context-pressure', (evt: any) => {
      if (evt?.sessionId) {
        scheduler.enqueue('distill', evt.sessionId, { sessionId: evt.sessionId });
      }
    }) : undefined;

    // 3. 初始化稳定层 Prompt Section 管理器
    promptSections = new PromptSectionManager(currentDb, cfg);

    // 4. 注册 pre-step 动态注入瀑布监听器
    const unlistenPreStep = registerPreStep(ctx, {
      db: currentDb,
      promptSections,
      cfg,
    });

    // 5. 初始化模型工具
    const tools = new MemoryTools({ db: currentDb, cfg });

    if (ctx.tools?.register) {
      // tool 1: memory_search
      ctx.tools.register({
        name: 'memory_search',
        description: '在长期记忆库中检索历史事实、配置与经验规则。注意：只有在当前系统提供的 memory_context 中找不到所需信息时才调用此工具。',
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
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          const sessId = agent?.session?.id || 'default_session';
          const turn = agent?.position?.turn ?? 0;
          return tools.search(args, { workspaceId: cwd, sessionId: sessId, turn });
        },
      });

      // tool 2: memory_expand
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
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          const sessId = agent?.session?.id || 'default_session';
          return tools.expand(args, { workspaceId: cwd, sessionId: sessId });
        },
      });

      // tool 3: memory_feedback
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
          const agent = exec?.agent || ctx.agent;
          const sessId = agent?.session?.id || 'default_session';
          const turn = agent?.position?.turn ?? 0;
          return tools.feedback(args, { sessionId: sessId, turn });
        },
      });

      // tool 4: memory_note
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
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          const sessId = agent?.session?.id || 'default_session';
          const turn = agent?.position?.turn ?? 0;
          return tools.note(args, { workspaceId: cwd, sessionId: sessId, turn });
        },
      });

      // tool 5: memory_confirm (汲取自 tr1v3r/dsh-ltm)
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
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          return tools.confirm(args, { workspaceId: cwd });
        },
      });

      // tool 6: memory_merge (汲取自 tr1v3r/dsh-ltm)
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
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          return tools.merge(args, { workspaceId: cwd });
        },
      });

      // tool 7: memory (统一工具，汲取自 LZMW/dsh-memory 单工具设计，极大节省提示词空间)
      ctx.tools.register({
        name: 'memory',
        description: '长期记忆统一集成工具 (支持 search, expand, note, feedback, confirm, merge, core_read, core_set, core_append, reconcile, doctor, heal, init)。',
        parameters: {
          action: {
            type: 'string',
            required: true,
            description: '操作类型: search | expand | note | feedback | confirm | merge | core_read | core_set | core_append | reconcile | doctor | heal | init',
          },
          query: { type: 'string', description: '搜索关键词 (action=search 时使用)' },
          id: { type: 'string', description: '记忆 ID (action=expand/feedback/confirm 时使用)' },
          sourceId: { type: 'string', description: '待合并的源记忆 ID (action=merge 时使用)' },
          targetId: { type: 'string', description: '目标记忆 ID (action=merge 时使用)' },
          content: { type: 'string', description: '备忘/核心块/调和正文 (action=note/core_set/reconcile 时使用)' },
          kind: { type: 'string', description: '备忘类型: fact | preference | procedure (action=note 时使用)' },
          contentRev: { type: 'integer', description: '正文修订号 (action=feedback 时使用)' },
          helpful: { type: 'boolean', description: '是否有帮助 (action=feedback 时使用)' },
          limit: { type: 'number', description: '返回结果数量限制' },
          block: { type: 'string', description: '核心块名称 (human | persona | project, action=core_* 时使用)' },
          text: { type: 'string', description: '追加文本 (action=core_append 时使用)' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: any, value: string) => [{ type: 'text', text: value }],
        },
        execute: async (args: any, exec: any) => {
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          const sessId = agent?.session?.id || 'default_session';
          const turn = agent?.position?.turn ?? 0;
          return tools.unified(args, { workspaceId: cwd, sessionId: sessId, turn });
        },
      });

      // tool 8: memory_core (汲取自 Letta/MemGPT 核心工作区自编辑)
      ctx.tools.register({
        name: 'memory_core',
        description: '读写常驻模型上下文的核心记忆块 (human 用户画像, persona 智能体准则, project 项目强制规则)。',
        parameters: {
          action: { type: 'string', required: true, description: '操作: read | set | append' },
          block: { type: 'string', description: '核心块名称: human | persona | project (默认 project)' },
          content: { type: 'string', description: '设置的内容 (action=set 时使用)' },
          text: { type: 'string', description: '追加的内容 (action=append 时使用)' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: any, value: string) => [{ type: 'text', text: value }],
        },
        execute: async (args: any, exec: any) => {
          const agent = exec?.agent || ctx.agent;
          const cwd = agent?.cwd || process.cwd();
          if (args.action === 'read') return tools.coreRead({ block: args.block }, { workspaceId: cwd });
          if (args.action === 'set') return tools.coreSet({ block: args.block || 'project', content: args.content || '' }, { workspaceId: cwd });
          if (args.action === 'append') return tools.coreAppend({ block: args.block || 'project', text: args.text || args.content || '' }, { workspaceId: cwd });
          return `Error: unknown action '${args.action}'. Supported: read, set, append`;
        },
      });
    }

    // 6. 初始化并注册用户命令 /memory
    const commands = new MemoryCommands(currentDb, cfg);

    if (ctx.commands?.register) {
      ctx.commands.register({
        name: 'memory',
        description: '长期记忆系统管理与状态检查',
        input: { hint: 'init | stats | doctor | heal | inspect <id> | list | confirm <id> | merge <src> <tgt> | graph | export-md <path> | import-md <path> | forget <id> | pin <id> | unpin <id> | freeze <id> | unfreeze <id> | approve <id> | pending' },
        handler: ({ agent, rawInput }: any) => {
          const cwd = agent?.cwd || process.cwd();
          const sessId = agent?.session?.id || 'default_session';
          return commands.handleCommand(rawInput, {
            workspaceId: cwd,
            sessionId: sessId,
          });
        },
      });
    }

    // 6.2 注册 turn-stopping 延迟调度监听器
    const unlistenTurnStopping = registerTurnStopping(ctx, scheduler);

    // 6.3 注册 Web 端点（供 DSH 前端侧栏面板访问）
    const unlistenWeb = registerWebRoutes(ctx, currentDb, cfg);

    // 7. 卸载与清理
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        try {
          unlistenWeb();
          unlistenTurnStopping();
          unlistenSession();
          if (unlistenPressure) unlistenPressure();
          unlistenPreStep();
          scheduler.stop();
          promptSections?.disposeAll();
          db?.close();
          console.log('[dsh-memory] Plugin disposed cleanly');
        } catch {}
      });
    }
  } catch (err: any) {
    console.warn('[dsh-memory] Initialization failed (gracefully degraded):', err?.message || err);
  }
}

export default {
  name,
  inject,
  Config,
  apply,
};
