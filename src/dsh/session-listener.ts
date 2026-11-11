import type { Context, RawEvent } from '../types.js';
import type { IngestQueue } from '../ingest/queue.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { workspaceId } from '../core/scope.js';
import { isWorkspaceExcluded, redactSecrets } from '../core/privacy.js';
import { MemoryRefsSchema } from './memory-visibility.js';

export const IGNORED_EVENT_TYPES = new Set([
  'session-log-deepseek/delivery-accepted',
  'agent/inbox/spliced',
  'session/title-llm-request',
  'request/header',
  'request/context',
  'session/end-seed',
  'workspace/changes',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'model/selection',
  'session/title',
]);

export const IGNORED_USER_SOURCE_KINDS = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'tool-jobs',
]);

export function isIgnoredUserMessageSource(source: any): boolean {
  if (!source || typeof source !== 'object') return false;
  if (typeof source.kind === 'string' && IGNORED_USER_SOURCE_KINDS.has(source.kind)) {
    return true;
  }
  if (source.form === 'snapshot' || source.form === 'catalog') {
    return true;
  }
  return false;
}

export class SessionListener {
  private queue: IngestQueue;
  private cfg: PluginConfig;
  private ctx?: Context;
  // session_id -> Map<callId, toolName>
  private toolCallMaps = new Map<string, Map<string, string>>();
  // session_id -> turn count & event count (汲取自 dsh-expmem 上下文压力感知)
  private sessionTurnCounts = new Map<string, number>();
  private sessionEventCounts = new Map<string, number>();
  private pressureNotified = new Set<string>();

  constructor(queue: IngestQueue, cfg: PluginConfig = DEFAULTS, ctx?: Context) {
    this.queue = queue;
    this.cfg = cfg;
    this.ctx = ctx;
  }

