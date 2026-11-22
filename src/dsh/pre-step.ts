import crypto from 'node:crypto';
import type { Db } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { estimateTokens } from '../core/tokens.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import { getActiveStrategy } from '../evolution/strategy.js';
import { evaluateTurnOutcome } from '../evolution/outcome.js';
import type { PromptSectionManager } from './prompt-section.js';
import { isIgnoredUserMessageSource } from './session-listener.js';
import { isResolvedScopeExcluded, resolveRuntimeScope } from './scope-resolver.js';

export interface PreStepContext {
  db: Db;
  promptSections: PromptSectionManager;
  cfg?: PluginConfig;
  getCfg?: () => PluginConfig;
  strategyVersion?: number;
  getVisibleRefs?: (session: any) => Set<string> | null;
  flushIngest?: () => Promise<unknown>;
}

type CreateUserMessageFn = (content: any, options?: Record<string, any>) => any;

const DSH_LLM_MODULE = '@deepseek-ai/dsh-llm';
let cachedCreateUserMessage: CreateUserMessageFn | null | undefined;
let resolvingCreateUserMessage: Promise<CreateUserMessageFn | null> | null = null;

async function resolveCreateUserMessage(): Promise<CreateUserMessageFn | null> {
  if (cachedCreateUserMessage !== undefined) {
    return cachedCreateUserMessage;
  }
  if (!resolvingCreateUserMessage) {
    resolvingCreateUserMessage = import(DSH_LLM_MODULE)
      .then((mod: any) => {
        const fn = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : null;
        cachedCreateUserMessage = fn;
        return fn;
      })
      .catch(() => {
        cachedCreateUserMessage = null;
        return null;
      });
  }
  return resolvingCreateUserMessage;
}

function deepFreezeMessage(msg: any): any {
  if (!msg || typeof msg !== 'object') return msg;
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part === 'object' && !Object.isFrozen(part)) {
        Object.freeze(part);
      }
    }
    if (!Object.isFrozen(msg.content)) {
      Object.freeze(msg.content);
    }
  }
  if (msg.source && typeof msg.source === 'object' && !Object.isFrozen(msg.source)) {
    Object.freeze(msg.source);
  }
  return Object.isFrozen(msg) ? msg : Object.freeze(msg);
}

async function buildMemoryUserMessage(
  block: string,
  frozenSource: Record<string, any>
): Promise<any> {
  const frozenContent = Object.freeze([Object.freeze({ type: 'text' as const, text: block })]);
  const createUserMessage = await resolveCreateUserMessage();

  if (createUserMessage) {
    try {
      const created = createUserMessage(frozenContent, { source: frozenSource });
      if (created && typeof created === 'object') {
        const normalized = {
          ...created,
          id: typeof created.id === 'string' && created.id ? created.id : crypto.randomUUID(),
          role: 'user' as const,
          content: Array.isArray(created.content) ? created.content : frozenContent,
          source: frozenSource,
        };
        return deepFreezeMessage(normalized);
      }
    } catch {
      // Fall back cleanly if host helper signature differs
    }
  }

  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: frozenContent,
    source: frozenSource,
  });
}

function resolveStrategySafe(db: Db, cfg: PluginConfig) {
  try {
    return getActiveStrategy(db, cfg);
  } catch {
    return null;
  }
}

/**
 * agent/pre-step 注入处理函数 (§6.3)
 */
