import type { Db, RawEvent, CandidateInput } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { PROMPT_DISTILL, renderTranscript } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { reconcileCandidate } from './reconciler.js';
import { upsertCandidate, addRelation } from '../core/writer.js';
import { estimateTokens } from '../core/tokens.js';

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
  candidateIds?: string[];
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

  const row = targetSessionId
    ? db.get<{ session_id: string; workspace_id: string; cnt: number; min_seq: number }>(
        `SELECT session_id, workspace_id, COUNT(*) as cnt, MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2 AND session_id = ?
         GROUP BY session_id, workspace_id
         HAVING cnt >= ?
         LIMIT 1`,
        [targetSessionId, minEvents]
      )
    : db.get<{ session_id: string; workspace_id: string; cnt: number; min_seq: number }>(
        `SELECT session_id, workspace_id, COUNT(*) as cnt, MIN(seq) as min_seq
         FROM raw_events
         WHERE processed < 2
         GROUP BY session_id, workspace_id
         HAVING cnt >= ?
         ORDER BY CASE WHEN COUNT(*) >= 5 THEN 0 ELSE 1 END, MIN(time) ASC
         LIMIT 1`,
        [minEvents]
      );

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
    const wsRow = db.get<{ workspace_id: string }>(
      'SELECT workspace_id FROM raw_events WHERE session_id = ? LIMIT 1',
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

  // 2. 连续有界选批，严格计算完整输入预算 <= cfg.distillMaxInputTokens (默认 6000)
  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  const batchEvents: RawEvent[] = [];
  const testLedger: EvidenceLedger = new Map();

  const wrapperUserPrompt = PROMPT_DISTILL.buildUser({
    cwd: workspaceId,
    sessionId: targetSessionId,
    rangeLabel: `seq ${allUnprocessed[0].seq}..${allUnprocessed[allUnprocessed.length - 1].seq}`,
    isoTime: new Date(allUnprocessed[0].time).toISOString(),
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
    transcript: finalTranscript,
  });

  // 3. 调用离线 LLM
  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'distill',
      promptVersion: PROMPT_DISTILL.version,
      systemPrompt: PROMPT_DISTILL.system,
      userPrompt,
      maxOutputTokens: PROMPT_DISTILL.maxOutputTokens,
      cwd: options.cwd || workspaceId,
      workspaceId,
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

  // 5. 同一事务提交：智能调和 (Mem0/Zep Slot & Semantic Reconciliation) 写入候选记忆、推进 processed=2、推进 watermark
  const candidateIds: string[] = [];
  const now = Date.now();
  try {
    db.transaction(() => {
      // 写入记忆（先经 reconcileCandidate 推断规范槽位、抑制完全冗余项并关联语义演化冲突边）
      for (const item of parseRes.items) {
        const decision = reconcileCandidate(db, item);
        if (decision.action === 'NOOP' && decision.reason === 'subsumed_by_existing_memory') {
          continue;
        }
        const upsertRes = upsertCandidate(db, item, now);
        if ('id' in upsertRes) {
          if (upsertRes.action !== 'merged') {
            candidateIds.push(upsertRes.id);
          }
          if (
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
    candidateIds,
  };
}
