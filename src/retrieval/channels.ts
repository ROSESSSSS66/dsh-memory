import type { Db, QueryPlan, ChannelName } from '../types.js';
import { scopeFilterSQL } from '../core/scope.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { computeLocalEmbedding } from '../core/vector.js';
import { searchWorkspaceVectors } from '../core/vector-index.js';

export interface Candidate {
  id: string;
  channel: ChannelName;
  rank: number; // 1-based
  similarity?: number;
}

export interface ChannelContext {
  workspaceId: string;
  sessionId?: string;
  cfg?: PluginConfig;
  precomputedQueryVec?: Float32Array;
}

/** lexical 并集快路径的原始结果，供同一次召回内的 typed 通道复用，避免重复执行同一条 FTS MATCH */
export interface LexicalFastPath {
  rows?: Array<{ id: string; ok: number; type: string }>;
  fromAndProbe?: boolean;
  primaryTokens?: string[];
  droppedAny?: boolean;
}

const TYPED_CHANNEL_TYPES = new Set(['procedural', 'failure', 'episodic']);
const LEXICAL_FAST_LIMIT = 250;
const TYPED_FALLBACK_FTS_LIMIT = 600;
const LEXICAL_AND_PROBE_MAX_TOKENS = 16;

interface TemporalAuxEntry {
  id: string;
  scope: string;
  workspace_id: string | null;
  session_id: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  valid_from: number | null;
  valid_to: number | null;
}

interface TemporalAuxCache {
  dv: number;
  tc: number;
  entries: TemporalAuxEntry[];
}

const temporalAuxCacheByDb = new WeakMap<Db, TemporalAuxCache>();

function readDbVersionSnapshot(db: Db): { dv: number; tc: number } {
  try {
    const row = db.get<{ dv: number; tc: number }>(
      'SELECT (SELECT data_version FROM pragma_data_version) AS dv, total_changes() AS tc'
    );
    return {
      dv: typeof row?.dv === 'number' ? row.dv : 0,
      tc: typeof row?.tc === 'number' ? row.tc : 0,
    };
  } catch {
    return { dv: -1, tc: -1 };
  }
}

function getTemporalAuxEntries(db: Db): TemporalAuxEntry[] {
  const snap = readDbVersionSnapshot(db);
  const cached = temporalAuxCacheByDb.get(db);
  if (cached && snap.dv >= 0 && cached.dv === snap.dv && cached.tc === snap.tc) {
    return cached.entries;
  }

  const entries = db.all<TemporalAuxEntry>(
    `SELECT id, scope, workspace_id, session_id, status, created_at, updated_at, valid_from, valid_to
     FROM memories
     WHERE status IN ('active', 'frozen', 'superseded')
       AND type != 'meta'
       AND (valid_from IS NOT NULL OR updated_at != created_at)`
  );
  if (snap.dv >= 0) {
    temporalAuxCacheByDb.set(db, { dv: snap.dv, tc: snap.tc, entries });
  }
  return entries;
}

/**
 * 识别查询词元中被复合词/驼峰词严格覆盖且复合词本身已在 memory_fts 命中 (>=1 条，5µs LIMIT 1 探针) 的冗余子词元：
 * 避免如 "cluster_3" -> "cluster"、"node-5" -> "node"、"srv-12.internal" -> "srv"/"internal"、"PostgreSQL" -> "postgre"/"sql"
 * 在 10k-50k 规模下将高频泛化子词注入 OR 查询导致全表 BM25 扫描；若复合词无命中则原样保留子词确保 100% 召回完备性。
 */
function pruneMatchedCompoundSubTokens(
  db: Db,
  matchTokens: string[]
): { primaryTokens: string[]; droppedAny: boolean } {
  if (matchTokens.length <= 2) {
    return { primaryTokens: matchTokens, droppedAny: false };
  }

  const unquoted = matchTokens.map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
  const rawSet = new Set(unquoted);
  const compoundCandidates: Array<{ quoted: string; subs: string[] }> = [];
  const separatorCompounds = new Set<string>();

  for (let i = 0; i < unquoted.length; i++) {
    const raw = unquoted[i];
    if (/[/.\-_@:]/.test(raw)) {
      separatorCompounds.add(raw);
      const parts = raw.split(/[/.\-_@:]+/).filter((p) => p.length >= 2 && p !== raw);
      const subs: string[] = [];
      for (const p of parts) {
        if (rawSet.has(p)) subs.push(p);
      }
      if (subs.length > 0) {
        compoundCandidates.push({ quoted: matchTokens[i], subs });
      }
    }
  }

  // 检测由两个已知子词拼接而成的驼峰词（如 postgresql = postgre + sql, oomkilled = oom + killed）
  for (let i = 0; i < unquoted.length; i++) {
    const raw = unquoted[i];
    if (raw.length < 5 || !/^[a-z]+$/.test(raw)) continue;
    for (let split = 2; split <= raw.length - 2; split++) {
      const left = raw.slice(0, split);
      const right = raw.slice(split);
      if (rawSet.has(left) && rawSet.has(right)) {
        compoundCandidates.push({ quoted: matchTokens[i], subs: [left, right] });
        break;
      }
    }
  }

  if (compoundCandidates.length === 0) {
    return { primaryTokens: matchTokens, droppedAny: false };
  }

  const redundantSubs = new Set<string>();
  for (const cand of compoundCandidates) {
    try {
      const hit = db.get<{ hit: number }>(
        'SELECT 1 AS hit FROM memory_fts WHERE memory_fts MATCH ? LIMIT 1',
        [cand.quoted]
      );
      if (hit) {
        for (const sub of cand.subs) {
          if (!separatorCompounds.has(sub)) {
            redundantSubs.add(sub);
          }
        }
      }
    } catch {
      // 忽略探针异常，保守保留全部词元
    }
  }

  if (redundantSubs.size === 0) {
    return { primaryTokens: matchTokens, droppedAny: false };
  }

  const primaryTokens: string[] = [];
  for (let i = 0; i < matchTokens.length; i++) {
    if (!redundantSubs.has(unquoted[i])) {
      primaryTokens.push(matchTokens[i]);
    }
  }

  if (primaryTokens.length === 0) {
    return { primaryTokens: matchTokens, droppedAny: false };
  }

  return {
    primaryTokens,
    droppedAny: primaryTokens.length < matchTokens.length,
  };
}

