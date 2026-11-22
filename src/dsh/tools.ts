import fs from 'node:fs';
import * as z from 'zod';
import type { Db, MemoryRecord, MemoryType, Scope, VikingContextTier } from '../types.js';
import { get, sources } from '../core/store.js';
import { workspaceId, scopeFilterSQL } from '../core/scope.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import { getActiveStrategy } from '../evolution/strategy.js';
import { TAG_MAP, singleLine, escapeXmlData } from '../retrieval/render.js';
import { budgetTokens } from '../core/tokens.js';
import { redactSecrets } from '../core/privacy.js';
import { upsertCandidate, confirmMemory, mergeMemories } from '../core/writer.js';
import {
  getCoreMemory,
  getAllCoreMemories,
  setCoreMemory,
  appendCoreMemory,
  renderCoreMemoryMarkdown,
} from '../core/core-memory.js';
import { auditMemoryHealth, autoHealMemoryHealth } from '../core/health.js';
import { autoBootstrapMemory } from '../core/bootstrap.js';
import {
  parseHindsightNetwork,
  classifyHindsightNetwork,
  runHindsightReflect,
  formatHindsightReflectReport,
  traceHindsightEvolution,
} from '../core/hindsight.js';
import {
  resolveVikingUri,
  resolveVikingUrisBatch,
  normalizeVikingUriInput,
  resolveMemoryByVikingUriOrId,
  browseVikingDirectory,
  findInVikingTree,
  getVikingEvolutionDiff,
  formatVikingEvolutionDiff,
  buildInlineL1Overview,
  buildTieredMemoryView,
} from '../core/viking.js';
import { reconcileAndUpsert } from '../evolution/reconciler.js';
import { enqueueRepairJobIfEligible } from '../evolution/repair.js';
import { normalizeMemoryType } from '../service/index.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  isWorkspaceOrMappedExcluded,
  resolveSessionWorkspaceId,
} from './scope-resolver.js';

export interface ToolContext {
  db: Db;
  cfg?: PluginConfig;
  getCfg?: () => PluginConfig;
  strategyVersion?: number;
}

const MAX_RATE_LIMIT_ENTRIES = 500;
const NOTE_WINDOW_MS = 60_000;
const MAX_NOTES_PER_WINDOW = 3;
const MAX_L0_L1_EXPAND_TOKENS = 400;
const MAX_L2_EXPAND_TOKENS = 1500;
const MAX_SEARCH_OUTPUT_TOKENS = 800;

const TierSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.enum(['L0', 'L1', 'L2']));

const NetworkSchema = z
  .string()
  .trim()
  .refine((v) => parseHindsightNetwork(v) !== undefined, {
    message: 'network must be one of: world, experience, observation, opinion',
  })
  .transform((v) => parseHindsightNetwork(v)!);

const SearchParamsSchema = z.object({
  query: z.string().trim().min(1, 'query is required').max(500, 'query exceeds 500 characters'),
  limit: z.number().finite().int().min(1).max(12).optional(),
  types: z.array(z.string().trim().min(1)).max(16).optional(),
  network: NetworkSchema.optional(),
  uriPrefix: z.string().trim().max(300).optional(),
  tier: TierSchema.optional(),
});

const ExpandParamsSchema = z.object({
  id: z.string().trim().min(1, 'memory id is required').max(300),
  tier: TierSchema.optional(),
});

const FeedbackParamsSchema = z.object({
  id: z.string().trim().min(1, 'valid id and integer contentRev are required').max(300),
  contentRev: z
    .number({ message: 'valid id and integer contentRev are required' })
    .int('valid id and integer contentRev are required')
    .positive('valid id and integer contentRev are required')
    .max(Number.MAX_SAFE_INTEGER),
  helpful: z.boolean({ message: 'helpful must be a strict boolean' }),
  note: z.string().optional(),
});

const ALLOWED_NOTE_TYPES = [
  'semantic',
  'preference',
  'procedural',
  'failure',
  'episodic',
  'belief',
  'goal',
] as const;

const NoteParamsSchema = z.object({
  content: z
    .string()
    .trim()
    .min(8, 'content length must be between 8 and 400 characters')
    .max(400, 'content length must be between 8 and 400 characters'),
  type: z.string().trim().optional(),
  kind: z.enum(['fact', 'preference', 'procedure']).optional(),
  scope: z.enum(['workspace', 'session', 'user']).optional(),
});

const ConfirmParamsSchema = z.object({
  id: z.string().trim().min(1, 'memory id is required').max(300),
});

const MergeParamsSchema = z.object({
  sourceId: z.string().trim().min(1, 'sourceId and targetId are required').max(300),
  targetId: z.string().trim().min(1, 'sourceId and targetId are required').max(300),
  reason: z.string().trim().max(300).optional(),
});

const CoreReadParamsSchema = z.object({
  block: z.string().trim().max(64).optional(),
});

const CoreSetParamsSchema = z.object({
  block: z.string().trim().min(1, 'both block and content are required').max(64),
  content: z.string().trim().min(1, 'both block and content are required').max(4000),
});

const CoreAppendParamsSchema = z.object({
  block: z.string().trim().min(1, 'both block and text are required').max(64),
  text: z.string().trim().min(1, 'both block and text are required').max(4000),
});

const ReconcileParamsSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'content is required for reconciliation')
    .max(2000, 'content too long for reconciliation (max 2000 characters)'),
  type: z.string().trim().optional(),
  slotKey: z.string().trim().max(120).optional(),
});

