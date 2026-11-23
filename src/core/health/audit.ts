import type { Db } from '../../types.js';
import { memoryPrivacyFilterSQL } from '../privacy.js';
import { scopeFilterSQL, workspaceId } from '../scope.js';
import { jaccard, tokenSet } from '../text.js';
import { cosineSimilarity, getOrComputeEmbedding } from '../vector.js';

export interface DuplicatePairItem {
  sourceId: string;
  targetId: string;
  sourceSummary: string;
  targetSummary: string;
  similarity: number;
  slotKey: string | null;
  reason: 'same_slot_key' | 'high_lexical_overlap' | 'high_semantic_overlap';
}

export type DuplicatePair = DuplicatePairItem;

export interface ContradictionItem {
  fromId: string;
  toId: string;
  fromSummary: string;
  toSummary: string;
}

export interface StaleMemoryItem {
  id: string;
  type: string;
  summary: string;
  utility: number;
  daysUnused: number;
}

export interface MemoryHealthReport {
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  counts: {
    total: number;
    active: number;
    candidate: number;
    frozen: number;
    superseded: number;
    archived: number;
    pinned: number;
  };
  ftsConsistent: boolean;
  ftsCount: number;
  missingEmbeddingsCount?: number;
  embeddingsReadyCount?: number;
  orphanMemoriesCount?: number;
  staleModelsCount?: number;
  staleModelIds?: string[];
  danglingRelationsCount?: number;
  duplicatePairs: DuplicatePairItem[];
  contradictions: ContradictionItem[];
  staleMemories: StaleMemoryItem[];
  recommendations: string[];
  checkedAt: number;
}

export interface AuditMemoryHealthOptions {
  workspaceId?: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
  now?: number;
  maxDuplicates?: number;
}

export const STALE_UTILITY_THRESHOLD = 0.35;
export const STALE_MIN_DAYS_UNUSED = 14;
const DAY_MS = 86_400_000;

/**
 * 构建健康审计/自愈/织网统一的作用域与隐私隔离 SQL 片段：
 * - 指定 workspaceId 时严格使用 scopeFilterSQL（无 sessionId 时绝不泄漏 session 作用域）
 * - 全局扫描无 sessionId 时同样排除 session 作用域，防止跨会话串扰
 * - 始终叠加 memoryPrivacyFilterSQL(excludeWorkspaces)
 */
export function buildHealthScopeFilter(
  options: { workspaceId?: string; sessionId?: string; excludeWorkspaces?: string[] },
  tableAlias?: string
): { sql: string; params: unknown[] } {
  const p = tableAlias ? `${tableAlias}.` : '';
  const clauses: string[] = [];
  const params: unknown[] = [];

  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;
  const sid = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';

  if (wsFilter) {
    const sf = scopeFilterSQL({ workspaceId: wsFilter, sessionId: sid || undefined }, tableAlias);
    clauses.push(sf.sql);
    params.push(...sf.params);
  } else if (sid) {
    clauses.push(`(${p}scope != 'session' OR ${p}session_id = ?)`);
    params.push(sid);
  } else {
    clauses.push(`${p}scope != 'session'`);
  }

  const privacy = memoryPrivacyFilterSQL(options.excludeWorkspaces);
  if (privacy.params.length > 0) {
    const privSql = tableAlias
      ? privacy.sql.replace(/\bmemories\./g, `${tableAlias}.`)
      : privacy.sql;
    clauses.push(privSql);
    params.push(...privacy.params);
  }

  return {
    sql: clauses.join(' AND '),
    params,
  };
}

/**
 * 规范化槽位键用于近似等价检测：
 * 严格保留 `.` 层级边界，仅在每个 `.` 分段内将 `-` / `_` / 空白统一为 `_`（绝不吞掉 `.` 或 `_`），
 * 因而 `pkg_manager` === `pkg-manager`，而 `api.v1_0` !== `api.v10` 且 `api.v1.0` !== `api.v10`。
 */
export function normSlot(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .toLowerCase()
    .trim()
    .split('.')
    .map((seg) => seg.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, ''))
    .join('.');
}

function parseSnapshotSources(
  metadata: string | null | undefined
): Array<{ memory_id: string; content_rev: number; hash: string }> {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && Array.isArray(parsed.sources)) {
      return parsed.sources.filter(
        (s: unknown): s is { memory_id: string; content_rev: number; hash: string } =>
          Boolean(s) &&
          typeof s === 'object' &&
          typeof (s as { memory_id?: unknown }).memory_id === 'string' &&
          typeof (s as { content_rev?: unknown }).content_rev === 'number' &&
          typeof (s as { hash?: unknown }).hash === 'string'
      );
    }
  } catch {
    // ignore malformed metadata
  }
  return [];
}

