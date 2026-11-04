import crypto from 'node:crypto';
import type { Db, MemoryRecord } from '../types.js';
import { scopeFilterSQL } from '../core/scope.js';
import { render } from '../retrieval/render.js';
import { budgetTokens } from '../core/tokens.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export interface StableSectionState {
  disposer?: () => void;
  lastHash?: string;
  visibleRefs: Set<string>; // id@contentRev
  stableTokens: number;
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
): { text: string; visibleRefs: Set<string>; stableTokens: number } {
  try {
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
      return { text: '', visibleRefs: new Set(), stableTokens: 0 };
    }

    // 装箱预算检查
    let selected = [...rows];
    const maxStableTokens = cfg.stableBudgetTokens || 600;

    // 先测试全选时预算
    let currentText = render(
      selected.map((m) => ({ memory: m, form: 'content' as const })),
      { strategyVersion, layer: 'stable', db, scopeCtx: ctx }
    );
    let currentTokens = budgetTokens(currentText);

    // 如果超预算，按 utility 从低到高剔除，直到符合预算
    if (currentTokens > maxStableTokens) {
      // 保持原有顺序索引，按 utility 升序排剔除队列
      const sortedByUtil = [...selected].sort((a, b) => a.utility - b.utility);

      while (sortedByUtil.length > 0 && currentTokens > maxStableTokens) {
        const toRemove = sortedByUtil.shift()!;
        selected = selected.filter((m) => m.id !== toRemove.id);

        if (selected.length === 0) {
          currentText = '';
          currentTokens = 0;
          break;
        }

        // 重新按 id 升序排列
        selected.sort((a, b) => a.id.localeCompare(b.id));
        currentText = render(
          selected.map((m) => ({ memory: m, form: 'content' as const })),
          { strategyVersion, layer: 'stable', db, scopeCtx: ctx }
        );
        currentTokens = budgetTokens(currentText);
      }
    }

    const visibleRefs = new Set<string>();
    for (const m of selected) {
      visibleRefs.add(`${m.id}@${m.content_rev}`);
    }

    return {
      text: currentText,
      visibleRefs,
      stableTokens: currentTokens,
    };
  } catch (err: any) {
    console.warn('[dsh-memory] renderStableLayer failed (degrading to empty):', err?.message || err);
    return { text: '', visibleRefs: new Set(), stableTokens: 0 };
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
      state = { visibleRefs: new Set(), stableTokens: 0 };
      this.agentStates.set(agentId, state);
    }

    const { text, visibleRefs, stableTokens } = renderStableLayer(
      this.db,
      scopeCtx,
      this.cfg
    );

    const hash = crypto.createHash('sha256').update(text).digest('hex');

    // 只有文本 hash 发生变化时才注销重注
    if (hash === state.lastHash && state.disposer) {
      state.visibleRefs = visibleRefs;
      state.stableTokens = stableTokens;
      return state;
    }

    // 撤销旧 section
    if (state.disposer) {
      try {
        state.disposer();
      } catch {}
      state.disposer = undefined;
    }

    state.lastHash = hash;
    state.visibleRefs = visibleRefs;
    state.stableTokens = stableTokens;

    // 注册到 agent.ctx.systemPrompt
    if (agent?.ctx?.systemPrompt?.section) {
      try {
        state.disposer = agent.ctx.systemPrompt.section({
          name: 'memory-stable',
          order: 3000,
          text,
          interpolate: false, // 严禁插值，防止用户记忆中的 {{ }} 破坏组装
        });
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
