import type { Db, RawEvent, CandidateInput, MemoryRecord } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { PROMPT_DISTILL, renderTranscript } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { reconcileCandidate } from './reconciler.js';
import {
  upsertCandidate,
  addRelation,
  saveVersionSnapshot,
} from '../core/writer.js';
import { removeCachedRuntimeEmbedding } from '../core/vector.js';
import { estimateTokens } from '../core/tokens.js';
import { isWorkspaceExcluded, memoryPrivacyFilterSQL, memoryWorkspaceIds } from '../core/privacy.js';
import { getUnchangedReviewedMemory, sameMemoryOwner } from './review-snapshot.js';
import { hasUserEvidence } from '../core/trust.js';

export interface DistillBatchOptions {
  sessionId?: string;
  cwd?: string;
  signal?: AbortSignal;
  jobDeadline?: number;
  fetchFn?: typeof fetch;
  isIdle?: boolean;
}

export interface DistillResult {
  success: boolean;
  sessionId?: string;
  consumedCount: number;
  itemsCreated: number;
  itemsUpdated?: number;
  itemsDiscarded?: number;
  candidateIds?: string[];
  discardedIds?: string[];
  error?: string;
}

/**
 * 寻找需要蒸馏的会话（未处理事件 >= cfg.distillMinEvents，或空闲状态下任何未处理事件）
 * 返回未处理区间起点 minSeq，用于构造无死锁的批次水位线任务键
 */
export function findEligibleDistillSession(
  db: Db,
  cfg: PluginConfig,
  isIdle = false,
  targetSessionId?: string
): { sessionId: string; workspaceId: string; count: number; minSeq: number } | null {
  const minEvents = isIdle ? 1 : cfg.distillMinEvents || 40;

  const rows = targetSessionId
    ? db.all<{ session_id: string; workspace_id: string; cnt: number; min_seq: number }>(
        `SELECT session_id, workspace_id, COUNT(*) as cnt, MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2 AND session_id = ?
         GROUP BY session_id, workspace_id
         HAVING cnt >= ?`,
        [targetSessionId, minEvents]
      )
    : db.all<{ session_id: string; workspace_id: string; cnt: number; min_seq: number }>(
        `SELECT session_id, workspace_id, COUNT(*) as cnt, MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2
         GROUP BY session_id, workspace_id
         HAVING cnt >= ?
         ORDER BY CASE WHEN COUNT(*) >= 5 THEN 0 ELSE 1 END, MIN(time) ASC`,
        [minEvents]
      );

  const excludedSessions = new Set(
    db.all<{ session_id: string; workspace_id: string }>('SELECT * FROM session_workspace_owners')
      .filter(owner => isWorkspaceExcluded(owner.workspace_id, cfg.excludeWorkspaces))
      .map(owner => owner.session_id)
  );
  const row = rows.find(r => !excludedSessions.has(r.session_id) &&
    !isWorkspaceExcluded(r.workspace_id, cfg.excludeWorkspaces));
  if (!row) return null;
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    count: row.cnt,
    minSeq: Number(row.min_seq ?? 0),
  };
}

/**
 * 从单个会话抽取并蒸馏连续事件批次
 * 严格保证：连续有界批不丢早期事件、伪造引用丢弃、事务失败不推进processed/watermark、空items可推进
 */
