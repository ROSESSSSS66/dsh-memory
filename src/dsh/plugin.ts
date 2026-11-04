import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DEFAULTS, validateConfig, type PluginConfig } from '../config.js';
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
import {
  archiveColdMemories,
  expireCandidates,
  autoPinMemories,
  checkAndRepairFts,
  cleanOldTelemetry,
} from '../evolution/maintenance.js';
import type { Db } from '../types.js';

export const name = 'dsh-memory';
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'commands'];

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

export function apply(ctx: any, config?: Partial<PluginConfig>) {
  let db: Db | undefined;
  let promptSections: PromptSectionManager | undefined;
  let queue: IngestQueue | undefined;

  try {
    const cfg = validateConfig(config);
    if (!cfg.enabled) {
      console.log('[dsh-memory] Plugin is disabled by configuration');
      return;
    }

    // 1. 打开数据库（支持配置 dbPath，默认 ~/.dsh/storages/dsh-memory/memory.db）
    const defaultDataDir = path.join(os.homedir(), '.dsh', 'storages', 'dsh-memory');
    const dataDir = cfg.dataDir || defaultDataDir;
    const dbPath = cfg.dbPath || path.join(dataDir, 'memory.db');
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

    console.log('[dsh-memory] Plugin initialized with database at:', dbPath);

    // 1.1 启动恢复：running 任务恢复为 failed，保留额度一致性
    recoverJobsOnStartup(currentDb);

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
      cleanOldTelemetry(currentDb);
      return { action: 'done' };
    });

    // 2. 初始化摄入队列与 Session 事件监听器
    queue = new IngestQueue(currentDb, cfg);
    const unlistenSession = registerSessionListener(ctx, queue, cfg);

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
    }

    // 6. 初始化并注册用户命令 /memory
    const commands = new MemoryCommands(currentDb, cfg);

    if (ctx.commands?.register) {
      ctx.commands.register({
        name: 'memory',
        description: '长期记忆系统管理与状态检查',
        input: { hint: 'stats | inspect <id> | list | forget <id> | pin <id> | unpin <id> | freeze <id> | unfreeze <id> | approve <id> | pending' },
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

    // 7. 卸载与清理
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        try {
          unlistenTurnStopping();
          unlistenSession();
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