  public handleEvent(session: any, event: any): void {
    if (!session || !event || typeof event !== 'object') return;
    if (!event.type || typeof event.seq !== 'number') return;

    // 1. 忽略列表直接跳过
    if (IGNORED_EVENT_TYPES.has(event.type)) return;

    // 2. 工作区排除检查 (DSH 真实 Session 路径位于 session.header.cwd)
    const cwd = session.cwd || session.header?.cwd || session.workspaceId || '';
    if (isWorkspaceExcluded(cwd, this.cfg.excludeWorkspaces)) {
      return;
    }
    const wsId = workspaceId(cwd);
    const sessionId = session.id || 'default_session';

    const time = typeof event.time === 'number' ? event.time : Date.now();
    const turn = typeof event.data?.turn === 'number' ? event.data.turn : null;

    // 3. 区分类型映射
    let role: 'user' | 'assistant' | 'tool' | 'system' | 'compaction' | null = null;
    let origin_kind: 'user' | 'assistant' | 'tool' | 'web' | 'system' = 'system';
    let tool_name: string | null = null;
    let is_error = 0;
    let rawText = '';

    if (event.type === 'user/message') {
      const source = event.data?.source;
      // Committed plugin messages update telemetry, but never become extraction evidence.
      if (source?.kind === 'plugin' && source?.plugin === 'dsh-memory') {
        const refs = MemoryRefsSchema.safeParse(source.memoryRefs);
        const metadata = source.memoryInjection;
        if (!refs.success) {
          console.warn('[dsh-memory] Committed memory message has invalid memoryRefs');
          return;
        }
        if (Number.isSafeInteger(metadata?.turn) && metadata.turn >= 0 &&
            Number.isSafeInteger(metadata?.strategyVersion) && metadata.strategyVersion >= 1 &&
            Array.isArray(metadata?.items) && metadata.items.length === refs.data.length &&
            metadata.items.every((item: any) => Number.isSafeInteger(item?.tokens) && item.tokens >= 0 &&
              (item.form === 'content' || item.form === 'summary'))) {
          this.queue.push({
            sessionId, time, turn: metadata.turn, strategyVersion: metadata.strategyVersion,
            items: refs.data.map((ref, index) => ({
              ref, rank: index + 1, tokens: metadata.items[index].tokens, form: metadata.items[index].form,
            })),
          });
        }
        return;
      }
      // DSH 自己的运行时快照 / 时间上下文 / 技能目录 / 后台任务快照不纳入原始记忆事件
      if (isIgnoredUserMessageSource(source)) {
        return;
      }

      role = 'user';
      // 只有真实用户消息才具备 origin_kind = 'user'
      origin_kind = source?.kind === 'user' ? 'user' : 'system';

      const content = event.data?.content;
      if (Array.isArray(content)) {
        rawText = content
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof event.data?.text === 'string') {
        rawText = event.data.text;
      }
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      origin_kind = 'assistant';

      const content = event.data?.message?.content || event.data?.content;
      if (Array.isArray(content)) {
        // 必须过滤掉 type === 'reasoning'
        rawText = content
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof event.data?.text === 'string') {
        rawText = event.data.text;
      }
    } else if (event.type === 'tool/call') {
      role = 'tool';
      origin_kind = 'tool';
      tool_name = event.data?.name || null;
      const callId = event.data?.callId;

      if (callId && tool_name) {
        let sMap = this.toolCallMaps.get(sessionId);
        if (!sMap) {
          sMap = new Map();
          this.toolCallMaps.set(sessionId, sMap);
        }
        sMap.set(callId, tool_name);
        // 防止单 session toolCallMap 无限膨胀
        if (sMap.size > 200) {
          const firstKey = sMap.keys().next().value;
          if (firstKey) sMap.delete(firstKey);
        }
      }

      if (typeof event.data?.arguments === 'string') {
        rawText = event.data.arguments;
      } else if (event.data?.arguments) {
        try {
          rawText = JSON.stringify(event.data.arguments);
        } catch {
          rawText = '';
        }
      }
    } else if (event.type === 'tool/result') {
      role = 'tool';
      origin_kind = 'tool';

      const callId =
        event.data?.toolCallId ||
        event.data?.message?.toolCallId ||
        event.data?.source?.callId;

      if (callId) {
        const sMap = this.toolCallMaps.get(sessionId);
        tool_name = (sMap && sMap.get(callId)) || event.data?.name || null;
      } else {
        tool_name = event.data?.name || null;
      }

      is_error =
        event.data?.isError ||
        event.data?.is_error ||
        event.data?.message?.isError ||
        event.data?.status === 'error'
          ? 1
          : 0;

      const content = event.data?.message?.content || event.data?.content;
      if (Array.isArray(content)) {
        rawText = content
          .filter((b: any) => b && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
      } else if (typeof event.data?.text === 'string') {
        rawText = event.data.text;
      }
    } else if (event.type.startsWith('compaction')) {
      role = 'compaction';
      origin_kind = 'system';
    } else {
      // 未关心的其它事件直接跳过
      return;
    }

    // 4. 隐私扫描脱敏与截断 (用户 2000 字符，其余 800 字符)
    const redacted = rawText ? redactSecrets(rawText).text : '';
    const maxLen = role === 'user' ? 2000 : 800;
    const finalText = redacted ? redacted.slice(0, maxLen) : null;

    const rawEvent: RawEvent = {
      session_id: sessionId,
      seq: event.seq,
      workspace_id: wsId,
      type: event.type,
      time,
      turn,
      role,
      origin_kind,
      tool_name,
      is_error,
      text: finalText,
      processed: 0,
    };

    this.queue.push(rawEvent);

    // 4. 上下文压力感知 (汲取自 creativedswork/dsh-expmem)
    if (turn !== null) {
      const prevTurn = this.sessionTurnCounts.get(sessionId) || 0;
      if (turn > prevTurn) this.sessionTurnCounts.set(sessionId, turn);
    }
    const eventCount = (this.sessionEventCounts.get(sessionId) || 0) + 1;
    this.sessionEventCounts.set(sessionId, eventCount);

    const currentTurn = this.sessionTurnCounts.get(sessionId) || 0;
    if ((currentTurn >= 15 || eventCount >= 40) && !this.pressureNotified.has(sessionId)) {
      this.pressureNotified.add(sessionId);
      if (this.ctx && typeof this.ctx.emit === 'function') {
        this.ctx.emit('memory/context-pressure', {
          sessionId,
          workspaceId: wsId,
          ...(cwd ? { cwd } : {}),
          turn: currentTurn,
          eventCount,
        });
      }
    }
  }
}

export function registerSessionListener(
  ctx: Context,
  queue: IngestQueue,
  cfg: PluginConfig = DEFAULTS
): () => void {
  const listener = new SessionListener(queue, cfg, ctx);
  return ctx.on('session/event', (session: any, event: any) => {
    listener.handleEvent(session, event);
  });
}