export async function distillSession(
  db: Db,
  cfg: PluginConfig,
  options: DistillBatchOptions = {}
): Promise<DistillResult> {
  let targetSessionId = options.sessionId;
  let workspaceId = '';

  if (!targetSessionId) {
    const eligible = findEligibleDistillSession(db, cfg, options.isIdle);
    if (!eligible) {
      return { success: true, consumedCount: 0, itemsCreated: 0 };
    }
    targetSessionId = eligible.sessionId;
    workspaceId = eligible.workspaceId;
  } else {
    const wsRow =
      db.get<{ workspace_id: string }>(
        "SELECT workspace_id FROM raw_events WHERE session_id = ? AND workspace_id != '' LIMIT 1",
        [targetSessionId]
      ) ||
      db.get<{ workspace_id: string }>(
        "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != '' LIMIT 1",
        [targetSessionId]
      );
    workspaceId = wsRow?.workspace_id || '';
  }

  // 1. 获取该会话从最早开始所有未蒸馏事件 (processed < 2)
  const allUnprocessed = db.all<RawEvent>(
    `SELECT * FROM raw_events
     WHERE session_id = ? AND processed < 2
     ORDER BY seq ASC`,
    [targetSessionId]
  );

  if (allUnprocessed.length === 0) {
    return { success: true, sessionId: targetSessionId, consumedCount: 0, itemsCreated: 0 };
  }
  if (
    isWorkspaceExcluded(workspaceId, cfg.excludeWorkspaces) ||
    allUnprocessed.some(ev => isWorkspaceExcluded(ev.workspace_id, cfg.excludeWorkspaces))
  ) {
    return { success: false, sessionId: targetSessionId, consumedCount: 0, itemsCreated: 0, error: 'workspace_excluded' };
  }

  // 2. 连续有界选批，严格计算完整输入预算 <= cfg.distillMaxInputTokens (默认 6000)
  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  const batchEvents: RawEvent[] = [];
  const testLedger: EvidenceLedger = new Map();

  // 查询当前工作区存量非冻结记忆摘要，供 LLM 自动识别过时/无效记忆并执行原地升级
  const privacy = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
  const existingRows = workspaceId
    ? db.all<MemoryRecord>(
        `SELECT *
         FROM memories
         WHERE (workspace_id = ? OR scope IN ('user', 'global'))
           AND (scope != 'session' OR session_id = ?)
           AND status IN ('active', 'candidate')
           AND pinned = 0
           AND type != 'meta'
           AND COALESCE(slot_key, '') NOT LIKE 'core:%'
           AND ${privacy.sql}
         ORDER BY updated_at DESC
         LIMIT 16`,
        [workspaceId, targetSessionId, ...privacy.params]
      )
    : [];
  const reviewedMap = new Map(existingRows.map(m => [m.id, m]));
  const existingMemoriesText = existingRows
    .map(
      (m) =>
        `[${m.id}] type=${m.type} status=${m.status}${m.slot_key ? ` slot=${m.slot_key}` : ''}: ${(m.summary || m.content).slice(0, 120)}`
    )
    .join('\n');

  const wrapperUserPrompt = PROMPT_DISTILL.buildUser({
    cwd: workspaceId,
    sessionId: targetSessionId,
    rangeLabel: `seq ${allUnprocessed[0].seq}..${allUnprocessed[allUnprocessed.length - 1].seq}`,
    isoTime: new Date(allUnprocessed[0].time).toISOString(),
    existingMemories: existingMemoriesText,
    transcript: '',
  });
  let runningTokens = estimateTokens(PROMPT_DISTILL.system + wrapperUserPrompt) + 200;

  for (const ev of allUnprocessed) {
    const singleLedger: EvidenceLedger = new Map();
    const singleLine = renderTranscript([ev], singleLedger);
    const lineTokens = estimateTokens(singleLine + '\n');

    if (batchEvents.length > 0 && runningTokens + lineTokens > maxInputTokens) {
      // 超出 token 预算，停止本批，剩余事件留待后续批次
      break;
    }

    if (batchEvents.length === 0 && runningTokens + lineTokens > maxInputTokens) {
      // 单条事件超出预算时，截断文本避免会话游标永久死锁
      const maxChars = Math.max(100, Math.floor((maxInputTokens - runningTokens) * 2));
      batchEvents.push({
        ...ev,
        text: (ev.text || '').slice(0, maxChars),
      });
      break;
    }

    batchEvents.push(ev);
    runningTokens += lineTokens;
  }

  if (batchEvents.length === 0) {
    return { success: true, sessionId: targetSessionId, consumedCount: 0, itemsCreated: 0 };
  }

  const finalTranscript = renderTranscript(batchEvents, testLedger);
  const userPrompt = PROMPT_DISTILL.buildUser({
    cwd: workspaceId,
    sessionId: targetSessionId,
    rangeLabel: `seq ${batchEvents[0].seq}..${batchEvents[batchEvents.length - 1].seq}`,
    isoTime: new Date(batchEvents[0].time).toISOString(),
    existingMemories: existingMemoriesText,
    transcript: finalTranscript,
  });

  // 3. 调用离线 LLM
  const realCwd =
    options.cwd && options.cwd.trim() && !/^[0-9a-f]{16}$/i.test(options.cwd.trim())
      ? options.cwd.trim()
      : process.cwd();
  const sessionOwnerWsIds = db
    .all<{ workspace_id: string }>(
      "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != ''",
      [targetSessionId]
    )
    .map(r => r.workspace_id);
  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'distill',
      promptVersion: PROMPT_DISTILL.version,
      systemPrompt: PROMPT_DISTILL.system,
      userPrompt,
      maxOutputTokens: PROMPT_DISTILL.maxOutputTokens,
      cwd: realCwd,
      workspaceId,
      dataWorkspaceIds: [
        ...batchEvents.map(ev => ev.workspace_id),
        ...sessionOwnerWsIds,
        ...memoryWorkspaceIds(db, existingRows),
      ],
      signal: options.signal,
      jobDeadline: options.jobDeadline,
      fetchFn: options.fetchFn,
    },
    cfg
  );

  if (!llmRes.ok) {
    return {
      success: false,
      sessionId: targetSessionId,
      consumedCount: 0,
      itemsCreated: 0,
      error: llmRes.error,
    };
  }

  // 4. 解析输出
  const parseRes = parseOutput(llmRes.content, {
    taskKind: 'distill',
    evidenceLedger: testLedger,
    workspaceId,
    sessionId: targetSessionId,
  });

  if (!parseRes.success) {
    return {
      success: false,
      sessionId: targetSessionId,
      consumedCount: 0,
      itemsCreated: 0,
      error: parseRes.error,
    };
  }

  // 5. 同一事务提交：智能调和 (Mem0/Zep Slot & Semantic Reconciliation) + LLM 自动舍弃无效记忆 + 自动升级旧记忆
  const candidateIds: string[] = [];
  const discardedIds: string[] = [];
  let itemsUpdated = 0;
  const now = Date.now();
  try {
    db.transaction(() => {
      // 5.1 执行 LLM 识别出的无效/过时记忆淘汰指令 (discard_ids)
      if (parseRes.discardIds && parseRes.discardIds.length > 0) {
        for (const discardId of parseRes.discardIds) {
          const target = getUnchangedReviewedMemory(db, reviewedMap, discardId);
          if (
            target &&
            target.status !== 'frozen' &&
            target.pinned === 0 &&
            (target.status === 'active' || target.status === 'candidate')
          ) {
            saveVersionSnapshot(db, target, 'llm_distill_discard', 'llm', now);
            const nextStatus = target.status === 'candidate' ? 'rejected' : 'archived';
            db.run(
              `UPDATE memories
               SET status = ?, valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [nextStatus, now, now, now, target.id]
            );
            removeCachedRuntimeEmbedding(target.id);
            discardedIds.push(target.id);
          }
        }
      }

      // 5.2 写入新记忆并自动执行旧记忆升级取代 (LLM 显式 supersedes_id 原地取代 + Mem0 冲突边关联)
      for (const item of parseRes.items) {
        const decision = reconcileCandidate(db, item);
        if (
          decision.action === 'NOOP' &&
          (decision.reason === 'subsumed_by_existing_memory' ||
            decision.reason === 'identical_slot_and_content')
        ) {
          continue;
        }

        const oldMem = item.supersedesId
          ? getUnchangedReviewedMemory(db, reviewedMap, item.supersedesId)
          : undefined;

        const upsertRes = upsertCandidate(db, item, now);
        if ('id' in upsertRes) {
          const newMemory = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [upsertRes.id])!;
          if (upsertRes.action !== 'merged') {
            candidateIds.push(upsertRes.id);
          }

          if (
            oldMem &&
            oldMem.id !== upsertRes.id &&
            sameMemoryOwner(oldMem, newMemory) &&
            oldMem.status !== 'frozen' &&
            (oldMem.status === 'active' || oldMem.status === 'candidate')
          ) {
            const canActivate = hasUserEvidence(db, newMemory) && !item.origin_kinds.includes('web');
            if (oldMem.status === 'active' && !canActivate) continue;
            const slotConflict = canActivate && newMemory.slot_key ? db.get<MemoryRecord>(
              `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
               AND COALESCE(session_id, '') = ? AND slot_key = ?
               AND status IN ('active', 'frozen') AND id NOT IN (?, ?)`,
              [newMemory.scope, newMemory.workspace_id || '', newMemory.session_id || '',
                newMemory.slot_key, newMemory.id, oldMem.id]
            ) : undefined;
            // Validate every affected row before invalidating the old memory.
            if (slotConflict && !getUnchangedReviewedMemory(db, reviewedMap, slotConflict.id)) continue;
            saveVersionSnapshot(db, oldMem, 'llm_auto_supersede', 'llm', now);
            db.run(
              `UPDATE memories
               SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [now, now, now, oldMem.id]
            );
            removeCachedRuntimeEmbedding(oldMem.id);
            addRelation(db, upsertRes.id, oldMem.id, 'supersedes', now);
            itemsUpdated++;

            if (oldMem.status === 'active' && canActivate) {
              if (slotConflict) {
                saveVersionSnapshot(db, slotConflict, 'llm_auto_supersede_slot', 'llm', now);
                db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`, [now, now, now, slotConflict.id]);
                removeCachedRuntimeEmbedding(slotConflict.id);
                addRelation(db, upsertRes.id, slotConflict.id, 'supersedes', now);
              }
              db.run(
                `UPDATE memories
                 SET status = 'active', approved_at = ?, approved_by = 'llm-auto-update', updated_at = ?
                 WHERE id = ?`,
                [now, now, upsertRes.id]
              );
            }
          } else if (
            (decision.action === 'UPDATE' || decision.action === 'DELETE') &&
            decision.targetId &&
            decision.targetId !== upsertRes.id &&
            upsertRes.action === 'inserted'
          ) {
            addRelation(db, upsertRes.id, decision.targetId, 'contradicts', now);
          }
        }
      }

      // 推进已消费事件的 processed 状态为 2
      const minSeq = batchEvents[0].seq;
      const maxSeq = batchEvents[batchEvents.length - 1].seq;
      db.run(
        `UPDATE raw_events
         SET processed = 2
         WHERE session_id = ? AND seq >= ? AND seq <= ?`,
        [targetSessionId, minSeq, maxSeq]
      );

      // 更新 watermark 至 meta 表
      const watermarkData = JSON.stringify({
        lastSeq: maxSeq,
        updatedAt: now,
      });
      db.run(
        `INSERT INTO meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [`distill:${targetSessionId}`, watermarkData]
      );
    });
  } catch (err: any) {
    return {
      success: false,
      sessionId: targetSessionId,
      consumedCount: 0,
      itemsCreated: 0,
      error: `transaction_failed: ${err?.message}`,
    };
  }

  return {
    success: true,
    sessionId: targetSessionId,
    consumedCount: batchEvents.length,
    itemsCreated: candidateIds.length,
    itemsUpdated,
    itemsDiscarded: discardedIds.length,
    candidateIds,
    discardedIds,
  };
}
