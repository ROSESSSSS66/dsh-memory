import type { Db, MemoryRecord } from '../types.js';
import { tokenSet, jaccard, extractEntities } from './text.js';
import { estimateTokens } from './tokens.js';
import { workspaceId } from './scope.js';
import { getCoreMemory, setCoreMemory } from './core-memory.js';
import {
  getOrComputeEmbedding,
  cosineSimilarity,
  backfillMissingEmbeddings,
} from './vector.js';
import {
  mergeMemories,
  saveVersionSnapshot,
  addRelation,
  approveCandidate,
} from './writer.js';
import { checkAndRepairFts, pruneInvalidMemories } from '../evolution/maintenance.js';
import { approveRepairProposal, listRepairProposals } from '../evolution/repair.js';

export interface DuplicatePairItem {
  sourceId: string;
  targetId: string;
  sourceSummary: string;
  targetSummary: string;
  similarity: number;
  slotKey: string | null;
  reason: 'same_slot_key' | 'high_lexical_overlap' | 'high_semantic_overlap';
}

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
  duplicatePairs: DuplicatePairItem[];
  contradictions: ContradictionItem[];
  staleMemories: StaleMemoryItem[];
  recommendations: string[];
  checkedAt: number;
}

export interface AutoHealResult {
  beforeScore: number;
  afterScore: number;
  afterGrade: MemoryHealthReport['grade'];
  ftsRebuilt: boolean;
  embeddingsBackfilled: number;
  duplicatesMerged: number;
  contradictionsResolved: number;
  linksWeaved: number;
  candidatesPromoted?: number;
  repairsApplied?: number;
  coreBlocksSynced?: number;
  invalidPruned?: number;
  report: MemoryHealthReport;
}

/**
 * 记忆库健康度与冲突体检医生 (Memory Health & Conflict Doctor)
 * 审计维度：
 * 1. 状态分布与候选积压 (Active / Candidate / Frozen / Superseded / Archived)
 * 2. FTS5 倒排索引与主表一致性
 * 3. 同作用域下的槽位冲突与高相似度冗余对 (Jaccard >= 0.65 或相同 slot_key 或 128D 语义重合)
 * 4. 仍处于 Active/Frozen 状态的显式 contradicts 矛盾关系
 * 5. 低效用长期未召回的陈旧记忆 (Stale Memories) 与 A-Mem 孤岛节点统计
 */
