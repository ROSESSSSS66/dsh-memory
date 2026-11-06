import type { Db, QueryPlan, ChannelName } from '../types.js';
import { scopeFilterSQL } from '../core/scope.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { computeLocalEmbedding, decodeEmbeddingBlob, cosineSimilarity } from '../core/vector.js';

export interface Candidate {
  id: string;
  channel: ChannelName;
  rank: number; // 1-based
  similarity?: number;
}

export interface ChannelContext {
  workspaceId: string;
  sessionId: string;
  cfg?: PluginConfig;
}

/**
 * 1. Lexical 通道 (全文检索 BM25)
 */
export function recallLexical(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.tokens || plan.tokens.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const matchTokens = plan.tokens
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .filter((t) => t.length > 2);

  if (matchTokens.length === 0) {
    return [];
  }

  const matchExpr = matchTokens.join(' OR ');

  const sql = `
    SELECT m.id
    FROM memory_fts f
    JOIN memories m ON m.rowid_ = f.rowid
    WHERE memory_fts MATCH ?
      AND ${scope.sql}
      AND m.status IN ('active', 'frozen')
      AND m.type != 'meta'
    ORDER BY bm25(memory_fts)
    LIMIT 50
  `;

  try {
    const rows = db.all<{ id: string }>(sql, [matchExpr, ...scope.params]);
    return rows.map((r, idx) => ({
      id: r.id,
      channel: 'lexical',
      rank: idx + 1,
    }));
  } catch (err: any) {
    console.warn('[dsh-memory] recallLexical error:', err?.message || err);
    return [];
  }
}

/**
 * 2. Entity 通道 (实体倒排索引)
 */
export function recallEntity(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  const allEntities = Array.from(new Set([...plan.entities, ...plan.contextEntities]))
    .map((e) => e.toLowerCase().trim())
    .filter(Boolean);

  if (allEntities.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const placeholders = allEntities.map(() => '?').join(', ');

  const sql = `
    SELECT m.id, COUNT(*) as cnt
    FROM memory_entities e
    JOIN memories m ON m.id = e.memory_id
    WHERE e.entity IN (${placeholders})
      AND ${scope.sql}
      AND m.status IN ('active', 'frozen')
      AND m.type != 'meta'
    GROUP BY m.id
    ORDER BY cnt DESC
    LIMIT 30
  `;

  try {
    const rows = db.all<{ id: string }>(sql, [...allEntities, ...scope.params]);
    return rows.map((r, idx) => ({
      id: r.id,
      channel: 'entity',
      rank: idx + 1,
    }));
  } catch (err: any) {
    console.warn('[dsh-memory] recallEntity error:', err?.message || err);
    return [];
  }
}

/**
 * 3. Typed 通道 (procedural / causal 意图下的特定类型检索)
 */
export function recallTyped(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.intents.procedural && !plan.intents.causal) {
    return [];
  }
  if (!plan.tokens || plan.tokens.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const matchTokens = plan.tokens
    .slice(0, 32)
    .map((t) => `"${t.replace(/"/g, '')}"`)
    .filter((t) => t.length > 2);

  if (matchTokens.length === 0) {
    return [];
  }

  const matchExpr = matchTokens.join(' OR ');

  const sql = `
    SELECT m.id
    FROM memory_fts f
    JOIN memories m ON m.rowid_ = f.rowid
    WHERE memory_fts MATCH ?
      AND ${scope.sql}
      AND m.status IN ('active', 'frozen')
      AND m.type IN ('procedural', 'failure', 'episodic')
    ORDER BY bm25(memory_fts)
    LIMIT 20
  `;

  try {
    const rows = db.all<{ id: string }>(sql, [matchExpr, ...scope.params]);
    return rows.map((r, idx) => ({
      id: r.id,
      channel: 'typed',
      rank: idx + 1,
    }));
  } catch (err: any) {
    console.warn('[dsh-memory] recallTyped error:', err?.message || err);
    return [];
  }
}

/**
 * 4. Temporal 通道 (时间范围命中)
 */
export function recallTemporal(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.timeRange) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const statusCondition = plan.temporalBrowse
    ? "m.status IN ('active', 'frozen', 'superseded')"
    : "m.status IN ('active', 'frozen')";

  const { from, to } = plan.timeRange;

  const sql = `
    SELECT m.id
    FROM memories m
    WHERE ${statusCondition}
      AND ${scope.sql}
      AND m.type != 'meta'
      AND (
        (m.created_at BETWEEN ? AND ?)
        OR (m.valid_from <= ? AND (m.valid_to IS NULL OR m.valid_to >= ?))
      )
    ORDER BY m.created_at DESC
    LIMIT 20
  `;

  try {
    const rows = db.all<{ id: string }>(sql, [
      ...scope.params,
      from,
      to,
      to,
      from,
    ]);
    return rows.map((r, idx) => ({
      id: r.id,
      channel: 'temporal',
      rank: idx + 1,
    }));
  } catch (err: any) {
    console.warn('[dsh-memory] recallTemporal error:', err?.message || err);
    return [];
  }
}

