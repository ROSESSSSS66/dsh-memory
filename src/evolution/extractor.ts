import type { PluginConfig } from '../config.js';
import {
  isWorkspaceExcluded,
  memoryPrivacyFilterSQL,
  memoryWorkspaceIds,
} from '../core/privacy.js';
import { workspaceId as normalizeWorkspaceId, resolveWorkspaceCwd } from '../core/scope.js';
import { estimateTokens } from '../core/tokens.js';
import { hasUntrustedOrigin, hasUserEvidence } from '../core/trust.js';
import { removeCachedRuntimeEmbedding } from '../core/vector.js';
import { addRelation, saveVersionSnapshot, upsertCandidate } from '../core/writer.js';
import {
  type Db,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type OriginKind,
  type RawEvent,
} from '../types.js';
import { callOfflineLLM } from './llm.js';
import { parseOutput } from './parse.js';
import {
  PROMPT_DISTILL,
  packPromptWithinBudget,
  renderTranscript,
  truncateTextToTokenBudget,
} from './prompts.js';
import { reconcileCandidate } from './reconciler.js';
import {
  getUnchangedReviewedMemory,
  isProtectedFromModelDiscard,
  sameMemoryOwner,
} from './review-snapshot.js';
import type { EvidenceLedger } from './types.js';

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

interface DistillBatchCap {
  minSeq: number;
  maxCount: number;
  singleEventFails: number;
  updatedAt: number;
}

function readBatchCap(db: Db, key: string): DistillBatchCap | null {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [key]);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<DistillBatchCap>;
    if (
      typeof parsed.minSeq === 'number' &&
      typeof parsed.maxCount === 'number' &&
      parsed.maxCount >= 1
    ) {
      return {
        minSeq: parsed.minSeq,
        maxCount: Math.floor(parsed.maxCount),
        singleEventFails: typeof parsed.singleEventFails === 'number' ? parsed.singleEventFails : 0,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
  } catch {}
  return null;
}

