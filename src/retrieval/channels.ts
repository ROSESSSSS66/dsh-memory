import type { Db, QueryPlan, ChannelName } from '../types.js';
import { scopeFilterSQL } from '../core/scope.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  computeLocalEmbedding,
  decodeEmbeddingBlob,
  cosineSimilarity,
  getCachedRuntimeEmbedding,
  getOrComputeEmbedding,
} from '../core/vector.js';

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

/** lexical 并集快路径的原始结果，供同一次召回内的 typed 通道复用，避免重复执行同一条 FTS MATCH */
export interface LexicalFastPath {
  rows?: Array<{ id: string; ok: number; type: string }>;
}

const TYPED_CHANNEL_TYPES = new Set(['procedural', 'failure', 'episodic']);
const LEXICAL_FAST_LIMIT = 250;

/**
 * 1. Lexical 通道 (全文检索 BM25)
 */
export function recallLexical(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  shared?: LexicalFastPath
): Candidate[] {
  if (!plan.tokens || plan.tokens.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const matchTokens = Array.from(
    new Set(
      plan.tokens
        .slice(0, 32)
        .map((t) => `"${t.replace(/"/g, '')}"`)
        .filter((t) => t.length > 2)
    )
  );

  if (matchTokens.length === 0) {
    return [];
  }

  try {
    // 1. 高密度语料交集探针：当查询词 >= 3 个且同域存在 >= 25 条全词精确命中文档时，按高区分度词优先交集返回 (< 2ms)
    if (matchTokens.length >= 3) {
      const prioritized = [...matchTokens].sort((a, b) => {
        const aAsciiOrNum = /[0-9a-z]/i.test(a) ? 0 : 1;
        const bAsciiOrNum = /[0-9a-z]/i.test(b) ? 0 : 1;
        if (aAsciiOrNum !== bAsciiOrNum) return aAsciiOrNum - bAsciiOrNum;
        return b.length - a.length;
      });
      const andExpr = prioritized.slice(0, 6).join(' AND ');
      const andRows = db.all<{ id: string }>(
        `WITH top_and AS MATERIALIZED (
           SELECT rowid, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT 120
         )
         SELECT m.id
         FROM top_and f
         JOIN memories m ON m.rowid_ = f.rowid
         WHERE ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
         LIMIT 50`,
        [andExpr, ...scope.params]
      );
      if (andRows.length >= 25) {
        return andRows.map((r, idx) => ({
          id: r.id,
          channel: 'lexical',
          rank: idx + 1,
        }));
      }
    }

    const matchExpr = matchTokens.join(' OR ');

    // 2. 并集快路径：利用 FTS5 原生 C 层 Top-K 最小堆 (INDEX 32:M1) 先取前 250 条，避免 10k+ 命中时的全表回表与临时排序树
    const fastRows = db.all<{ id: string; ok: number; type: string }>(
      `WITH top_fts AS MATERIALIZED (
         SELECT rowid, rank
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT ${LEXICAL_FAST_LIMIT}
       )
       SELECT m.id, m.type,
              CASE WHEN (${scope.sql})
                    AND m.status IN ('active', 'frozen')
                    AND m.type != 'meta'
                   THEN 1 ELSE 0 END AS ok
       FROM top_fts f
       JOIN memories m ON m.rowid_ = f.rowid`,
      [matchExpr, ...scope.params]
    );
    if (shared) shared.rows = fastRows;

    let validIds = fastRows.filter((r) => r.ok === 1).map((r) => r.id);

    // 完备性回退：仅当全局 Top-250 触顶且有效同域结果不足 50 条时，回退全量关联查询保证 100% 精确召回
    if (fastRows.length >= LEXICAL_FAST_LIMIT && validIds.length < 50) {
      const fullRows = db.all<{ id: string }>(
        `SELECT m.id
         FROM memory_fts f
         JOIN memories m ON m.rowid_ = f.rowid
         WHERE memory_fts MATCH ?
           AND ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
         ORDER BY bm25(memory_fts)
         LIMIT 50`,
        [matchExpr, ...scope.params]
      );
      validIds = fullRows.map((r) => r.id);
    } else if (validIds.length > 50) {
      validIds = validIds.slice(0, 50);
    }

    return validIds.map((id, idx) => ({
      id,
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
export function recallTyped(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  shared?: LexicalFastPath
): Candidate[] {
  if (!plan.intents.procedural && !plan.intents.causal) {
    return [];
  }
  if (!plan.tokens || plan.tokens.length === 0) {
    return [];
  }

  // lexical 通道刚用同一批 token 跑过 Top-K：未触顶时其结果已包含全部命中，直接按类型筛选即可
  if (shared?.rows) {
    const typedIds = shared.rows
      .filter((r) => r.ok === 1 && TYPED_CHANNEL_TYPES.has(r.type))
      .map((r) => r.id);
    if (shared.rows.length < LEXICAL_FAST_LIMIT || typedIds.length >= 20) {
      return typedIds.slice(0, 20).map((id, idx) => ({ id, channel: 'typed', rank: idx + 1 }));
    }
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

  try {
    const fastRows = db.all<{ id: string; ok: number }>(
      `WITH top_fts AS MATERIALIZED (
         SELECT rowid, rank
         FROM memory_fts
         WHERE memory_fts MATCH ?
         ORDER BY rank
         LIMIT 200
       )
       SELECT m.id,
              CASE WHEN (${scope.sql})
                    AND m.status IN ('active', 'frozen')
                    AND m.type IN ('procedural', 'failure', 'episodic')
                   THEN 1 ELSE 0 END AS ok
       FROM top_fts f
       JOIN memories m ON m.rowid_ = f.rowid`,
      [matchExpr, ...scope.params]
    );

    let validIds = fastRows.filter((r) => r.ok === 1).map((r) => r.id);

    if (fastRows.length >= 200 && validIds.length < 20) {
      const rows = db.all<{ id: string }>(
        `SELECT m.id
         FROM memory_fts f
         JOIN memories m ON m.rowid_ = f.rowid
         WHERE memory_fts MATCH ?
           AND ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type IN ('procedural', 'failure', 'episodic')
         ORDER BY bm25(memory_fts)
         LIMIT 20`,
        [matchExpr, ...scope.params]
      );
      validIds = rows.map((r) => r.id);
    } else if (validIds.length > 20) {
      validIds = validIds.slice(0, 20);
    }

    return validIds.map((id, idx) => ({
      id,
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
    // 1. 强制走 ix_mem_vec_rank 覆盖索引提取 Top-400 (id, hash)，零主表与零临时排序树扫描
    const ranked = db.all<{ id: string; hash: string }>(
      `SELECT m.id, m.hash
       FROM memories m INDEXED BY ix_mem_vec_rank
       WHERE m.status IN ('active', 'frozen')
         AND m.type != 'meta'
         AND (${scope.sql})
       ORDER BY m.pinned DESC, m.utility DESC, m.updated_at DESC
       LIMIT 400`,
      scope.params
    );

    if (ranked.length === 0) {
      return [];
    }

    // 2. 优先命中内存 LRU / 外部缓存；仅对冷启动未缓存项按主键批量拉取一次
    const vecById = new Map<string, Float32Array>();
    const missingIds: string[] = [];
    for (const r of ranked) {
      const cachedVec = cache?.get(r.id) ?? getCachedRuntimeEmbedding(r.id, r.hash);
      if (cachedVec) {
        vecById.set(r.id, cachedVec);
      } else {
        missingIds.push(r.id);
      }
    }

    if (missingIds.length > 0) {
      const placeholders = missingIds.map(() => '?').join(', ');
      const fetchedRows = db.all<{
        id: string;
        summary?: string;
        content?: string;
        slot_key?: string | null;
        hash?: string;
        embedding: Uint8Array | Buffer | null;
      }>(
        `SELECT id, summary, content, slot_key, hash, embedding
         FROM memories
         WHERE id IN (${placeholders})`,
        missingIds
      );
      for (const fullRow of fetchedRows) {
        const docVec = getOrComputeEmbedding(fullRow, cache);
        if (docVec) {
          vecById.set(fullRow.id, docVec);
        }
      }
    }

    const queryVec = computeLocalEmbedding(plan.text);
    const scored: Array<{ id: string; similarity: number }> = [];

    for (const r of ranked) {
      const docVec = vecById.get(r.id);
      if (!docVec) continue;
      const sim = cosineSimilarity(queryVec, docVec);
      if (sim >= minSim) {
        scored.push({ id: r.id, similarity: sim });
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
  const lexicalFastPath: LexicalFastPath = {};
  results.lexical = recallLexical(db, plan, ctx, lexicalFastPath);
  if (Date.now() - t0 > onlineBudget) return results;

  // entity
  results.entity = recallEntity(db, plan, ctx);
  if (Date.now() - t0 > onlineBudget) return results;

  // typed
  results.typed = recallTyped(db, plan, ctx, lexicalFastPath);
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

export interface AssociativeNeighbor {
  neighborId: string;
  seedId: string;
  rel: 'related' | 'derived_from';
  seedRank: number;
  hop?: 1 | 2;
  seedDegree?: number;
  activationWeight?: number;
}

/**
 * SYNAPSE (Jan 2026) / ACT-R 扇出注意力稀释因子 (Fan-Effect Attenuation)
 * 当种子节点关联的边数 (degree/fan) 越高，单条边分配到的激活能量越低，抑制泛化 Hub 节点噪声
 */
export function computeFanAttenuation(degree: number): number {
  const d = Math.max(1, degree);
  return Number((1 / (1 + 0.25 * Math.log(1 + Math.max(0, d - 1)))).toFixed(4));
}

/**
 * 7. GraphRAG + SYNAPSE 扇出衰减多跳关联拓扑扩展 (Spreading Activation over related / derived_from)
 * 从高优先级种子候选中沿着正向关系边 (related / derived_from) 发现同作用域的 1~2 跳关联活跃记忆，
 * 并基于 ACT-R Fan Effect 与跳数阻尼 (gamma = 0.45) 计算激活扩散权重。
 */
export function expandGraphNeighbors(
  db: Db,
  seedIds: string[],
  ctx: ChannelContext,
  maxNeighbors: number = 12
): AssociativeNeighbor[] {
  const uniqueSeeds = Array.from(new Set(seedIds)).slice(0, 8);
  if (uniqueSeeds.length === 0) return [];

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId });
  const placeholders = uniqueSeeds.map(() => '?').join(', ');

  try {
    const rows = db.all<{
      from_id: string;
      to_id: string;
      rel: 'related' | 'derived_from';
      neighbor_id: string;
    }>(
      `SELECT r.from_id, r.to_id, r.rel, m.id as neighbor_id
       FROM memory_relations r
       JOIN memories m ON (m.id = CASE WHEN r.from_id IN (${placeholders}) THEN r.to_id ELSE r.from_id END)
       WHERE r.rel IN ('related', 'derived_from')
         AND (r.from_id IN (${placeholders}) OR r.to_id IN (${placeholders}))
         AND m.status IN ('active', 'frozen')
         AND m.type != 'meta'
         AND (${scope.sql})
       LIMIT ?`,
      [...uniqueSeeds, ...uniqueSeeds, ...uniqueSeeds, ...scope.params, maxNeighbors * 3]
    );

    const seedRankMap = new Map<string, number>();
    uniqueSeeds.forEach((id, idx) => seedRankMap.set(id, idx + 1));

    // 计算各判断种子节点的关联扇出度 (Fan Degree)
    const seedDegreeMap = new Map<string, number>();
    for (const r of rows) {
      const seedId = seedRankMap.has(r.from_id) ? r.from_id : r.to_id;
      seedDegreeMap.set(seedId, (seedDegreeMap.get(seedId) || 0) + 1);
    }

    const results: AssociativeNeighbor[] = [];
    const seen = new Set<string>();
    const hop1BridgeNodes: Array<{ bridgeId: string; rootSeedId: string; rootRank: number; hop1Weight: number }> = [];

    for (const r of rows) {
      const seedId = seedRankMap.has(r.from_id) ? r.from_id : r.to_id;
      const neighborId = r.neighbor_id;
      if (neighborId === seedId) continue;
      const pairKey = `${seedId}->${neighborId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const seedRank = seedRankMap.get(seedId) ?? 1;
      const seedDegree = seedDegreeMap.get(seedId) ?? 1;
      const activationWeight = computeFanAttenuation(seedDegree);

      results.push({
        neighborId,
        seedId,
        rel: r.rel,
        seedRank,
        hop: 1,
        seedDegree,
        activationWeight,
      });

      if (seedRank <= 2 && !seedRankMap.has(neighborId) && hop1BridgeNodes.length < 4) {
        hop1BridgeNodes.push({
          bridgeId: neighborId,
          rootSeedId: seedId,
          rootRank: seedRank,
          hop1Weight: activationWeight,
        });
      }

      const hop1Cap = maxNeighbors >= 6 ? maxNeighbors - 2 : maxNeighbors;
      if (results.length >= hop1Cap) break;
    }

    // 二跳阻尼扩散 (HippoRAG 2 / SYNAPSE 2-Hop Damped Spreading Activation, gamma = 0.45)
    if (results.length < maxNeighbors && hop1BridgeNodes.length > 0) {
      const bridgeIds = hop1BridgeNodes.map((b) => b.bridgeId);
      const bridgePlaceholders = bridgeIds.map(() => '?').join(', ');
      const hop2Rows = db.all<{
        from_id: string;
        to_id: string;
        rel: 'related' | 'derived_from';
        neighbor_id: string;
      }>(
        `SELECT r.from_id, r.to_id, r.rel, m.id as neighbor_id
         FROM memory_relations r
         JOIN memories m ON (m.id = CASE WHEN r.from_id IN (${bridgePlaceholders}) THEN r.to_id ELSE r.from_id END)
         WHERE r.rel IN ('related', 'derived_from')
           AND (r.from_id IN (${bridgePlaceholders}) OR r.to_id IN (${bridgePlaceholders}))
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
           AND (${scope.sql})
         LIMIT ?`,
        [...bridgeIds, ...bridgeIds, ...bridgeIds, ...scope.params, maxNeighbors]
      );

      const bridgeMap = new Map(hop1BridgeNodes.map((b) => [b.bridgeId, b]));
      const bridgeDegreeMap = new Map<string, number>();
      for (const r of hop2Rows) {
        const bId = bridgeMap.has(r.from_id) ? r.from_id : r.to_id;
        bridgeDegreeMap.set(bId, (bridgeDegreeMap.get(bId) || 0) + 1);
      }

      for (const r of hop2Rows) {
        if (results.length >= maxNeighbors) break;
        const bId = bridgeMap.has(r.from_id) ? r.from_id : r.to_id;
        const bridgeInfo = bridgeMap.get(bId);
        if (!bridgeInfo) continue;

        const targetId = r.neighbor_id;
        if (targetId === bId || targetId === bridgeInfo.rootSeedId || seedRankMap.has(targetId)) {
          continue;
        }
        const pairKey = `${bridgeInfo.rootSeedId}->${targetId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const bridgeDegree = bridgeDegreeMap.get(bId) ?? 1;
        const hop2Weight = Number(
          (0.45 * bridgeInfo.hop1Weight * computeFanAttenuation(bridgeDegree)).toFixed(4)
        );

        results.push({
          neighborId: targetId,
          seedId: bridgeInfo.rootSeedId,
          rel: r.rel,
          seedRank: bridgeInfo.rootRank,
          hop: 2,
          seedDegree: bridgeDegree,
          activationWeight: hop2Weight,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}