function detectStaleModels(db: Db, filter: { sql: string; params: unknown[] }): string[] {
  const modelRows = db.all<{ id: string }>(
    `SELECT id FROM memories
     WHERE status IN ('active', 'frozen')
       AND (slot_key LIKE 'hindsight.model.%' OR slot_key LIKE 'hindsight.obs.%')
       AND (${filter.sql})
     LIMIT 100`,
    filter.params
  );
  if (modelRows.length === 0) return [];

  const modelIds = modelRows.map((m) => m.id);
  const ph = modelIds.map(() => '?').join(', ');
  const edges = db.all<{
    from_id: string;
    to_id: string;
    metadata: string | null;
    target_id: string | null;
    target_status: string | null;
    target_rev: number | null;
    target_hash: string | null;
  }>(
    `SELECT r.from_id, r.to_id, r.metadata,
            t.id AS target_id, t.status AS target_status,
            t.content_rev AS target_rev, t.hash AS target_hash
     FROM memory_relations r
     LEFT JOIN memories t ON t.id = r.to_id
     WHERE r.rel = 'derived_from'
       AND r.from_id IN (${ph})`,
    modelIds
  );

  const staleSet = new Set<string>();
  for (const edge of edges) {
    if (staleSet.has(edge.from_id)) continue;
    const alive =
      edge.target_id !== null &&
      (edge.target_status === 'active' || edge.target_status === 'frozen');
    if (!alive) {
      staleSet.add(edge.from_id);
      continue;
    }
    const snaps = parseSnapshotSources(edge.metadata);
    const snap = snaps.find((s) => s.memory_id === edge.to_id);
    if (snap && (snap.content_rev !== edge.target_rev || snap.hash !== edge.target_hash)) {
      staleSet.add(edge.from_id);
    }
  }

  return Array.from(staleSet);
}

function countDanglingRelations(
  db: Db,
  options: { workspaceId?: string; sessionId?: string; excludeWorkspaces?: string[] }
): number {
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;
  if (wsFilter) {
    const f1 = buildHealthScopeFilter(options, 'm1');
    const f2 = buildHealthScopeFilter(options, 'm2');
    const row = db.get<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM memory_relations r
       LEFT JOIN memories m1 ON m1.id = r.from_id
       LEFT JOIN memories m2 ON m2.id = r.to_id
       WHERE (m1.id IS NULL OR m2.id IS NULL)
         AND (
           (m1.id IS NOT NULL AND (${f1.sql}))
           OR (m2.id IS NOT NULL AND (${f2.sql}))
         )`,
      [...f1.params, ...f2.params]
    );
    return Number(row?.cnt ?? 0);
  }

  const row = db.get<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM memory_relations r
     LEFT JOIN memories m1 ON m1.id = r.from_id
     LEFT JOIN memories m2 ON m2.id = r.to_id
     WHERE m1.id IS NULL OR m2.id IS NULL`
  );
  return Number(row?.cnt ?? 0);
}

function countActiveOrphans(
  db: Db,
  activeRows: Array<{ id: string; type: string; slot_key: string | null }>,
  options: { workspaceId?: string; sessionId?: string; excludeWorkspaces?: string[] }
): number {
  if (activeRows.length < 2) return 0;

  const nonCoreActiveRows = activeRows.filter(
    (r) => !r.slot_key?.startsWith('core:') && r.type !== 'meta'
  );
  if (nonCoreActiveRows.length === 0) return 0;

  const auditIdsJson = JSON.stringify(activeRows.map((r) => r.id));
  const f1 = buildHealthScopeFilter(options, 'm1');
  const f2 = buildHealthScopeFilter(options, 'm2');

  // 仅计入邻居同处于 active/frozen 且符合作用域/隐私过滤的有效关系边
  const allRelRows = db.all<{ from_id: string; to_id: string }>(
    `SELECT r.from_id, r.to_id
     FROM memory_relations r
     JOIN memories m1 ON m1.id = r.from_id
     JOIN memories m2 ON m2.id = r.to_id
     WHERE r.rel IN ('related', 'derived_from', 'supersedes')
       AND m1.status IN ('active', 'frozen')
       AND m2.status IN ('active', 'frozen')
       AND m1.id != m2.id
       AND (${f1.sql})
       AND (${f2.sql})
       AND (r.from_id IN (SELECT value FROM json_each(?)) OR r.to_id IN (SELECT value FROM json_each(?)))`,
    [...f1.params, ...f2.params, auditIdsJson, auditIdsJson]
  );

  const connectedIdSet = new Set<string>();
  for (const rel of allRelRows) {
    connectedIdSet.add(rel.from_id);
    connectedIdSet.add(rel.to_id);
  }

  let orphanMemoriesCount = 0;
  for (const r of nonCoreActiveRows) {
    if (!connectedIdSet.has(r.id)) {
      orphanMemoriesCount++;
    }
  }
  return orphanMemoriesCount;
}

