import { DEFAULTS, type PluginConfig } from '../config.js';
import { redactSecrets } from '../core/privacy.js';
import { extractToolCallId, extractToolResultCallId } from '../ingest/backfill.js';
import type { IngestQueue } from '../ingest/queue.js';
import type { Context, Db, RawEvent } from '../types.js';
import { MemoryRefsSchema } from './memory-visibility.js';
import {
  extractSessionCwd,
  isWorkspaceOrMappedExcluded,
  observeWorkspacePath,
  resolveSessionWorkspaceId,
} from './scope-resolver.js';

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
  'command/run',
  'command/done',
  'assistant/attempt',
]);

export const IGNORED_USER_SOURCE_KINDS = new Set([
  'runtime-context',
  'time-context',
  'skill-catalog',
  'tool-jobs',
  'tool-registry',
]);

export const SELF_MEMORY_TOOL_NAMES = new Set([
  'memory',
  'memory_search',
  'memory_expand',
  'memory_feedback',
  'memory_note',
  'memory_confirm',
  'memory_merge',
  'memory_core',
]);

const MAX_TRACKED_SESSIONS = 200;
const MAX_TOOL_CALLS_PER_SESSION = 200;
const PRESSURE_TURN_THRESHOLD = 15;
const PRESSURE_EVENT_THRESHOLD = 40;
const PRESSURE_RETRIGGER_STEP = 40;
const MAX_PEM_TAIL_EXTENSION = 8192;

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

function touchLru<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
}

/**
 * 在调用 redactSecrets 之前将原始长文本限制在有界窗口内（避免多 MB 工具输出阻塞事件循环），
 * 同时检测并保护起始于窗口内的 PEM 私钥块尾部，确保完整命中脱敏规则。
 */
function boundRawTextForRedaction(rawText: string, maxLen: number): string {
  const capWindow = maxLen * 4;
  if (rawText.length <= capWindow) return rawText;

  const head = rawText.slice(0, capWindow);
  const pemStart = head.lastIndexOf('-----BEGIN ');
  if (pemStart >= 0 && head.indexOf('-----END ', pemStart) < 0) {
    const pemEnd = rawText.indexOf('-----END ', capWindow);
    if (pemEnd >= 0) {
      const lineEnd = rawText.indexOf('\n', pemEnd);
      const sliceEnd =
        lineEnd >= 0
          ? Math.min(lineEnd + 1, capWindow + MAX_PEM_TAIL_EXTENSION)
          : Math.min(pemEnd + 64, capWindow + MAX_PEM_TAIL_EXTENSION);
      return rawText.slice(0, sliceEnd);
    }
    return `${head}\n-----END PRIVATE KEY-----`;
  }
  return head;
}

/**
 * 截断脱敏文本至 maxLen，避免把 `[REDACTED:...]` 占位符从中劈断
 */
function sliceWithoutBisectingRedaction(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const candidate = text.slice(0, maxLen);
  const lastOpen = candidate.lastIndexOf('[REDACTED:');
  if (lastOpen >= 0) {
    const closeAfter = candidate.indexOf(']', lastOpen);
    if (closeAfter < 0) {
      return candidate.slice(0, lastOpen).trimEnd();
    }
  }
  return candidate;
}

function extractTextFromContent(content: unknown, fallbackText: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  if (typeof content === 'string') {
    return content;
  }
  if (typeof fallbackText === 'string') {
    return fallbackText;
  }
  return '';
}

export class SessionListener {
  private queue: IngestQueue;
  private cfg: PluginConfig;
  private getCfg?: () => PluginConfig;
  private ctx?: Context;
  private db?: Db;
  // session_id -> Map<callId, toolName>
  private toolCallMaps = new Map<string, Map<string, string>>();
  // session_id -> current active turn tracked from turn/start & step/start
  private currentTurnBySession = new Map<string, number>();
  // session_id -> max observed turn & event count (上下文压力感知)
  private sessionTurnCounts = new Map<string, number>();
  private sessionEventCounts = new Map<string, number>();
  // session_id -> last eventCount at which context-pressure was emitted (0 means not yet emitted)
  private pressureLastEventCount = new Map<string, number>();

  constructor(
    queue: IngestQueue,
    cfg: PluginConfig | (() => PluginConfig) = DEFAULTS,
    ctx?: Context,
    db?: Db
  ) {
    this.queue = queue;
    if (typeof cfg === 'function') {
      this.getCfg = cfg;
      this.cfg = DEFAULTS;
    } else {
      this.cfg = cfg || DEFAULTS;
    }
    this.ctx = ctx;
    this.db = db;
  }

  private currentCfg(): PluginConfig {
    return this.getCfg ? this.getCfg() : this.cfg;
  }

