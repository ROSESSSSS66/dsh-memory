import crypto from 'node:crypto';
import type { Db, MemoryRecord } from '../types.js';
import { scopeFilterSQL } from '../core/scope.js';
import { render } from '../retrieval/render.js';
import { budgetTokens, estimateTokens } from '../core/tokens.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export interface StableSectionState {
  disposer?: () => void;
  lastHash?: string;
  visibleRefs: Set<string>; // id@contentRev
  stableTokens: number;
  estimatedTokens: number;
}

/**
 * 渲染稳定层内容 (§5.10, §6.4)
 * 1. 当前 scope 内 pinned=1 且 status 为 active/frozen 的记录，排除 meta
 * 2. 按 id 排序（保证前缀缓存命中稳定）
 * 3. 超出 cfg.stableBudgetTokens (默认 600) 时按 utility 从低到高剔除
 * 4. 最终选出的记录按 id 升序排列并渲染成 layer="stable" 的 memory_context
 */
export function renderStableLayer(
  db: Db,
  ctx: { workspaceId: string; sessionId?: string },
  cfg: PluginConfig = DEFAULTS,
  strategyVersion: number = 1
): { text: string; visibleRefs: Set<string>; stableTokens: number; estimatedTokens: number } {
  try {
    const maxStableTokens = Math.min(cfg.stableBudgetTokens ?? 600, cfg.hardBudgetTokens ?? 3200);
    if (maxStableTokens <= 0) {
      return { text: '', visibleRefs: new Set(), stableTokens: 0, estimatedTokens: 0 };
    }
    const scope = scopeFilterSQL({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId || '',
    });

    const rows = db.all<MemoryRecord>(
      `SELECT * FROM memories
       WHERE ${scope.sql}
         AND pinned = 1
         AND status IN ('active', 'frozen')
         AND type != 'meta'
       ORDER BY id ASC`,
      scope.params
    );

    if (!rows || rows.length === 0) {
      return { text: '', visibleRefs: new Set(), stableTokens: 0, estimatedTokens: 0 };
    }

    const sortedByUtil = [...rows].sort((a, b) => a.utility - b.utility);
    const renderSuffix = (offset: number) => {
      const selected = sortedByUtil.slice(offset).sort((a, b) => a.id.localeCompare(b.id));
      const text = render(
        selected.map(memory => ({ memory, form: 'content' as const })),
        { strategyVersion, layer: 'stable', db, scopeCtx: ctx }
      );
      return { selected, text, tokens: budgetTokens(text) };
    };

    // Removing lowest-utility records only reduces size, including short-code lengths.
    // Find the first fitting suffix without re-rendering once per discarded record.
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (renderSuffix(mid).tokens <= maxStableTokens) high = mid;
      else low = mid + 1;
    }
    const { selected, text: currentText, tokens: currentTokens } = renderSuffix(low);

    const visibleRefs = new Set<string>();
    for (const m of selected) {
      visibleRefs.add(`${m.id}@${m.content_rev}`);
    }

    return {
      text: currentText,
      visibleRefs,
      stableTokens: currentTokens,
      estimatedTokens: estimateTokens(currentText),
    };
  } catch (err: any) {
    console.warn('[dsh-memory] renderStableLayer failed (degrading to empty):', err?.message || err);
    return { text: '', visibleRefs: new Set(), stableTokens: 0, estimatedTokens: 0 };
  }
}

/**
 * 为指定 agent 实例注册 / 刷新稳定层 prompt section
 */
export class PromptSectionManager {
  private db: Db;
  private cfg: PluginConfig;
  // agentId -> state
  private agentStates = new Map<string, StableSectionState>();

  constructor(db: Db, cfg: PluginConfig = DEFAULTS) {
    this.db = db;
    this.cfg = cfg;
  }

  public updateSection(
    agent: any,
    scopeCtx: { workspaceId: string; sessionId?: string }
  ): StableSectionState {
    const agentId = agent?.id || 'default_agent';
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = { visibleRefs: new Set(), stableTokens: 0, estimatedTokens: 0 };
      this.agentStates.set(agentId, state);
    }

    const { text, visibleRefs, stableTokens, estimatedTokens } = renderStableLayer(
      this.db,
      scopeCtx,
      this.cfg
    );

    const hash = crypto.createHash('sha256').update(text).digest('hex');

    // 只有文本 hash 发生变化时才注销重注
    if (hash === state.lastHash && state.disposer) {
      state.visibleRefs = visibleRefs;
      state.stableTokens = stableTokens;
      state.estimatedTokens = estimatedTokens;
      return state;
    }

    // 撤销旧 section
    if (state.disposer) {
      try {
        state.disposer();
      } catch {}
      state.disposer = undefined;
    }

    state.lastHash = undefined;
    state.visibleRefs = new Set();
    state.stableTokens = 0;
    state.estimatedTokens = 0;

    // 注册到 agent.ctx.systemPrompt
    if (agent?.ctx?.systemPrompt?.section) {
      try {
        state.disposer = agent.ctx.systemPrompt.section({
          name: 'memory-stable',
          order: 3000,
          text,
          interpolate: false, // 严禁插值，防止用户记忆中的 {{ }} 破坏组装
        });
        state.lastHash = hash;
        state.visibleRefs = visibleRefs;
        state.stableTokens = stableTokens;
        state.estimatedTokens = estimatedTokens;
      } catch (err: any) {
        console.warn('[dsh-memory] Failed to register memory-stable section:', err?.message || err);
      }
    }

    return state;
  }

  public getVisibleRefs(agentId: string): Set<string> {
    return this.agentStates.get(agentId)?.visibleRefs || new Set();
  }

  public getStableTokens(agentId: string): number {
    return this.agentStates.get(agentId)?.stableTokens || 0;
  }

  public getStableEstimatedTokens(agentId: string): number {
    const state = this.agentStates.get(agentId);
    return state?.estimatedTokens ?? state?.stableTokens ?? 0;
  }

  public disposeAgent(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state?.disposer) {
      try {
        state.disposer();
      } catch {}
    }
    this.agentStates.delete(agentId);
  }

  public disposeAll(): void {
    for (const [id] of this.agentStates) {
      this.disposeAgent(id);
    }
  }
}