function checkFtsHealth(db: Db): { ftsConsistent: boolean; ftsCount: number } {
  const totalGlobalRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memories`);
  try {
    const ftsRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memory_fts`);
    const ftsCount = Number(ftsRow?.c ?? 0);
    return {
      ftsCount,
      ftsConsistent: ftsCount === Number(totalGlobalRow?.c ?? 0),
    };
  } catch {
    return { ftsCount: 0, ftsConsistent: false };
  }
}

function computeScoreGradeAndRecommendations(params: {
  ftsConsistent: boolean;
  duplicatePairs: DuplicatePairItem[];
  contradictions: ContradictionItem[];
  staleMemories: StaleMemoryItem[];
  counts: MemoryHealthReport['counts'];
  orphanMemoriesCount: number;
  staleModelsCount: number;
  danglingRelationsCount: number;
}): { score: number; grade: MemoryHealthReport['grade']; recommendations: string[] } {
  const {
    ftsConsistent,
    duplicatePairs,
    contradictions,
    staleMemories,
    counts,
    orphanMemoriesCount,
    staleModelsCount,
    danglingRelationsCount,
  } = params;

  let score = 100;
  if (!ftsConsistent) score -= 25;
  score -= Math.min(30, duplicatePairs.length * 6);
  score -= Math.min(25, contradictions.length * 8);
  score -= Math.min(15, staleMemories.length * 2);
  if (counts.candidate > 15) {
    score -= Math.min(10, Math.floor((counts.candidate - 15) / 3));
  }
  if (staleModelsCount > 0) {
    score -= Math.min(8, staleModelsCount * 2);
  }
  if (danglingRelationsCount > 0) {
    score -= Math.min(5, danglingRelationsCount);
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade: MemoryHealthReport['grade'] = 'A+';
  if (score >= 95) grade = 'A+';
  else if (score >= 85) grade = 'A';
  else if (score >= 75) grade = 'B';
  else if (score >= 60) grade = 'C';
  else grade = 'D';

  const recommendations: string[] = [];
  if (!ftsConsistent) {
    recommendations.push(
      'FTS5 倒排索引行数与 memories 主表存在偏差，全自动自愈守护进程将在下一周期自动对齐并重建索引。'
    );
  }
  if (duplicatePairs.length > 0) {
    recommendations.push(
      `检测到 ${duplicatePairs.length} 对高相似或共享槽位 (slot_key) 的活跃记忆，全自动自愈引擎将自动合并去重并收敛因果链。`
    );
  }
  if (contradictions.length > 0) {
    recommendations.push(
      `存在 ${contradictions.length} 组尚未消解的显式矛盾记忆 (contradicts)，全自动自愈引擎将依据效用与置信度自动裁决并归档旧规则。`
    );
  }
  if (staleMemories.length > 0) {
    recommendations.push(
      `发现 ${staleMemories.length} 条长期未召回的低效用记忆 (Utility < ${STALE_UTILITY_THRESHOLD} 且 >= ${STALE_MIN_DAYS_UNUSED} 天未使用)，全自动老化维护守护进程将自动降级归档以保障召回信噪比。`
    );
  }
  if (counts.candidate > 10) {
    recommendations.push(
      `当前有 ${counts.candidate} 条候选记忆在观察池中，高置信度候选将由全自动晋升流水线自动转正。`
    );
  }
  if (orphanMemoriesCount >= 3) {
    recommendations.push(
      `检测到 ${orphanMemoriesCount} 条缺乏活跃拓扑关联的孤岛记忆，A-Mem 自动双链织网引擎将在后台自动编织语义图谱。`
    );
  }
  if (staleModelsCount > 0) {
    recommendations.push(
      `检测到 ${staleModelsCount} 条派生源已变更或失效的陈旧心智模型 (hindsight.model.*)，Hindsight 反思引擎将在下一周期刷新或归档。`
    );
  }
  if (danglingRelationsCount > 0) {
    recommendations.push(
      `检测到 ${danglingRelationsCount} 条指向已删除记录的悬空关系边 (memory_relations)，建议执行清理以维持图谱完整性。`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('全自动记忆系统运行健康：FTS5 索引同步、无冗余槽位冲突、无活跃矛盾记忆。');
  }

  return { score, grade, recommendations };
}

/**
 * 轻量级刷新健康报告（供 autoHealMemoryHealth 在仅发生 FTS / 向量回填 / 织网 / 校准等非结构变更时复用，
 * 避免重复运行 O(n²) 词法/向量相似度扫描）
 */
export function refreshLightweightHealthReport(
  db: Db,
  previous: MemoryHealthReport,
  options: AuditMemoryHealthOptions = {}
): MemoryHealthReport {
  const now = options.now ?? Date.now();
  const normOpts = options.workspaceId
    ? { ...options, workspaceId: workspaceId(options.workspaceId) }
    : options;
  const filter = buildHealthScopeFilter(normOpts);

  const { ftsConsistent, ftsCount } = checkFtsHealth(db);

  const missingEmbRow = db.get<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM memories
     WHERE status IN ('active', 'frozen')
       AND embedding IS NULL
       AND (${filter.sql})`,
    filter.params
  );
  const missingEmbeddingsCount = Number(missingEmbRow?.cnt ?? 0);
  const embeddingsReadyCount = Math.max(
    0,
    previous.counts.active + previous.counts.frozen - missingEmbeddingsCount
  );

  const activeStubRows = db.all<{ id: string; type: string; slot_key: string | null }>(
    `SELECT id, type, slot_key FROM memories
     WHERE status IN ('active', 'frozen')
       AND (${filter.sql})
     ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
     LIMIT 250`,
    filter.params
  );
  const orphanMemoriesCount = countActiveOrphans(db, activeStubRows, normOpts);
  const staleModelIds = detectStaleModels(db, filter);
  const staleModelsCount = staleModelIds.length;
  const danglingRelationsCount = countDanglingRelations(db, normOpts);

  const { score, grade, recommendations } = computeScoreGradeAndRecommendations({
    ftsConsistent,
    duplicatePairs: previous.duplicatePairs,
    contradictions: previous.contradictions,
    staleMemories: previous.staleMemories,
    counts: previous.counts,
    orphanMemoriesCount,
    staleModelsCount,
    danglingRelationsCount,
  });

  return {
    ...previous,
    score,
    grade,
    ftsConsistent,
    ftsCount,
    missingEmbeddingsCount,
    embeddingsReadyCount,
    orphanMemoriesCount,
    staleModelsCount,
    staleModelIds,
    danglingRelationsCount,
    recommendations,
    checkedAt: now,
  };
}

/**
 * 记忆库健康度与冲突体检医生 (Memory Health & Conflict Doctor)
 * 审计维度：
 * 1. 状态分布与候选积压 (Active / Candidate / Frozen / Superseded / Archived)
 * 2. FTS5 倒排索引与主表一致性
 * 3. 全库未嵌入计数 (命中 ix_mem_missing_embedding)
 * 4. 同作用域下的槽位冲突与高相似度冗余对（保留 `.` 分段边界，且槽位字面不同时需满足最低相似度门槛）
 * 5. 仍处于 Active/Frozen 状态的显式 contradicts 矛盾关系
 * 6. 低效用 (Utility < 0.35) 且长期未召回 (>= 14 天) 的陈旧记忆
 * 7. A-Mem 活跃图谱孤岛节点、陈旧 hindsight.model.* 派生模型与悬空关系边诊断
 */
export function auditMemoryHealth(
  db: Db,
  options: AuditMemoryHealthOptions = {}
): MemoryHealthReport {
  const now = options.now ?? Date.now();
  const normOpts = options.workspaceId
    ? { ...options, workspaceId: workspaceId(options.workspaceId) }
    : options;
  const maxDuplicates = normOpts.maxDuplicates ?? 15;
  const filter = buildHealthScopeFilter(normOpts);

  const statusRows = db.all<{ status: string; cnt: number; pinned_cnt: number }>(
    `SELECT status, COUNT(*) as cnt, SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_cnt
     FROM memories
     WHERE ${filter.sql}
     GROUP BY status`,
    filter.params
  );

  const counts = {
    total: 0,
    active: 0,
    candidate: 0,
    frozen: 0,
    superseded: 0,
    archived: 0,
    pinned: 0,
  };

  for (const row of statusRows) {
    const c = Number(row.cnt || 0);
    counts.total += c;
    counts.pinned += Number(row.pinned_cnt || 0);
    if (row.status === 'active') counts.active = c;
    else if (row.status === 'candidate') counts.candidate = c;
    else if (row.status === 'frozen') counts.frozen = c;
    else if (row.status === 'superseded') counts.superseded = c;
    else if (row.status === 'archived') counts.archived = c;
  }

  // FTS5 一致性检查
  const { ftsConsistent, ftsCount } = checkFtsHealth(db);

  // 全库缺失向量统计（直接命中 ix_mem_missing_embedding，不受 LIMIT 250 截断）
  const missingEmbRow = db.get<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM memories
     WHERE status IN ('active', 'frozen')
       AND embedding IS NULL
       AND (${filter.sql})`,
    filter.params
  );
  const missingEmbeddingsCount = Number(missingEmbRow?.cnt ?? 0);
  const embeddingsReadyCount = Math.max(0, counts.active + counts.frozen - missingEmbeddingsCount);

  // 检查同作用域 Active/Frozen 记忆中的近重复与同 slot_key 冲突
  const activeRows = db.all<{
    id: string;
    scope: string;
    workspace_id: string | null;
    session_id: string | null;
    type: string;
    summary: string;
    content: string;
    slot_key: string | null;
    hash: string;
    embedding: Uint8Array | Buffer | null;
    utility: number;
    confidence: number;
    updated_at: number;
  }>(
    `SELECT id, scope, workspace_id, session_id, type, summary, content, slot_key, hash, embedding, utility, confidence, updated_at
     FROM memories
     WHERE status IN ('active', 'frozen')
       AND (${filter.sql})
     ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
     LIMIT 250`,
    filter.params
  );

  const tokenCache = new Map<string, Set<string>>();
  const vecCache = new Map<string, Float32Array | null>();
  const numsCache = new Map<string, string>();
  const slotCache = new Map<string, string>();

  for (const r of activeRows) {
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
    vecCache.set(r.id, getOrComputeEmbedding(r, db));
    numsCache.set(r.id, (r.content.match(/\d+(?:\.\d+)?/g) || []).join(','));
    slotCache.set(r.id, normSlot(r.slot_key));
  }

  const duplicatePairs: DuplicatePairItem[] = [];
  for (let i = 0; i < activeRows.length && duplicatePairs.length < maxDuplicates; i++) {
    const a = activeRows[i];
    const setA = tokenCache.get(a.id)!;
    const vecA = vecCache.get(a.id);
    for (let j = i + 1; j < activeRows.length && duplicatePairs.length < maxDuplicates; j++) {
      const b = activeRows[j];
      // 仅比较相同作用域的记忆（session 作用域还必须是同一会话）
      const sameScope =
        a.scope === b.scope &&
        (a.scope === 'global' || a.scope === 'user' || a.workspace_id === b.workspace_id) &&
        (a.scope !== 'session' || (a.session_id || '') === (b.session_id || ''));
      if (!sameScope) continue;

      const rawSameSlot = Boolean(a.slot_key && b.slot_key && a.slot_key === b.slot_key);
      const normSameSlot = Boolean(
        a.slot_key && b.slot_key && slotCache.get(a.id) === slotCache.get(b.id)
      );
      if (a.slot_key && b.slot_key && !normSameSlot) continue;

      const setB = tokenCache.get(b.id)!;
      const sim = jaccard(setA, setB);
      const vecB = vecCache.get(b.id);
      const rawVecSim = vecA && vecB ? cosineSimilarity(vecA, vecB) : 0;

      // 当规范化槽位相等但原始 slot_key 字面不同时，必须满足最低内容相似度门槛才认定为同槽位冗余
      const sameSlot = rawSameSlot || (normSameSlot && (sim >= 0.35 || rawVecSim >= 0.7));
      if (normSameSlot && !sameSlot) continue;

      if (!sameSlot) {
        const numsA = numsCache.get(a.id)!;
        const numsB = numsCache.get(b.id)!;
        if (numsA && numsB && numsA !== numsB) continue;
      }

      const typedVecSim = a.type === b.type ? rawVecSim : 0;
      const isSemanticDup = !sameSlot && sim < 0.65 && sim >= 0.45 && typedVecSim >= 0.84;

      if (sameSlot || sim >= 0.65 || isSemanticDup) {
        // targetId 保留排序更高的 a，sourceId 为待被合并的 b
        const combinedSim = sameSlot
          ? Math.max(sim, rawVecSim, 0.85)
          : isSemanticDup
            ? typedVecSim
            : sim;
        duplicatePairs.push({
          sourceId: b.id,
          targetId: a.id,
          sourceSummary: b.summary,
          targetSummary: a.summary,
          similarity: Number(combinedSim.toFixed(2)),
          slotKey: sameSlot ? a.slot_key : a.slot_key || b.slot_key,
          reason: sameSlot
            ? 'same_slot_key'
            : isSemanticDup
              ? 'high_semantic_overlap'
              : 'high_lexical_overlap',
        });
      }
    }
  }

  // 检查仍同时处于 active/frozen 的显式 contradicts 关系（双端应用作用域与隐私隔离）
  const filterM1 = buildHealthScopeFilter(normOpts, 'm1');
  const filterM2 = buildHealthScopeFilter(normOpts, 'm2');
  const contradictionRows = db.all<{
    from_id: string;
    to_id: string;
    from_summary: string;
    to_summary: string;
  }>(
    `SELECT r.from_id, r.to_id, m1.summary as from_summary, m2.summary as to_summary
     FROM memory_relations r
     JOIN memories m1 ON m1.id = r.from_id
     JOIN memories m2 ON m2.id = r.to_id
     WHERE r.rel = 'contradicts'
       AND m1.status IN ('active', 'frozen')
       AND m2.status IN ('active', 'frozen')
       AND (${filterM1.sql})
       AND (${filterM2.sql})
     LIMIT 20`,
    [...filterM1.params, ...filterM2.params]
  );

  const contradictions: ContradictionItem[] = contradictionRows.map((r) => ({
    fromId: r.from_id,
    toId: r.to_id,
    fromSummary: r.from_summary,
    toSummary: r.to_summary,
  }));

  // 检查低效用 (< 0.35) 且长期未召回 (>= 14 天) 的陈旧记忆
  const staleCutoff = now - STALE_MIN_DAYS_UNUSED * DAY_MS;
  const staleRows = db.all<{
    id: string;
    type: string;
    summary: string;
    utility: number;
    ref_time: number;
  }>(
    `SELECT id, type, summary, utility, COALESCE(last_used_at, created_at) as ref_time
     FROM memories
     WHERE status = 'active'
       AND pinned = 0
       AND utility < ?
       AND COALESCE(last_used_at, created_at) <= ?
       AND (${filter.sql})
     ORDER BY utility ASC, ref_time ASC
     LIMIT 15`,
    [STALE_UTILITY_THRESHOLD, staleCutoff, ...filter.params]
  );

  const staleMemories: StaleMemoryItem[] = staleRows.map((r) => ({
    id: r.id,
    type: r.type,
    summary: r.summary,
    utility: Number(r.utility.toFixed(3)),
    daysUnused: Math.max(0, Math.floor((now - Number(r.ref_time || now)) / DAY_MS)),
  }));

  // 统计尚未与任何 active/frozen 节点建立拓扑关系边的孤岛记忆数
  const orphanMemoriesCount = countActiveOrphans(db, activeRows, normOpts);

  // 检测陈旧 hindsight.model.* 派生模型与悬空关系边
  const staleModelIds = detectStaleModels(db, filter);
  const staleModelsCount = staleModelIds.length;
  const danglingRelationsCount = countDanglingRelations(db, normOpts);

  const { score, grade, recommendations } = computeScoreGradeAndRecommendations({
    ftsConsistent,
    duplicatePairs,
    contradictions,
    staleMemories,
    counts,
    orphanMemoriesCount,
    staleModelsCount,
    danglingRelationsCount,
  });

  return {
    score,
    grade,
    counts,
    ftsConsistent,
    ftsCount,
    missingEmbeddingsCount,
    embeddingsReadyCount,
    orphanMemoriesCount,
    staleModelsCount,
    staleModelIds,
    danglingRelationsCount,
    duplicatePairs,
    contradictions,
    staleMemories,
    recommendations,
    checkedAt: now,
  };
}
