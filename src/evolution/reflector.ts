import type { Db, RawEvent } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import type { JobRecord, JobHandlerResult } from '../jobs/types.js';
import { PROMPT_REFLECT, renderTranscript } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { upsertCandidate } from '../core/writer.js';
import { workspaceId } from '../core/scope.js';
import { registerJobHandler } from '../jobs/runner.js';

export interface ReflectPayload {
  sessionId?: string;
  turn?: number;
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

  // 1. 获取失败/纠正前后的关键事件
  let events = db.all<RawEvent>(
    `SELECT * FROM raw_events
     WHERE session_id = ? AND (turn = ? OR turn = ?)
     ORDER BY seq ASC`,
    [sessionId, turn, turn + 1]
  );

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

  const wsId =
    payload.workspaceId ||
    (cwd && !/^[0-9a-f]{16}$/i.test(cwd) ? workspaceId(cwd) : cwd || events[0].workspace_id || '');
  const realCwd = resolveRealCwd(cwd);
  const evidenceLedger: EvidenceLedger = new Map();
  const transcript = renderTranscript(events, evidenceLedger);
  const signalKind = payload.signalKind || (sig ? 'repeated_tool_failure' : 'user_correction');

  const userPrompt = PROMPT_REFLECT.buildUser({
    cwd: wsId,
    turn,
    signalKind,
    signalDetail: correctionMessage,
    transcript,
  });

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
      signal,
      fetchFn,
    },
    cfg
  );

  if (!llmRes.ok) {
    if (llmRes.error === 'daily_tokens_exceeded' || llmRes.error === 'daily_calls_exceeded') {
      return { action: 'skipped', reason: llmRes.error };
    }
    return { action: 'failed', error: llmRes.error };
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
