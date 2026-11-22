import type { Db, RawEvent } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { jobFailure, type JobRecord, type JobHandlerResult } from '../jobs/types.js';
import {
  PROMPT_REFLECT,
  packPromptWithinBudget,
  renderTranscript,
  truncateTextToTokenBudget,
} from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { upsertCandidate } from '../core/writer.js';
import { workspaceId, resolveWorkspaceCwd } from '../core/scope.js';
import { estimateTokens } from '../core/tokens.js';
import { redactSecrets } from '../core/privacy.js';

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
  return estimateTokens(PROMPT_REFLECT.system + userPrompt) + 250;
}

/**
 * O(N) 高信号有界事件筛选：预先一次性计算每条事件的渲染成本，
 * 优先保留：
 * 1) 真实用户提问/纠正消息 (origin_kind='user')
 * 2) 轮次尾部事件（最终答复或末尾失败现场）
 * 3) 所有错误事件 (is_error=1) 及其紧邻前后事件
 * 4) 从后向前补齐剩余预算内的最近上下文
 */
function selectBoundedReflectEvents(
  events: RawEvent[],
  maxTranscriptTokens: number
): RawEvent[] {
  if (events.length === 0 || maxTranscriptTokens <= 0) return [];

  // 一次性预渲染计算单行 token 成本，全程 O(N)
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

  // O(N) 裁剪：按优先级保留末尾事件、用户消息与错误事件，逐个移除非关键低优先级条目直到满足预算
  const selectedIndices = Array.from(chosen).sort((a, b) => a - b);
  let totalCost = selectedIndices.reduce((acc, idx) => acc + renderedCost[idx], 0);
  if (selectedIndices.length > 1 && totalCost > maxTranscriptTokens) {
    const keepMask = new Array<boolean>(selectedIndices.length).fill(true);
    // 先丢弃非用户、非错误的非末尾事件
    for (let i = 0; i < selectedIndices.length - 1 && totalCost > maxTranscriptTokens; i++) {
      const ev = events[selectedIndices[i]];
      if (ev.origin_kind !== 'user' && ev.is_error !== 1) {
        keepMask[i] = false;
        totalCost -= renderedCost[selectedIndices[i]];
      }
    }
    // 若仍超预算，从最早事件开始裁剪直到只剩至少 1 条
    let remaining = keepMask.filter(Boolean).length;
    for (let i = 0; i < selectedIndices.length - 1 && totalCost > maxTranscriptTokens && remaining > 1; i++) {
      if (keepMask[i]) {
        keepMask[i] = false;
        totalCost -= renderedCost[selectedIndices[i]];
        remaining--;
      }
    }
    return selectedIndices.filter((_, i) => keepMask[i]).map((idx) => events[idx]);
  }

  return selectedIndices.map((idx) => events[idx]);
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

  let { sessionId, turn, triggerSeq, cwd = '', correctionMessage } = payload;
  const sig = payload.sig;
  const rawPayloadWs = (payload.workspaceId || '').trim();
  const payloadWs = rawPayloadWs ? workspaceId(rawPayloadWs) : '';
  let sigWorkspaceId = '';

  // 兼容 R4 跨会话重复工具失败入队的 reflect:failure_sig 任务
  // 严格按 workspace_id 过滤 failure_sigs，且当无有效 turn 时使用 triggerSeq 定位，避免 turn=0 误拉取 turn 1
  if (sig && (!sessionId || typeof turn !== 'number')) {
    const sigRow = rawPayloadWs
      ? db.get<{ sessions: string; last_seq_ref: string | null; workspace_id: string }>(
          'SELECT sessions, last_seq_ref, workspace_id FROM failure_sigs WHERE sig = ? AND workspace_id IN (?, ?) ORDER BY updated_at DESC LIMIT 1',
          [sig, rawPayloadWs, payloadWs]
        )
      : db.get<{ sessions: string; last_seq_ref: string | null; workspace_id: string }>(
          'SELECT sessions, last_seq_ref, workspace_id FROM failure_sigs WHERE sig = ? ORDER BY updated_at DESC LIMIT 1',
          [sig]
        );
    if (sigRow) {
      sigWorkspaceId = sigRow.workspace_id || '';
      if (sigRow.last_seq_ref && sigRow.last_seq_ref.includes(':')) {
        const lastColon = sigRow.last_seq_ref.lastIndexOf(':');
        const refSess = sigRow.last_seq_ref.slice(0, lastColon);
        const refSeq = parseInt(sigRow.last_seq_ref.slice(lastColon + 1), 10);
        if (!sessionId && refSess) {
          sessionId = refSess;
        }
        if (typeof triggerSeq !== 'number' && Number.isInteger(refSeq) && refSeq > 0) {
          triggerSeq = refSeq;
        }
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
        const lastEv =
          typeof triggerSeq === 'number'
            ? db.get<{ turn: number | null }>(
                'SELECT turn FROM raw_events WHERE session_id = ? AND seq = ? LIMIT 1',
                [sessionId, triggerSeq]
              )
            : db.get<{ turn: number | null }>(
                'SELECT turn FROM raw_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
                [sessionId]
              );
        if (typeof lastEv?.turn === 'number' && lastEv.turn >= 1) {
          turn = lastEv.turn;
        }
      }
    }
    if (!correctionMessage) {
      correctionMessage = `Repeated tool failure signature: ${sig.slice(0, 200)}`;
    }
  }

  if (!correctionMessage) {
    correctionMessage = 'User corrected previous answer';
  }

  const hasValidTurn = typeof turn === 'number' && Number.isInteger(turn) && turn >= 1;
  const hasTriggerSeq = typeof triggerSeq === 'number' && Number.isInteger(triggerSeq) && triggerSeq >= 1;

  if (!sessionId || (!hasValidTurn && !hasTriggerSeq && !sig)) {
    return { action: 'failed', error: 'missing_session_or_turn', nonRetryable: true };
  }

  // 1. 获取失败/纠正前后的关键事件（支持省略 turn 时基于 triggerSeq 精确切片，禁止 turn=0 拉取 turn 1）
  let events: RawEvent[] = [];

  if (hasValidTurn) {
    const baseEvents = db.all<RawEvent>(
      `SELECT * FROM raw_events
       WHERE session_id = ? AND (turn = ? OR turn = ?)
       ORDER BY seq ASC`,
      [sessionId, turn!, turn! + 1]
    );

    if (baseEvents.length > 0) {
      const minBaseSeq = baseEvents[0].seq;
      const maxBaseSeq = baseEvents[baseEvents.length - 1].seq;
      const prevTurnRow = db.get<{ prev_seq: number | null }>(
        `SELECT MAX(seq) AS prev_seq
         FROM raw_events
         WHERE session_id = ? AND turn IS NOT NULL AND turn < ? AND seq < ?`,
        [sessionId, turn!, minBaseSeq]
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

      const extraTrigger = hasTriggerSeq
        ? db.all<RawEvent>(
            `SELECT * FROM raw_events
             WHERE session_id = ? AND seq = ?`,
            [sessionId, triggerSeq!]
          )
        : [];

      const bySeq = new Map<number, RawEvent>();
      for (const ev of [...nullTurnPrompts, ...baseEvents, ...extraTrigger]) {
        bySeq.set(ev.seq, ev);
      }
      events = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
    }
  }

  if (events.length === 0 && hasTriggerSeq) {
    events = db
      .all<RawEvent>(
        `SELECT * FROM raw_events
         WHERE session_id = ? AND seq <= ?
         ORDER BY seq DESC
         LIMIT 16`,
        [sessionId, triggerSeq!]
      )
      .reverse();
  }

  if (events.length === 0 && sig) {
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
  const nonEmptyEventWs = events.find((ev) => ev.workspace_id)?.workspace_id || '';
  const cwdWs = cwd && !/^[0-9a-f]{16}$/i.test(cwd) ? workspaceId(cwd) : cwd || '';
  const wsId =
    nonEmptyEventWs || sessionOwnerRows[0]?.workspace_id || sigWorkspaceId || payloadWs || cwdWs || '';
  const realCwd =
    (cwd && cwd.trim() && !/^[0-9a-f]{16}$/i.test(cwd.trim())
      ? cwd.trim()
      : resolveWorkspaceCwd(db, wsId)) || '';

  const dataWorkspaceIds = Array.from(
    new Set(
      [
        ...events.map((ev) => ev.workspace_id),
        ...sessionOwnerRows.map((r) => r.workspace_id),
        sigWorkspaceId,
        payloadWs,
      ].filter(Boolean)
    )
  );
  const signalKind = payload.signalKind || (sig ? 'repeated_tool_failure' : 'user_correction');
  const displayTurn = hasValidTurn ? turn! : 0;

  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  let boundedDetail = redactSecrets(correctionMessage).text.slice(0, 800);
  const emptyWrapperTokens = estimateReflectPromptTokens(wsId, displayTurn, signalKind, '', '');
  if (emptyWrapperTokens + estimateTokens(boundedDetail) > maxInputTokens) {
    const availDetailTokens = Math.max(20, maxInputTokens - emptyWrapperTokens - 40);
    boundedDetail = truncateTextToTokenBudget(boundedDetail, availDetailTokens);
  }
  const baseWrapperTokens = estimateReflectPromptTokens(
    wsId,
    displayTurn,
    signalKind,
    boundedDetail,
    ''
  );
  const transcriptBudget = Math.max(120, maxInputTokens - baseWrapperTokens - 60);

  let selectedEvents = selectBoundedReflectEvents(events, transcriptBudget);

  // 若预选结果加上外层包装后仍略超预算，通过 O(log N) packPromptWithinBudget 或单条真实 token 截断收敛
  const buildReflectUser = (evs: RawEvent[], ledger?: EvidenceLedger): string => {
    const transcript = renderTranscript(evs, ledger ?? new Map());
    return PROMPT_REFLECT.buildUser({
      cwd: wsId,
      turn: displayTurn,
      signalKind,
      signalDetail: boundedDetail,
      transcript,
    });
  };

  const packed = packPromptWithinBudget(
    PROMPT_REFLECT.system,
    (evs) => buildReflectUser(evs),
    selectedEvents,
    maxInputTokens,
    250
  );

  if (packed.selected.length > 0) {
    selectedEvents = packed.selected;
  } else if (selectedEvents.length > 0) {
    // 即使只剩最后 1 条事件也超出预算时，基于真实 estimateTokens 截断该单条事件文本
    const targetEv = selectedEvents[selectedEvents.length - 1];
    const availTokens = Math.max(30, maxInputTokens - baseWrapperTokens - 40);
    selectedEvents = [
      {
        ...targetEv,
        text: truncateTextToTokenBudget(targetEv.text || '', availTokens),
      },
    ];
  }

  const evidenceLedger: EvidenceLedger = new Map();
  const userPrompt = buildReflectUser(selectedEvents, evidenceLedger);

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
