import fs from 'node:fs';
import type { Db, MemoryRecord, MemoryType } from '../types.js';
import { get, sources } from '../core/store.js';
import { workspaceId, scopeFilterSQL } from '../core/scope.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { runAllChannels, expandGraphNeighbors } from '../retrieval/channels.js';
import { fuseCandidates } from '../retrieval/fuse.js';
import { getActiveStrategy } from '../evolution/strategy.js';
import { TAG_MAP } from '../retrieval/render.js';
import { budgetTokens } from '../core/tokens.js';
import { redactSecrets, isWorkspaceExcluded } from '../core/privacy.js';
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
import { reconcileAndUpsert } from '../evolution/reconciler.js';
import { enqueueRepairJobIfEligible } from '../evolution/repair.js';
import { DEFAULTS, type PluginConfig } from '../config.js';

export interface ToolContext {
  db: Db;
  cfg?: PluginConfig;
  strategyVersion?: number;
}

export class MemoryTools {
  private db: Db;
  private cfg: PluginConfig;
  private strategyVersion: number;
  // session:turn -> note call count
  private noteCallCounts = new Map<string, number>();

  constructor(ctx: ToolContext) {
    this.db = ctx.db;
    this.cfg = ctx.cfg || DEFAULTS;
    this.strategyVersion = ctx.strategyVersion || 1;
  }

  /**
   * 1. memory_search (§6.6)
   */
  public search(
    params: { query: string; limit?: number; types?: string[] },
    agentCtx: { workspaceId: string; sessionId: string; turn?: number }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawQuery = (params.query || '').trim();
    if (!rawQuery) return 'Error: query is required';
    if (rawQuery.length > 500) return 'Error: query exceeds 500 characters';

    const limit = Math.max(1, Math.min(8, params.limit ?? 5));
    const now = Date.now();
    const wsId = workspaceId(agentCtx.workspaceId);
    const sessionId = agentCtx.sessionId || 'default_session';
    const turn = agentCtx.turn ?? 0;

    const plan = buildQueryPlan({
      userText: rawQuery,
      now,
      cfg: this.cfg,
    });

    const activeStrat = getActiveStrategy(this.db, this.cfg);
    const strategy = activeStrat.config;
    const stratVer = activeStrat.version || this.strategyVersion;

    // 运行完整 7 路混合召回 (6 基础通道 + SYNAPSE 图谱拓扑扩散)
    const channelResults = runAllChannels(this.db, plan, {
      workspaceId: wsId,
      sessionId,
      cfg: this.cfg,
    });

    const allIdsSet = new Set<string>();
    for (const cands of Object.values(channelResults)) {
      for (const c of cands) {
        allIdsSet.add(c.id);
      }
    }

    if (allIdsSet.size === 0) {
      return 'No relevant memories found.';
    }

    const topSeedIds = [
      ...channelResults.lexical.slice(0, 4).map((c) => c.id),
      ...channelResults.entity.slice(0, 4).map((c) => c.id),
      ...channelResults.vector.slice(0, 3).map((c) => c.id),
    ];
    const associativeNeighbors = expandGraphNeighbors(
      this.db,
      topSeedIds,
      { workspaceId: wsId, sessionId, cfg: this.cfg },
      10
    );
    for (const edge of associativeNeighbors) {
      allIdsSet.add(edge.neighborId);
    }

    const allIds = Array.from(allIdsSet);
    const placeholders = allIds.map(() => '?').join(', ');
    const memRows = this.db.all<MemoryRecord>(
      `SELECT * FROM memories WHERE id IN (${placeholders}) AND status IN ('active', 'frozen')`,
      allIds
    );
    const memoriesMap = new Map<string, MemoryRecord>();
    for (const m of memRows) {
      if (params.types && params.types.length > 0 && !params.types.includes(m.type)) {
        continue;
      }
      memoriesMap.set(m.id, m);
    }

    if (memoriesMap.size === 0) {
      return 'No relevant memories found.';
    }

    const memoryEntitiesMap = new Map<string, Set<string>>();
    const entRows = this.db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      allIds
    );
    for (const r of entRows) {
      let s = memoryEntitiesMap.get(r.memory_id);
      if (!s) {
        s = new Set();
        memoryEntitiesMap.set(r.memory_id, s);
      }
      s.add(r.entity.toLowerCase().trim());
    }