export function auditMemoryHealth(
  db: Db,
  options: { workspaceId?: string; now?: number; maxDuplicates?: number } = {}
): MemoryHealthReport {
  const now = options.now ?? Date.now();
  if (options.workspaceId) options = { ...options, workspaceId: workspaceId(options.workspaceId) };
  const maxDuplicates = options.maxDuplicates ?? 15;
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;

  const statusRows = wsFilter
    ? db.all<{ status: string; cnt: number; pinned_cnt: number }>(
        `SELECT status, COUNT(*) as cnt, SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_cnt
         FROM memories
         WHERE workspace_id = ? OR scope IN ('user', 'global')
         GROUP BY status`,
        [wsFilter]
      )
    : db.all<{ status: string; cnt: number; pinned_cnt: number }>(
        `SELECT status, COUNT(*) as cnt, SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_cnt
         FROM memories
         GROUP BY status`
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
  const totalGlobalRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memories`);
  let ftsCount = 0;
  let ftsConsistent = true;
  try {
    const ftsRow = db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memory_fts`);
    ftsCount = Number(ftsRow?.c ?? 0);
    ftsConsistent = ftsCount === Number(totalGlobalRow?.c ?? 0);
  } catch {
    ftsConsistent = false;
  }

  // 检查同作用域 Active/Frozen 记忆中的近重复与同 slot_key 冲突
  const activeRows = wsFilter
    ? db.all<{
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
           AND (workspace_id = ? OR scope IN ('user', 'global'))
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`,
        [wsFilter]
      )
    : db.all<{
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
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`
      );

  let missingEmbeddingsCount = 0;
  let embeddingsReadyCount = 0;
  const tokenCache = new Map<string, Set<string>>();
  const vecCache = new Map<string, Float32Array | null>();
  // 预计算每行的数字指纹与规范化槽位，避免在 O(n²) 内层循环中重复跑正则
  const numsCache = new Map<string, string>();
  const slotCache = new Map<string, string>();
  const normSlot = (s: string | null) => (s ? s.toLowerCase().replace(/[\s\-_.]+/g, '') : '');

  for (const r of activeRows) {
    if (r.embedding && r.embedding.byteLength > 0) {
      embeddingsReadyCount++;
    } else {
      missingEmbeddingsCount++;
    }
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
    vecCache.set(r.id, getOrComputeEmbedding(r));
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
        (a.scope === 'global' || a.workspace_id === b.workspace_id) &&
        (a.scope !== 'session' || (a.session_id || '') === (b.session_id || ''));
      if (!sameScope) continue;

      const sameSlot = Boolean(
        a.slot_key && b.slot_key && slotCache.get(a.id) === slotCache.get(b.id)
      );
      const setB = tokenCache.get(b.id)!;
      if (a.slot_key && b.slot_key && !sameSlot) continue;
      if (!sameSlot) {
        const numsA = numsCache.get(a.id)!;
        const numsB = numsCache.get(b.id)!;
        if (numsA && numsB && numsA !== numsB) continue;
      }
      const sim = jaccard(setA, setB);

      const vecB = vecCache.get(b.id);
      const vecSim = vecA && vecB && a.type === b.type ? cosineSimilarity(vecA, vecB) : 0;
      const isSemanticDup = !sameSlot && sim < 0.65 && sim >= 0.45 && vecSim >= 0.84;

      if (sameSlot || sim >= 0.65 || isSemanticDup) {
        // targetId 保留效用/置信度更高的 a，sourceId 为待被合并的 b
        const combinedSim = sameSlot
          ? Math.max(sim, 0.85)
          : isSemanticDup
          ? vecSim
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

  // 检查仍同时处于 active/frozen 的显式 contradicts 关系
  const contradictionRows = wsFilter
    ? db.all<{
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
           AND (m1.workspace_id = ? OR m1.scope IN ('user', 'global'))
           AND (m2.workspace_id = ? OR m2.scope IN ('user', 'global'))
         LIMIT 20`,
        [wsFilter, wsFilter]
      )
    : db.all<{
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
         LIMIT 20`
      );

  const contradictions: ContradictionItem[] = contradictionRows.map((r) => ({
    fromId: r.from_id,
    toId: r.to_id,
    fromSummary: r.from_summary,
    toSummary: r.to_summary,
  }));

  // 检查低效用且长期未召回的陈旧记忆
  const staleRows = wsFilter
    ? db.all<{
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
           AND utility < 0.38
           AND (workspace_id = ? OR scope IN ('user', 'global'))
         ORDER BY utility ASC, ref_time ASC
         LIMIT 15`,
        [wsFilter]
      )
    : db.all<{
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
           AND utility < 0.38
         ORDER BY utility ASC, ref_time ASC
         LIMIT 15`
      );

  const staleMemories: StaleMemoryItem[] = staleRows.map((r) => ({
    id: r.id,
    type: r.type,
    summary: r.summary,
    utility: Number(r.utility.toFixed(3)),
    daysUnused: Math.max(0, Math.floor((now - Number(r.ref_time || now)) / 86_400_000)),
  }));

  // 统计尚未建立任何拓扑关系边的孤岛记忆数 (A-Mem Zettelkasten 连通度诊断)
  const connectedIdSet = new Set<string>();
  const auditIdsJson = JSON.stringify(activeRows.map((r) => r.id));
  const allRelRows = activeRows.length
    ? db.all<{ from_id: string; to_id: string }>(
        `SELECT from_id, to_id FROM memory_relations
         WHERE rel IN ('related', 'derived_from', 'supersedes')
           AND (from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?)))`,
        [auditIdsJson, auditIdsJson]
      )
    : [];
  for (const rel of allRelRows) {
    connectedIdSet.add(rel.from_id);
    connectedIdSet.add(rel.to_id);
  }
  let orphanMemoriesCount = 0;
  const nonCoreActiveRows = activeRows.filter(
    (r) => !r.slot_key?.startsWith('core:') && r.type !== 'meta'
  );
  if (activeRows.length >= 2) {
    for (const r of nonCoreActiveRows) {
      if (!connectedIdSet.has(r.id)) {
        orphanMemoriesCount++;
      }
    }
  }

  // 计算 0-100 综合健康分
  let score = 100;
  if (!ftsConsistent) score -= 25;
  score -= Math.min(30, duplicatePairs.length * 6);
  score -= Math.min(25, contradictions.length * 8);
  score -= Math.min(15, staleMemories.length * 2);
  if (counts.candidate > 15) {
    score -= Math.min(10, Math.floor((counts.candidate - 15) / 3));
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
      `发现 ${staleMemories.length} 条低效用记忆 (Utility < 0.38)，全自动老化维护守护进程将自动降级归档以保障召回信噪比。`
    );
  }
  if (counts.candidate > 10) {
    recommendations.push(
      `当前有 ${counts.candidate} 条候选记忆在观察池中，高置信度候选将由全自动晋升流水线自动转正。`
    );
  }
  if (orphanMemoriesCount >= 3) {
    recommendations.push(
      `检测到 ${orphanMemoriesCount} 条缺乏拓扑关联的孤岛记忆，A-Mem 自动双链织网引擎将在后台自动编织语义图谱。`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('全自动记忆系统运行健康：FTS5 索引同步、无冗余槽位冲突、无活跃矛盾记忆。');
  }

  return {
    score,
    grade,
    counts,
    ftsConsistent,
    ftsCount,
    missingEmbeddingsCount,
    embeddingsReadyCount,
    orphanMemoriesCount,
    duplicatePairs,
    contradictions,
    staleMemories,
    recommendations,
    checkedAt: now,
  };
}

function computeSlotKeyAffinity(slotA?: string | null, slotB?: string | null): number {
  if (!slotA || !slotB) return 0;
  const sa = slotA.toLowerCase().trim();
  const sb = slotB.toLowerCase().trim();
  if (!sa || !sb) return 0;
  if (sa === sb) return 0.35;
  const partsA = sa.split('.');
  const partsB = sb.split('.');
  if (partsA.length >= 2 && partsB.length >= 2 && partsA[0] === partsB[0] && partsA[1] === partsB[1]) {
    return 0.28;
  }
  if (partsA[0] === partsB[0]) {
    return 0.2;
  }
  return 0;
}

function areScopesCompatibleForWeaving(
  a: { scope: string; workspace_id: string | null },
  b: { scope: string; workspace_id: string | null }
): boolean {
  if (a.scope === 'session' || b.scope === 'session') {
    return (
      a.scope === 'session' &&
      b.scope === 'session' &&
      (a.workspace_id || '') === (b.workspace_id || '') &&
      ((a as any).session_id || '') === ((b as any).session_id || '')
    );
  }
  if (a.workspace_id && b.workspace_id && a.workspace_id === b.workspace_id) {
    return true;
  }
  if (
    (a.scope === 'global' || a.scope === 'user') &&
    (b.scope === 'global' || b.scope === 'user')
  ) {
    return true;
  }
  if (a.scope === b.scope && a.scope !== 'workspace') {
    return true;
  }
  return false;
}

/**
 * A-Mem (NeurIPS 2025, arXiv:2502.12110) Zettelkasten 自动双链织网引擎
 * 扫描同作用域内的活跃记忆，基于 128D 本地向量余弦 + 实体共现 + 词汇 Jaccard + 槽位命名空间亲和度
 * 为孤岛/弱连通节点自动编织 related 边，并通过 Phase 2 最近邻/核心锚点桥接彻底消除孤岛记忆
 */
export function weaveZettelkastenLinks(
  db: Db,
  options: { workspaceId?: string; maxNewLinks?: number; now?: number } | string = {}
): number {
  const opts = typeof options === 'string' ? { workspaceId: options } : options;
  const now = opts.now ?? Date.now();
  const maxNewLinks = opts.maxNewLinks ?? 60;
  const wsFilter = opts.workspaceId ? workspaceId(opts.workspaceId) : undefined;

  const activeRows = wsFilter
    ? db.all<{
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
      }>(
        `SELECT id, scope, workspace_id, session_id, type, summary, content, slot_key, hash, embedding
         FROM memories
         WHERE status IN ('active', 'frozen')
           AND type != 'meta'
           AND COALESCE(slot_key, '') NOT LIKE 'core:%'
           AND (workspace_id = ? OR scope IN ('user', 'global'))
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`,
        [wsFilter]
      )
    : db.all<{
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
      }>(
        `SELECT id, scope, workspace_id, session_id, type, summary, content, slot_key, hash, embedding
         FROM memories
         WHERE status IN ('active', 'frozen')
           AND type != 'meta'
           AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`
      );

  if (activeRows.length === 0) return 0;

  const existingPairs = new Set<string>();
  const connectedIds = new Set<string>();
  // 仅加载与本批活跃记忆相关的关系边，避免随关系表增长而全表加载
  const activeIdsJson = JSON.stringify(activeRows.map((r) => r.id));
  const relRows = db.all<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM memory_relations
     WHERE rel IN ('related', 'derived_from', 'supersedes')
       AND (from_id IN (SELECT value FROM json_each(?)) OR to_id IN (SELECT value FROM json_each(?)))`,
    [activeIdsJson, activeIdsJson]
  );
  for (const r of relRows) {
    existingPairs.add(`${r.from_id}->${r.to_id}`);
    existingPairs.add(`${r.to_id}->${r.from_id}`);
    connectedIds.add(r.from_id);
    connectedIds.add(r.to_id);
  }

  const tokenCache = new Map<string, Set<string>>();
  const entCache = new Map<string, Set<string>>();
  const vecCache = new Map<string, Float32Array | null>();

  for (const r of activeRows) {
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
    entCache.set(
      r.id,
      new Set(
        extractEntities(`${r.summary} ${r.content}`, 12).map((e) =>
          e.toLowerCase().replace(/\\/g, '/').trim()
        )
      )
    );
    vecCache.set(r.id, getOrComputeEmbedding(r));
  }

  // Merge indexed entities from memory_entities table
  if (activeRows.length > 0) {
    const placeholders = activeRows.map(() => '?').join(', ');
    const dbEntRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      activeRows.map((r) => r.id)
    );
    for (const row of dbEntRows) {
      const s = entCache.get(row.memory_id);
      if (s && row.entity) {
        s.add(row.entity.toLowerCase().replace(/\\/g, '/').trim());
      }
    }
  }

  const computePairAffinity = (
    a: (typeof activeRows)[0],
    b: (typeof activeRows)[0]
  ): { affinity: number; jaccardSim: number; vecSim: number; sharedEnts: number; slotBonus: number } => {
    const setA = tokenCache.get(a.id)!;
    const setB = tokenCache.get(b.id)!;
    const jaccardSim = jaccard(setA, setB);

    const vecA = vecCache.get(a.id);
    const vecB = vecCache.get(b.id);
    const vecSim = vecA && vecB ? Math.max(0, cosineSimilarity(vecA, vecB)) : 0;

    const entA = entCache.get(a.id)!;
    const entB = entCache.get(b.id)!;
    let sharedEnts = 0;
    for (const e of entA) {
      if (entB.has(e)) sharedEnts++;
    }

    const entBonus = Math.min(1, sharedEnts / 2);
    const slotBonus = computeSlotKeyAffinity(a.slot_key, b.slot_key);
    const typeBonus = a.type === b.type ? 0.05 : 0;
    const affinity = 0.45 * vecSim + 0.3 * jaccardSim + 0.15 * entBonus + slotBonus + typeBonus;

    return { affinity, jaccardSim, vecSim, sharedEnts, slotBonus };
  };

  const candidateEdges: Array<{ fromId: string; toId: string; affinity: number }> = [];

  for (let i = 0; i < activeRows.length; i++) {
    const a = activeRows[i];
    for (let j = i + 1; j < activeRows.length; j++) {
      const b = activeRows[j];
      if (!areScopesCompatibleForWeaving(a, b)) continue;
      if (existingPairs.has(`${a.id}->${b.id}`)) continue;

      const { affinity, jaccardSim, vecSim, sharedEnts, slotBonus } = computePairAffinity(a, b);
      // Avoid linking pairs that are near-identical duplicates (>= 0.65) which should be merged instead
      if (jaccardSim >= 0.65) continue;

      if (
        affinity >= 0.26 ||
        (sharedEnts >= 1 && vecSim >= 0.22) ||
        jaccardSim >= 0.18 ||
        slotBonus >= 0.2
      ) {
        candidateEdges.push({ fromId: a.id, toId: b.id, affinity });
      }
    }
  }

  candidateEdges.sort((a, b) => b.affinity - a.affinity);

  let weaved = 0;
  const degreeAdded = new Map<string, number>();

  const coreHubRows = db.all<{
    id: string;
    slot_key: string | null;
    scope: string;
    workspace_id: string | null;
  }>(
    `SELECT id, slot_key, scope, workspace_id
     FROM memories
     WHERE status IN ('active', 'frozen')
       AND slot_key LIKE 'core:%'`
  );

  db.transaction(() => {
    // Phase 1: 高亲和度多边双链织网
    for (const edge of candidateEdges) {
      if (weaved >= maxNewLinks) break;
      const degA = degreeAdded.get(edge.fromId) || 0;
      const degB = degreeAdded.get(edge.toId) || 0;
      if (degA >= 3 || degB >= 3) continue;

      addRelation(db, edge.fromId, edge.toId, 'related', now);
      existingPairs.add(`${edge.fromId}->${edge.toId}`);
      existingPairs.add(`${edge.toId}->${edge.fromId}`);
      connectedIds.add(edge.fromId);
      connectedIds.add(edge.toId);
      degreeAdded.set(edge.fromId, degA + 1);
      degreeAdded.set(edge.toId, degB + 1);
      weaved++;
    }

    // Phase 2: 孤岛节点最近邻与核心锚点桥接 (Nearest-Neighbor & Core-Hub Orphan Bridging)
    for (const orphan of activeRows) {
      if (connectedIds.has(orphan.id)) continue;

      let bestPeerId: string | null = null;
      let bestScore = -1;

      // 优先在兼容作用域/同工作区的活跃记忆中寻找最高亲和度邻居
      for (const peer of activeRows) {
        if (peer.id === orphan.id) continue;
        if (existingPairs.has(`${orphan.id}->${peer.id}`)) continue;
        if (!areScopesCompatibleForWeaving(orphan, peer)) continue;

        const { affinity, jaccardSim } = computePairAffinity(orphan, peer);
        if (jaccardSim >= 0.65) continue;
        const sameWsBonus =
          orphan.workspace_id && orphan.workspace_id === peer.workspace_id ? 0.12 : 0;
        const score = affinity + sameWsBonus;
        if (score > bestScore) {
          bestScore = score;
          bestPeerId = peer.id;
        }
      }

      // 若该工作区/作用域仅有此单条孤立记忆，尝试挂载至对应 Core Memory 锚点或全局最佳节点
      if (!bestPeerId && coreHubRows.length > 0) {
        const preferredSlot =
          orphan.scope === 'user' || orphan.type === 'preference'
            ? 'core:human'
            : orphan.type === 'procedural' || orphan.type === 'belief'
              ? 'core:persona'
              : 'core:project';
        const matchedCore =
          coreHubRows.find(
            (c) =>
              c.slot_key === preferredSlot &&
              (!c.workspace_id || !orphan.workspace_id || c.workspace_id === orphan.workspace_id)
          ) ||
          coreHubRows.find((c) => c.slot_key === 'core:human' || c.slot_key === 'core:persona') ||
          coreHubRows[0];
        if (matchedCore && matchedCore.id !== orphan.id) {
          bestPeerId = matchedCore.id;
        }
      }

      if (!bestPeerId && activeRows.length >= 2) {
        for (const peer of activeRows) {
          if (peer.id === orphan.id) continue;
          if (existingPairs.has(`${orphan.id}->${peer.id}`)) continue;
          if (orphan.workspace_id && peer.workspace_id && orphan.workspace_id !== peer.workspace_id) continue;
          const { affinity } = computePairAffinity(orphan, peer);
          if (affinity > bestScore) {
            bestScore = affinity;
            bestPeerId = peer.id;
          }
        }
      }

      if (bestPeerId) {
        addRelation(db, orphan.id, bestPeerId, 'related', now);
        existingPairs.add(`${orphan.id}->${bestPeerId}`);
        existingPairs.add(`${bestPeerId}->${orphan.id}`);
        connectedIds.add(orphan.id);
        connectedIds.add(bestPeerId);
        weaved++;
      }
    }
  });

  return weaved;
}

/**
 * 记忆库一键智能自愈引擎 (Auto-Healing Memory Doctor, v0.4.0)
 * 1. 自动校验并重建不一致的 FTS5 索引
 * 2. 自动为缺失向量的活跃/冻结记忆回填 128D 本地特征哈希向量
 * 3. 自动合并高置信度同槽位/高重合冗余记忆对，迁移证据与实体并建立 supersedes 因果链
 * 4. 自动消解明显的历史矛盾链 (保留高优/更新项，将旧冲突项标记为 superseded)
 * 5. 自动执行 A-Mem Zettelkasten 孤岛节点双链织网 (weaveZettelkastenLinks)
 */
export function autoHealMemoryHealth(
  db: Db,
  options: { workspaceId?: string; now?: number } = {}
): AutoHealResult {
  const now = options.now ?? Date.now();
  if (options.workspaceId) options = { ...options, workspaceId: workspaceId(options.workspaceId) };
  const beforeReport = auditMemoryHealth(db, { workspaceId: options.workspaceId, now });

  // 1. 修复 FTS5 倒排索引
  const ftsRes = checkAndRepairFts(db);

  // 2. 回填缺失的 128D 本地特征向量
  const embeddingsBackfilled = backfillMissingEmbeddings(db, {
    workspaceId: options.workspaceId,
    limit: 500,
  });

  // 3. 自动合并高重合度冗余对
  let duplicatesMerged = 0;
  const consumedIds = new Set<string>();
  for (const pair of beforeReport.duplicatePairs) {
    if (consumedIds.has(pair.sourceId) || consumedIds.has(pair.targetId)) continue;
    const srcRow = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [pair.sourceId]);
    const tgtRow = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [pair.targetId]);
    if (!srcRow || !tgtRow) continue;
    if (srcRow.status === 'frozen') continue;

    if (pair.reason === 'same_slot_key' || pair.similarity >= 0.65) {
      const mRes = mergeMemories(
        db,
        pair.sourceId,
        pair.targetId,
        `auto_heal_${pair.reason}`,
        'system',
        now
      );
      if (mRes.success) {
        duplicatesMerged++;
        consumedIds.add(pair.sourceId);
      }
    }
  }

  // 4. 自动消解非冻结的活跃矛盾关系 (保留高优或更新项，将落后冲突项置为 superseded)
  let contradictionsResolved = 0;
  for (const c of beforeReport.contradictions) {
    const mFrom = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [c.fromId]);
    const mTo = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [c.toId]);
    if (!mFrom || !mTo) continue;
    if (mFrom.status !== 'active' && mFrom.status !== 'frozen') continue;
    if (mTo.status !== 'active' && mTo.status !== 'frozen') continue;
    if (mFrom.status === 'frozen' && mTo.status === 'frozen') continue;

    // 决定保留者 (winner) 与被取代者 (loser)
    const scoreA =
      mFrom.utility * 0.5 +
      mFrom.confidence * 0.5 +
      (mFrom.pinned ? 0.5 : 0) +
      (mFrom.status === 'frozen' ? 1.0 : 0);
    const scoreB =
      mTo.utility * 0.5 +
      mTo.confidence * 0.5 +
      (mTo.pinned ? 0.5 : 0) +
      (mTo.status === 'frozen' ? 1.0 : 0);
    const winner =
      scoreA > scoreB || (scoreA === scoreB && mFrom.updated_at >= mTo.updated_at) ? mFrom : mTo;
    const loser = winner.id === mFrom.id ? mTo : mFrom;

    if (loser.status === 'frozen' || loser.pinned === 1) continue;

    db.transaction(() => {
      saveVersionSnapshot(db, loser, 'auto_heal_contradiction', 'system', now);
      db.run(
        `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
        [now, now, loser.id]
      );
      db.run(
        `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
         VALUES (?, ?, 'supersedes', ?, ?)`,
        [winner.id, loser.id, JSON.stringify({ reason: 'auto_heal_contradiction' }), now]
      );
    });
    contradictionsResolved++;
  }

  // 5. 全自动落地待处理的 RIME 记忆修复提案 (Auto-Apply Verified Repair Proposals)
  let repairsApplied = 0;
  try {
    const pendingProposals = listRepairProposals(db, 'candidate');
    for (const prop of pendingProposals) {
      if (prop.expiresAt > now) {
        const res = approveRepairProposal(db, prop.id, 'autonomous-doctor', now);
        if (res.ok) {
          repairsApplied++;
        }
      }
    }
  } catch {
    // 忽略异常确保自愈流水线幂等继续
  }

  // 5.5 全自动清理无效、被遮蔽或多次负反馈的噪音记忆 (Auto-Prune Invalid & Noisy Memories)
  let invalidPruned = 0;
  try {
    const pruneRes = pruneInvalidMemories(db, { workspaceId: options.workspaceId, now });
    invalidPruned = pruneRes.prunedCount;
  } catch {
    // 忽略异常确保自愈流水线幂等继续
  }

  // 6. 全自动晋升高置信度候选记忆 (Auto-Promote Verified Candidates)
  // 安全边界：排除外部不可信 web 来源与未经验证的纯规则工具报错候选
  let candidatesPromoted = 0;
  try {
    const candidateRows = options.workspaceId
      ? db.all<{ id: string }>(
          `SELECT id FROM memories
           WHERE status = 'candidate'
             AND confidence >= 0.5
             AND source_kind != 'web'
             AND COALESCE(origin_kinds, '') NOT LIKE '%"web"%'
             AND NOT (source_kind = 'rule' AND COALESCE(origin_kinds, '') LIKE '%"tool"%')
             AND (workspace_id = ? OR scope IN ('user', 'global'))
           ORDER BY confidence DESC, utility DESC
           LIMIT 30`,
          [options.workspaceId]
        )
      : db.all<{ id: string }>(
          `SELECT id FROM memories
           WHERE status = 'candidate'
             AND confidence >= 0.5
             AND source_kind != 'web'
             AND COALESCE(origin_kinds, '') NOT LIKE '%"web"%'
             AND NOT (source_kind = 'rule' AND COALESCE(origin_kinds, '') LIKE '%"tool"%')
           ORDER BY confidence DESC, utility DESC
           LIMIT 30`
        );
    for (const cand of candidateRows) {
      const appRes = approveCandidate(db, cand.id, 'autonomous-doctor', now);
      if (appRes.action === 'approved') {
        candidatesPromoted++;
      }
    }
  } catch {
    // 忽略异常确保自愈流水线幂等继续
  }

  // 7. 全自动同步已验证高效用规则至 Letta Core Memory 暂存区 (Autonomous Core Memory Sync)
  const coreBlocksSynced = syncAutonomousCoreMemory(db, {
    workspaceId: options.workspaceId,
    now,
  });

  // 8. A-Mem Zettelkasten 孤岛节点自动双链织网
  const linksWeaved = weaveZettelkastenLinks(db, {
    workspaceId: options.workspaceId,
    maxNewLinks: 60,
    now,
  });

  const afterReport = auditMemoryHealth(db, { workspaceId: options.workspaceId, now });

  return {
    beforeScore: beforeReport.score,
    afterScore: afterReport.score,
    afterGrade: afterReport.grade,
    ftsRebuilt: ftsRes.rebuilt,
    embeddingsBackfilled,
    duplicatesMerged,
    contradictionsResolved,
    linksWeaved,
    candidatesPromoted,
    repairsApplied,
    coreBlocksSynced,
    invalidPruned,
    report: afterReport,
  };
}