  private evictIfNeeded(activeSessionId: string): void {
    const checkEvict = (primary: Map<string, unknown>) => {
      while (primary.size > MAX_TRACKED_SESSIONS) {
        let evicted = false;
        for (const key of primary.keys()) {
          if (key !== activeSessionId) {
            this.sessionEventCounts.delete(key);
            this.sessionTurnCounts.delete(key);
            this.currentTurnBySession.delete(key);
            this.toolCallMaps.delete(key);
            this.pressureLastEventCount.delete(key);
            evicted = true;
            break;
          }
        }
        if (!evicted) break;
      }
    };
    checkEvict(this.sessionEventCounts);
    checkEvict(this.currentTurnBySession);
  }

  public handleEvent(session: any, event: any): void {
    if (!session || !event || typeof event !== 'object') return;
    if (!event.type || typeof event.seq !== 'number') return;

    // 1. 忽略列表直接跳过
    if (IGNORED_EVENT_TYPES.has(event.type)) return;

    const liveCfg = this.currentCfg();
    const sessionId =
      typeof session.id === 'string' && session.id.trim() ? session.id.trim() : 'default_session';

    // 2. 跟踪 turn/start 与 step/start 轮次号（不落库 raw_events），解决 DSH user/message 缺失 data.turn 的问题
    if (event.type === 'turn/start' || event.type === 'step/start') {
      const explicitTurn =
        typeof event.data?.turn === 'number' && Number.isFinite(event.data.turn)
          ? event.data.turn
          : typeof event.turn === 'number' && Number.isFinite(event.turn)
            ? event.turn
            : null;
      if (explicitTurn !== null) {
        touchLru(this.currentTurnBySession, sessionId, explicitTurn);
        this.evictIfNeeded(sessionId);
      } else if (event.type === 'turn/start') {
        const nextTurn = (this.currentTurnBySession.get(sessionId) ?? 0) + 1;
        touchLru(this.currentTurnBySession, sessionId, nextTurn);
        this.evictIfNeeded(sessionId);
      }
      return;
    }

    // 3. 工作区解析与排除检查 (DSH 真实 Session 路径位于 session.header.cwd)
    const directCwd = extractSessionCwd(session);
    const effectiveWorkspace =
      directCwd ||
      (sessionId !== 'default_session' ? resolveSessionWorkspaceId(this.db, sessionId) : '');

    if (
      effectiveWorkspace &&
      isWorkspaceOrMappedExcluded(effectiveWorkspace, liveCfg.excludeWorkspaces, this.db)
    ) {
      return;
    }

    const wsId = effectiveWorkspace ? observeWorkspacePath(this.db, effectiveWorkspace) : '';
    const time = typeof event.time === 'number' ? event.time : Date.now();
    const explicitDataTurn =
      typeof event.data?.turn === 'number' && Number.isFinite(event.data.turn)
        ? event.data.turn
        : null;
    if (explicitDataTurn !== null) {
      const prevTracked = this.currentTurnBySession.get(sessionId);
      if (prevTracked === undefined || explicitDataTurn >= prevTracked) {
        touchLru(this.currentTurnBySession, sessionId, explicitDataTurn);
      }
    }
    const turn = explicitDataTurn ?? this.currentTurnBySession.get(sessionId) ?? null;

    // 4. 区分类型映射
    let role: 'user' | 'assistant' | 'tool' | 'system' | 'compaction' | null = null;
    let origin_kind: 'user' | 'assistant' | 'tool' | 'web' | 'system' = 'system';
    let tool_name: string | null = null;
    let is_error = 0;
    let rawText = '';

    if (event.type === 'user/message') {
      const source = event.data?.source;
      // Committed plugin messages update telemetry, but never become extraction evidence.
      const isDshMemory =
        source?.kind === 'dsh-memory' ||
        (source?.kind === 'plugin' && source?.plugin === 'dsh-memory');
      if (isDshMemory) {
        const refs = MemoryRefsSchema.safeParse(source.memoryRefs);
        const metadata = source.memoryInjection;
        if (!refs.success) {
          console.warn('[dsh-memory] Committed memory message has invalid memoryRefs');
          return;
        }
        if (
          Number.isSafeInteger(metadata?.turn) &&
          metadata.turn >= 0 &&
          Number.isSafeInteger(metadata?.strategyVersion) &&
          metadata.strategyVersion >= 1 &&
          Array.isArray(metadata?.items) &&
          metadata.items.length === refs.data.length &&
          metadata.items.every(
            (item: any) =>
              Number.isSafeInteger(item?.tokens) &&
              item.tokens >= 0 &&
              (item.form === 'content' || item.form === 'summary')
          )
        ) {
          this.queue.push({
            sessionId,
            time,
            turn: metadata.turn,
            strategyVersion: metadata.strategyVersion,
            items: refs.data.map((ref, index) => ({
              ref,
              rank: index + 1,
              tokens: metadata.items[index].tokens,
              form: metadata.items[index].form,
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
      origin_kind = source?.kind === 'user' ? 'user' : 'system';
      rawText = extractTextFromContent(event.data?.content, event.data?.text);
    } else if (event.type === 'assistant/message') {
      role = 'assistant';
      origin_kind = 'assistant';
      const content = event.data?.message?.content ?? event.data?.content;
      rawText = extractTextFromContent(content, event.data?.text);
    } else if (event.type === 'tool/call') {
      role = 'tool';
      origin_kind = 'tool';
      tool_name =
        typeof event.data?.name === 'string' && event.data.name.trim()
          ? event.data.name.trim()
          : null;
      const callId = extractToolCallId(event.data);

      if (callId && tool_name) {
        let sMap = this.toolCallMaps.get(sessionId);
        if (!sMap) {
          sMap = new Map();
          this.toolCallMaps.set(sessionId, sMap);
        }
        touchLru(sMap, callId, tool_name);
        if (sMap.size > MAX_TOOL_CALLS_PER_SESSION) {
          const firstKey = sMap.keys().next().value;
          if (firstKey !== undefined) sMap.delete(firstKey);
        }
      }

      // 跳过 dsh-memory 自身工具调用（已先登记 callId -> tool_name 以屏蔽对应 tool/result 回声）
      if (tool_name && SELF_MEMORY_TOOL_NAMES.has(tool_name)) {
        return;
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

      const callId = extractToolResultCallId(event.data);
      const fallbackName =
        typeof event.data?.name === 'string' && event.data.name.trim()
          ? event.data.name.trim()
          : null;

      if (callId) {
        const sMap = this.toolCallMaps.get(sessionId);
        const mapped = sMap?.get(callId);
        if (mapped) {
          tool_name = mapped;
          sMap!.delete(callId);
        } else {
          tool_name = fallbackName;
        }
      } else {
        tool_name = fallbackName;
      }

      // 跳过 dsh-memory 自身工具返回结果，防止记忆回声循环污染 raw_events
      if (tool_name && SELF_MEMORY_TOOL_NAMES.has(tool_name)) {
        return;
      }

      is_error =
        event.data?.isError ||
        event.data?.is_error ||
        event.data?.message?.isError ||
        event.data?.status === 'error'
          ? 1
          : 0;

      const content = event.data?.message?.content ?? event.data?.content;
      rawText = extractTextFromContent(content, event.data?.text);
    } else if (event.type.startsWith('compaction')) {
      role = 'compaction';
      origin_kind = 'system';
    } else {
      return;
    }

    // 5. 先限制窗口大小再执行隐私扫描脱敏，并防止截断劈断 [REDACTED:...]
    const maxLen = role === 'user' ? 2000 : 800;
    const boundedRaw = rawText ? boundRawTextForRedaction(rawText, maxLen) : '';
    const redacted = boundedRaw ? redactSecrets(boundedRaw).text : '';
    const finalText = redacted ? sliceWithoutBisectingRedaction(redacted, maxLen) : null;

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

    // compaction 心跳事件不计入上下文压力事件计数
    if (role === 'compaction') {
      return;
    }

    // 6. 上下文压力感知 (真 LRU 淘汰 + 每 +40 事件再次触发 + 异步微任务派发)
    if (turn !== null) {
      const prevTurn = this.sessionTurnCounts.get(sessionId) || 0;
      if (turn > prevTurn) {
        touchLru(this.sessionTurnCounts, sessionId, turn);
      }
    }
    const eventCount = (this.sessionEventCounts.get(sessionId) || 0) + 1;
    touchLru(this.sessionEventCounts, sessionId, eventCount);
    this.evictIfNeeded(sessionId);

    const currentTurn = this.sessionTurnCounts.get(sessionId) || 0;
    const lastNotifiedAtCount = this.pressureLastEventCount.get(sessionId) || 0;
    const shouldEmitPressure =
      lastNotifiedAtCount === 0
        ? currentTurn >= PRESSURE_TURN_THRESHOLD || eventCount >= PRESSURE_EVENT_THRESHOLD
        : eventCount >= lastNotifiedAtCount + PRESSURE_RETRIGGER_STEP;

    if (shouldEmitPressure) {
      touchLru(this.pressureLastEventCount, sessionId, eventCount);
      const emitCtx = this.ctx;
      if (emitCtx && typeof emitCtx.emit === 'function') {
        const pressurePayload = {
          sessionId,
          workspaceId: wsId,
          ...(directCwd ? { cwd: directCwd } : {}),
          turn: currentTurn,
          eventCount,
        };
        queueMicrotask(() => {
          try {
            emitCtx.emit('memory/context-pressure', pressurePayload);
          } catch {}
        });
      }
    }
  }
}

export function registerSessionListener(
  ctx: Context,
  queue: IngestQueue,
  cfg: PluginConfig | (() => PluginConfig) = DEFAULTS,
  db?: Db
): () => void {
  const listener = new SessionListener(queue, cfg, ctx, db);
  return ctx.on('session/event', (session: any, event: any) => {
    listener.handleEvent(session, event);
  });
}
