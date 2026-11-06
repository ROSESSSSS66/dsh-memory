import type { Db, MemoryRecord } from '../types.js';
import { tokenSet, jaccard } from './text.js';
import {
  getOrComputeEmbedding,
  cosineSimilarity,
  backfillMissingEmbeddings,
} from './vector.js';
import { mergeMemories, saveVersionSnapshot } from './writer.js';
import { checkAndRepairFts } from '../evolution/maintenance.js';

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
  report: MemoryHealthReport;
}

/**
 * 记忆库健康度与冲突体检医生 (Memory Health & Conflict Doctor)
 * 审计维度：
 * 1. 状态分布与候选积压 (Active / Candidate / Frozen / Superseded / Archived)
 * 2. FTS5 倒排索引与主表一致性
 * 3. 同作用域下的槽位冲突与高相似度冗余对 (Jaccard >= 0.65 或相同 slot_key)
 * 4. 仍处于 Active/Frozen 状态的显式 contradicts 矛盾关系
 * 5. 低效用长期未召回的陈旧记忆 (Stale Memories)
 */
export function auditMemoryHealth(
  db: Db,
  options: { workspaceId?: string; now?: number; maxDuplicates?: number } = {}
): MemoryHealthReport {
  const now = options.now ?? Date.now();
  const maxDuplicates = options.maxDuplicates ?? 15;
  const wsFilter = options.workspaceId;

  const statusRows = wsFilter
    ? db.all<{ status: string; cnt: number; pinned_cnt: number }>(
        `SELECT status, COUNT(*) as cnt, SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned_cnt
         FROM memories
         WHERE workspace_id = ? OR scope = 'global'
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
        `SELECT id, scope, workspace_id, type, summary, content, slot_key, hash, embedding, utility, confidence, updated_at
         FROM memories
         WHERE status IN ('active', 'frozen')
           AND (workspace_id = ? OR scope = 'global')
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`,
        [wsFilter]
      )
    : db.all<{
        id: string;
        scope: string;
        workspace_id: string | null;
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
        `SELECT id, scope, workspace_id, type, summary, content, slot_key, hash, embedding, utility, confidence, updated_at
         FROM memories
         WHERE status IN ('active', 'frozen')
         ORDER BY utility DESC, confidence DESC, updated_at DESC
         LIMIT 250`
      );

  let missingEmbeddingsCount = 0;
  let embeddingsReadyCount = 0;
  const tokenCache = new Map<string, Set<string>>();
  const vecCache = new Map<string, Float32Array | null>();

  for (const r of activeRows) {
    if (r.embedding && r.embedding.byteLength > 0) {
      embeddingsReadyCount++;
    } else {
      missingEmbeddingsCount++;
    }
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
    vecCache.set(r.id, getOrComputeEmbedding(r));
  }

  const duplicatePairs: DuplicatePairItem[] = [];
  for (let i = 0; i < activeRows.length && duplicatePairs.length < maxDuplicates; i++) {
    const a = activeRows[i];
    const setA = tokenCache.get(a.id)!;
    const vecA = vecCache.get(a.id);
    for (let j = i + 1; j < activeRows.length && duplicatePairs.length < maxDuplicates; j++) {
      const b = activeRows[j];
      // 仅比较相同作用域的记忆
      const sameScope =
        a.scope === b.scope && (a.scope === 'global' || a.workspace_id === b.workspace_id);
      if (!sameScope) continue;

      const normSlot = (s: string | null) =>
        s ? s.toLowerCase().replace(/[\s\-_.]+/g, '') : '';
      const sameSlot = Boolean(
        a.slot_key && b.slot_key && normSlot(a.slot_key) === normSlot(b.slot_key)
      );
      const setB = tokenCache.get(b.id)!;
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
           AND (workspace_id = ? OR scope = 'global')
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
      'FTS5 倒排索引行数与 memories 主表不一致，建议立即执行「运行老化维护 (Maintain)」自动重建 FTS5 索引。'
    );
  }
  if (duplicatePairs.length > 0) {
    recommendations.push(
      `检测到 ${duplicatePairs.length} 对高相似或共享槽位 (slot_key) 的活跃记忆，可使用「一键合并去重」将其收敛为单条权威记忆。`
    );
  }
  if (contradictions.length > 0) {
    recommendations.push(
      `存在 ${contradictions.length} 组尚未消解的显式矛盾记忆 (contradicts)，建议审阅并归档旧规则。`
    );
  }
  if (staleMemories.length > 0) {
    recommendations.push(
      `发现 ${staleMemories.length} 条低效用记忆 (Utility < 0.38)，可通过后台维护或手动归档释放召回信噪比。`
    );
  }
  if (counts.candidate > 10) {
    recommendations.push(
      `当前有 ${counts.candidate} 条候选记忆待晋升，建议触发「蒸馏会话 (Distill)」或「反思升华 (Reflect)」加速沉淀。`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('记忆库结构健康：FTS5 索引同步、无冗余槽位冲突、无活跃矛盾记忆。');
  }

  return {
    score,
    grade,
    counts,
    ftsConsistent,
    ftsCount,
    missingEmbeddingsCount,
    embeddingsReadyCount,
    duplicatePairs,
    contradictions,
    staleMemories,
    recommendations,
    checkedAt: now,
  };
}

/**
 * 记忆库一键智能自愈引擎 (Auto-Healing Memory Doctor, v0.3.0)
 * 1. 自动校验并重建不一致的 FTS5 索引
 * 2. 自动为缺失向量的活跃/冻结记忆回填 128D 本地特征哈希向量
 * 3. 自动合并高置信度同槽位/高重合冗余记忆对，迁移证据与实体并建立 supersedes 因果链
 * 4. 自动消解明显的历史矛盾链 (保留高优/更新项，将旧冲突项标记为 superseded)
 */
export function autoHealMemoryHealth(
  db: Db,
  options: { workspaceId?: string; now?: number } = {}
): AutoHealResult {
  const now = options.now ?? Date.now();
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
    const scoreA = mFrom.utility * 0.5 + mFrom.confidence * 0.5 + (mFrom.pinned ? 0.5 : 0) + (mFrom.status === 'frozen' ? 1.0 : 0);
    const scoreB = mTo.utility * 0.5 + mTo.confidence * 0.5 + (mTo.pinned ? 0.5 : 0) + (mTo.status === 'frozen' ? 1.0 : 0);
    const winner = scoreA > scoreB || (scoreA === scoreB && mFrom.updated_at >= mTo.updated_at) ? mFrom : mTo;
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

  const afterReport = auditMemoryHealth(db, { workspaceId: options.workspaceId, now });

  return {
    beforeScore: beforeReport.score,
    afterScore: afterReport.score,
    afterGrade: afterReport.grade,
    ftsRebuilt: ftsRes.rebuilt,
    embeddingsBackfilled,
    duplicatesMerged,
    contradictionsResolved,
    report: afterReport,
  };
}