/**
 * 全自动高置信度/高效用规则晋升同步至 Core Memory (v0.7.0 Autonomous Core Memory Sync)
 * 仅将线上正反馈验证过 (pinned=1 或 success_count>=1)、confidence >= 0.88 且 utility >= 0.65 的规则
 * 幂等蒸馏进 human (用户偏好) 与 project (项目核心规范) 块，严格限制每块 <= 220 tokens 且绝不覆盖 frozen 块
 */
export function syncAutonomousCoreMemory(
  db: Db,
  options: { workspaceId?: string; maxBlockTokens?: number; now?: number } = {}
): number {
  const maxBlockTokens = options.maxBlockTokens ?? 220;
  if (options.workspaceId) options = { ...options, workspaceId: workspaceId(options.workspaceId) };
  let blocksUpdated = 0;

  const trySyncBlock = (
    block: 'human' | 'project',
    candidates: Array<{ summary: string; content: string }>,
    wsId?: string
  ) => {
    if (candidates.length === 0) return;

    // 若目标 Core Memory 已处于 frozen 状态，绝不改动
    const rawCore = db.get<{ status: string }>(
      `SELECT status FROM memories
       WHERE slot_key = ?
         AND scope = ?
         AND COALESCE(workspace_id, '') = ?
         AND status IN ('active', 'frozen')
       LIMIT 1`,
      [`core:${block}`, block === 'human' ? 'user' : 'workspace', block === 'project' ? wsId || '' : '']
    );
    if (rawCore?.status === 'frozen') return;

    const existing = getCoreMemory(db, block, wsId ? { workspaceId: wsId } : undefined);
    let currentContent = existing?.content?.trim() || '';
    const existingLines = currentContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const existingLineTokens = existingLines.map((l) => tokenSet(l));
    let changed = false;

    for (const cand of candidates) {
      const cleanText = (cand.summary?.trim().length >= 8 ? cand.summary : cand.content)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 110);
      if (!cleanText) continue;

      const bullet = cleanText.startsWith('-') ? cleanText : `- ${cleanText}`;
      const candToks = tokenSet(cleanText);

      // 幂等去重：避免子串包含或高词法重叠
      const alreadyCovered =
        currentContent.includes(cleanText) ||
        existingLineTokens.some((lt) => jaccard(candToks, lt) >= 0.58);
      if (alreadyCovered) continue;

      const nextContent = currentContent ? `${currentContent}\n${bullet}` : bullet;
      if (estimateTokens(nextContent) > maxBlockTokens) {
        break;
      }

      currentContent = nextContent;
      existingLineTokens.push(candToks);
      changed = true;
    }

    if (changed && currentContent) {
      try {
        setCoreMemory(db, block, currentContent, {
          workspaceId: wsId,
          actor: 'system',
        });
        blocksUpdated++;
      } catch {
        // 保持自愈幂等容错
      }
    }
  };

  // 1. 同步用户级高效用偏好 -> core:human
  const userPrefs = db.all<{ summary: string; content: string }>(
    `SELECT summary, content FROM memories
     WHERE status IN ('active', 'frozen')
       AND scope = 'user'
       AND type = 'preference'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       AND confidence >= 0.88
       AND utility >= 0.65
       AND (pinned = 1 OR success_count >= 1)
     ORDER BY pinned DESC, utility DESC, success_count DESC, updated_at DESC
     LIMIT 3`
  );
  trySyncBlock('human', userPrefs);

  // 2. 同步当前工作区高效用架构/规范规则 -> core:project (仅在提供明确 workspaceId 时执行)
  if (options.workspaceId) {
    const wsRules = db.all<{ summary: string; content: string }>(
      `SELECT summary, content FROM memories
       WHERE status IN ('active', 'frozen')
         AND scope = 'workspace'
         AND workspace_id = ?
         AND type IN ('procedural', 'semantic', 'preference')
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         AND confidence >= 0.88
         AND utility >= 0.65
         AND (pinned = 1 OR success_count >= 1)
       ORDER BY pinned DESC, utility DESC, success_count DESC, updated_at DESC
       LIMIT 3`,
      [options.workspaceId]
    );
    trySyncBlock('project', wsRules, options.workspaceId);
  }

  return blocksUpdated;
}