export async function handlePreStep(
  payload: any,
  next: () => Promise<any>,
  ctx: PreStepContext
): Promise<any> {
  const cfg = ctx.getCfg ? ctx.getCfg() : ctx.cfg || DEFAULTS;
  const now = Date.now();

  // 1. 先跑下游 waterfall，拿到完整的 claimed 批次
  let decision: any;
  try {
    decision = await next();
  } catch (err: any) {
    console.warn('[dsh-memory] Downstream pre-step failed:', err?.message || err);
    throw err;
  }

  // 若下游取消或并非 enter，直接返回
  if (
    !decision ||
    decision.kind !== 'enter' ||
    !Array.isArray(decision.messages) ||
    payload?.signal?.aborted
  ) {
    return decision;
  }

  // 2. 插件停用或降级检查
  if (!cfg.enabled) {
    return decision;
  }

  try {
    // 3. 累积提取本步所有真实用户消息与最近工具调用（不覆盖早前的多条用户消息）
    const userTexts: string[] = [];
    const recentToolNames: string[] = [];

    for (const msg of decision.messages) {
      const source = msg?.source;
      // 跳过插件自身及运行时/时间/技能目录快照回声
      if (
        source?.kind === 'dsh-memory' ||
        (source?.kind === 'plugin' && source?.plugin === 'dsh-memory')
      ) {
        continue;
      }
      if (isIgnoredUserMessageSource(source)) continue;

      if (msg.role === 'user' && source?.kind === 'user') {
        let textBlock = '';
        if (Array.isArray(msg.content)) {
          textBlock = msg.content
            .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n')
            .trim();
        } else if (typeof msg.content === 'string') {
          textBlock = msg.content.trim();
        } else if (typeof msg.text === 'string') {
          textBlock = msg.text.trim();
        }
        if (textBlock) {
          userTexts.push(textBlock);
        }
      } else if (msg.role === 'tool' || msg.toolName) {
        const name = msg.toolName || msg.source?.toolName;
        if (name) recentToolNames.push(name);
      }
    }

    const userText = userTexts.join('\n');

    // 若当前步骤没有真实用户输入（例如中间工具调用步），跳过 flushIngest 与 updateSection 直接放行
    if (!userText.trim()) {
      return decision;
    }

    // 4. 解析作用域与 session 信息：绝不静默回退 process.cwd()
    const session = payload?.session || payload?.agent?.session;
    const scope = resolveRuntimeScope(
      undefined,
      ctx.db,
      {
        agent: payload?.agent,
        session,
        sessionId: payload?.sessionId,
        cwd: payload?.cwd,
        workspaceId: payload?.workspaceId,
        turn: payload?.turn,
      },
      { allowCwdFallback: false }
    );

    if (scope.resolved && isResolvedScopeExcluded(scope, cfg.excludeWorkspaces, ctx.db)) {
      return decision;
    }

    const sessionId = scope.sessId;
    const wsId = scope.resolved ? scope.workspaceId : '';
    const turn = scope.turn;
    const agentId = payload?.agent?.id || 'default_agent';

    // 5. 更新 / 刷新该 agent 的稳定层（PromptSectionManager 内部按 SQL 指纹缓存）
    const stableState = ctx.promptSections.updateSection(payload?.agent, {
      workspaceId: wsId,
      sessionId,
    });

    // 摄入落库失败（如库被占用）不应连带跳过本步召回
    try {
      await ctx.flushIngest?.();
    } catch {}

    // 6. 收集当前已注入集合 (包括 session 历史注入与本次稳定层引用)
    const alreadyInjected = new Set<string>();

    // A. 稳定层可见引用
    const stableRefs = stableState.visibleRefs.size > 0
      ? stableState.visibleRefs
      : ctx.promptSections.getVisibleRefs(agentId);
    for (const ref of stableRefs) {
      alreadyInjected.add(ref);
    }

    // B. Only committed messages still visible in the host surface suppress injection.
    const visibleRefs = ctx.getVisibleRefs?.(session);
    if (visibleRefs === null) return decision;
    for (const ref of visibleRefs || []) alreadyInjected.add(ref);

    // 7. 统一使用 budgetTokens 口径计算动态层可用预算 (stable.stableTokens 与 hardBudgetTokens 同量纲)
    const activeStrat = resolveStrategySafe(ctx.db, cfg);
    const strategyDynamicBudget =
      cfg.dynamicBudgetTokens === 0
        ? 0
        : Math.min(
            activeStrat?.config.dynamicBudgetTokens ?? cfg.dynamicBudgetTokens ?? 1600,
            cfg.dynamicBudgetTokens ?? 1600
          );
    const stableTokens = stableState.stableTokens;
    const hardBudget = cfg.hardBudgetTokens ?? 3200;
    const dynamicBudget = Math.min(strategyDynamicBudget, hardBudget - stableTokens);

    // 7.1 1-based 轮次延迟评估：仅当 turn > 1 且上一轮存在未归因注入或原始事件时，通过微任务异步评估，不阻塞本轮召回
    const scheduleOutcomeEvaluation = () => {
      if (turn <= 1) return;
      const prevTurn = turn - 1;
      try {
        const hasPrevWork = Boolean(
          ctx.db.get<{ ok: number }>(
            'SELECT 1 AS ok FROM injections WHERE session_id = ? AND turn = ? AND outcome IS NULL LIMIT 1',
            [sessionId, prevTurn]
          ) ||
            ctx.db.get<{ ok: number }>(
              'SELECT 1 AS ok FROM raw_events WHERE session_id = ? AND turn = ? LIMIT 1',
              [sessionId, prevTurn]
            )
        );
        if (!hasPrevWork) return;
        const evalPayload = {
          sessionId,
          turn: prevTurn,
          nextUserMessage: userText,
          cwd: scope.workspacePath || scope.cwd || undefined,
        };
        queueMicrotask(() => {
          try {
            evaluateTurnOutcome(ctx.db, evalPayload, cfg);
          } catch {}
        });
      } catch {}
    };

    if (dynamicBudget <= 0) {
      scheduleOutcomeEvaluation();
      return decision;
    }

    // 8. 构建查询并召回
    const plan = buildQueryPlan({
      userText,
      recentToolNames,
      now,
      cfg,
    });

    const recallResult = recall(ctx.db, plan, {
      workspaceId: wsId,
      sessionId,
      budget: dynamicBudget,
      alreadyInjected,
      strategyVersion: ctx.strategyVersion,
      now,
      cfg,
    });

    // 召回完成后异步派发上一轮结果评估，绝不增加在线召回延迟
    scheduleOutcomeEvaluation();

    const strategyVersion =
      recallResult.strategyVersion ??
      ctx.strategyVersion ??
      activeStrat?.version ??
      1;

    const queryTokens = estimateTokens(userText);
    const candidatesCount = recallResult.candidatesCount ?? recallResult.items.length;

    // 8.1 记录轮次遥测指标 (供 Sentinel 监控与离线策略实验室使用)
    try {
      ctx.db.run(
        `INSERT INTO turn_metrics (
          session_id, turn, query_tokens, candidates, injected, inject_tokens, latency_ms, correction, strategy_v, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(session_id, turn) DO UPDATE SET
          query_tokens = excluded.query_tokens,
          candidates = excluded.candidates,
          injected = excluded.injected,
          inject_tokens = excluded.inject_tokens,
          latency_ms = excluded.latency_ms,
          strategy_v = excluded.strategy_v
        WHERE turn_metrics.injected = 0 OR excluded.injected > 0`,
        [
          sessionId,
          turn,
          queryTokens,
          candidatesCount,
          0,
          0,
          recallResult.latencyMs,
          strategyVersion,
          now,
        ]
      );
    } catch {}

    if (!recallResult.block || recallResult.items.length === 0) {
      return decision;
    }

    // 10. 构造 DSH v4 不可变注入消息（遵循 NOTES.md:24 producer-owned source 契约）
    const frozenMemoryRefs = Object.freeze(
      recallResult.items.map((it) =>
        Object.freeze({
          id: it.memory.id,
          contentRev: it.memory.content_rev,
        })
      )
    );
    const frozenSource = Object.freeze({
      kind: 'dsh-memory' as const,
      plugin: 'dsh-memory',
      memoryRefs: frozenMemoryRefs,
      memoryInjection: Object.freeze({
        turn,
        strategyVersion,
        items: Object.freeze(
          recallResult.items.map((item) =>
            Object.freeze({ tokens: item.tokens, form: item.form })
          )
        ),
      }),
    });

    const memoryMsg = await buildMemoryUserMessage(recallResult.block, frozenSource);

    return {
      ...decision,
      messages: [...decision.messages, memoryMsg],
    };
  } catch (err: any) {
    console.warn('[dsh-memory] pre-step injection failed (gracefully degraded):', err?.message || err);
    return decision;
  }
}

/**
 * 注册 pre-step 监听器
 */
export function registerPreStep(
  ctx: any,
  preStepCtx: PreStepContext
): () => void {
  return ctx.on(
    'agent/pre-step',
    async (payload: any, next: () => Promise<any>) => {
      return handlePreStep(payload, next, preStepCtx);
    },
    { prepend: true }
  );
}
