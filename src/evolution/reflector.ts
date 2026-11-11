import type { Db, RawEvent } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { jobFailure, type JobRecord, type JobHandlerResult } from '../jobs/types.js';
import { PROMPT_REFLECT, renderTranscript } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { upsertCandidate } from '../core/writer.js';
import { workspaceId } from '../core/scope.js';
import { estimateTokens } from '../core/tokens.js';
import { redactSecrets } from '../core/privacy.js';
import { registerJobHandler } from '../jobs/runner.js';

export interface ReflectPayload {
  sessionId?: string;
  turn?: number;
  triggerSeq?: number;
  cwd?: string;
  workspaceId?: string;
  sig?: string;
  signalKind?: 'user_correction' | 'repeated_tool_failure';
  correctionMessage?: string;
}

function resolveRealCwd(cwdOrWsId?: string): string {
  if (cwdOrWsId && cwdOrWsId.trim() && !/^[0-9a-f]{16}$/i.test(cwdOrWsId.trim())) {
    return cwdOrWsId.trim();
  }
  return process.cwd();
}

function estimateReflectPromptTokens(
  wsId: string,
  turn: number,
  signalKind: string,
  signalDetail: string,
  transcript: string
): number {
  const userPrompt = PROMPT_REFLECT.buildUser({
    cwd: wsId,
    turn,
    signalKind,
    signalDetail,
    transcript,
  });
  return estimateTokens(PROMPT_REFLECT.system + userPrompt) + 200;
}

/**
 * 对超长失败/纠正轮次进行高信号有界事件筛选，保证总输入稳定控制在 distillMaxInputTokens 以内：
 * 1) 真实用户提问/纠正消息 (origin_kind='user')
 * 2) 轮次尾部事件（最终答复或末尾失败现场）
 * 3) 所有错误事件 (is_error=1) 及其紧邻前后事件（tool/call + assistant 反应）
 * 4) 从后向前补齐剩余预算内的最近上下文
 */
function selectBoundedReflectEvents(
  events: RawEvent[],
  maxTranscriptTokens: number
): RawEvent[] {
  if (events.length === 0 || maxTranscriptTokens <= 0) return [];

  const renderedCost = events.map((ev) => {
    const line = renderTranscript([ev], new Map());
    if (!line) return 0;
    return estimateTokens(`${line}\n`) + 1;
  });

  const chosen = new Set<number>();
  let usedTokens = 0;

  const tryAdd = (idx: number): boolean => {
    if (idx < 0 || idx >= events.length) return false;
    if (chosen.has(idx)) return true;
    const cost = renderedCost[idx];
    if (cost === 0) return false;
    if (chosen.size > 0 && usedTokens + cost > maxTranscriptTokens) {
      return false;
    }
    chosen.add(idx);
    usedTokens += cost;
    return true;
  };

  for (let i = 0; i < events.length; i++) {
    if (events[i].origin_kind === 'user') {
      tryAdd(i);
    }
  }

  for (let i = events.length - 1; i >= Math.max(0, events.length - 4); i--) {
    tryAdd(i);
  }

  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].is_error === 1) {
      tryAdd(i);
      tryAdd(i - 1);
      tryAdd(i + 1);
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    if (!tryAdd(i) && usedTokens >= maxTranscriptTokens * 0.95) {
      break;
    }
  }

  if (chosen.size === 0) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (renderedCost[i] > 0) {
        chosen.add(i);
        break;
      }
    }
  }

  const ordered = Array.from(chosen)
    .sort((a, b) => a - b)
    .map((idx) => events[idx]);

  if (ordered.length === 1) {
    const cost0 = estimateTokens(renderTranscript([ordered[0]], new Map()));
    if (cost0 > maxTranscriptTokens) {
      const maxChars = Math.max(60, Math.floor(maxTranscriptTokens * 2));
      return [{ ...ordered[0], text: (ordered[0].text || '').slice(0, maxChars) }];
    }
  }

  return ordered;
}

/**
 * 执行失败反思任务 (reflect-v2, 附录 B-2)
 */
