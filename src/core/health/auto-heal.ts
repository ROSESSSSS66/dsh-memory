import { checkAndRepairFts, pruneInvalidMemories } from '../../evolution/maintenance.js';
import { type Db, hydrateMemoryRow, type MemoryRecord, type MemoryRow } from '../../types.js';
import { runHindsightReflect } from '../hindsight.js';
import { isWorkspaceExcluded } from '../privacy.js';
import { workspaceId } from '../scope.js';
import { hasUntrustedOrigin, hasUserEvidence } from '../trust.js';
import { backfillMissingEmbeddings, removeCachedRuntimeEmbedding } from '../vector.js';
import { approveCandidate, mergeMemories, saveVersionSnapshot } from '../writer.js';
import {
  type AuditMemoryHealthOptions,
  auditMemoryHealth,
  buildHealthScopeFilter,
  type MemoryHealthReport,
  refreshLightweightHealthReport,
} from './audit.js';
import { syncAutonomousCoreMemory } from './core-sync.js';
import { weaveZettelkastenLinks } from './zettelkasten.js';

export interface AutoHealOptions {
  workspaceId?: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
  now?: number;
  skipFts?: boolean;
  skipEmbeddings?: boolean;
  skipPrune?: boolean;
  skipWeave?: boolean;
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
  confidenceCalibrated?: number;
  modelsSynthesized?: number;
  errors: string[];
  report: MemoryHealthReport;
}