function toFtsQuotedToken(raw: string): string | null {
  const cleaned = raw.replace(/"/g, '').trim();
  if (!cleaned || !/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return `"${cleaned}"`;
}

/**
 * 为 FTS5 筛选至多 maxTokens (默认 32) 个高价值查询词元：
 * 1) 优先取 plan.entities 与 plan.contentTokens（仅当均为空时回退 plan.tokens），杜绝提示词污染 FTS
 * 2) 优先保留实体、数字（端口号/错误码等）与字母词元
 * 3) 对超长 CJK 查询执行头尾均衡采样（如前 14 + 后 18），彻底修复长中文问句末尾关键词被截断丢失
 */
export function selectLexicalMatchTokens(plan: QueryPlan, maxTokens: number = 32): string[] {
  const sourceTokens =
    plan.contentTokens && plan.contentTokens.length > 0
      ? plan.contentTokens
      : plan.tokens || [];

  const priority: string[] = [];
  const prioritySet = new Set<string>();
  const addPriority = (raw: string) => {
    const tok = toFtsQuotedToken(raw);
    if (tok && !prioritySet.has(tok)) {
      prioritySet.add(tok);
      priority.push(tok);
    }
  };

  for (const ent of plan.entities || []) {
    addPriority(ent);
  }
  for (const t of sourceTokens) {
    if (/\d/.test(t)) addPriority(t);
  }
  for (const t of sourceTokens) {
    if (/[a-z]/i.test(t)) addPriority(t);
  }

  const remaining: string[] = [];
  const remainingSet = new Set<string>();
  for (const t of sourceTokens) {
    const tok = toFtsQuotedToken(t);
    if (tok && !prioritySet.has(tok) && !remainingSet.has(tok)) {
      remainingSet.add(tok);
      remaining.push(tok);
    }
  }

  const maxPriority =
    remaining.length === 0
      ? maxTokens
      : Math.min(priority.length, Math.max(maxTokens - remaining.length, Math.floor(maxTokens / 2)));

  const selected: string[] = [];
  if (priority.length <= maxPriority) {
    selected.push(...priority);
  } else {
    const pHead = Math.ceil(maxPriority * 0.65);
    const pTail = maxPriority - pHead;
    selected.push(...priority.slice(0, pHead), ...priority.slice(priority.length - pTail));
  }

  const slotsLeft = maxTokens - selected.length;
  if (slotsLeft > 0 && remaining.length > 0) {
    if (remaining.length <= slotsLeft) {
      selected.push(...remaining);
    } else {
      const headCount = Math.floor(slotsLeft * 0.44);
      const tailCount = slotsLeft - headCount;
      selected.push(
        ...remaining.slice(0, headCount),
        ...remaining.slice(remaining.length - tailCount)
      );
    }
  }

  return selected;
}

/**
 * 构建净化后的向量查询文本（去除自然问句提示词与复合路径重复子词，为空时回退 plan.text）
 */
export function buildVectorQueryText(plan: QueryPlan): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const coveredSubTokens = new Set<string>();

  const registerSubTokens = (norm: string) => {
    if (/[/.\-_@:]/.test(norm)) {
      for (const sub of norm.split(/[/.\-_@:]+/)) {
        if (sub.length >= 2) coveredSubTokens.add(sub);
      }
    }
  };

  for (const ent of plan.entities || []) {
    const norm = ent.toLowerCase().trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    parts.push(norm);
    registerSubTokens(norm);
  }

  for (const tok of plan.contentTokens || []) {
    const norm = tok.toLowerCase().trim();
    if (!norm || seen.has(norm) || coveredSubTokens.has(norm)) continue;
    seen.add(norm);
    parts.push(norm);
    registerSubTokens(norm);
  }

  const cleaned = parts.join(' ').trim();
  return cleaned || plan.text || '';
}

/**
 * 1. Lexical 通道 (全文检索 BM25)
 */
export function recallLexical(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  shared?: LexicalFastPath
): Candidate[] {
  const matchTokens = selectLexicalMatchTokens(plan, 32);
  if (matchTokens.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }, 'm');

  try {
    const { primaryTokens, droppedAny } = pruneMatchedCompoundSubTokens(db, matchTokens);
    if (shared) {
      shared.primaryTokens = primaryTokens;
      shared.droppedAny = droppedAny;
    }

    // 1. 高密度语料交集探针：当主实词数在 [2, 16] 时优先执行全词 AND 交集，
    //    利用 FTS5 最短倒排链求交避免对 10k-50k 高频词全量 OR 扫描，并回填 shared.rows 供 recallTyped 直接复用
    if (primaryTokens.length >= 2 && primaryTokens.length <= LEXICAL_AND_PROBE_MAX_TOKENS) {
      const andExpr = primaryTokens.join(' AND ');
      const andRows = db.all<{ id: string; type: string }>(
        `WITH top_and AS MATERIALIZED (
           SELECT rowid, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT 120
         )
         SELECT m.id, m.type
         FROM top_and f
         CROSS JOIN memories m ON m.rowid_ = f.rowid
         WHERE ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
         ORDER BY f.rank
         LIMIT 50`,
        [andExpr, ...scope.params]
      );
      if (andRows.length >= 25) {
        if (shared) {
          shared.rows = andRows.map((r) => ({ id: r.id, ok: 1, type: r.type }));
          shared.fromAndProbe = true;
        }
        return andRows.map((r, idx) => ({
          id: r.id,
          channel: 'lexical',
          rank: idx + 1,
        }));
      }
    }

    const runOrFastPath = (
      tokens: string[]
    ): { fastRows: Array<{ id: string; ok: number; type: string }>; validIds: string[] } => {
      const expr = tokens.join(' OR ');
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
         CROSS JOIN memories m ON m.rowid_ = f.rowid
         ORDER BY f.rank`,
        [expr, ...scope.params]
      );
      const validIds = fastRows.filter((r) => r.ok === 1).map((r) => r.id);
      return { fastRows, validIds };
    };

    // 2. 并集快路径：先使用已去冗余复合子词的 primaryTokens；若有效结果不足 15 条再回退全量 matchTokens 确保完备召回
    let activeTokens = primaryTokens;
    let { fastRows, validIds } = runOrFastPath(activeTokens);

    if (droppedAny && validIds.length < 15) {
      activeTokens = matchTokens;
      const fallback = runOrFastPath(activeTokens);
      fastRows = fallback.fastRows;
      validIds = fallback.validIds;
    }

    if (shared) {
      shared.rows = fastRows;
      shared.fromAndProbe = false;
    }

    // 完备性回退：仅当全局 Top-250 触顶且有效同域结果不足 50 条时，回退全量关联查询保证精确召回
    if (fastRows.length >= LEXICAL_FAST_LIMIT && validIds.length < 50) {
      const fullMatchExpr = activeTokens.join(' OR ');
      const fullRows = db.all<{ id: string }>(
        `SELECT m.id
         FROM memory_fts f
         CROSS JOIN memories m ON m.rowid_ = f.rowid
         WHERE memory_fts MATCH ?
           AND ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
         ORDER BY f.rank
         LIMIT 50`,
        [fullMatchExpr, ...scope.params]
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
 * 2. Entity 通道 (实体倒排索引：显式查询实体权重 3 严格高于上下文工具实体权重 1，并按 utility/updated_at 确定性破平)
 */
export function recallEntity(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  const primaryEntities = Array.from(
    new Set((plan.entities || []).map((e) => e.toLowerCase().trim()).filter(Boolean))
  );
  const primarySet = new Set(primaryEntities);
  const secondaryEntities = Array.from(
    new Set(
      (plan.contextEntities || [])
        .map((e) => e.toLowerCase().trim())
        .filter((e) => e && !primarySet.has(e))
    )
  );
  const allEntities = [...primaryEntities, ...secondaryEntities];

  if (allEntities.length === 0) {
    return [];
  }

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }, 'm');
  const allPlaceholders = allEntities.map(() => '?').join(', ');

  let sql: string;
  let params: unknown[];

  if (primaryEntities.length > 0 && secondaryEntities.length > 0) {
    const primaryPlaceholders = primaryEntities.map(() => '?').join(', ');
    sql = `
      SELECT m.id,
             SUM(CASE WHEN e.entity IN (${primaryPlaceholders}) THEN 3 ELSE 1 END) AS score
      FROM memory_entities e
      JOIN memories m ON m.id = e.memory_id
      WHERE e.entity IN (${allPlaceholders})
        AND ${scope.sql}
        AND m.status IN ('active', 'frozen')
        AND m.type != 'meta'
      GROUP BY m.id
      ORDER BY score DESC, m.utility DESC, m.updated_at DESC
      LIMIT 30
    `;
    params = [...primaryEntities, ...allEntities, ...scope.params];
  } else {
    const weight = primaryEntities.length > 0 ? 3 : 1;
    sql = `
      SELECT m.id, COUNT(*) * ${weight} AS score
      FROM memory_entities e
      JOIN memories m ON m.id = e.memory_id
      WHERE e.entity IN (${allPlaceholders})
        AND ${scope.sql}
        AND m.status IN ('active', 'frozen')
        AND m.type != 'meta'
      GROUP BY m.id
      ORDER BY score DESC, m.utility DESC, m.updated_at DESC
      LIMIT 30
    `;
    params = [...allEntities, ...scope.params];
  }

  try {
    const rows = db.all<{ id: string }>(sql, params);
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
 * 直接复用 lexical 通道已拉取的 shared.rows，彻底消除 50k 规模下重复执行 LIMIT 200 CTE 与无界全表回表
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

  if (shared?.rows) {
    let validCount = 0;
    const typedIds: string[] = [];
    for (let i = 0; i < shared.rows.length; i++) {
      const r = shared.rows[i];
      if (r.ok === 1) {
        validCount++;
        if (TYPED_CHANNEL_TYPES.has(r.type)) {
          typedIds.push(r.id);
        }
      }
    }
    // 复用 lexical 结果：命中目标类型、或 lexical OR 已覆盖足够同域 Top-BM25 结果 (>=50) / 未触顶时直接返回，杜绝 50k 下重复 FTS5 OR 全扫
    if (
      typedIds.length > 0 ||
      (!shared.fromAndProbe && (shared.rows.length < LEXICAL_FAST_LIMIT || validCount >= 50))
    ) {
      return typedIds.slice(0, 20).map((id, idx) => ({
        id,
        channel: 'typed',
        rank: idx + 1,
      }));
    }
  }

  const matchTokens = selectLexicalMatchTokens(plan, 32);
  if (matchTokens.length === 0) {
    return [];
  }

  try {
    // 5µs 覆盖索引探测：库内不存在目标类型活跃记忆时直接返回
    const hasTyped = db.get<{ hit: number }>(
      `SELECT 1 AS hit FROM memories WHERE type IN ('procedural', 'failure', 'episodic') AND status IN ('active', 'frozen') LIMIT 1`
    );
    if (!hasTyped) {
      return [];
    }

    const pruned = shared?.primaryTokens
      ? { primaryTokens: shared.primaryTokens, droppedAny: Boolean(shared.droppedAny) }
      : pruneMatchedCompoundSubTokens(db, matchTokens);
    const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }, 'm');

    const runTypedMatch = (expr: string, ftsLimit: number): Array<{ id: string }> =>
      db.all<{ id: string }>(
        `WITH top_typed AS MATERIALIZED (
           SELECT rowid, rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ${ftsLimit}
         )
         SELECT m.id
         FROM top_typed f
         CROSS JOIN memories m ON m.rowid_ = f.rowid
         WHERE ${scope.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type IN ('procedural', 'failure', 'episodic')
         ORDER BY f.rank
         LIMIT 20`,
        [expr, ...scope.params]
      );

    if (
      !shared?.fromAndProbe &&
      pruned.primaryTokens.length >= 2 &&
      pruned.primaryTokens.length <= LEXICAL_AND_PROBE_MAX_TOKENS
    ) {
      const andTyped = runTypedMatch(pruned.primaryTokens.join(' AND '), 120);
      if (andTyped.length >= 10) {
        return andTyped.map((r, idx) => ({
          id: r.id,
          channel: 'typed',
          rank: idx + 1,
        }));
      }
    }

    let rows = runTypedMatch(pruned.primaryTokens.join(' OR '), TYPED_FALLBACK_FTS_LIMIT);
    if (rows.length === 0 && pruned.droppedAny) {
      rows = runTypedMatch(matchTokens.join(' OR '), TYPED_FALLBACK_FTS_LIMIT);
    }

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
 * 4. Temporal 通道 (基于 ix_mem_temporal 的分作用域/分状态严格有序索引范围检索 + 轻量版本感知辅助缓存)
 * - 主路径按 (scope, workspace_id, status) 等值 + created_at BETWEEN 范围直击 ix_mem_temporal，单分支 LIMIT 20 零临时排序
 * - 辅助路径缓存 valid_from IS NOT NULL 与 updated_at != created_at 的少量记录（随 data_version/total_changes 严格失效）
 * - temporalBrowse ("昨天发生了什么") 仅匹配在时间窗内创建/更新/生效的记录，不再误召回两年前的长期无过期事实
 */
export function recallTemporal(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.timeRange) {
    return [];
  }

  const { from, to } = plan.timeRange;
  const ws = ctx.workspaceId || '';
  const sid = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';
  const statuses = plan.temporalBrowse ? (['active', 'frozen', 'superseded'] as const) : (['active', 'frozen'] as const);
  const allowedStatusSet = new Set<string>(statuses);

  const branches: string[] = [];
  const params: unknown[] = [];

  for (const status of statuses) {
    // 分支 1: user 作用域（严格命中 ix_mem_temporal: scope='user', workspace_id IS NULL, status, created_at DESC）
    branches.push(
      `SELECT id, created_at, updated_at FROM (
         SELECT id, created_at, updated_at
         FROM memories
         WHERE scope = 'user'
           AND workspace_id IS NULL
           AND status = '${status}'
           AND created_at BETWEEN ? AND ?
           AND type != 'meta'
         ORDER BY created_at DESC
         LIMIT 20
       )`
    );
    params.push(from, to);

    // 分支 2: global 作用域
    branches.push(
      `SELECT id, created_at, updated_at FROM (
         SELECT id, created_at, updated_at
         FROM memories
         WHERE scope = 'global'
           AND workspace_id IS NULL
           AND status = '${status}'
           AND created_at BETWEEN ? AND ?
           AND type != 'meta'
         ORDER BY created_at DESC
         LIMIT 20
       )`
    );
    params.push(from, to);

    // 分支 3: workspace 作用域
    branches.push(
      `SELECT id, created_at, updated_at FROM (
         SELECT id, created_at, updated_at
         FROM memories
         WHERE scope = 'workspace'
           AND workspace_id = ?
           AND status = '${status}'
           AND created_at BETWEEN ? AND ?
           AND type != 'meta'
         ORDER BY created_at DESC
         LIMIT 20
       )`
    );
    params.push(ws, from, to);

    // 分支 4: session 作用域（仅当存在有效 sessionId 时启用，严格防止跨会话泄漏）
    if (sid) {
      branches.push(
        `SELECT id, created_at, updated_at FROM (
           SELECT id, created_at, updated_at
           FROM memories
           WHERE scope = 'session'
             AND workspace_id = ?
             AND status = '${status}'
             AND created_at BETWEEN ? AND ?
             AND session_id = ?
             AND type != 'meta'
           ORDER BY created_at DESC
           LIMIT 20
         )`
      );
      params.push(ws, from, to, sid);
    }
  }

  const sql = `
    SELECT id, created_at, updated_at
    FROM (
      ${branches.join('\n      UNION ALL\n      ')}
    )
    ORDER BY created_at DESC, updated_at DESC
    LIMIT 20
  `;

  try {
    const createdRows = db.all<{ id: string; created_at: number; updated_at: number }>(sql, params);
    const auxEntries = getTemporalAuxEntries(db);

    if (auxEntries.length === 0) {
      return createdRows.map((r, idx) => ({
        id: r.id,
        channel: 'temporal',
        rank: idx + 1,
      }));
    }

    const merged = new Map<string, { id: string; created_at: number; updated_at: number }>();
    for (const r of createdRows) {
      merged.set(r.id, r);
    }

    for (let i = 0; i < auxEntries.length; i++) {
      const e = auxEntries[i];
      if (!allowedStatusSet.has(e.status)) continue;

      const inScope =
        ((e.scope === 'user' || e.scope === 'global') && e.workspace_id === null) ||
        (e.scope === 'workspace' && e.workspace_id === ws) ||
        (Boolean(sid) && e.scope === 'session' && e.workspace_id === ws && e.session_id === sid);
      if (!inScope) continue;

      let timeMatch = false;
      if (plan.temporalBrowse) {
        timeMatch =
          (e.updated_at >= from && e.updated_at <= to) ||
          (e.valid_from !== null && e.valid_from >= from && e.valid_from <= to);
      } else {
        timeMatch =
          e.valid_from !== null &&
          e.valid_from <= to &&
          (e.valid_to === null || e.valid_to >= from);
      }

      if (timeMatch && !merged.has(e.id)) {
        merged.set(e.id, {
          id: e.id,
          created_at: e.created_at,
          updated_at: e.updated_at,
        });
      }
    }

    const sorted = Array.from(merged.values());
    sorted.sort(
      (a, b) =>
        b.created_at - a.created_at ||
        b.updated_at - a.updated_at ||
        a.id.localeCompare(b.id)
    );

    return sorted.slice(0, 20).map((r, idx) => ({
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
 * 5. Preference 通道 (偏好意图检索：低基数走 ix_mem_type，高基数走 ix_mem_weave 分域有序 LIMIT 10 避免全表排序)
 */
export function recallPreference(db: Db, plan: QueryPlan, ctx: ChannelContext): Candidate[] {
  if (!plan.intents.preference && !plan.preferenceBrowse) {
    return [];
  }

  try {
    // 20µs 基数探测：覆盖索引 ix_mem_type(type, status) 上限 201 行
    const prefCount =
      db.get<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT 1 FROM memories WHERE type = 'preference' AND status IN ('active', 'frozen') LIMIT 201
         )`
      )?.cnt ?? 0;

    if (prefCount === 0) {
      return [];
    }

    if (prefCount <= 200) {
      const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }, 'm');
      const rows = db.all<{ id: string }>(
        `SELECT m.id
         FROM memories m
         WHERE m.type = 'preference'
           AND ${scope.sql}
           AND m.status IN ('active', 'frozen')
         ORDER BY m.utility DESC, m.updated_at DESC
         LIMIT 10`,
        scope.params
      );
      return rows.map((r, idx) => ({
        id: r.id,
        channel: 'preference',
        rank: idx + 1,
      }));
    }

    // 高基数路径：按 (scope, workspace_id, status) 走 ix_mem_weave 预排序索引单分支 LIMIT 10
    const ws = ctx.workspaceId || '';
    const sid = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';
    const branches: string[] = [];
    const params: unknown[] = [];

    for (const status of ['active', 'frozen'] as const) {
      branches.push(
        `SELECT id, utility, updated_at FROM (
           SELECT id, utility, updated_at
           FROM memories
           WHERE scope = 'user' AND workspace_id IS NULL AND status = '${status}' AND type = 'preference'
           ORDER BY utility DESC, updated_at DESC
           LIMIT 10
         )`
      );
      branches.push(
        `SELECT id, utility, updated_at FROM (
           SELECT id, utility, updated_at
           FROM memories
           WHERE scope = 'global' AND workspace_id IS NULL AND status = '${status}' AND type = 'preference'
           ORDER BY utility DESC, updated_at DESC
           LIMIT 10
         )`
      );
      branches.push(
        `SELECT id, utility, updated_at FROM (
           SELECT id, utility, updated_at
           FROM memories
           WHERE scope = 'workspace' AND workspace_id = ? AND status = '${status}' AND type = 'preference'
           ORDER BY utility DESC, updated_at DESC
           LIMIT 10
         )`
      );
      params.push(ws);

      if (sid) {
        branches.push(
          `SELECT id, utility, updated_at FROM (
             SELECT id, utility, updated_at
             FROM memories
             WHERE scope = 'session' AND workspace_id = ? AND status = '${status}' AND session_id = ? AND type = 'preference'
             ORDER BY utility DESC, updated_at DESC
             LIMIT 10
           )`
        );
        params.push(ws, sid);
      }
    }

    const rows = db.all<{ id: string }>(
      `SELECT id
       FROM (
         ${branches.join('\n         UNION ALL\n         ')}
       )
       ORDER BY utility DESC, updated_at DESC
       LIMIT 10`,
      params
    );

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
 * 6. Vector 通道 (基于按工作区懒加载的全量内存向量矩阵 WorkspaceVectorIndex，彻底消除 Top-400 盲区与 INDEXED BY 脆弱依赖)
 */
export function recallVector(
  db: Db,
  plan: QueryPlan,
  ctx: ChannelContext,
  _cache?: Map<string, Float32Array>
): Candidate[] {
  if (
    !ctx.precomputedQueryVec &&
    (!plan.text ||
      ((!plan.tokens || plan.tokens.length === 0) &&
        (!plan.entities || plan.entities.length === 0)))
  ) {
    return [];
  }

  const minSim = ctx.cfg?.minVectorSimilarity ?? DEFAULTS.minVectorSimilarity;

  try {
    const queryVec =
      ctx.precomputedQueryVec ?? computeLocalEmbedding(buildVectorQueryText(plan));
    if (!queryVec || queryVec.length === 0) {
      return [];
    }

    const hits = searchWorkspaceVectors(
      db,
      { workspaceId: ctx.workspaceId, sessionId: ctx.sessionId },
      queryVec,
      {
        limit: 30,
        minScore: minSim * 0.5,
      }
    );

    return hits.map((hit, idx) => ({
      id: hit.id,
      channel: 'vector',
      rank: idx + 1,
      similarity: Number(hit.score.toFixed(4)),
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
  bridgeEntity?: string;
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
 * - 拆分 OR 边查询为 UNION ALL（分别命中 ix_rel_type 与 ix_rel_type_to，兼顾 seed-to-seed 对称协同）
 * - 实体二部图桥接先通过 eligible_entities CTE 过滤 fan <= 10，防止高频 Hub 实体挤占稀缺桥接实体
 */
export function expandGraphNeighbors(
  db: Db,
  seedIds: string[],
  ctx: ChannelContext,
  maxNeighbors: number = 12
): AssociativeNeighbor[] {
  const uniqueSeeds = Array.from(new Set(seedIds)).slice(0, 8);
  if (uniqueSeeds.length === 0 || maxNeighbors <= 0) return [];

  const scope = scopeFilterSQL({ workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }, 'm');
  const placeholders = uniqueSeeds.map(() => '?').join(', ');

  try {
    // 一、1-Hop 显式关系边（UNION ALL + CROSS JOIN 锁定 r -> m 主键驱动，命中 ix_rel_type 与 ix_rel_type_to，兼顾 seed-to-seed 对称性）
    const rows = db.all<{
      seed_id: string;
      neighbor_id: string;
      rel: 'related' | 'derived_from';
    }>(
      `SELECT seed_id, neighbor_id, rel
       FROM (
         SELECT r.from_id AS seed_id, r.to_id AS neighbor_id, r.rel AS rel
         FROM memory_relations r
         CROSS JOIN memories m ON m.id = r.to_id
         WHERE r.rel IN ('related', 'derived_from')
           AND r.from_id IN (${placeholders})
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
           AND (${scope.sql})
         UNION ALL
         SELECT r.to_id AS seed_id, r.from_id AS neighbor_id, r.rel AS rel
         FROM memory_relations r
         CROSS JOIN memories m ON m.id = r.from_id
         WHERE r.rel IN ('related', 'derived_from')
           AND r.to_id IN (${placeholders})
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
           AND (${scope.sql})
       )
       LIMIT ?`,
      [...uniqueSeeds, ...scope.params, ...uniqueSeeds, ...scope.params, maxNeighbors * 4]
    );

    const seedRankMap = new Map<string, number>();
    for (let idx = 0; idx < uniqueSeeds.length; idx++) {
      seedRankMap.set(uniqueSeeds[idx], idx + 1);
    }

    // 按种子排名升序排序，确保高优先级种子不被低排名种子挤占容量
    rows.sort(
      (a, b) =>
        (seedRankMap.get(a.seed_id) ?? 99) - (seedRankMap.get(b.seed_id) ?? 99) ||
        a.neighbor_id.localeCompare(b.neighbor_id)
    );

    // 按去重邻接点统计每个种子节点的关联扇出度 (Fan Degree)
    const seedNeighborsMap = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.neighbor_id === r.seed_id) continue;
      let set = seedNeighborsMap.get(r.seed_id);
      if (!set) {
        set = new Set();
        seedNeighborsMap.set(r.seed_id, set);
      }
      set.add(r.neighbor_id);
    }

    const results: AssociativeNeighbor[] = [];
    const seen = new Set<string>();
    const hop1BridgeNodes: Array<{
      bridgeId: string;
      rootSeedId: string;
      rootRank: number;
      hop1Weight: number;
    }> = [];
    const hop1Cap = maxNeighbors >= 6 ? maxNeighbors - 2 : maxNeighbors;

    for (const r of rows) {
      const seedId = r.seed_id;
      const neighborId = r.neighbor_id;
      if (neighborId === seedId) continue;
      const pairKey = `${seedId}->${neighborId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const seedRank = seedRankMap.get(seedId) ?? 1;
      const seedDegree = seedNeighborsMap.get(seedId)?.size ?? 1;
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

      if (seedRank <= 3 && !seedRankMap.has(neighborId) && hop1BridgeNodes.length < 4) {
        hop1BridgeNodes.push({
          bridgeId: neighborId,
          rootSeedId: seedId,
          rootRank: seedRank,
          hop1Weight: activationWeight,
        });
      }

      if (results.length >= hop1Cap) break;
    }

    // 二、二跳阻尼扩散 (HippoRAG 2 / SYNAPSE 2-Hop Damped Spreading Activation, gamma = 0.45)
    if (results.length < maxNeighbors && hop1BridgeNodes.length > 0) {
      const bridgeIds = Array.from(new Set(hop1BridgeNodes.map((b) => b.bridgeId)));
      const bridgePlaceholders = bridgeIds.map(() => '?').join(', ');
      const hop2Rows = db.all<{
        bridge_id: string;
        neighbor_id: string;
        rel: 'related' | 'derived_from';
      }>(
        `SELECT bridge_id, neighbor_id, rel
         FROM (
           SELECT r.from_id AS bridge_id, r.to_id AS neighbor_id, r.rel AS rel
           FROM memory_relations r
           CROSS JOIN memories m ON m.id = r.to_id
           WHERE r.rel IN ('related', 'derived_from')
             AND r.from_id IN (${bridgePlaceholders})
             AND m.status IN ('active', 'frozen')
             AND m.type != 'meta'
             AND (${scope.sql})
           UNION ALL
           SELECT r.to_id AS bridge_id, r.from_id AS neighbor_id, r.rel AS rel
           FROM memory_relations r
           CROSS JOIN memories m ON m.id = r.from_id
           WHERE r.rel IN ('related', 'derived_from')
             AND r.to_id IN (${bridgePlaceholders})
             AND m.status IN ('active', 'frozen')
             AND m.type != 'meta'
             AND (${scope.sql})
         )
         LIMIT ?`,
        [...bridgeIds, ...scope.params, ...bridgeIds, ...scope.params, maxNeighbors * 2]
      );

      const bridgeMap = new Map(hop1BridgeNodes.map((b) => [b.bridgeId, b]));
      const bridgeNeighborsMap = new Map<string, Set<string>>();
      for (const r of hop2Rows) {
        if (r.neighbor_id === r.bridge_id) continue;
        let set = bridgeNeighborsMap.get(r.bridge_id);
        if (!set) {
          set = new Set();
          bridgeNeighborsMap.set(r.bridge_id, set);
        }
        set.add(r.neighbor_id);
      }

      for (const r of hop2Rows) {
        if (results.length >= maxNeighbors) break;
        const bridgeInfo = bridgeMap.get(r.bridge_id);
        if (!bridgeInfo) continue;

        const targetId = r.neighbor_id;
        if (
          targetId === r.bridge_id ||
          targetId === bridgeInfo.rootSeedId ||
          seedRankMap.has(targetId)
        ) {
          continue;
        }
        const pairKey = `${bridgeInfo.rootSeedId}->${targetId}`;
        if (seen.has(pairKey)) continue;
        seen.add(pairKey);

        const bridgeDegree = bridgeNeighborsMap.get(r.bridge_id)?.size ?? 1;
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

    // 三、Hindsight 实体二部图桥接遍历 (Bipartite Entity-Bridge Traversal: seed -> @entity -> neighbor)
    // 三步显式驱动：1) 主键拉取种子实体 (空表/无实体 5µs 立即返回)；2) LIMIT 11 有界扇出检测 O(11) 阻断 10k+ Hub 实体扫描；
    // 3) 仅对 fan ∈ [2, 10] 的稀缺桥接实体 CROSS JOIN memories 主键回表，彻底消除 SQLite CTE 连接翻转导致的全表扫描
    if (results.length < maxNeighbors) {
      const entitySeeds = uniqueSeeds.slice(0, 6);
      const entPlaceholders = entitySeeds.map(() => '?').join(', ');
      const remainingSlots = maxNeighbors - results.length;

      const seedEntRows = db.all<{ memory_id: string; entity: string }>(
        `SELECT memory_id, entity
         FROM memory_entities
         WHERE memory_id IN (${entPlaceholders})
           AND length(entity) >= 2`,
        entitySeeds
      );

      if (seedEntRows.length > 0) {
        const entityToSeeds = new Map<string, string[]>();
        for (const row of seedEntRows) {
          let list = entityToSeeds.get(row.entity);
          if (!list) {
            list = [];
            entityToSeeds.set(row.entity, list);
          }
          list.push(row.memory_id);
        }

        const eligibleEntities: Array<{ entity: string; fan: number }> = [];
        for (const entity of entityToSeeds.keys()) {
          const fanRow = db.get<{ fan: number }>(
            `SELECT COUNT(*) AS fan FROM (SELECT 1 FROM memory_entities WHERE entity = ? LIMIT 11)`,
            [entity]
          );
          const fan = fanRow?.fan ?? 0;
          if (fan >= 2 && fan <= 10) {
            eligibleEntities.push({ entity, fan });
          }
        }

        if (eligibleEntities.length > 0) {
          const fanMap = new Map(eligibleEntities.map((e) => [e.entity, e.fan]));
          const eligNames = eligibleEntities.map((e) => e.entity);
          const eligPlaceholders = eligNames.map(() => '?').join(', ');

          const neighborRows = db.all<{
            entity: string;
            neighbor_id: string;
            utility: number;
            updated_at: number;
          }>(
            `SELECT e2.entity AS entity, m.id AS neighbor_id, m.utility AS utility, m.updated_at AS updated_at
             FROM memory_entities e2
             CROSS JOIN memories m ON m.id = e2.memory_id
             WHERE e2.entity IN (${eligPlaceholders})
               AND m.status IN ('active', 'frozen')
               AND m.type != 'meta'
               AND (${scope.sql})`,
            [...eligNames, ...scope.params]
          );

          const entityBridgeRows: Array<{
            seed_id: string;
            entity: string;
            fan: number;
            neighbor_id: string;
            utility: number;
            updated_at: number;
          }> = [];

          for (const nr of neighborRows) {
            const seedsForEntity = entityToSeeds.get(nr.entity);
            if (!seedsForEntity) continue;
            const fan = fanMap.get(nr.entity) ?? 2;
            for (const seedId of seedsForEntity) {
              if (nr.neighbor_id === seedId || seedRankMap.has(nr.neighbor_id)) continue;
              entityBridgeRows.push({
                seed_id: seedId,
                entity: nr.entity,
                fan,
                neighbor_id: nr.neighbor_id,
                utility: nr.utility ?? 0,
                updated_at: nr.updated_at ?? 0,
              });
            }
          }

          entityBridgeRows.sort(
            (a, b) =>
              a.fan - b.fan ||
              b.utility - a.utility ||
              b.updated_at - a.updated_at ||
              (seedRankMap.get(a.seed_id) ?? 99) - (seedRankMap.get(b.seed_id) ?? 99) ||
              a.neighbor_id.localeCompare(b.neighbor_id)
          );

          const cap = Math.max(remainingSlots * 3, 12);
          for (let i = 0; i < entityBridgeRows.length && i < cap; i++) {
            const er = entityBridgeRows[i];
            if (results.length >= maxNeighbors) break;
            if (!er.entity || er.entity.length < 2) continue;

            const pairKey = `${er.seed_id}->${er.neighbor_id}`;
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);

            const seedRank = seedRankMap.get(er.seed_id) ?? 1;
            const entityFan = Math.max(2, er.fan || 2);
            const bridgeWeight = Number((0.78 * computeFanAttenuation(entityFan)).toFixed(4));

            results.push({
              neighborId: er.neighbor_id,
              seedId: er.seed_id,
              rel: 'related',
              seedRank,
              hop: 1,
              seedDegree: entityFan,
              activationWeight: bridgeWeight,
              bridgeEntity: er.entity,
            });
          }
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}