export async function runReflectJob(
  db: Db,
  cfg: PluginConfig,
  job: JobRecord,
  signal?: AbortSignal,
  fetchFn?: typeof fetch
): Promise<JobHandlerResult> {
  let payload: ReflectPayload;
  try {
    payload = job.payload ? JSON.parse(job.payload) : ({} as any);
  } catch {
    return { action: 'failed', error: 'invalid_reflect_job_payload', nonRetryable: true };
  }

  let { sessionId, turn, cwd = '', correctionMessage } = payload;
  const sig = payload.sig;

  // 兼容 R4 跨会话重复工具失败入队的 reflect:failure_sig 任务
  if (sig && (!sessionId || typeof turn !== 'number')) {
    const sigRow = db.get<{ sessions: string; last_seq_ref: string | null; workspace_id: string }>(
      'SELECT sessions, last_seq_ref, workspace_id FROM failure_sigs WHERE sig = ? ORDER BY updated_at DESC LIMIT 1',
      [sig]
    );
    if (sigRow) {
      if (!sessionId && sigRow.last_seq_ref && sigRow.last_seq_ref.includes(':')) {
        sessionId = sigRow.last_seq_ref.split(':')[0];
      }
      if (!sessionId) {
        try {
          const parsedSessions = JSON.parse(sigRow.sessions || '[]');
          if (Array.isArray(parsedSessions) && parsedSessions.length > 0) {
            sessionId = String(parsedSessions[parsedSessions.length - 1]);
          }
        } catch {}
      }
      if (typeof turn !== 'number' && sessionId) {
        const lastEv = db.get<{ turn: number | null }>(
          'SELECT turn FROM raw_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
          [sessionId]
        );
        turn = typeof lastEv?.turn === 'number' ? lastEv.turn : 0;
      }
    }
    if (!correctionMessage) {
      correctionMessage = `Repeated tool failure signature: ${sig.slice(0, 200)}`;
    }
  }

  if (!correctionMessage) {
    correctionMessage = 'User corrected previous answer';
  }

  if (!sessionId || typeof turn !== 'number') {
    return { action: 'failed', error: 'missing_session_or_turn', nonRetryable: true };
  }

  // 1. 获取失败/纠正前后的关键事件（兼容 DSH 中 user/message.turn 为 NULL 的真实会话日志）
  const baseEvents = db.all<RawEvent>(
    `SELECT * FROM raw_events
     WHERE session_id = ? AND (turn = ? OR turn = ?)
     ORDER BY seq ASC`,
    [sessionId, turn, turn + 1]
  );

  let events: RawEvent[] = [];
  if (baseEvents.length > 0) {
    const minBaseSeq = baseEvents[0].seq;
    const maxBaseSeq = baseEvents[baseEvents.length - 1].seq;
    const prevTurnRow = db.get<{ prev_seq: number | null }>(
      `SELECT MAX(seq) AS prev_seq
       FROM raw_events
       WHERE session_id = ? AND turn IS NOT NULL AND turn < ? AND seq < ?`,
      [sessionId, turn, minBaseSeq]
    );
    const prevTurnMaxSeq = prevTurnRow?.prev_seq ?? 0;

    const nullTurnPrompts = db.all<RawEvent>(
      `SELECT * FROM raw_events
       WHERE session_id = ?
         AND turn IS NULL
         AND origin_kind = 'user'
         AND seq > ?
         AND seq <= ?
       ORDER BY seq ASC`,
      [sessionId, prevTurnMaxSeq, maxBaseSeq]
    );

    const extraTrigger =
      typeof payload.triggerSeq === 'number'
        ? db.all<RawEvent>(
            `SELECT * FROM raw_events
             WHERE session_id = ? AND seq = ? AND origin_kind = 'user'`,
            [sessionId, payload.triggerSeq]
          )
        : [];

    const bySeq = new Map<number, RawEvent>();
    for (const ev of [...nullTurnPrompts, ...baseEvents, ...extraTrigger]) {
      bySeq.set(ev.seq, ev);
    }
    events = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  } else if (sig) {
    events = db
      .all<RawEvent>(
        `SELECT * FROM raw_events
         WHERE session_id = ?
         ORDER BY seq DESC
         LIMIT 12`,
        [sessionId]
      )
      .reverse();
  }

  if (events.length === 0) {
    return { action: 'done' };
  }

  const sessionOwnerRows = db.all<{ workspace_id: string }>(
    "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != ''",
    [sessionId]
  );
  const nonEmptyEventWs = events.find(ev => ev.workspace_id)?.workspace_id || '';
  const payloadWs = payload.workspaceId ? workspaceId(payload.workspaceId) : '';
  const cwdWs = cwd && !/^[0-9a-f]{16}$/i.test(cwd) ? workspaceId(cwd) : cwd || '';
  const wsId = nonEmptyEventWs || sessionOwnerRows[0]?.workspace_id || payloadWs || cwdWs || '';
  const realCwd = resolveRealCwd(cwd);
  const dataWorkspaceIds = Array.from(
    new Set([
      ...events.map(ev => ev.workspace_id),
      ...sessionOwnerRows.map(r => r.workspace_id),
    ])
  );
  const signalKind = payload.signalKind || (sig ? 'repeated_tool_failure' : 'user_correction');

  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  let boundedDetail = redactSecrets(correctionMessage).text.slice(0, 800);
  const emptyWrapperTokens = estimateReflectPromptTokens(wsId, turn, signalKind, '', '');
  if (emptyWrapperTokens + estimateTokens(boundedDetail) > maxInputTokens) {
    const maxDetailChars = Math.max(40, Math.floor((maxInputTokens - emptyWrapperTokens - 20) * 2));
    boundedDetail = boundedDetail.slice(0, maxDetailChars);
  }
  const baseWrapperTokens = estimateReflectPromptTokens(wsId, turn, signalKind, boundedDetail, '');
  const transcriptBudget = Math.max(120, maxInputTokens - baseWrapperTokens - 60);

  let selectedEvents = selectBoundedReflectEvents(events, transcriptBudget);
  const evidenceLedger: EvidenceLedger = new Map();
  let transcript = renderTranscript(selectedEvents, evidenceLedger);
  let userPrompt = PROMPT_REFLECT.buildUser({
    cwd: wsId,
    turn,
    signalKind,
    signalDetail: boundedDetail,
    transcript,
  });

  while (
    selectedEvents.length > 1 &&
    estimateTokens(PROMPT_REFLECT.system + userPrompt) + 200 > maxInputTokens
  ) {
    const dropIdx = selectedEvents.findIndex(
      (ev, idx) =>
        idx < selectedEvents.length - 1 &&
        ev.origin_kind !== 'user' &&
        ev.is_error !== 1
    );
    const removeAt = dropIdx >= 0 ? dropIdx : 0;
    selectedEvents.splice(removeAt, 1);
    evidenceLedger.clear();
    transcript = renderTranscript(selectedEvents, evidenceLedger);
    userPrompt = PROMPT_REFLECT.buildUser({
      cwd: wsId,
      turn,
      signalKind,
      signalDetail: boundedDetail,
      transcript,
    });
  }

  if (
    selectedEvents.length === 1 &&
    estimateTokens(PROMPT_REFLECT.system + userPrompt) + 200 > maxInputTokens
  ) {
    const rawText = selectedEvents[0].text || '';
    const allowedTranscriptTokens = Math.max(40, maxInputTokens - baseWrapperTokens - 60);
    let targetChars = Math.min(rawText.length, Math.max(40, Math.floor(allowedTranscriptTokens * 1.2)));
    while (targetChars >= 20) {
      selectedEvents = [
        {
          ...selectedEvents[0],
          text: rawText.slice(0, targetChars),
        },
      ];
      evidenceLedger.clear();
      transcript = renderTranscript(selectedEvents, evidenceLedger);
      userPrompt = PROMPT_REFLECT.buildUser({
        cwd: wsId,
        turn,
        signalKind,
        signalDetail: boundedDetail,
        transcript,
      });
      if (estimateTokens(PROMPT_REFLECT.system + userPrompt) + 200 <= maxInputTokens) {
        break;
      }
      targetChars = Math.floor(targetChars * 0.75);
    }
  }

  // 2. 调用离线 LLM
  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'reflect',
      promptVersion: PROMPT_REFLECT.version,
      systemPrompt: PROMPT_REFLECT.system,
      userPrompt,
      maxOutputTokens: PROMPT_REFLECT.maxOutputTokens,
      cwd: realCwd,
      workspaceId: wsId,
      dataWorkspaceIds,
      signal,
      fetchFn,
    },
    cfg
  );

  if (!llmRes.ok) {
    return jobFailure(llmRes.error);
  }

  // 3. 解析模型输出
  const parseRes = parseOutput(llmRes.content, {
    taskKind: 'reflect',
    evidenceLedger,
    workspaceId: wsId,
    sessionId,
  });

  if (!parseRes.success) {
    return { action: 'failed', error: parseRes.error, nonRetryable: true };
  }

  // 4. 写入候选记忆 (candidate)
  db.transaction(() => {
    for (const item of parseRes.items) {
      upsertCandidate(db, item);
    }
  });

  return { action: 'done' };
}

/**
 * 注册 reflect 离线任务处理器
 */
export function registerReflectHandler(db: Db, cfg: PluginConfig, fetchFn?: typeof fetch): void {
  registerJobHandler('reflect', async (job, signal) => {
    return runReflectJob(db, cfg, job, signal, fetchFn);
  });
}
