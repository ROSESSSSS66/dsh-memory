import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { MemoryTools } from './tools.js';
import { isResolvedScopeExcluded, resolveRuntimeScope } from './scope-resolver.js';

export const REGISTERED_MEMORY_TOOL_NAMES = [
  'memory_search',
  'memory_expand',
  'memory_feedback',
  'memory_note',
] as const;

export interface ToolRegistryDeps {
  db: Db;
  tools: MemoryTools;
  getLiveCfg: () => PluginConfig;
}

function safeToolExecute(
  handler: (args: any, exec: any) => string | Promise<string>
): (args: any, exec: any) => Promise<string> {
  return async (args: any, exec: any) => {
    if (exec?.signal?.aborted) {
      return 'Aborted.';
    }
    try {
      const result = await handler(args ?? {}, exec);
      return typeof result === 'string' ? result : String(result);
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory tool execution failed'}`;
    }
  };
}

/**
 * 向 DSH 注册 4 个精简、强校验的 LLM 工具（Option A）：
 * - memory_search
 * - memory_expand
 * - memory_feedback
 * - memory_note
 * 严禁向 LLM 暴露 memory_confirm / memory_merge / memory_core 或 16 参数 mega-tool。
 */
export function registerMemoryTools(ctx: any, deps: ToolRegistryDeps): () => void {
  if (!ctx?.tools?.register) {
    return () => {};
  }

  const disposers: Array<() => void> = [];
  const disposeAll = () => {
    for (const d of disposers.splice(0, disposers.length)) {
      try {
        d();
      } catch {}
    }
  };

  const addDisp = (d: unknown) => {
    if (typeof d === 'function') {
      disposers.push(d as () => void);
    }
  };

  const renderTextOutput = {
    schema: { type: 'string' },
    render: (_args: any, value: string) => [{ type: 'text', text: value }],
  };

  try {
    // Tool 1: memory_search
    // Note: ctx.tools.register() forwards `parameters` verbatim as raw JSON Schema (unlike defineTool()),
    // and @deepseek-ai/dsh-tools enforces a strict JSON Schema subset (no minimum/maximum/minLength/maxLength).
    addDisp(
      ctx.tools.register({
        name: 'memory_search',
        description:
          'Search long-term memory for facts, preferences, skills, or past lessons (only when not already present in memory_context).',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search keywords or question (1-500 chars)' },
            network: {
              type: 'string',
              enum: ['world', 'experience', 'observation', 'opinion'],
              description: 'Optional Hindsight cognitive network filter',
            },
            uriPrefix: {
              type: 'string',
              description: 'Optional OpenViking URI prefix filter (e.g. viking://workspace/memories/skills)',
            },
            tier: {
              type: 'string',
              enum: ['L0', 'L1', 'L2'],
              description: 'Output granularity: L0 (abstract, default), L1 (overview), or L2 (content)',
            },
            limit: {
              type: 'integer',
              description: 'Maximum results to return (1-12, default 5)',
            },
          },
          required: ['query'],
        },
        output: renderTextOutput,
        execute: safeToolExecute((args, exec) => {
          const liveCfg = deps.getLiveCfg();
          const scope = resolveRuntimeScope(ctx, deps.db, exec, { allowCwdFallback: false });
          if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, deps.db)) {
            return 'Error: workspace is excluded by privacy configuration.';
          }
          return deps.tools.search(args, {
            workspaceId: scope.resolved ? scope.cwd : '',
            sessionId: scope.sessId,
            turn: scope.turn,
          });
        }),
      })
    );

    // Tool 2: memory_expand
    addDisp(
      ctx.tools.register({
        name: 'memory_expand',
        description:
          'Expand a memory item by full/short ID or viking:// URI at L0 (abstract), L1 (overview), or L2 (full content + sources).',
        parameters: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Full memory ID, short code (e.g. m_ab12), or viking:// URI',
            },
            tier: {
              type: 'string',
              enum: ['L0', 'L1', 'L2'],
              description: 'Detail tier: L0, L1, or L2 (default L2)',
            },
          },
          required: ['id'],
        },
        output: renderTextOutput,
        execute: safeToolExecute((args, exec) => {
          const liveCfg = deps.getLiveCfg();
          const scope = resolveRuntimeScope(ctx, deps.db, exec, { allowCwdFallback: false });
          if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, deps.db)) {
            return 'Error: workspace is excluded by privacy configuration.';
          }
          return deps.tools.expand(args, {
            workspaceId: scope.resolved ? scope.cwd : '',
            sessionId: scope.explicitSessionId,
            turn: scope.turn,
          });
        }),
      })
    );

    // Tool 3: memory_feedback
    addDisp(
      ctx.tools.register({
        name: 'memory_feedback',
        description:
          'Report whether a referenced memory was helpful or unhelpful in the current session (once per memory revision).',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory full or short ID' },
            contentRev: { type: 'integer', description: 'Referenced content revision number (>= 1)' },
            helpful: { type: 'boolean', description: 'True if helpful, false if unhelpful/wrong' },
            note: { type: 'string', description: 'Optional brief feedback note (max 300 chars)' },
          },
          required: ['id', 'contentRev', 'helpful'],
        },
        output: renderTextOutput,
        execute: safeToolExecute((args, exec) => {
          const liveCfg = deps.getLiveCfg();
          const scope = resolveRuntimeScope(ctx, deps.db, exec, { allowCwdFallback: false });
          if (!scope.resolved && !scope.explicitSessionId) {
            return 'Error: workspace or session scope could not be resolved; refusing mutation.';
          }
          if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, deps.db)) {
            return 'Error: workspace is excluded by privacy configuration.';
          }
          return deps.tools.feedback(args, {
            ...(scope.resolved ? { workspaceId: scope.cwd } : {}),
            sessionId: scope.explicitSessionId || scope.sessId,
            turn: scope.turn,
          });
        }),
      })
    );

    // Tool 4: memory_note
    addDisp(
      ctx.tools.register({
        name: 'memory_note',
        description:
          'Save a candidate memory note for user approval (8-400 chars; rate-limited to 3 per turn).',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Concise memory content (8-400 chars)',
            },
            type: {
              type: 'string',
              enum: ['semantic', 'preference', 'procedural', 'failure', 'episodic', 'belief', 'goal'],
              description: 'Memory category (default semantic)',
            },
            scope: {
              type: 'string',
              enum: ['workspace', 'session', 'user'],
              description: 'Visibility scope (default workspace)',
            },
          },
          required: ['content'],
        },
        output: renderTextOutput,
        execute: safeToolExecute((args, exec) => {
          const liveCfg = deps.getLiveCfg();
          const scope = resolveRuntimeScope(ctx, deps.db, exec, { allowCwdFallback: false });
          const requestedScope = typeof args?.scope === 'string' ? args.scope : 'workspace';

          // Fail closed: 写操作在既无工作区也无会话（或需要工作区但未解析出工作区）时一律拒绝
          if (!scope.resolved && !scope.explicitSessionId) {
            return 'Error: workspace or session scope could not be resolved; refusing mutation.';
          }
          if ((requestedScope === 'workspace' || requestedScope === 'session') && !scope.resolved) {
            return 'Error: workspace scope could not be resolved; refusing mutation.';
          }
          if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, deps.db)) {
            return 'Error: workspace is excluded by privacy configuration.';
          }

          return deps.tools.note(args, {
            workspaceId: scope.cwd,
            sessionId: scope.explicitSessionId || scope.sessId,
            turn: scope.turn,
          });
        }),
      })
    );
  } catch (err) {
    disposeAll();
    throw err;
  }

  return disposeAll;
}