/**
 * 5. Preference 通道 (偏好意图检索)
 */
export function recallPreference(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.intents.preference && !plan.preferenceBrowse) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });

  const sql = `
    SELECT m.id
    FROM memories m
    WHERE m.type = 'preference'
      AND ${scope.sql}
      AND m.status IN ('active', 'frozen')
    ORDER BY m.utility DESC
    LIMIT 10
  `;

  try {
    const rows = db.all<{ id: string }>(sql, scope.params);
    return rows.map((r, idx) => ({
      id: r.id,
      channel: 'preference',
      rank: idx + 1,
    }));
  } catch (err: any) {
    console.warn('[dsh-memory] recallPreference error:', err?.message || err);
    return [];
  }
}

/**
 * 6. Vector 通道 (离线计算+在线纯内存/本地特征向量余弦检索)
 */
export function recallVector(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  cache?: Map<string, Float32Array>
): Candidate[] {
  if (!plan.text || ((!plan.tokens || plan.tokens.length === 0) && (!plan.entities || plan.entities.length === 0))) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const minSim = ctx.cfg?.minVectorSimilarity ?? DEFAULTS.minVectorSimilarity;

  try {
    const rows = cache && cache.size > 0
      ? db.all<{ id: string; embedding: Uint8Array | Buffer | null }>(
          `SELECT m.id, m.embedding
           FROM memories m
           WHERE m.status IN ('active', 'frozen')
             AND (${scope.sql})
           LIMIT 250`,
          scope.params
        )
      : db.all<{ id: string; embedding: Uint8Array | Buffer | null }>(
          `SELECT m.id, m.embedding
           FROM memories m
           WHERE m.status IN ('active', 'frozen')
             AND m.embedding IS NOT NULL
             AND (${scope.sql})
           LIMIT 250`,
          scope.params
        );

    if (rows.length === 0) {
      return [];
    }

    const queryVec = computeLocalEmbedding(plan.text);
    const scored: Array<{ id: string; similarity: number }> = [];

    for (const row of rows) {
      const docVec = cache?.get(row.id) ?? decodeEmbeddingBlob(row.embedding);
      if (!docVec) continue;
      const sim = cosineSimilarity(queryVec, docVec);
      if (sim >= minSim) {
        scored.push({ id: row.id, similarity: sim });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, 20).map((item, idx) => ({
      id: item.id,
      channel: 'vector',
      rank: idx + 1,
      similarity: Number(item.similarity.toFixed(4)),
    }));
  } catch {
    return [];
  }
}

/**
 * 运行所有召回通道
 */
export function runAllChannels(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  options: {
    onlineBudgetMs?: number;
    t0?: number;
  } = {}
): Record<ChannelName, Candidate[]> {
  const t0 = options.t0 ?? Date.now();
  const onlineBudget = options.onlineBudgetMs ?? (ctx.cfg?.onlineBudgetMs || DEFAULTS.onlineBudgetMs);

  const results: Record<ChannelName, Candidate[]> = {
    lexical: [],
    entity: [],
    typed: [],
    temporal: [],
    preference: [],
    vector: [],
  };

  // lexical 总是运行
  results.lexical = recallLexical(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // entity
  results.entity = recallEntity(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // typed
  results.typed = recallTyped(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // temporal
  results.temporal = recallTemporal(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // preference
  results.preference = recallPreference(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // vector
  results.vector = recallVector(db, plan, ctx);

  return results;
}