    const relRows = this.db.all<{ from_id: string; to_id: string; target_id: string }>(
      `SELECT r.from_id, r.to_id, target.id as target_id
       FROM memory_relations r
       JOIN memories target ON (target.id = r.to_id OR target.id = r.from_id)
       WHERE r.rel = 'contradicts'
         AND target.status IN ('active', 'frozen')
         AND (r.from_id IN (${placeholders}) OR r.to_id IN (${placeholders}))`,
      [...allIds, ...allIds]
    );
    const contradictionsSet = new Set<string>();
    for (const rel of relRows) {
      if (allIdsSet.has(rel.from_id) && rel.target_id === rel.to_id) {
        contradictionsSet.add(rel.from_id);
      }
      if (allIdsSet.has(rel.to_id) && rel.target_id === rel.from_id) {
        contradictionsSet.add(rel.to_id);
      }
    }

    const scored = fuseCandidates(
      plan,
      channelResults,
      memoriesMap,
      memoryEntitiesMap,
      contradictionsSet,
      strategy,
      this.cfg,
      now,
      associativeNeighbors
    );

    // 去除同槽位旧项与同哈希重复项
    const seenSlots = new Set<string>();
    const seenHashes = new Set<string>();
    const deduped = scored.filter((sc) => {
      const m = sc.memory;
      if (seenHashes.has(m.hash)) return false;
      if (m.slot_key) {
        const sk = `${m.scope}:${m.workspace_id || ''}:${m.session_id || ''}:${m.slot_key}`;
        if (seenSlots.has(sk)) return false;
        seenSlots.add(sk);
      }
      seenHashes.add(m.hash);
      return true;
    });

    const filtered = deduped.slice(0, limit);
    if (filtered.length === 0) {
      return 'No relevant memories found.';
    }

