import type { Db, MemoryRecord, MemoryType } from '../types.js';
import { get, sources } from '../core/store.js';
import { scopeFilterSQL, workspaceId } from '../core/scope.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recallLexical, recallEntity } from '../retrieval/channels.js';
import { fuseCandidates, DEFAULT_STRATEGY } from '../retrieval/fuse.js';
import { TAG_MAP } from '../retrieval/render.js';
import { budgetTokens } from '../core/tokens.js';
import { redactSecrets } from '../core/privacy.js';
import { upsertCandidate } from '../core/writer.js';
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

    // 运行 lexical 与 entity 检索
    const lexicalCands = recallLexical(this.db, plan, { workspaceId: wsId, sessionId, cfg: this.cfg });
    const entityCands = recallEntity(this.db, plan, { workspaceId: wsId, sessionId, cfg: this.cfg });

    const channelResults = {
      lexical: lexicalCands,
      entity: entityCands,
      typed: [],
      temporal: [],
      preference: [],
      vector: [],
    };

    const allIds = Array.from(new Set([...lexicalCands.map((c) => c.id), ...entityCands.map((c) => c.id)]));
    if (allIds.length === 0) {
      return 'No relevant memories found.';
    }

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

    const scored = fuseCandidates(
      plan,
      channelResults,
      memoriesMap,
      memoryEntitiesMap,
      new Set(),
      DEFAULT_STRATEGY,
      this.cfg,
      now
    );

    const filtered = scored.slice(0, limit);
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

      // 写一条 layer='tool' 的 injections 记录
      this.db.run(
        `INSERT OR IGNORE INTO injections (
          session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
        ) VALUES (?, ?, ?, ?, 'tool', ?, ?, 'summary', ?, ?)`,
        [sessionId, turn, m.id, m.content_rev, i + 1, m.summary_cost, this.strategyVersion, now]
      );
    }

    let output = lines.join('\n');
    // 约束在 800 tokens 以内
    while (lines.length > 1 && budgetTokens(output) > 800) {
      lines.pop();
      output = lines.join('\n');
    }

    return output;
  }

  /**
   * 2. memory_expand (§6.6)
   */
  public expand(
    params: { id: string },
    agentCtx: { workspaceId: string; sessionId?: string }
  ): string {
    const rawId = (params.id || '').trim();
    if (!rawId) return 'Error: memory id is required';

    const wsId = workspaceId(agentCtx.workspaceId);
    let mem: MemoryRecord | undefined;
    try {
      mem = get(this.db, rawId, { workspaceId: wsId });
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

    let res = `[${TAG_MAP[mem.type] || 'FACT'} ${mem.id}] (rev ${mem.content_rev})\n${cleanContent}`;
    if (srcLines.length > 0) {
      res += `\nSources:\n${srcLines.join('\n')}`;
    }

    // 约束总长度 <= 1500 tokens
    if (budgetTokens(res) > 1500) {
      // 优先削减证据
      res = `[${TAG_MAP[mem.type] || 'FACT'} ${mem.id}] (rev ${mem.content_rev})\n${cleanContent}`;
      if (budgetTokens(res) > 1500) {
        return `Error: memory content exceeds token limit (1500 tokens).`;
      }
    }

    return res;
  }

  /**
   * 3. memory_feedback (§6.6)
   */
  public feedback(
    params: { id: string; contentRev: number; helpful: boolean; note?: string },
    agentCtx: { sessionId: string; turn?: number }
  ): string {
    const rawId = (params.id || '').trim();
    const contentRev = Number(params.contentRev);
    if (!rawId || !Number.isInteger(contentRev) || contentRev < 1) {
      return 'Error: valid id and integer contentRev are required';
    }

    const mem = this.db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [rawId]);
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
    const inj = this.db.get<{ id: string }>(
      'SELECT memory_id FROM injections WHERE session_id = ? AND memory_id = ? AND content_rev = ?',
      [sessionId, rawId, contentRev]
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
          rawId,
        ]
      );

      this.db.run(
        `UPDATE injections
         SET outcome = ?, used = 1
         WHERE session_id = ? AND turn = ? AND memory_id = ? AND content_rev = ?`,
        [r, sessionId, turn, rawId, contentRev]
      );
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
}
