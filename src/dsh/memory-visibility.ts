// 命名空间导入：`import { z }` 会连带打入 zod 全部 locale（约 575KB），无法被 tree-shake
import * as z from 'zod';
import type { MemoryRef } from '../types.js';

export const MEMORY_VISIBILITY_KEY = 'dsh-memory.visibility';

export const MemoryRefItemSchema = z.object({
  id: z.string().regex(/^m_[a-z0-9_]{16,32}$/i),
  contentRev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const MemoryRefsSchema = z.array(MemoryRefItemSchema).min(1);

const StateSchema = z.object({
  visibleInjections: z.array(
    z.object({
      messageId: z.string().min(1),
      seq: z.number().int().nonnegative(),
      refs: MemoryRefsSchema,
    })
  ),
  invalidReferenceEvents: z.number().int().nonnegative(),
});

export type MemoryVisibilityState = z.infer<typeof StateSchema>;

const derivedRefsCache = new WeakMap<object, Set<string>>();
const validatedStateRefsCache = new WeakMap<object, Set<string> | null>();
const WARN_THROTTLE_MS = 60_000;

export function emptyMemoryVisibility(): MemoryVisibilityState {
  return { visibleInjections: [], invalidReferenceEvents: 0 };
}

const surfaceTypes = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/result',
]);

/** Fold committed surface events only. Compaction lifecycle events never remove visibility. */
export function foldMemoryVisibility(
  state: MemoryVisibilityState,
  event: any
): MemoryVisibilityState {
  if (!surfaceTypes.has(event?.type) || !Number.isSafeInteger(event.seq) || event.seq < 0)
    return state;
  let visible = state.visibleInjections;
  const op = event.surfaceOp;
  if (
    op?.op === 'replace' &&
    Number.isSafeInteger(op.startSeq) &&
    Number.isSafeInteger(op.endSeq) &&
    op.startSeq >= 0 &&
    op.startSeq <= op.endSeq &&
    Array.isArray(event.sourceEventSeqs)
  ) {
    const covered = new Set(
      event.sourceEventSeqs.filter((seq: unknown) => Number.isSafeInteger(seq))
    );
    visible = visible.filter(
      (entry) => !(entry.seq >= op.startSeq && entry.seq <= op.endSeq && covered.has(entry.seq))
    );
  }

  const source = event.data?.source;
  let invalidReferenceEvents = state.invalidReferenceEvents;
  const isDshMemory =
    source?.kind === 'dsh-memory' || (source?.kind === 'plugin' && source?.plugin === 'dsh-memory');
  if (event.type === 'user/message' && isDshMemory) {
    const rawRefs = source?.memoryRefs;
    if (
      typeof event.data?.id !== 'string' ||
      !event.data.id ||
      !Array.isArray(rawRefs) ||
      rawRefs.length === 0
    ) {
      invalidReferenceEvents++;
    } else {
      // 逐条校验 memoryRefs：单条坏引用仅累加计数，保留同批次其余合法引用
      const validRefs: MemoryRef[] = [];
      let invalidCount = 0;
      for (const rawItem of rawRefs) {
        const parsedItem = MemoryRefItemSchema.safeParse(rawItem);
        if (parsedItem.success) {
          validRefs.push(parsedItem.data);
        } else {
          invalidCount++;
        }
      }
      if (invalidCount > 0) {
        invalidReferenceEvents += invalidCount;
      }
      if (validRefs.length > 0 && !visible.some((entry) => entry.seq === event.seq)) {
        visible = [...visible, { messageId: event.data.id, seq: event.seq, refs: validRefs }];
      }
    }
  }
  if (
    visible === state.visibleInjections &&
    invalidReferenceEvents === state.invalidReferenceEvents
  )
    return state;
  return { visibleInjections: visible, invalidReferenceEvents };
}

export function visibleMemoryRefs(state: MemoryVisibilityState): Set<string> {
  if (state && typeof state === 'object') {
    const cached = derivedRefsCache.get(state);
    if (cached) return cached;
  }
  const refs = new Set<string>();
  for (const entry of state.visibleInjections) {
    for (const ref of entry.refs) {
      refs.add(`${ref.id}@${ref.contentRev}`);
    }
  }
  if (state && typeof state === 'object') {
    derivedRefsCache.set(state, refs);
  }
  return refs;
}

export const memoryVisibilityProjection = {
  key: MEMORY_VISIBILITY_KEY,
  stateVersion: 2,
  stateSchema: StateSchema,
  schema: StateSchema,
  init: emptyMemoryVisibility,
  apply: foldMemoryVisibility,
  view: (state: MemoryVisibilityState) => state,
};

export interface MemoryVisibilityReader {
  getVisibleRefs(session: any): Set<string> | null;
  dispose(): void;
}

/** Support both the stateOf API and the earlier snapshot API with O(1) WeakMap caching. */
export async function registerMemoryVisibility(ctx: any): Promise<MemoryVisibilityReader> {
  const unavailable: MemoryVisibilityReader = { getVisibleRefs: () => null, dispose: () => {} };
  if (!ctx?.sessionProjections?.register) return unavailable;
  try {
    const registration = await ctx.sessionProjections.register(memoryVisibilityProjection);
    let lastWarnAt = 0;
    return {
      getVisibleRefs(session) {
        if (!session) return null;
        try {
          let state: unknown;
          if (typeof registration?.stateOf === 'function') {
            state = registration.stateOf(session);
          } else if (typeof ctx.sessionProjections?.stateOf === 'function') {
            state = ctx.sessionProjections.stateOf(session, MEMORY_VISIBILITY_KEY);
          } else if (typeof ctx.sessionProjections?.snapshot === 'function') {
            state = ctx.sessionProjections.snapshot(session)?.values?.[MEMORY_VISIBILITY_KEY];
          } else {
            return null;
          }

          if (!state || typeof state !== 'object') return null;
          const cached = validatedStateRefsCache.get(state);
          if (cached !== undefined) return cached;

          const parsed = StateSchema.safeParse(state);
          const result = parsed.success ? visibleMemoryRefs(parsed.data) : null;
          validatedStateRefsCache.set(state, result);
          return result;
        } catch (err: any) {
          const now = Date.now();
          if (now - lastWarnAt >= WARN_THROTTLE_MS) {
            lastWarnAt = now;
            console.warn(
              '[dsh-memory] Failed to read memory visibility projection:',
              err?.message || err
            );
          }
          return null;
        }
      },
      dispose() {
        if (typeof registration === 'function') registration();
        else registration?.dispose?.();
      },
    };
  } catch (err: any) {
    console.warn('[dsh-memory] Memory visibility registration failed:', err?.message || err);
    return unavailable;
  }
}

export interface CommittedInjection {
  sessionId: string;
  turn: number;
  time: number;
  strategyVersion: number;
  items: Array<{ ref: MemoryRef; rank: number; tokens: number; form: 'content' | 'summary' }>;
}