const TreeParamsSchema = z.object({
  uri: z.string().trim().max(300).optional(),
  query: z.string().trim().max(500).optional(),
  tier: TierSchema.optional(),
  limit: z.number().finite().int().min(1).max(25).optional(),
});

const ReflectParamsSchema = z.object({
  topic: z.string().trim().max(200).optional(),
  autoSynthesize: z.boolean().optional(),
  persistCalibration: z.boolean().optional(),
});

function formatZodError(err: z.ZodError): string {
  const first = err.issues[0];
  return `Error: ${first?.message || 'invalid input parameters'}`;
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (budgetTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = `${text.slice(0, mid).trimEnd()}…`;
    if (budgetTokens(candidate) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
}

function touchLruMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  if (map.size >= maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export class MemoryTools {
  private db: Db;
  private cfg: PluginConfig;
  private getCfg?: () => PluginConfig;
  private strategyVersion: number;
  // session:turn -> note call count (LRU bounded)
  private noteTurnCounts = new Map<string, number>();
  // sessionId -> timestamps within 60s window (fallback when turn === 0 / unavailable)
  private noteWindowTimestamps = new Map<string, number[]>();

  constructor(ctx: ToolContext) {
    this.db = ctx.db;
    this.cfg = ctx.cfg || DEFAULTS;
    this.getCfg = ctx.getCfg;
    this.strategyVersion = ctx.strategyVersion || 1;
  }

  private currentCfg(): PluginConfig {
    return this.getCfg ? this.getCfg() : this.cfg;
  }

  private isExcludedWorkspace(rawWs: string | undefined): boolean {
    const cfg = this.currentCfg();
    return isWorkspaceOrMappedExcluded(rawWs, cfg.excludeWorkspaces, this.db);
  }

  /**
   * 1. memory_search (§6.6 + Hindsight 4-Network & OpenViking URI / Tiered L0-L1-L2 Filter)
   */
  public search(
    params: {
      query: string;
      limit?: number;
      types?: string[];
      network?: string;
      uriPrefix?: string;
      tier?: VikingContextTier | string;
    },
    agentCtx: { workspaceId: string; sessionId: string; turn?: number }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = SearchParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const cfg = this.currentCfg();
    const { query: rawQuery, types, network: targetNet, uriPrefix } = parsed.data;
    const requestedTier: VikingContextTier = parsed.data.tier || 'L0';
    const limit = parsed.data.limit ?? 5;
    const now = Date.now();
    const wsId = workspaceId(agentCtx.workspaceId || '');
    const sessionId = agentCtx.sessionId || 'default_session';
    const turn = typeof agentCtx.turn === 'number' && Number.isFinite(agentCtx.turn) ? agentCtx.turn : 0;

    const plan = buildQueryPlan({
      userText: rawQuery,
      now,
      cfg,
    });

    let activeStrat: ReturnType<typeof getActiveStrategy>;
    try {
      activeStrat = getActiveStrategy(this.db, cfg);
    } catch {
      activeStrat = {
        version: this.strategyVersion,
        config: {
          rrfK: 25,
          channelWeights: { lexical: 1, entity: 1.2, typed: 0.8, temporal: 0.8, preference: 0.6, vector: 1 },
          scoreWeights: { relevance: 0.5, confidence: 0.14, utility: 0.14, freshness: 0.08, consistency: 0.06, specificity: 0.03, importance: 0.05 },
          minRelevance: 0.15,
          dynamicBudgetTokens: 1600,
          maxItems: 6,
        },
      };
    }

    const stratVer = activeStrat.version || this.strategyVersion;
    const normUriPrefix = uriPrefix ? normalizeVikingUriInput(uriPrefix) : null;
    const hasPostFilters = Boolean(
      (types && types.length > 0) || targetNet || (normUriPrefix && normUriPrefix !== 'viking://')
    );

    const searchStrategy = {
      ...activeStrat.config,
      maxItems: hasPostFilters ? Math.max(limit * 4, 32) : Math.max(limit, activeStrat.config.maxItems, 12),
      dynamicBudgetTokens: hasPostFilters ? 16_000 : 10_000,
    };
    const recallCfg: PluginConfig =
      cfg.dynamicBudgetTokens === 0
        ? { ...cfg, dynamicBudgetTokens: searchStrategy.dynamicBudgetTokens }
        : cfg;

    // 委托共享 recall()（享受 onlineBudgetMs、索引 UNION 矛盾查询、水合 origin_kinds、作用域隔离）
    const recallRes = recall(this.db, plan, {
      workspaceId: wsId,
      sessionId,
      budget: searchStrategy.dynamicBudgetTokens,
      alreadyInjected: new Set(),
      strategy: searchStrategy,
      strategyVersion: stratVer,
      now,
      cfg: recallCfg,
      onlineBudgetMs: cfg.onlineBudgetMs,
    });

    if (recallRes.items.length === 0) {
      return 'No relevant memories found.';
    }

    const candidateMemories = recallRes.items.map((it) => it.memory);
    const uriMap = resolveVikingUrisBatch(this.db, candidateMemories);
    const allowedTypes = types && types.length > 0 ? new Set(types.map((t) => t.toLowerCase())) : null;

    const filtered: MemoryRecord[] = [];
    for (const m of candidateMemories) {
      if (m.status !== 'active' && m.status !== 'frozen') continue;
      if (allowedTypes && !allowedTypes.has(m.type.toLowerCase())) continue;
      // 仅使用 classifyHindsightNetwork(m.type, m.slot_key) 过滤，防止 slot_key 重分类条目误入其他网络
      if (targetNet && classifyHindsightNetwork(m.type, m.slot_key) !== targetNet) continue;
      if (normUriPrefix && normUriPrefix !== 'viking://') {
        const memUri = (uriMap.get(m.id) || resolveVikingUri(m)).toLowerCase();
        if (!memUri.startsWith(normUriPrefix)) continue;
      }
      filtered.push(m);
      if (filtered.length >= limit) break;
    }

    if (filtered.length === 0) {
      return 'No relevant memories found.';
    }

    const lines: string[] = [];
    for (const m of filtered) {
      const tag = TAG_MAP[m.type] || 'FACT';
      if (requestedTier === 'L1') {
        const uri = uriMap.get(m.id) || resolveVikingUri(m);
        const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
        const l1Text = escapeXmlData(singleLine(redactSecrets(buildInlineL1Overview(m, 170)).text));
        lines.push(
          `[${tag} ${m.id}] (${net} · ${uri} · c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)}) ${l1Text}`
        );
      } else if (requestedTier === 'L2') {
        const cleanContent = escapeXmlData(singleLine(redactSecrets(m.content).text));
        lines.push(
          `[${tag} ${m.id}] ${cleanContent} (c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})`
        );
      } else {
        const cleanSummary = escapeXmlData(singleLine(redactSecrets(m.summary || m.content).text));
        lines.push(
          `[${tag} ${m.id}] ${cleanSummary} (c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})`
        );
      }
    }

    let output = lines.join('\n');
    while (lines.length > 0 && budgetTokens(output) > MAX_SEARCH_OUTPUT_TOKENS) {
      lines.pop();
      output = lines.join('\n');
    }
    if (!lines.length) {
      return `Error: memory summaries exceed token limit (${MAX_SEARCH_OUTPUT_TOKENS} tokens).`;
    }

    // 单事务原子记录实际返回的 tool 引用
    this.db.transaction(() => {
      for (let i = 0; i < lines.length; i++) {
        const m = filtered[i];
        this.db.run(
          `INSERT OR IGNORE INTO injections (
            session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
          ) VALUES (?, ?, ?, ?, 'tool', ?, ?, ?, ?, ?)`,
          [
            sessionId,
            turn,
            m.id,
            m.content_rev,
            i + 1,
            requestedTier === 'L2' ? m.token_cost : m.summary_cost,
            requestedTier === 'L2' ? 'content' : 'summary',
            stratVer,
            now,
          ]
        );
      }
    });

    return output;
  }

  /**
   * 2. memory_expand (§6.6 + OpenViking L0/L1/L2 分层展开与 `viking://` 虚拟路径寻址)
   */
  public expand(
    params: { id: string; tier?: VikingContextTier | string },
    agentCtx: { workspaceId: string; sessionId?: string; turn?: number }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = ExpandParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const cfg = this.currentCfg();
    const rawId = parsed.data.id;
    const requestedTier: VikingContextTier = parsed.data.tier || 'L2';
    const wsId = workspaceId(agentCtx.workspaceId || '');
    const scopeCtx = {
      workspaceId: wsId,
      sessionId: agentCtx.sessionId,
    };

    let mem: MemoryRecord | undefined;
    try {
      mem = resolveMemoryByVikingUriOrId(this.db, rawId, scopeCtx);
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory lookup failed'}`;
    }

    if (!mem) {
      return `Error: memory '${rawId}' not found or not in current scope.`;
    }
    if (mem.workspace_id && this.isExcludedWorkspace(mem.workspace_id)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    if (mem.status !== 'active' && mem.status !== 'frozen') {
      return `Error: memory '${rawId}' is not active.`;
    }

    if (requestedTier === 'L0' || requestedTier === 'L1') {
      const view = buildTieredMemoryView(mem);
      let tierOut =
        requestedTier === 'L0'
          ? `[${TAG_MAP[mem.type] || 'FACT'} ${mem.id}] [L0 ${view.uri}] ${view.l0Abstract}`
          : view.l1Overview;

      if (budgetTokens(tierOut) > MAX_L0_L1_EXPAND_TOKENS) {
        tierOut = truncateToTokenBudget(tierOut, MAX_L0_L1_EXPAND_TOKENS);
        if (!tierOut || budgetTokens(tierOut) > MAX_L0_L1_EXPAND_TOKENS) {
          return `Error: memory ${requestedTier} view exceeds token limit (${MAX_L0_L1_EXPAND_TOKENS} tokens).`;
        }
      }

      if (agentCtx.sessionId) {
        const stratVer = getActiveStrategy(this.db, cfg).version || this.strategyVersion;
        this.db.run(
          `INSERT OR IGNORE INTO injections (
            session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
          ) VALUES (?, ?, ?, ?, 'tool', 1, ?, 'summary', ?, ?)`,
          [agentCtx.sessionId, agentCtx.turn ?? 0, mem.id, mem.content_rev, mem.summary_cost, stratVer, Date.now()]
        );
      }
      return tierOut;
    }

    // L2 展开：提取正文并脱敏
    const cleanContent = redactSecrets(mem.content).text;

    // 最多 3 条证据
    const srcList = sources(this.db, mem.id, mem.content_rev).slice(0, 3);
    const srcLines = srcList.map((s) => {
      const sessShort = (s.session_id || '').slice(0, 8);
      const excerpt = s.excerpt ? ` "${singleLine(redactSecrets(s.excerpt).text).slice(0, 60)}"` : '';
      return `  - session ${sessShort} seq ${s.seq} (${s.kind})${excerpt}`;
    });

    // 1-hop 因果与拓扑关联（强制受 scopeFilterSQL 隔离）
    const relationScope = scopeFilterSQL(scopeCtx, 'm2');
    const relEdges = this.db.all<{
      from_id: string;
      to_id: string;
      rel: string;
      other_id: string;
      other_summary: string;
      other_status: string;
    }>(
      `SELECT r.from_id, r.to_id, r.rel,
              m2.id as other_id, m2.summary as other_summary, m2.status as other_status
       FROM memory_relations r
       JOIN memories m2
         ON m2.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
       WHERE (r.from_id = ? OR r.to_id = ?)
         AND (${relationScope.sql})
       ORDER BY r.created_at DESC
       LIMIT 4`,
      [mem.id, mem.id, mem.id, ...relationScope.params]
    );
    const relLines = relEdges.map((r) => {
      const dir = r.from_id === mem!.id ? `-> ${r.rel} ->` : `<- ${r.rel} <-`;
      const sum = singleLine(redactSecrets(r.other_summary || '').text).slice(0, 60);
      return `  - ${dir} [${r.other_id}] (${r.other_status}) ${sum}`;
    });

    const headerAndBody = `[${TAG_MAP[mem.type] || 'FACT'} ${mem.id}] (rev ${mem.content_rev})\n${cleanContent}`;
    let res = headerAndBody;
    if (srcLines.length > 0) {
      res += `\nSources:\n${srcLines.join('\n')}`;
    }
    if (relLines.length > 0) {
      const withRels = `${res}\nRelations:\n${relLines.join('\n')}`;
      if (budgetTokens(withRels) <= MAX_L2_EXPAND_TOKENS) {
        res = withRels;
      }
    }

    // 演化链溯源（带 scopeCtx 与 excludeWorkspaces 隔离）
    try {
      const trace = traceHindsightEvolution(this.db, mem, {
        workspaceId: wsId,
        sessionId: agentCtx.sessionId,
        excludeWorkspaces: cfg.excludeWorkspaces,
      });
      if (trace.timeline.length > 1) {
        const evoLines = trace.timeline
          .filter((n) => n.relationToCurrent !== 'current')
          .slice(-3)
          .map(
            (n) =>
              `  - [${n.relationToCurrent}] ${n.id} (v${n.version}, ${n.status}) ${singleLine(n.summary).slice(0, 60)}`
          );
        if (evoLines.length > 0) {
          const withEvo = `${res}\nEvolution:\n${evoLines.join('\n')}`;
          if (budgetTokens(withEvo) <= MAX_L2_EXPAND_TOKENS) {
            res = withEvo;
          }
        }
      }
    } catch {}

    // 约束总长度 <= 1500 tokens
    if (budgetTokens(res) > MAX_L2_EXPAND_TOKENS) {
      res = headerAndBody;
      if (budgetTokens(res) > MAX_L2_EXPAND_TOKENS) {
        return `Error: memory content exceeds token limit (${MAX_L2_EXPAND_TOKENS} tokens).`;
      }
    }

    if (agentCtx.sessionId) {
      const stratVer = getActiveStrategy(this.db, cfg).version || this.strategyVersion;
      this.db.run(
        `INSERT OR IGNORE INTO injections (
          session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
        ) VALUES (?, ?, ?, ?, 'tool', 1, ?, 'content', ?, ?)`,
        [agentCtx.sessionId, agentCtx.turn ?? 0, mem.id, mem.content_rev, mem.token_cost, stratVer, Date.now()]
      );
    }
    return res;
  }

  /**
   * 3. memory_feedback (§6.6)
   */
  public feedback(
    params: { id: string; contentRev: number; helpful: boolean; note?: string },
    agentCtx: { workspaceId?: string; sessionId: string; turn?: number }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = FeedbackParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const cfg = this.currentCfg();
    const { id: rawId, contentRev, helpful, note } = parsed.data;
    const sessionId =
      typeof agentCtx?.sessionId === 'string' && agentCtx.sessionId.trim()
        ? agentCtx.sessionId.trim()
        : 'default_session';
    const turn = typeof agentCtx?.turn === 'number' && Number.isFinite(agentCtx.turn) ? agentCtx.turn : 0;

    // 解析作用域并在 get() 中强制执行（若未显式传 workspaceId 则先尝试从 session_workspace_owners 反查）
    const explicitWs =
      agentCtx?.workspaceId !== undefined ? agentCtx.workspaceId : undefined;
    const inferredWs =
      explicitWs === undefined && sessionId !== 'default_session'
        ? resolveSessionWorkspaceId(this.db, sessionId)
        : '';
    const effectiveScopeCtx =
      explicitWs !== undefined
        ? { workspaceId: workspaceId(explicitWs), sessionId }
        : inferredWs
          ? { workspaceId: workspaceId(inferredWs), sessionId }
          : undefined;

    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, effectiveScopeCtx);
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory lookup failed'}`;
    }

    if (!mem) {
      return `Error: memory '${rawId}' not found`;
    }
    // 防御：无 workspaceId 回退查库时仍须校验 session 私有隔离与 excludeWorkspaces
    if (mem.scope === 'session' && mem.session_id && mem.session_id !== sessionId) {
      return `Error: memory '${rawId}' not found`;
    }
    if (mem.workspace_id && this.isExcludedWorkspace(mem.workspace_id)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }

    // 先验证本 session 确实注入/展开过该记忆，避免在未引用时泄露 mem.content_rev
    const anyInj = this.db.get<{ content_rev: number }>(
      'SELECT content_rev FROM injections WHERE session_id = ? AND memory_id = ? ORDER BY created_at DESC LIMIT 1',
      [sessionId, mem.id]
    );
    if (!anyInj) {
      return 'Error: memory was not referenced in this session';
    }

    if (mem.content_rev !== contentRev) {
      return `Error: contentRev mismatch (current: ${mem.content_rev}, provided: ${contentRev})`;
    }

    const now = Date.now();
    const r = helpful ? 1 : -1;
    const target = (r + 1) / 2; // helpful -> 1, unhelpful -> 0
    const lr = cfg.utilityLR || 0.1;
    const sanitizedNote = note
      ? singleLine(redactSecrets(note.trim()).text).slice(0, 300)
      : '';
    const repairQuery = sanitizedNote || 'Negative tool feedback';

    // 使用 SQLite 原子条件更新实现跨进程、持久化的单次反馈幂等保护（替代易失内存 Set）
    const txResult = this.db.transaction((): 'ok' | 'not_referenced' | 'already_recorded' => {
      const updInj = this.db.run(
        `UPDATE injections
         SET outcome = ?, used = 1
         WHERE session_id = ? AND memory_id = ? AND content_rev = ? AND outcome IS NULL`,
        [r, sessionId, mem!.id, contentRev]
      );

      if (Number(updInj.changes) === 0) {
        const exactInj = this.db.get<{ outcome: number | null }>(
          'SELECT outcome FROM injections WHERE session_id = ? AND memory_id = ? AND content_rev = ? LIMIT 1',
          [sessionId, mem!.id, contentRev]
        );
        return exactInj ? 'already_recorded' : 'not_referenced';
      }

      const freshMem = this.db.get<{ utility: number }>(
        'SELECT utility FROM memories WHERE id = ?',
        [mem!.id]
      );
      const baseUtil = freshMem?.utility ?? mem!.utility;
      const newUtility = baseUtil + lr * 1.0 * (target - baseUtil);

      this.db.run(
        `UPDATE memories
         SET utility = ?,
             success_count = success_count + ?,
             fail_count = fail_count + ?,
             updated_at = ?
         WHERE id = ?`,
        [newUtility, helpful ? 1 : 0, helpful ? 0 : 1, now, mem!.id]
      );

      if (!helpful) {
        try {
          enqueueRepairJobIfEligible(
            this.db,
            {
              memoryId: mem!.id,
              sessionId,
              query: repairQuery,
              turn,
            },
            cfg,
            now
          );
        } catch {}
      }

      return 'ok';
    });

    if (txResult === 'not_referenced') {
      return 'Error: memory was not referenced in this session';
    }
    if (txResult === 'already_recorded') {
      return 'Error: feedback already recorded for this memory in this session';
    }
    return 'ok';
  }

  /**
   * 4. memory_note (§6.6)
   */
  public note(
    params: {
      content: string;
      type?: string;
      kind?: 'fact' | 'preference' | 'procedure';
      scope?: 'workspace' | 'session' | 'user';
    },
    agentCtx: { workspaceId: string; sessionId: string; turn?: number }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = NoteParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const rawContent = parsed.data.content;
    const rawType = parsed.data.type?.toLowerCase();
    if (rawType === 'meta') {
      return 'Error: meta memory type is not allowed';
    }

    let memType: MemoryType = 'semantic';
    if (rawType) {
      if (!(ALLOWED_NOTE_TYPES as readonly string[]).includes(rawType)) {
        return `Error: invalid note type '${parsed.data.type}'. Allowed: ${ALLOWED_NOTE_TYPES.join(', ')}`;
      }
      memType = rawType as MemoryType;
    } else if (parsed.data.kind) {
      const kindMap: Record<'fact' | 'preference' | 'procedure', MemoryType> = {
        fact: 'semantic',
        preference: 'preference',
        procedure: 'procedural',
      };
      memType = kindMap[parsed.data.kind];
    }

    const chosenScope: Scope = parsed.data.scope || 'workspace';
    const sessionId = agentCtx.sessionId || 'default_session';
    const turn = typeof agentCtx.turn === 'number' && Number.isFinite(agentCtx.turn) ? agentCtx.turn : 0;
    const now = Date.now();

    // 速率限制：turn > 0 时按 turn 真 LRU 限流；turn === 0 / 不可用时退回 60s 滑动时间窗口限流（每 60s 最多 3 次）
    if (turn > 0) {
      const turnKey = `${sessionId}:${turn}`;
      const currentCount = this.noteTurnCounts.get(turnKey) || 0;
      if (currentCount >= MAX_NOTES_PER_WINDOW) {
        return 'Error: memory_note call limit reached for this turn (max 3 calls)';
      }
      touchLruMap(this.noteTurnCounts, turnKey, currentCount + 1, MAX_RATE_LIMIT_ENTRIES);
    } else {
      const prev = this.noteWindowTimestamps.get(sessionId) || [];
      const recent = prev.filter((ts) => now - ts < NOTE_WINDOW_MS);
      if (recent.length >= MAX_NOTES_PER_WINDOW) {
        touchLruMap(this.noteWindowTimestamps, sessionId, recent, MAX_RATE_LIMIT_ENTRIES);
        return 'Error: memory_note call limit reached for this time window (max 3 calls per 60s)';
      }
      recent.push(now);
      touchLruMap(this.noteWindowTimestamps, sessionId, recent, MAX_RATE_LIMIT_ENTRIES);
    }

    const wsId = chosenScope === 'user' ? undefined : workspaceId(agentCtx.workspaceId || '');
    if ((chosenScope === 'workspace' || chosenScope === 'session') && !wsId) {
      return 'Error: workspace scope is required for workspace/session notes';
    }

    const insertRes = upsertCandidate(
      this.db,
      {
        type: memType,
        content: rawContent,
        scope: chosenScope,
        workspaceId: wsId,
        sessionId,
        source_kind: 'assistant',
        origin_kinds: ['assistant'],
        confidence: 0.5,
        status: 'candidate', // 强制 candidate
        sources: [{ session_id: sessionId, seq: 0, kind: 'assistant' }],
        actor: 'llm',
      },
      now
    );

    if (insertRes.action === 'rejected') {
      return `Error: note rejected: ${insertRes.reason}`;
    }

    return `saved as candidate ${insertRes.id}`;
  }

  /**
   * 5. memory_confirm (内部辅助方法，不再直接暴露为 DSH LLM 工具)
   */
  public confirm(
    params: { id: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = ConfirmParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const rawId = parsed.data.id;
    const wsId = workspaceId(agentCtx.workspaceId || '');
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, { workspaceId: wsId, sessionId: agentCtx.sessionId });
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory lookup failed'}`;
    }

    if (!mem) return `Error: memory '${rawId}' not found in current scope.`;

    const res = confirmMemory(this.db, mem.id, 'llm');
    if (!res.success) return `Error: ${res.message}`;
    return res.message;
  }

  /**
   * 6. memory_merge (内部辅助方法，不再直接暴露为 DSH LLM 工具)
   */
  public merge(
    params: { sourceId: string; targetId: string; reason?: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = MergeParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const { sourceId: srcId, targetId: tgtId, reason } = parsed.data;
    const wsId = workspaceId(agentCtx.workspaceId || '');
    let srcMem: MemoryRecord | undefined;
    let tgtMem: MemoryRecord | undefined;
    try {
      srcMem = get(this.db, srcId, { workspaceId: wsId, sessionId: agentCtx.sessionId });
      tgtMem = get(this.db, tgtId, { workspaceId: wsId, sessionId: agentCtx.sessionId });
    } catch (err: any) {
      return `Error: ${err?.message || 'Lookup failed'}`;
    }

    if (!srcMem) return `Error: source memory '${srcId}' not found.`;
    if (!tgtMem) return `Error: target memory '${tgtId}' not found.`;

    const res = mergeMemories(this.db, srcMem.id, tgtMem.id, reason || 'manual_merge', 'llm');
    if (!res.success) return `Error: ${res.message}`;
    return res.message;
  }

  /**
   * 7. core_read (内部辅助方法)
   */
  public coreRead(
    params: { block?: string },
    agentCtx: { workspaceId: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = CoreReadParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const wsId = workspaceId(agentCtx.workspaceId || '');
    if (parsed.data.block) {
      const entry = getCoreMemory(this.db, parsed.data.block, { workspaceId: wsId });
      if (!entry) return `Core memory block '${parsed.data.block}' is empty.`;
      return `[CORE MEMORY: ${entry.block.toUpperCase()}] (v${entry.version})\n${entry.content}`;
    }
    const all = getAllCoreMemories(this.db, { workspaceId: wsId });
    if (all.length === 0) return 'No core memory blocks configured.';
    return renderCoreMemoryMarkdown(all);
  }

  /**
   * 8. core_set (内部辅助方法)
   */
  public coreSet(
    params: { block: string; content: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = CoreSetParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const wsId = workspaceId(agentCtx.workspaceId || '');
    try {
      const res = setCoreMemory(this.db, parsed.data.block, parsed.data.content, {
        workspaceId: wsId,
        sessionId: agentCtx.sessionId,
        actor: 'assistant',
      });
      if (res.action === 'proposed') {
        return `Core memory block '${parsed.data.block}' saved as candidate ${res.id}; pending user approval.`;
      }
      return `Core memory block '${parsed.data.block}' ${res.action} successfully (id: ${res.id}).`;
    } catch (err: any) {
      return `Error: ${err?.message || 'Failed to set core memory'}`;
    }
  }

  /**
   * 9. core_append (内部辅助方法)
   */
  public coreAppend(
    params: { block: string; text: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = CoreAppendParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const wsId = workspaceId(agentCtx.workspaceId || '');
    try {
      const res = appendCoreMemory(this.db, parsed.data.block, parsed.data.text, {
        workspaceId: wsId,
        sessionId: agentCtx.sessionId,
        actor: 'assistant',
      });
      if (res.action === 'proposed') {
        return `Core memory block '${parsed.data.block}' append saved as candidate ${res.id}; pending user approval.`;
      }
      return `Appended to core memory block '${parsed.data.block}' successfully.`;
    } catch (err: any) {
      return `Error: ${err?.message || 'Failed to append to core memory'}`;
    }
  }

  /**
   * 10. reconcile (内部辅助方法，拦截 core:* 与 meta 类型)
   */
  public reconcile(
    params: { content: string; type?: string; slotKey?: string },
    agentCtx: { workspaceId: string; sessionId: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = ReconcileParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const rawType = (parsed.data.type || 'semantic').toLowerCase();
    if (rawType === 'meta') {
      return 'Error: meta memory type is not allowed for reconciliation.';
    }
    if (parsed.data.slotKey && parsed.data.slotKey.toLowerCase().startsWith('core:')) {
      return 'Error: core:* slot_key is not allowed for reconciliation.';
    }

    const wsId = workspaceId(agentCtx.workspaceId || '');
    const sessionId = agentCtx.sessionId || 'default_session';
    const type = normalizeMemoryType(rawType, 'semantic');
    if (type === 'meta') {
      return 'Error: meta memory type is not allowed for reconciliation.';
    }

    const candInput = {
      type,
      content: parsed.data.content,
      slot_key: parsed.data.slotKey,
      scope: 'workspace' as const,
      workspaceId: wsId,
      sessionId,
      source_kind: 'assistant' as const,
      origin_kinds: ['assistant' as const],
      confidence: 0.8,
      importance: 7,
      status: 'active' as const,
      sources: [{ session_id: sessionId, seq: 0, kind: 'assistant' }],
      actor: 'llm' as const,
    };

    const res = reconcileAndUpsert(this.db, candInput);
    return `Reconciled: action=${res.decision.action}, reason=${res.decision.reason}, resultAction=${res.action}`;
  }

  /**
   * 11. doctor (记忆库健康度体检与冲突检测)
   */
  public doctor(
    agentCtx: { workspaceId: string; sessionId?: string },
    options?: { autoFix?: boolean }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    if (options?.autoFix) {
      return this.heal(agentCtx);
    }
    const cfg = this.currentCfg();
    const wsId = workspaceId(agentCtx.workspaceId || '');
    const report = auditMemoryHealth(this.db, {
      workspaceId: wsId,
      sessionId: agentCtx.sessionId,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });
    const lines = [
      `[Memory Health Doctor] Score: ${report.score}/100 (Grade ${report.grade})`,
      `Counts: active=${report.counts.active}, candidate=${report.counts.candidate}, frozen=${report.counts.frozen}, superseded=${report.counts.superseded}, archived=${report.counts.archived}, pinned=${report.counts.pinned}`,
      `FTS5 Index: ${report.ftsConsistent ? 'Consistent' : 'Out of sync'} (${report.ftsCount} rows)`,
      `Near-Duplicates: ${report.duplicatePairs.length} | Active Contradictions: ${report.contradictions.length} | Stale Memories: ${report.staleMemories.length} | Orphans: ${report.orphanMemoriesCount ?? 0}`,
    ];
    if (report.duplicatePairs.length > 0) {
      lines.push('Duplicate Pairs (can merge via /memory merge):');
      for (const pair of report.duplicatePairs.slice(0, 5)) {
        lines.push(`  - ${pair.sourceId} -> ${pair.targetId} (sim=${pair.similarity}, reason=${pair.reason})`);
      }
    }
    if (report.recommendations.length > 0) {
      lines.push('Recommendations:');
      for (const rec of report.recommendations) {
        lines.push(`  * ${rec}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * 11.5 heal (一键智能自愈修复)
   */
  public heal(agentCtx: { workspaceId: string; sessionId?: string }): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const cfg = this.currentCfg();
    const wsId = workspaceId(agentCtx.workspaceId || '');
    const res = autoHealMemoryHealth(this.db, {
      workspaceId: wsId,
      sessionId: agentCtx.sessionId,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });
    return [
      `[Memory Auto-Heal Completed] Score: ${res.beforeScore} -> ${res.afterScore}/100 (Grade ${res.afterGrade})`,
      `Actions: ftsRebuilt=${res.ftsRebuilt}, embeddingsBackfilled=${res.embeddingsBackfilled}, duplicatesMerged=${res.duplicatesMerged}, contradictionsResolved=${res.contradictionsResolved}, linksWeaved=${res.linksWeaved}, coreBlocksSynced=${res.coreBlocksSynced ?? 0}`,
    ].join('\n');
  }

  /**
   * 11.8 init (工作区记忆自动初始化与冷启动扫描)
   */
  public init(agentCtx: { workspaceId: string }, options?: { force?: boolean }): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const cfg = this.currentCfg();
    const wsPath =
      agentCtx.workspaceId && fs.existsSync(agentCtx.workspaceId)
        ? agentCtx.workspaceId
        : process.cwd();
    if (this.isExcludedWorkspace(wsPath)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const res = autoBootstrapMemory(this.db, {
      workspacePath: wsPath,
      cfg,
      force: options?.force ?? false,
      includeBackfill: true,
    });
    return [
      `[Workspace Memory Bootstrap] workspace=${res.workspaceId}, alreadyInitialized=${res.alreadyInitialized}`,
      `Result: coreBlocks=[${res.coreBlocksInitialized.join(',')}], seeded=${res.workspaceMemoriesSeeded}, markdownImported=${res.markdownMemoriesImported}, backfillMemories=${res.backfillMemoriesCreated}, embeddingsBackfilled=${res.embeddingsBackfilled}, linksWeaved=${res.linksWeaved}`,
    ].join('\n');
  }

  /**
   * 11.9 tree (OpenViking `viking://` 目录浏览与子树混合检索)
   */
  public tree(
    params: { uri?: string; query?: string; tier?: VikingContextTier | string; limit?: number },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = TreeParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const wsId = workspaceId(agentCtx.workspaceId || '');
    if (parsed.data.query && parsed.data.query.trim()) {
      return findInVikingTree(this.db, {
        query: parsed.data.query.trim(),
        uri: parsed.data.uri,
        workspaceId: wsId,
        sessionId: agentCtx.sessionId,
        tier: parsed.data.tier || 'L1',
        limit: parsed.data.limit,
      });
    }
    return browseVikingDirectory(this.db, {
      uri: parsed.data.uri,
      workspaceId: wsId,
      sessionId: agentCtx.sessionId,
      tier: parsed.data.tier || 'L0',
      limit: parsed.data.limit,
    });
  }

  /**
   * 11.92 find (OpenViking 子树检索快捷入口)
   */
  public find(
    params: { query: string; uri?: string; tier?: VikingContextTier | string; limit?: number },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    return this.tree(
      {
        uri: params?.uri,
        query: params?.query,
        tier: params?.tier || 'L1',
        limit: params?.limit,
      },
      agentCtx
    );
  }

  /**
   * 11.95 diff (OpenViking Self-Evolving Context Diff Audit)
   */
  public diff(agentCtx: { workspaceId: string; sessionId?: string }): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const cfg = this.currentCfg();
    const wsId = workspaceId(agentCtx.workspaceId || '');
    return formatVikingEvolutionDiff(
      getVikingEvolutionDiff(this.db, {
        workspaceId: wsId,
        sessionId: agentCtx.sessionId,
        excludeWorkspaces: cfg.excludeWorkspaces,
      })
    );
  }

  /**
   * 11.10 reflect (默认只读：除非显式 privileged=true，否则绝不合成心智模型或改写置信度)
   */
  public reflect(
    params: { topic?: string; autoSynthesize?: boolean; persistCalibration?: boolean },
    agentCtx: { workspaceId: string; sessionId?: string },
    options?: { privileged?: boolean }
  ): string {
    if (this.isExcludedWorkspace(agentCtx?.workspaceId)) {
      return 'Error: workspace is excluded by privacy configuration.';
    }
    const parsed = ReflectParamsSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return formatZodError(parsed.error);
    }

    const cfg = this.currentCfg();
    const wsId = workspaceId(agentCtx.workspaceId || '');
    const allowMutate = options?.privileged === true;
    const report = runHindsightReflect(this.db, {
      workspaceId: wsId,
      sessionId: agentCtx.sessionId,
      topic: parsed.data.topic,
      autoSynthesize: allowMutate && parsed.data.autoSynthesize === true,
      persistCalibration: allowMutate && parsed.data.persistCalibration === true,
      excludeWorkspaces: cfg.excludeWorkspaces,
    });
    return formatHindsightReflectReport(report);
  }

  /**
   * 12. 遗留统一工具调度入口 (仅供内部/测试调用，不再向 DSH LLM 注册)
   */
  public unified(
    params: {
      action:
        | 'search'
        | 'expand'
        | 'note'
        | 'feedback'
        | 'confirm'
        | 'merge'
        | 'core_read'
        | 'core_set'
        | 'core_append'
        | 'reconcile'
        | 'doctor'
        | 'heal'
        | 'init'
        | 'bootstrap'
        | 'tree'
        | 'ls'
        | 'viking'
        | 'find'
        | 'diff'
        | 'reflect';
      query?: string;
      id?: string;
      uri?: string;
      tier?: VikingContextTier;
      network?: string;
      topic?: string;
      sourceId?: string;
      targetId?: string;
      content?: string;
      type?: string;
      kind?: 'fact' | 'preference' | 'procedure';
      scope?: 'workspace' | 'session' | 'user';
      contentRev?: number;
      helpful?: boolean;
      note?: string;
      limit?: number;
      types?: string[];
      reason?: string;
      block?: string;
      text?: string;
      slotKey?: string;
      force?: boolean;
    },
    agentCtx: { workspaceId: string; sessionId: string; turn?: number }
  ): string {
    if (!params || typeof params !== 'object' || typeof params.action !== 'string') {
      return 'Error: action is required';
    }
    const action = params.action;
    switch (action) {
      case 'search':
        return this.search(
          {
            query: params.query as string,
            limit: params.limit,
            types: params.types,
            network: params.network,
            uriPrefix: params.uri,
            tier: params.tier,
          },
          agentCtx
        );
      case 'expand':
        return this.expand({ id: (params.id || params.uri) as string, tier: params.tier }, agentCtx);
      case 'note':
        return this.note(
          {
            content: params.content as string,
            type: params.type,
            kind: params.kind,
            scope: params.scope,
          },
          agentCtx
        );
      case 'feedback':
        return this.feedback(
          {
            id: params.id as string,
            contentRev: params.contentRev as number,
            helpful: params.helpful as boolean,
            note: params.note,
          },
          agentCtx
        );
      case 'confirm':
        return this.confirm({ id: params.id as string }, agentCtx);
      case 'merge':
        return this.merge(
          { sourceId: params.sourceId as string, targetId: params.targetId as string, reason: params.reason },
          agentCtx
        );
      case 'core_read':
        return this.coreRead({ block: params.block }, agentCtx);
      case 'core_set':
        return this.coreSet({ block: params.block || 'project', content: argsContent(params) }, agentCtx);
      case 'core_append':
        return this.coreAppend({ block: params.block || 'project', text: params.text || params.content || '' }, agentCtx);
      case 'reconcile':
        return this.reconcile(
          { content: params.content as string, type: params.type || params.kind || 'semantic', slotKey: params.slotKey },
          agentCtx
        );
      case 'doctor':
        return this.doctor(agentCtx);
      case 'heal':
        return this.heal(agentCtx);
      case 'init':
      case 'bootstrap':
        return this.init(agentCtx, { force: params.force });
      case 'tree':
      case 'ls':
      case 'viking':
        return this.tree(
          {
            uri: params.uri || (!params.query ? params.id : undefined),
            query: params.query,
            tier: params.tier,
            limit: params.limit,
          },
          agentCtx
        );
      case 'find':
        return this.find(
          {
            uri: params.uri,
            query: params.query || params.content || params.id || '',
            tier: params.tier || 'L1',
            limit: params.limit,
          },
          agentCtx
        );
      case 'diff':
        return this.diff(agentCtx);
      case 'reflect':
        return this.reflect({ topic: params.topic || params.query }, agentCtx, { privileged: false });
      default:
        return `Error: unknown action '${action}'. Supported: search, expand, note, feedback, confirm, merge, core_read, core_set, core_append, reconcile, doctor, heal, init, tree, find, diff, reflect`;
    }
  }
}

function argsContent(params: { content?: string; text?: string }): string {
  return params.content || params.text || '';
}