function formatErr(step: string, err: unknown): string {
  return `${step}: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * 记忆库一键智能自愈引擎 (Auto-Healing Memory Doctor)
 * 1. 自动校验并重建不一致的 FTS5 索引 (支持 skipFts)
 * 2. 自动为缺失向量的活跃/冻结记忆回填 128D 本地特征向量 (支持 skipEmbeddings)
 * 3. 自动合并高置信度同槽位冗余记忆对，迁移证据与实体并建立 supersedes 因果链
 * 4. 自动消解同作用域、非双用户审批的非冻结活跃矛盾关系
 * 5. 严守 001_init.sql 人工审批契约：绝不自动批准 repair_proposals
 * 6. 清理无效/噪音记忆 (支持 skipPrune) 并仅晋升具备纯净用户证据的非 llm_extract 候选
 * 7. 同步高效用规则至 Core Memory，执行 Hindsight 幂等置信度校准与心智模型合成
 * 8. 执行 A-Mem Zettelkasten 孤岛节点双链织网 (支持 skipWeave)
 */
export function autoHealMemoryHealth(db: Db, options: AutoHealOptions = {}): AutoHealResult {
  const now = options.now ?? Date.now();
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;
  const excludeWorkspaces = options.excludeWorkspaces;
  const errors: string[] = [];

  const auditOpts: AuditMemoryHealthOptions = {
    workspaceId: wsFilter,
    sessionId: options.sessionId,
    excludeWorkspaces,
    now,
  };

  const beforeReport = auditMemoryHealth(db, auditOpts);

  // 若显式指定的 workspace 位于排除名单中，跳过所有针对该工作区的自愈写操作
  if (wsFilter && excludeWorkspaces?.length && isWorkspaceExcluded(wsFilter, excludeWorkspaces)) {
    return {
      beforeScore: beforeReport.score,
      afterScore: beforeReport.score,
      afterGrade: beforeReport.grade,
      ftsRebuilt: false,
      embeddingsBackfilled: 0,
      duplicatesMerged: 0,
      contradictionsResolved: 0,
      linksWeaved: 0,
      candidatesPromoted: 0,
      repairsApplied: 0,
      coreBlocksSynced: 0,
      invalidPruned: 0,
      confidenceCalibrated: 0,
      modelsSynthesized: 0,
      errors,
      report: beforeReport,
    };
  }

  // 解析未排除的目标工作区列表（未传 workspaceId 时枚举库中所有非排除 workspace_id，绝不静默回退 process.cwd()）
  const targetWorkspaces: string[] = wsFilter
    ? [wsFilter]
    : db
        .all<{ workspace_id: string }>(
          `SELECT DISTINCT workspace_id FROM memories
           WHERE status IN ('active', 'frozen')
             AND scope = 'workspace'
             AND workspace_id IS NOT NULL
             AND workspace_id != ''`
        )
        .map((r) => r.workspace_id)
        .filter((id) => !isWorkspaceExcluded(id, excludeWorkspaces));

  // 1. 修复 FTS5 倒排索引
  let ftsRebuilt = false;
  if (!options.skipFts) {
    try {
      const ftsRes = checkAndRepairFts(db);
      ftsRebuilt = ftsRes.rebuilt;
    } catch (err) {
      errors.push(formatErr('fts_repair', err));
    }
  }

  // 2. 回填缺失的 128D 本地特征向量
  let embeddingsBackfilled = 0;
  if (!options.skipEmbeddings) {
    try {
      if (wsFilter) {
        embeddingsBackfilled = backfillMissingEmbeddings(db, {
          workspaceId: wsFilter,
          limit: 500,
        });
      } else if (excludeWorkspaces?.length) {
        for (const targetWs of targetWorkspaces) {
          embeddingsBackfilled += backfillMissingEmbeddings(db, {
            workspaceId: targetWs,
            limit: 500,
          });
        }
      } else {
        embeddingsBackfilled = backfillMissingEmbeddings(db, { limit: 500 });
      }
    } catch (err) {
      errors.push(formatErr('embeddings_backfill', err));
    }
  }

  // 3. 自动合并同槽位冗余对（audit.ts 已验证 `.` 层级边界与字面差异槽位的最低内容相似度）
  let duplicatesMerged = 0;
  const consumedIds = new Set<string>();
  for (const pair of beforeReport.duplicatePairs) {
    if (consumedIds.has(pair.sourceId) || consumedIds.has(pair.targetId)) continue;
    if (pair.reason !== 'same_slot_key') continue;

    const srcRow = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [pair.sourceId])
    );
    const tgtRow = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [pair.targetId])
    );
    if (!srcRow || !tgtRow) continue;
    if (srcRow.status === 'frozen' || srcRow.pinned === 1) continue;
    if (tgtRow.status === 'frozen' || tgtRow.pinned === 1) continue;
    if (
      srcRow.scope !== tgtRow.scope ||
      (srcRow.workspace_id || '') !== (tgtRow.workspace_id || '') ||
      (srcRow.session_id || '') !== (tgtRow.session_id || '')
    ) {
      continue;
    }

    try {
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
    } catch (err) {
      errors.push(formatErr(`merge_duplicate(${pair.sourceId}->${pair.targetId})`, err));
    }
  }

  // 4. 自动消解非冻结的活跃矛盾关系
  // 安全护栏：绝不自动裁决跨作用域 (如 user/global vs workspace) 或双方均由用户批准 (approved_by = 'user') 的矛盾
  let contradictionsResolved = 0;
  for (const c of beforeReport.contradictions) {
    const mFrom = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [c.fromId])
    );
    const mTo = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [c.toId])
    );
    if (!mFrom || !mTo) continue;
    if (mFrom.status !== 'active' && mFrom.status !== 'frozen') continue;
    if (mTo.status !== 'active' && mTo.status !== 'frozen') continue;
    if (mFrom.status === 'frozen' && mTo.status === 'frozen') continue;

    // 禁止跨作用域/跨归属自动裁决
    if (
      mFrom.scope !== mTo.scope ||
      (mFrom.workspace_id || '') !== (mTo.workspace_id || '') ||
      (mFrom.session_id || '') !== (mTo.session_id || '')
    ) {
      continue;
    }

    // 禁止自动裁决两条均经用户显式审批的记忆之间的矛盾
    if (mFrom.approved_by === 'user' && mTo.approved_by === 'user') {
      continue;
    }

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

    const userApprovedWins = (a: MemoryRecord, b: MemoryRecord) =>
      a.approved_by === 'user' && b.approved_by !== 'user';
    const winner = userApprovedWins(mFrom, mTo)
      ? mFrom
      : userApprovedWins(mTo, mFrom)
        ? mTo
        : scoreA > scoreB || (scoreA === scoreB && mFrom.updated_at >= mTo.updated_at)
          ? mFrom
          : mTo;
    const loser = winner.id === mFrom.id ? mTo : mFrom;

    if (loser.status === 'frozen' || loser.pinned === 1) continue;

    try {
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
        db.afterCommit(() => removeCachedRuntimeEmbedding(loser.id, db));
      });
      contradictionsResolved++;
    } catch (err) {
      errors.push(formatErr(`resolve_contradiction(${c.fromId},${c.toId})`, err));
    }
  }

  // 5. 修复提案 (repair_proposals) 严格遵守 001_init.sql 人工审批契约，后台自愈绝不自动批准
  const repairsApplied = 0;

  // 5.5 清理无效、被遮蔽或多次负反馈的噪音记忆
  let invalidPruned = 0;
  if (!options.skipPrune) {
    try {
      if (wsFilter) {
        const pruneRes = pruneInvalidMemories(db, { workspaceId: wsFilter, now });
        invalidPruned = pruneRes.prunedCount;
      } else if (excludeWorkspaces?.length) {
        for (const targetWs of targetWorkspaces) {
          const pruneRes = pruneInvalidMemories(db, { workspaceId: targetWs, now });
          invalidPruned += pruneRes.prunedCount;
        }
      } else {
        const pruneRes = pruneInvalidMemories(db, { now });
        invalidPruned = pruneRes.prunedCount;
      }
    } catch (err) {
      errors.push(formatErr('prune_invalid', err));
    }
  }

  // 6. 自动晋升具备纯净用户证据的高置信度候选记忆
  // 安全边界：绝不自动晋升 source_kind = 'llm_extract'、web/tool 污点或混合污点候选，且严格遵守 scope/privacy 隔离
  let candidatesPromoted = 0;
  try {
    const scopeFilter = buildHealthScopeFilter({
      workspaceId: wsFilter,
      sessionId: options.sessionId,
      excludeWorkspaces,
    });
    const rawCandidateRows = db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status = 'candidate'
         AND confidence >= 0.5
         AND source_kind NOT IN ('web', 'tool', 'llm_extract')
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         AND (${scopeFilter.sql})
       ORDER BY confidence DESC, utility DESC
       LIMIT 30`,
      scopeFilter.params
    );

    for (const rawCand of rawCandidateRows) {
      const cand = hydrateMemoryRow(rawCand);
      if (
        cand.source_kind === 'llm_extract' ||
        cand.source_kind === 'web' ||
        cand.source_kind === 'tool'
      ) {
        continue;
      }
      if (hasUntrustedOrigin(cand)) continue;
      if (!hasUserEvidence(db, cand)) continue;

      const appRes = approveCandidate(db, cand.id, 'autonomous-doctor', now);
      if (appRes.action === 'approved' || appRes.action === 'superseded') {
        candidatesPromoted++;
      }
    }
  } catch (err) {
    errors.push(formatErr('promote_candidates', err));
  }

  // 7. 同步已验证高效用规则至 Core Memory 暂存区
  let coreBlocksSynced = 0;
  try {
    coreBlocksSynced = syncAutonomousCoreMemory(db, {
      workspaceId: wsFilter,
      sessionId: options.sessionId,
      excludeWorkspaces,
      now,
      onError: (msg) => errors.push(msg),
    });
  } catch (err) {
    errors.push(formatErr('core_sync', err));
  }

  // 7.5 Hindsight 幂等置信度校准与心智模型合成（未传 workspaceId 时逐个处理非排除工作区，绝不回退 process.cwd()）
  let confidenceCalibrated = 0;
  let modelsSynthesized = 0;
  for (const targetWs of targetWorkspaces) {
    try {
      const reflectReport = runHindsightReflect(db, {
        workspaceId: targetWs,
        sessionId: options.sessionId,
        excludeWorkspaces,
        autoSynthesize: true,
        minClusterSize: 3,
        persistCalibration: true,
        now,
      });
      confidenceCalibrated += reflectReport.calibratedMemories.length;
      modelsSynthesized += reflectReport.synthesizedModels.length;
    } catch (err) {
      errors.push(formatErr(`hindsight_reflect(${targetWs})`, err));
    }
  }

  // 8. A-Mem Zettelkasten 孤岛节点自动双链织网
  let linksWeaved = 0;
  if (!options.skipWeave) {
    try {
      linksWeaved = weaveZettelkastenLinks(db, {
        workspaceId: wsFilter,
        sessionId: options.sessionId,
        excludeWorkspaces,
        maxNewLinks: 60,
        now,
      });
    } catch (err) {
      errors.push(formatErr('weave_links', err));
    }
  }

  // 增量刷新或按需重算健康报告：无任何变更时直接复用 beforeReport；仅非结构变更时跳过 O(n²) 重复对扫描
  const hasStructuralMutation =
    duplicatesMerged > 0 ||
    contradictionsResolved > 0 ||
    invalidPruned > 0 ||
    candidatesPromoted > 0 ||
    coreBlocksSynced > 0 ||
    modelsSynthesized > 0;
  const hasLightweightMutation =
    ftsRebuilt || embeddingsBackfilled > 0 || linksWeaved > 0 || confidenceCalibrated > 0;

  let afterReport: MemoryHealthReport;
  if (!hasStructuralMutation && !hasLightweightMutation) {
    afterReport = beforeReport;
  } else if (!hasStructuralMutation) {
    afterReport = refreshLightweightHealthReport(db, beforeReport, auditOpts);
  } else {
    afterReport = auditMemoryHealth(db, auditOpts);
  }

  return {
    beforeScore: beforeReport.score,
    afterScore: afterReport.score,
    afterGrade: afterReport.grade,
    ftsRebuilt,
    embeddingsBackfilled,
    duplicatesMerged,
    contradictionsResolved,
    linksWeaved,
    candidatesPromoted,
    repairsApplied,
    coreBlocksSynced,
    invalidPruned,
    confidenceCalibrated,
    modelsSynthesized,
    errors,
    report: afterReport,
  };
}