/**
 * 寻找需要蒸馏的会话（未处理事件 >= cfg.distillMinEvents，或空闲状态下任何未处理事件）
 * 按 session_id 聚合（避免同一会话内空/非空 workspace_id 拆分计数与错乱 minSeq）。
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
        `SELECT session_id,
                MAX(CASE WHEN workspace_id != '' THEN workspace_id ELSE '' END) as workspace_id,
                COUNT(*) as cnt,
                MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2 AND session_id = ?
         GROUP BY session_id
         HAVING cnt >= ?`,
        [targetSessionId, minEvents]
      )
    : db.all<{ session_id: string; workspace_id: string; cnt: number; min_seq: number }>(
        `SELECT session_id,
                MAX(CASE WHEN workspace_id != '' THEN workspace_id ELSE '' END) as workspace_id,
                COUNT(*) as cnt,
                MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2
         GROUP BY session_id
         HAVING cnt >= ?
         ORDER BY CASE WHEN COUNT(*) >= 5 THEN 0 ELSE 1 END, MIN(time) ASC`,
        [minEvents]
      );

  const excludedSessions = new Set<string>();
  for (const owner of db.all<{ session_id: string; workspace_id: string }>(
    'SELECT session_id, workspace_id FROM session_workspace_owners'
  )) {
    if (isWorkspaceExcluded(owner.workspace_id, cfg.excludeWorkspaces)) {
      excludedSessions.add(owner.session_id);
    }
  }
  for (const evWs of db.all<{ session_id: string; workspace_id: string }>(
    "SELECT DISTINCT session_id, workspace_id FROM raw_events WHERE processed < 2 AND workspace_id != ''"
  )) {
    if (isWorkspaceExcluded(evWs.workspace_id, cfg.excludeWorkspaces)) {
      excludedSessions.add(evWs.session_id);
    }
  }

  const row = rows.find(
    (r) =>
      !excludedSessions.has(r.session_id) &&
      !isWorkspaceExcluded(r.workspace_id, cfg.excludeWorkspaces)
  );
  if (!row) return null;

  let effectiveWs = row.workspace_id || '';
  if (!effectiveWs) {
    effectiveWs =
      db.get<{ workspace_id: string }>(
        "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != '' LIMIT 1",
        [row.session_id]
      )?.workspace_id || '';
  }

  return {
    sessionId: row.session_id,
    workspaceId: effectiveWs,
    count: row.cnt,
    minSeq: Number(row.min_seq ?? 0),
  };
}

/**
 * 从单个会话抽取并蒸馏连续事件批次
 * 严格保证：连续有界批不丢早期事件、批次级污点传播、受保护记忆不可被模型取代、
 * 解析失败先逐次折半缩小批次定位单条中毒事件、事务失败不推进 processed/watermark。
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

  const sessionOwnerWsIds = db
    .all<{ workspace_id: string }>(
      "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != ''",
      [targetSessionId]
    )
    .map((r) => r.workspace_id);

  if (
    isWorkspaceExcluded(workspaceId, cfg.excludeWorkspaces) ||
    allUnprocessed.some((ev) => isWorkspaceExcluded(ev.workspace_id, cfg.excludeWorkspaces)) ||
    sessionOwnerWsIds.some((ws) => isWorkspaceExcluded(ws, cfg.excludeWorkspaces))
  ) {
    return {
      success: false,
      sessionId: targetSessionId,
      consumedCount: 0,
      itemsCreated: 0,
      error: 'workspace_excluded',
    };
  }

  // 检查是否因前一次解析失败处于折半隔离状态
  const batchCapKey = `distill_batch_cap:${targetSessionId}`;
  const existingCap = readBatchCap(db, batchCapKey);
  const candidatePool =
    existingCap && existingCap.minSeq === allUnprocessed[0].seq
      ? allUnprocessed.slice(0, existingCap.maxCount)
      : allUnprocessed;

  // 2. 连续有界选批，基于真实 estimateTokens 打包（绝不使用 chars * 2）
  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  const privacy = memoryPrivacyFilterSQL(cfg.excludeWorkspaces);
  const normWsId = workspaceId ? normalizeWorkspaceId(workspaceId) : '';
  const existingRows = workspaceId
    ? db
        .all<MemoryRow>(
          `SELECT *
           FROM memories
           WHERE (workspace_id IN (?, ?) OR scope IN ('user', 'global'))
             AND (scope != 'session' OR session_id = ?)
             AND status IN ('active', 'candidate')
             AND pinned = 0
             AND type != 'meta'
             AND COALESCE(slot_key, '') NOT LIKE 'core:%'
             AND ${privacy.sql}
           ORDER BY updated_at DESC
           LIMIT 16`,
          [workspaceId, normWsId, targetSessionId, ...privacy.params]
        )
        .map((r) => hydrateMemoryRow(r))
    : [];
  const reviewedMap = new Map<string, MemoryRecord>(existingRows.map((m) => [m.id, m]));
  const existingMemoriesText = existingRows
    .map(
      (m) =>
        `[${m.id}] type=${m.type} status=${m.status}${m.slot_key ? ` slot=${m.slot_key}` : ''}: ${(m.summary || m.content).slice(0, 120)}`
    )
    .join('\n');

  const buildDistillUser = (events: RawEvent[], ledger?: EvidenceLedger): string => {
    const transcript = renderTranscript(events, ledger ?? new Map());
    const rangeLabel =
      events.length > 0
        ? `seq ${events[0].seq}..${events[events.length - 1].seq}`
        : `seq ${candidatePool[0].seq}..${candidatePool[0].seq}`;
    const isoTime =
      events.length > 0
        ? new Date(events[0].time).toISOString()
        : new Date(candidatePool[0].time).toISOString();
    return PROMPT_DISTILL.buildUser({
      cwd: workspaceId,
      sessionId: targetSessionId!,
      rangeLabel,
      isoTime,
      existingMemories: existingMemoriesText,
      transcript,
    });
  };

  const packed = packPromptWithinBudget(
    PROMPT_DISTILL.system,
    (evs) => buildDistillUser(evs),
    candidatePool,
    maxInputTokens,
    250
  );

  let batchEvents: RawEvent[] = packed.selected;

  if (batchEvents.length === 0) {
    // 单条事件本身超出预算时，按真实 token 预算截断其文本避免游标永久死锁
    const firstEv = candidatePool[0];
    const emptyPromptTokens = estimateTokens(PROMPT_DISTILL.system + buildDistillUser([])) + 250;
    const availTokens = Math.max(30, maxInputTokens - emptyPromptTokens - 20);
    const truncatedText = truncateTextToTokenBudget(firstEv.text || '', availTokens);
    batchEvents = [
      {
        ...firstEv,
        text: truncatedText,
      },
    ];
  }

  if (batchEvents.length === 0) {
    return { success: true, sessionId: targetSessionId, consumedCount: 0, itemsCreated: 0 };
  }

  const testLedger: EvidenceLedger = new Map();
  const userPrompt = buildDistillUser(batchEvents, testLedger);

  // P0 批次级污点判定：只要本批包含任何 tool/web 不可信来源，所有提取条目均视为受污点影响
  const batchUntrustedOrigins: OriginKind[] = [];
  if (batchEvents.some((ev) => ev.origin_kind === 'web')) batchUntrustedOrigins.push('web');
  if (batchEvents.some((ev) => ev.origin_kind === 'tool')) batchUntrustedOrigins.push('tool');
  const batchTainted = batchUntrustedOrigins.length > 0;

  // 3. 调用离线 LLM（使用 resolveWorkspaceCwd 解析工作区路径进行脱敏，禁止泄露宿主 process.cwd()）
  const realCwd =
    (options.cwd && options.cwd.trim() && !/^[0-9a-f]{16}$/i.test(options.cwd.trim())
      ? options.cwd.trim()
      : resolveWorkspaceCwd(db, workspaceId)) || '';

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
        ...batchEvents.map((ev) => ev.workspace_id),
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

  const minSeq = batchEvents[0].seq;
  const maxSeq = batchEvents[batchEvents.length - 1].seq;

  if (!parseRes.success) {
    const failNow = Date.now();
    // 若当前批次包含多条事件，先逐次折半缩小批次以精准隔离中毒事件，绝不整批跳过正常事件
    if (batchEvents.length > 1) {
      const nextCap: DistillBatchCap = {
        minSeq,
        maxCount: Math.max(1, Math.floor(batchEvents.length / 2)),
        singleEventFails: 0,
        updatedAt: failNow,
      };
      db.run(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [batchCapKey, JSON.stringify(nextCap)]
      );
      return {
        success: false,
        sessionId: targetSessionId,
        consumedCount: 0,
        itemsCreated: 0,
        error: parseRes.error,
      };
    }

    // 单条事件连续 >= 2 次解析失败，仅跳过这一条中毒事件并恢复后续事件正常蒸馏
    const prevSingleFails =
      existingCap && existingCap.minSeq === minSeq ? existingCap.singleEventFails : 0;
    const nextSingleFails = prevSingleFails + 1;
    if (nextSingleFails >= 2) {
      db.transaction(() => {
        db.run(`UPDATE raw_events SET processed = 2 WHERE session_id = ? AND seq = ?`, [
          targetSessionId,
          minSeq,
        ]);
        db.run(
          `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [
            `distill:${targetSessionId}`,
            JSON.stringify({ lastSeq: maxSeq, updatedAt: failNow, skippedPoisonedEvent: minSeq }),
          ]
        );
        db.run('DELETE FROM meta WHERE key = ?', [batchCapKey]);
      });
      return {
        success: true,
        sessionId: targetSessionId,
        consumedCount: 1,
        itemsCreated: 0,
      };
    }

    const nextCap: DistillBatchCap = {
      minSeq,
      maxCount: 1,
      singleEventFails: nextSingleFails,
      updatedAt: failNow,
    };
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [batchCapKey, JSON.stringify(nextCap)]
    );
    return {
      success: false,
      sessionId: targetSessionId,
      consumedCount: 0,
      itemsCreated: 0,
      error: parseRes.error,
    };
  }

  // 5. 同一事务提交：智能调和 + 受保护守卫 + 批次污点隔离 + 清理冲突边
  const candidateIds: string[] = [];
  const discardedIds: string[] = [];
  let itemsUpdated = 0;
  const now = Date.now();

  // 收集本次已被合法 supersedesId 引用的目标，避免 5.1 先将其 discard 导致 5.2 快照失配
  const validSupersedeTargets = new Set<string>(
    parseRes.items
      .map((item) => item.supersedesId)
      .filter((id): id is string => Boolean(id && reviewedMap.has(id)))
  );

  try {
    db.transaction(() => {
      // 5.1 执行 LLM 识别出的无效/过时记忆淘汰指令 (discard_ids)
      if (parseRes.discardIds && parseRes.discardIds.length > 0) {
        for (const discardId of parseRes.discardIds) {
          if (validSupersedeTargets.has(discardId)) continue;
          const target = getUnchangedReviewedMemory(db, reviewedMap, discardId);
          if (
            target &&
            target.status !== 'frozen' &&
            target.pinned === 0 &&
            (target.status === 'active' || target.status === 'candidate') &&
            !isProtectedFromModelDiscard(db, target)
          ) {
            saveVersionSnapshot(db, target, 'llm_distill_discard', 'llm', now);
            const nextStatus = target.status === 'candidate' ? 'rejected' : 'archived';
            db.run(
              `UPDATE memories
               SET status = ?, valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [nextStatus, now, now, now, target.id]
            );
            db.afterCommit(() => removeCachedRuntimeEmbedding(target.id, db));
            discardedIds.push(target.id);
          }
        }
      }

      // 5.2 写入新记忆并执行受保护守卫下的自动升级取代
      for (const rawItem of parseRes.items) {
        // P0 批次级污点传播：受污点批次产出的条目必须携带污点来源，绝不允许绕过候选审批
        const item = batchTainted
          ? {
              ...rawItem,
              origin_kinds: Array.from(
                new Set<OriginKind>([...rawItem.origin_kinds, ...batchUntrustedOrigins])
              ),
            }
          : rawItem;

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
          const newMemory = hydrateMemoryRow(
            db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [upsertRes.id])!
          );
          if (upsertRes.action !== 'merged') {
            candidateIds.push(upsertRes.id);
          }

          if (
            oldMem &&
            oldMem.id !== upsertRes.id &&
            sameMemoryOwner(oldMem, newMemory) &&
            oldMem.status !== 'frozen' &&
            oldMem.pinned === 0 &&
            (oldMem.status === 'active' || oldMem.status === 'candidate') &&
            !isProtectedFromModelDiscard(db, oldMem)
          ) {
            // P0 信任边界：批次受污点、含 web/tool/system 来源或无干净用户证据时不得自动激活或取代 active 记忆
            const canActivate =
              !batchTainted &&
              !hasUntrustedOrigin(newMemory) &&
              hasUserEvidence(db, newMemory) &&
              !item.origin_kinds.some(
                (kind) => kind === 'web' || kind === 'tool' || kind === 'system'
              );
            if (oldMem.status === 'active' && !canActivate) continue;

            const slotConflict =
              canActivate && newMemory.slot_key
                ? hydrateMemoryRow(
                    db.get<MemoryRow>(
                      `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ?
                       AND COALESCE(session_id, '') = ? AND slot_key = ?
                       AND status IN ('active', 'frozen') AND id NOT IN (?, ?)`,
                      [
                        newMemory.scope,
                        newMemory.workspace_id || '',
                        newMemory.session_id || '',
                        newMemory.slot_key,
                        newMemory.id,
                        oldMem.id,
                      ]
                    )
                  )
                : undefined;

            // Validate every affected row before invalidating the old memory.
            if (
              slotConflict &&
              (!getUnchangedReviewedMemory(db, reviewedMap, slotConflict.id) ||
                isProtectedFromModelDiscard(db, slotConflict))
            ) {
              continue;
            }

            saveVersionSnapshot(db, oldMem, 'llm_auto_supersede', 'llm', now);
            db.run(
              `UPDATE memories
               SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [now, now, now, oldMem.id]
            );
            db.afterCommit(() => removeCachedRuntimeEmbedding(oldMem.id, db));
            // 清理 upsertCandidate 阶段因槽位冲突写入的陈旧 contradicts 边
            db.run(
              `DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = 'contradicts'`,
              [upsertRes.id, oldMem.id]
            );
            addRelation(db, upsertRes.id, oldMem.id, 'supersedes', now);
            itemsUpdated++;

            if (oldMem.status === 'active' && canActivate) {
              if (slotConflict) {
                saveVersionSnapshot(db, slotConflict, 'llm_auto_supersede_slot', 'llm', now);
                db.run(
                  `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
                  [now, now, now, slotConflict.id]
                );
                db.afterCommit(() => removeCachedRuntimeEmbedding(slotConflict.id, db));
                db.run(
                  `DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = 'contradicts'`,
                  [upsertRes.id, slotConflict.id]
                );
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
      db.run(
        `UPDATE raw_events
         SET processed = 2
         WHERE session_id = ? AND seq >= ? AND seq <= ?`,
        [targetSessionId, minSeq, maxSeq]
      );

      // 更新 watermark 至 meta 表并清除折半隔离标记
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
      db.run('DELETE FROM meta WHERE key = ?', [batchCapKey]);
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
