// 命名空间导入：`import { z }` 会连带打入 zod 全部 locale（约 575KB），无法被 tree-shake
import * as z from 'zod';
import type { MemoryRef } from '../types.js';

export const MEMORY_VISIBILITY_KEY = 'dsh-memory.visibility';

export const MemoryRefsSchema = z.array(z.object({
  id: z.string().regex(/^m_[a-z0-9_]{16,32}$/i),
  contentRev: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})).min(1);

const StateSchema = z.object({
  visibleInjections: z.array(z.object({
    messageId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    refs: MemoryRefsSchema,
  })),
  invalidReferenceEvents: z.number().int().nonnegative(),
});

export type MemoryVisibilityState = z.infer<typeof StateSchema>;

export function emptyMemoryVisibility(): MemoryVisibilityState {
  return { visibleInjections: [], invalidReferenceEvents: 0 };
}

const surfaceTypes = new Set([
  'user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result',
]);

/** Fold committed surface events only. Compaction lifecycle events never remove visibility. */
export function foldMemoryVisibility(state: MemoryVisibilityState, event: any): MemoryVisibilityState {
  if (!surfaceTypes.has(event?.type) || !Number.isSafeInteger(event.seq) || event.seq < 0) return state;
  let visible = state.visibleInjections;
  const op = event.surfaceOp;
  if (op?.op === 'replace' && Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq) &&
      op.startSeq >= 0 && op.startSeq <= op.endSeq && Array.isArray(event.sourceEventSeqs)) {
    const covered = new Set(event.sourceEventSeqs.filter((seq: unknown) => Number.isSafeInteger(seq)));
    visible = visible.filter(entry =>
      !(entry.seq >= op.startSeq && entry.seq <= op.endSeq && covered.has(entry.seq))
    );
  }

  const source = event.data?.source;
  let invalidReferenceEvents = state.invalidReferenceEvents;
  const isDshMemory = source?.kind === 'dsh-memory' || (source?.kind === 'plugin' && source?.plugin === 'dsh-memory');
  if (event.type === 'user/message' && isDshMemory) {
    const refs = MemoryRefsSchema.safeParse(source.memoryRefs);
    if (!refs.success || typeof event.data.id !== 'string' || !event.data.id) {
      invalidReferenceEvents++;
    } else if (!visible.some(entry => entry.seq === event.seq)) {
      visible = [...visible, { messageId: event.data.id, seq: event.seq, refs: refs.data }];
    }
  }
  if (visible === state.visibleInjections && invalidReferenceEvents === state.invalidReferenceEvents) return state;
  return { visibleInjections: visible, invalidReferenceEvents };
}

export function visibleMemoryRefs(state: MemoryVisibilityState): Set<string> {
  return new Set(state.visibleInjections.flatMap(entry => entry.refs.map(ref => `${ref.id}@${ref.contentRev}`)));
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

/** Support both the stateOf API and the earlier snapshot API. */
export async function registerMemoryVisibility(ctx: any): Promise<MemoryVisibilityReader> {
  const unavailable: MemoryVisibilityReader = { getVisibleRefs: () => null, dispose: () => {} };
  if (!ctx.sessionProjections?.register) return unavailable;
  try {
    const registration = await ctx.sessionProjections.register(memoryVisibilityProjection);
    return {
      getVisibleRefs(session) {
        if (!session) return null;
        const state = typeof registration?.stateOf === 'function'
          ? registration.stateOf(session)
          : typeof ctx.sessionProjections.stateOf === 'function'
            ? ctx.sessionProjections.stateOf(session, MEMORY_VISIBILITY_KEY)
            : ctx.sessionProjections.snapshot(session)?.values?.[MEMORY_VISIBILITY_KEY];
        const parsed = StateSchema.safeParse(state);
        return parsed.success ? visibleMemoryRefs(parsed.data) : null;
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