    // 格式化输出: [TAG id] summary (c=..., u=...)
    const lines: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const item = filtered[i];
      const m = item.memory;
      const tag = TAG_MAP[m.type] || 'FACT';
      const cleanSummary = redactSecrets(m.summary || m.content).text;
      const line = `[${tag} ${m.id}] ${cleanSummary} (c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})`;
      lines.push(line);
    }

    let output = lines.join('\n');
    while (lines.length > 0 && budgetTokens(output) > 800) {
      lines.pop();
      output = lines.join('\n');
    }
    if (!lines.length) return 'Error: memory summaries exceed token limit (800 tokens).';

    // Only returned references may receive feedback or outcome attribution.
    for (let i = 0; i < lines.length; i++) {
      const m = filtered[i].memory;
      this.db.run(
        `INSERT OR IGNORE INTO injections (
          session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
        ) VALUES (?, ?, ?, ?, 'tool', ?, ?, 'summary', ?, ?)`,
        [sessionId, turn, m.id, m.content_rev, i + 1, m.summary_cost, stratVer, now]
      );
    }

    return output;
  }

  /**
   * 2. memory_expand (§6.6)
   */
  public expand(
    params: { id: string },
    agentCtx: { workspaceId: string; sessionId?: string; turn?: number }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawId = (params.id || '').trim();
    if (!rawId) return 'Error: memory id is required';

    const wsId = workspaceId(agentCtx.workspaceId);
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, { workspaceId: wsId, sessionId: agentCtx.sessionId });
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory lookup failed'}`;
    }

    if (!mem) {
      return `Error: memory '${rawId}' not found or not in current scope.`;
    }
    if (mem.status !== 'active' && mem.status !== 'frozen') {
      return `Error: memory '${rawId}' is not active.`;
    }

    // 提取正文并脱敏
    const cleanContent = redactSecrets(mem.content).text;

    // 最多 3 条证据
    const srcList = sources(this.db, mem.id, mem.content_rev).slice(0, 3);
    const srcLines = srcList.map((s) => {
      const sessShort = (s.session_id || '').slice(0, 8);
      const excerpt = s.excerpt ? ` "${redactSecrets(s.excerpt).text.slice(0, 60)}"` : '';
      return `  - session ${sessShort} seq ${s.seq} (${s.kind})${excerpt}`;
    });

    // 1-hop 因果与拓扑关联 (supersedes / derived_from / contradicts / related)
    const relationScope = scopeFilterSQL({ workspaceId: wsId, sessionId: agentCtx.sessionId });
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
       JOIN (SELECT * FROM memories WHERE ${relationScope.sql}) m2
         ON m2.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
       WHERE r.from_id = ? OR r.to_id = ?
       ORDER BY r.created_at DESC
       LIMIT 4`,
      [...relationScope.params, mem.id, mem.id, mem.id]
    );
    const relLines = relEdges.map((r) => {
      const dir = r.from_id === mem!.id ? `-> ${r.rel} ->` : `<- ${r.rel} <-`;
      const sum = redactSecrets(r.other_summary || '').text.slice(0, 60);
      return `  - ${dir} [${r.other_id}] (${r.other_status}) ${sum}`;
    });

    const headerAndBody = `[${TAG_MAP[mem.type] || 'FACT'} ${mem.id}] (rev ${mem.content_rev})\n${cleanContent}`;
    let res = headerAndBody;
    if (srcLines.length > 0) {
      res += `\nSources:\n${srcLines.join('\n')}`;
    }
    if (relLines.length > 0) {
      const withRels = `${res}\nRelations:\n${relLines.join('\n')}`;
      if (budgetTokens(withRels) <= 1500) {
        res = withRels;
      }
    }

    // 约束总长度 <= 1500 tokens
    if (budgetTokens(res) > 1500) {
      // 优先削减证据
      res = headerAndBody;
      if (budgetTokens(res) > 1500) {
        return `Error: memory content exceeds token limit (1500 tokens).`;
      }
    }

    if (agentCtx.sessionId) {
      const stratVer = getActiveStrategy(this.db, this.cfg).version || this.strategyVersion;
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
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawId = (params.id || '').trim();
    const contentRev = Number(params.contentRev);
    if (!rawId || !Number.isInteger(contentRev) || contentRev < 1) {
      return 'Error: valid id and integer contentRev are required';
    }

    let mem;
    try {
      mem = get(
        this.db,
        rawId,
        agentCtx.workspaceId !== undefined
          ? { workspaceId: workspaceId(agentCtx.workspaceId), sessionId: agentCtx.sessionId }
          : undefined
      );
    } catch (err: any) {
      return `Error: ${err?.message || 'Memory lookup failed'}`;
    }
    if (!mem) {
      return `Error: memory '${rawId}' not found`;
    }
    if (mem.content_rev !== contentRev) {
      return `Error: contentRev mismatch (current: ${mem.content_rev}, provided: ${contentRev})`;
    }

    const sessionId = agentCtx.sessionId || 'default_session';
    const turn = agentCtx.turn ?? 0;
    const now = Date.now();

    // 检查本轮是否确实注入或展开过该引用
    const inj = this.db.get<{ memory_id: string }>(
      'SELECT memory_id FROM injections WHERE session_id = ? AND memory_id = ? AND content_rev = ?',
      [sessionId, mem.id, contentRev]
    );

    if (!inj) {
      return 'Error: memory was not referenced in this session';
    }

    // 立即更新 utility (w=1, r=±1)
    const r = params.helpful ? 1 : -1;
    const target = (r + 1) / 2; // helpful -> 1, unhelpful -> 0
    const lr = this.cfg.utilityLR || 0.1;
    const newUtility = mem.utility + lr * 1.0 * (target - mem.utility);

    this.db.transaction(() => {
      this.db.run(
        `UPDATE memories
         SET utility = ?,
             success_count = success_count + ?,
             fail_count = fail_count + ?,
             updated_at = ?
         WHERE id = ?`,
        [
          newUtility,
          params.helpful ? 1 : 0,
          params.helpful ? 0 : 1,
          now,
          mem.id,
        ]
      );

      this.db.run(
        `UPDATE injections
         SET outcome = ?, used = 1
         WHERE session_id = ? AND memory_id = ? AND content_rev = ?`,
        [r, sessionId, mem.id, contentRev]
      );

      if (!params.helpful) {
        try {
          enqueueRepairJobIfEligible(
            this.db,
            {
              memoryId: mem.id,
              sessionId,
              query: params.note || 'Negative tool feedback',
              turn,
            },
            this.cfg,
            now
          );
        } catch {}
      }
    });

    return 'ok';
  }

  /**
   * 4. memory_note (§6.6)
   */
  public note(
    params: { content: string; kind: 'fact' | 'preference' | 'procedure' },
    agentCtx: { workspaceId: string; sessionId: string; turn?: number }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawContent = (params.content || '').trim();
    if (rawContent.length < 8 || rawContent.length > 400) {
      return 'Error: content length must be between 8 and 400 characters';
    }

    const sessionId = agentCtx.sessionId || 'default_session';
    const turn = agentCtx.turn ?? 0;
    const turnKey = `${sessionId}:${turn}`;

    // 每个 turn 最多调用 3 次
    const currentCount = this.noteCallCounts.get(turnKey) || 0;
    if (currentCount >= 3) {
      return 'Error: memory_note call limit reached for this turn (max 3 calls)';
    }
    if (this.noteCallCounts.size > 500) {
      const oldestKey = this.noteCallCounts.keys().next().value;
      if (oldestKey) this.noteCallCounts.delete(oldestKey);
    }
    this.noteCallCounts.set(turnKey, currentCount + 1);

    const typeMap: Record<string, MemoryType> = {
      fact: 'semantic',
      preference: 'preference',
      procedure: 'procedural',
    };
    const memType = typeMap[params.kind] || 'semantic';

    const wsId = workspaceId(agentCtx.workspaceId);
    const now = Date.now();

    const insertRes = upsertCandidate(
      this.db,
      {
        type: memType,
        content: rawContent,
        scope: 'workspace',
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

    return `saved as candidate ${(insertRes as any).id}`;
  }

  /**
   * 5. memory_confirm (汲取自 tr1v3r/dsh-ltm)
   */
  public confirm(
    params: { id: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawId = (params.id || '').trim();
    if (!rawId) return 'Error: memory id is required';

    const wsId = workspaceId(agentCtx.workspaceId);
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
   * 6. memory_merge (汲取自 tr1v3r/dsh-ltm)
   */
  public merge(
    params: { sourceId: string; targetId: string; reason?: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const srcId = (params.sourceId || '').trim();
    const tgtId = (params.targetId || '').trim();
    if (!srcId || !tgtId) return 'Error: sourceId and targetId are required';

    const wsId = workspaceId(agentCtx.workspaceId);
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

    const res = mergeMemories(this.db, srcMem.id, tgtMem.id, params.reason || 'manual_merge', 'llm');
    if (!res.success) return `Error: ${res.message}`;
    return res.message;
  }

  /**
   * 7. core_read (汲取自 Letta/MemGPT 核心工作区)
   */
  public coreRead(
    params: { block?: string },
    agentCtx: { workspaceId: string }
  ): string {
    const wsId = workspaceId(agentCtx.workspaceId);
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    if (params.block) {
      const entry = getCoreMemory(this.db, params.block, { workspaceId: wsId });
      if (!entry) return `Core memory block '${params.block}' is empty.`;
      return `[CORE MEMORY: ${entry.block.toUpperCase()}] (v${entry.version})\n${entry.content}`;
    }
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const all = getAllCoreMemories(this.db, { workspaceId: wsId });
    if (all.length === 0) return 'No core memory blocks configured.';
    return renderCoreMemoryMarkdown(all);
  }

  /**
   * 8. core_set (汲取自 Letta/MemGPT 核心工作区自编辑)
   */
  public coreSet(
    params: { block: string; content: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    const wsId = workspaceId(agentCtx.workspaceId);
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    if (!params.block || !params.content) {
      return 'Error: both block and content are required';
    }
    try {
      const res = setCoreMemory(this.db, params.block, params.content, { workspaceId: wsId, sessionId: agentCtx.sessionId, actor: 'assistant' });
      if (res.action === 'proposed') {
        return `Core memory block '${params.block}' saved as candidate ${res.id}; pending user approval.`;
      }
      return `Core memory block '${params.block}' ${res.action} successfully (id: ${res.id}).`;
    } catch (err: any) {
      return `Error: ${err?.message || 'Failed to set core memory'}`;
    }
  }

  /**
   * 9. core_append (汲取自 Letta/MemGPT core_memory_append)
   */
  public coreAppend(
    params: { block: string; text: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    const wsId = workspaceId(agentCtx.workspaceId);
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    if (!params.block || !params.text) {
      return 'Error: both block and text are required';
    }
    try {
      const res = appendCoreMemory(this.db, params.block, params.text, { workspaceId: wsId, sessionId: agentCtx.sessionId, actor: 'assistant' });
      if (res.action === 'proposed') {
        return `Core memory block '${params.block}' append saved as candidate ${res.id}; pending user approval.`;
      }
      return `Appended to core memory block '${params.block}' successfully.`;
    } catch (err: any) {
      return `Error: ${err?.message || 'Failed to append to core memory'}`;
    }
  }

  /**
   * 10. reconcile (汲取自 Mem0 智能调和)
   */
  public reconcile(
    params: { content: string; type?: string; slotKey?: string },
    agentCtx: { workspaceId: string; sessionId: string }
  ): string {
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const rawContent = (params.content || '').trim();
    if (!rawContent) return 'Error: content is required for reconciliation';
    if (rawContent.length > 2000) return 'Error: content too long for reconciliation (max 2000 characters)';

    const wsId = workspaceId(agentCtx.workspaceId);
    const sessionId = agentCtx.sessionId || 'default_session';
    // 工具参数 kind 取值为 fact/preference/procedure，需映射到合法 MemoryType，否则会触发 DB CHECK 约束异常
    const kindMap: Record<string, MemoryType> = { fact: 'semantic', procedure: 'procedural' };
    const validTypes: MemoryType[] = ['episodic', 'semantic', 'procedural', 'belief', 'preference', 'goal', 'failure', 'meta'];
    const rawType = String(params.type || 'semantic').toLowerCase();
    const type: MemoryType = kindMap[rawType] || (validTypes.includes(rawType as MemoryType) ? (rawType as MemoryType) : 'semantic');

    const candInput = {
      type,
      content: rawContent,
      slot_key: params.slotKey,
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
  public doctor(agentCtx: { workspaceId: string }, options?: { autoFix?: boolean }): string {
    if (options?.autoFix) {
      return this.heal(agentCtx);
    }
    const wsId = workspaceId(agentCtx.workspaceId);
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const report = auditMemoryHealth(this.db, { workspaceId: wsId });
    const lines = [
      `[Memory Health Doctor] Score: ${report.score}/100 (Grade ${report.grade})`,
      `Counts: active=${report.counts.active}, candidate=${report.counts.candidate}, frozen=${report.counts.frozen}, superseded=${report.counts.superseded}, archived=${report.counts.archived}, pinned=${report.counts.pinned}`,
      `FTS5 Index: ${report.ftsConsistent ? 'Consistent' : 'Out of sync'} (${report.ftsCount} rows)`,
      `Near-Duplicates: ${report.duplicatePairs.length} | Active Contradictions: ${report.contradictions.length} | Stale Memories: ${report.staleMemories.length} | Orphans: ${report.orphanMemoriesCount ?? 0}`,
    ];
    if (report.duplicatePairs.length > 0) {
      lines.push('Duplicate Pairs (can merge via memory_merge):');
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
   * 11.5 heal (一键智能自愈修复：FTS5 重建 + 本地向量回填 + 冗余去重 + 矛盾消解 + A-Mem 双链织网)
   */
  public heal(agentCtx: { workspaceId: string }): string {
    const wsId = workspaceId(agentCtx.workspaceId);
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const res = autoHealMemoryHealth(this.db, { workspaceId: wsId });
    return [
      `[Memory Auto-Heal Completed] Score: ${res.beforeScore} -> ${res.afterScore}/100 (Grade ${res.afterGrade})`,
      `Actions: ftsRebuilt=${res.ftsRebuilt}, embeddingsBackfilled=${res.embeddingsBackfilled}, duplicatesMerged=${res.duplicatesMerged}, contradictionsResolved=${res.contradictionsResolved}, linksWeaved=${res.linksWeaved}, coreBlocksSynced=${res.coreBlocksSynced ?? 0}`,
    ].join('\n');
  }

  /**
   * 11.8 init (v0.4.0 工作区记忆自动初始化与冷启动扫描)
   */
  public init(agentCtx: { workspaceId: string }, options?: { force?: boolean }): string {
    const wsPath =
      agentCtx.workspaceId && fs.existsSync(agentCtx.workspaceId)
        ? agentCtx.workspaceId
        : process.cwd();
    if (agentCtx.workspaceId && isWorkspaceExcluded(agentCtx.workspaceId, this.cfg.excludeWorkspaces)) return 'Error: workspace is excluded by privacy configuration.';
    const res = autoBootstrapMemory(this.db, {
      workspacePath: wsPath,
      cfg: this.cfg,
      force: options?.force ?? false,
      includeBackfill: true,
    });
    return [
      `[Workspace Memory Bootstrap] workspace=${res.workspaceId}, alreadyInitialized=${res.alreadyInitialized}`,
      `Result: coreBlocks=[${res.coreBlocksInitialized.join(',')}], seeded=${res.workspaceMemoriesSeeded}, markdownImported=${res.markdownMemoriesImported}, backfillMemories=${res.backfillMemoriesCreated}, embeddingsBackfilled=${res.embeddingsBackfilled}, linksWeaved=${res.linksWeaved}`,
    ].join('\n');
  }

  /**
   * 12. 统一 memory 工具接口 (汲取自 LZMW/dsh-memory 单工具设计，节省提示词上下文)
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
        | 'bootstrap';
      query?: string;
      id?: string;
      sourceId?: string;
      targetId?: string;
      content?: string;
      kind?: 'fact' | 'preference' | 'procedure';
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
    const action = params.action;
    switch (action) {
      case 'search':
        return this.search({ query: params.query || '', limit: params.limit, types: params.types }, agentCtx);
      case 'expand':
        return this.expand({ id: params.id || '' }, agentCtx);
      case 'note':
        return this.note({ content: params.content || '', kind: params.kind || 'fact' }, agentCtx);
      case 'feedback':
        return this.feedback(
          {
            id: params.id || '',
            contentRev: params.contentRev || 1,
            helpful: params.helpful ?? true,
            note: params.note,
          },
          agentCtx
        );
      case 'confirm':
        return this.confirm({ id: params.id || '' }, agentCtx);
      case 'merge':
        return this.merge(
          { sourceId: params.sourceId || '', targetId: params.targetId || '', reason: params.reason },
          agentCtx
        );
      case 'core_read':
        return this.coreRead({ block: params.block }, agentCtx);
      case 'core_set':
        return this.coreSet({ block: params.block || 'project', content: argsContent(params) }, agentCtx);
      case 'core_append':
        return this.coreAppend({ block: params.block || 'project', text: params.text || params.content || '' }, agentCtx);
      case 'reconcile':
        return this.reconcile({ content: params.content || '', type: params.kind || 'semantic', slotKey: params.slotKey }, agentCtx);
      case 'doctor':
        return this.doctor(agentCtx);
      case 'heal':
        return this.heal(agentCtx);
      case 'init':
      case 'bootstrap':
        return this.init(agentCtx, { force: params.force });
      default:
        return `Error: unknown action '${action}'. Supported: search, expand, note, feedback, confirm, merge, core_read, core_set, core_append, reconcile, doctor, heal, init`;
    }
  }
}

function argsContent(params: { content?: string; text?: string }): string {
  return params.content || params.text || '';
}
