import type { Db } from '../types.js';
import { tokenSet, jaccard } from './text.js';

export interface DuplicatePairItem {
  sourceId: string;
  targetId: string;
  sourceSummary: string;
  targetSummary: string;
  similarity: number;
  slotKey: string | null;
  reason: 'same_slot_key' | 'high_lexical_overlap';
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
  duplicatePairs: DuplicatePairItem[];
  contradictions: ContradictionItem[];
  staleMemories: StaleMemoryItem[];
  recommendations: string[];
  checkedAt: number;
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
        utility: number;
        confidence: number;
        updated_at: number;
      }>(
        `SELECT id, scope, workspace_id, type, summary, content, slot_key, utility, confidence, updated_at
         FROM memories
         WHERE status IN ('active', 'frozen')
           AND (workspace_id = ? OR scope = 'global')
         ORDER BY utility DESC, updated_at DESC
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
        utility: number;
        confidence: number;
        updated_at: number;
      }>(
        `SELECT id, scope, workspace_id, type, summary, content, slot_key, utility, confidence, updated_at
         FROM memories
         WHERE status IN ('active', 'frozen')
         ORDER BY utility DESC, updated_at DESC
         LIMIT 250`
      );

  const tokenCache = new Map<string, Set<string>>();
  for (const r of activeRows) {
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
  }

  const duplicatePairs: DuplicatePairItem[] = [];
  for (let i = 0; i < activeRows.length && duplicatePairs.length < maxDuplicates; i++) {
    const a = activeRows[i];
    const setA = tokenCache.get(a.id)!;
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

      if (sameSlot || sim >= 0.65) {
        // targetId 保留效用/置信度更高的 a，sourceId 为待被合并的 b
        duplicatePairs.push({
          sourceId: b.id,
          targetId: a.id,
          sourceSummary: b.summary,
          targetSummary: a.summary,
          similarity: Number(Math.max(sim, sameSlot ? 0.85 : sim).toFixed(2)),
          slotKey: sameSlot ? a.slot_key : a.slot_key || b.slot_key,
          reason: sameSlot ? 'same_slot_key' : 'high_lexical_overlap',
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
    duplicatePairs,
    contradictions,
    staleMemories,
    recommendations,
    checkedAt: now,
  };
}
