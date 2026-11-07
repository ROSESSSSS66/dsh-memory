import crypto from 'node:crypto';
import type { Db } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { workspaceId } from '../core/scope.js';
import { isWorkspaceExcluded } from '../core/privacy.js';
import { estimateTokens } from '../core/tokens.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import { getActiveStrategy } from '../evolution/strategy.js';
import { evaluateTurnOutcome } from '../evolution/outcome.js';
import type { PromptSectionManager } from './prompt-section.js';

export interface PreStepContext {
  db: Db;
  promptSections: PromptSectionManager;
  cfg?: PluginConfig;
  strategyVersion?: number;
}

/**
 * agent/pre-step 注入处理函数 (§6.3)
 */
export async function handlePreStep(
  payload: any,
  next: () => Promise<any>,
  ctx: PreStepContext
): Promise<any> {
  const cfg = ctx.cfg || DEFAULTS;
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
  if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
    return decision;
  }

  // 2. 插件停用或降级检查
  if (!cfg.enabled) {
    return decision;
  }

  try {
    // 3. 解析作用域与 session 信息
    const session = payload?.session || payload?.agent?.session;
    const cwd = session?.cwd || session?.workspaceId || payload?.agent?.cwd || process.cwd();

    if (isWorkspaceExcluded(cwd, cfg.excludeWorkspaces)) {
      return decision;
    }

    const wsId = workspaceId(cwd);
    const sessionId = session?.id || payload?.sessionId || 'default_session';
    const turn = typeof payload?.turn === 'number' ? payload.turn : 0;
    const agentId = payload?.agent?.id || 'default_agent';

    // 4. 更新 / 刷新该 agent 的稳定层
    ctx.promptSections.updateSection(payload?.agent, {
      workspaceId: wsId,
      sessionId,
    });

    // 5. 提取真实用户文本与最近工具调用
    let userText = '';
    const recentToolNames: string[] = [];

    for (const msg of decision.messages) {
      const source = msg?.source;
      // 跳过插件自身或运行时上下文回声
      if (source?.kind === 'plugin' && source?.plugin === 'dsh-memory') continue;
      if (source?.kind === 'runtime-context') continue;

      if (msg.role === 'user' && source?.kind === 'user') {
        if (Array.isArray(msg.content)) {
          const textBlock = msg.content
            .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b: any) => b.text)
            .join('\n');
          if (textBlock) userText = textBlock;
        } else if (typeof msg.content === 'string') {
          userText = msg.content;
        } else if (typeof msg.text === 'string') {
          userText = msg.text;
        }
      } else if (msg.role === 'tool' || msg.toolName) {
        const name = msg.toolName || msg.source?.toolName;
        if (name) recentToolNames.push(name);
      }
    }

    // 5.1 若当前为后续轮次且有用户输入，评估上一轮结果 (§5.9)
    if (turn > 0 && userText.trim()) {
      try {
        evaluateTurnOutcome(ctx.db, { sessionId, turn: turn - 1, nextUserMessage: userText, cwd }, cfg);
      } catch {}
    }

    // 若当前步骤没有真实用户输入，不需要检索注入
    if (!userText.trim()) {
      return decision;
    }

    // 6. 收集当前已注入集合 (包括 session 历史注入与本次稳定层引用)
    const alreadyInjected = new Set<string>();

    // A. 稳定层可见引用
    const stableRefs = ctx.promptSections.getVisibleRefs(agentId);
    for (const ref of stableRefs) {
      alreadyInjected.add(ref);
    }

    // B. 本 session 历史注入
    const historyRows = ctx.db.all<{ memory_id: string; content_rev: number }>(
      'SELECT memory_id, content_rev FROM injections WHERE session_id = ?',
      [sessionId]
    );
    for (const row of historyRows) {
      alreadyInjected.add(`${row.memory_id}@${row.content_rev}`);
    }

    // 7. 计算动态层可用预算 (统一采用 estimateTokens 估值口径，避免 UTF-8 字节数与 token 预算混淆)
    const stableTokens =
      typeof ctx.promptSections.getStableEstimatedTokens === 'function'
        ? ctx.promptSections.getStableEstimatedTokens(agentId)
        : ctx.promptSections.getStableTokens(agentId);
    const hardBudget = cfg.hardBudgetTokens || 3200;
    const dynamicBudget = Math.min(cfg.dynamicBudgetTokens || 1600, hardBudget - stableTokens);

    if (dynamicBudget <= 0) {
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

    const strategyVersion =
      recallResult.strategyVersion ??
      ctx.strategyVersion ??
      getActiveStrategy(ctx.db, cfg).version;

    const queryTokens = estimateTokens(userText);
    const candidatesCount = recallResult.candidatesCount ?? recallResult.items.length;
    const injectedCount = recallResult.items.length;
    const injectTokens = recallResult.items.reduce((acc, it) => acc + (it.tokens || 0), 0);

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
          strategy_v = excluded.strategy_v`,
        [
          sessionId,
          turn,
          queryTokens,
          candidatesCount,
          injectedCount,
          injectTokens,
          recallResult.latencyMs,
          strategyVersion,
          now,
        ]
      );
    } catch {}

    if (!recallResult.block || recallResult.items.length === 0) {
      return decision;
    }

    // 9. 记录注入与更新使用计数
    ctx.db.transaction(() => {
      recallResult.items.forEach((item, idx) => {
        const m = item.memory;
        ctx.db.run(
          `INSERT OR IGNORE INTO injections (
            session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
          ) VALUES (?, ?, ?, ?, 'dynamic', ?, ?, ?, ?, ?)`,
          [
            sessionId,
            turn,
            m.id,
            m.content_rev,
            idx + 1,
            item.tokens,
            item.form,
            strategyVersion,
            now,
          ]
        );

        ctx.db.run(
          `UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`,
          [now, m.id]
        );
      });
    });

    // 10. 构造注入消息并追加到 decision.messages 尾部（遵循 §A.6.3 宿主消息不可变性契约）
    const frozenContent = Object.freeze([
      Object.freeze({ type: 'text' as const, text: recallResult.block }),
    ]);
    const frozenMemoryRefs = Object.freeze(
      recallResult.items.map((it) =>
        Object.freeze({
          id: it.memory.id,
          contentRev: it.memory.content_rev,
        })
      )
    );
    const frozenSource = Object.freeze({
      kind: 'plugin' as const,
      plugin: 'dsh-memory',
      memoryRefs: frozenMemoryRefs,
    });
    const memoryMsg = Object.freeze({
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: frozenContent,
      source: frozenSource,
    });

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
