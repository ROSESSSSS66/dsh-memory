import type { Db, MemoryRecord } from '../types.js';
import { hasUserEvidence } from '../core/trust.js';

/**
 * 模型的 discard 指令不附带任何证据，因此不得归档用户确认过或有用户证据支撑的生效记忆
 * （与 reconciler 的 isTrustedReconcileInput 同一条边界）；candidate 与无用户证据的记忆仍可淘汰。
 */
export function isProtectedFromModelDiscard(db: Db, memory: MemoryRecord): boolean {
  return memory.status === 'active' && (memory.approved_by === 'user' || hasUserEvidence(db, memory));
}

export function sameMemoryOwner(a: MemoryRecord, b: MemoryRecord): boolean {
  return a.scope === b.scope &&
    (a.workspace_id || '') === (b.workspace_id || '') &&
    (a.session_id || '') === (b.session_id || '');
}

/** Must be called inside the write transaction, after the asynchronous model request. */
export function getUnchangedReviewedMemory(
  db: Db,
  reviewed: Map<string, MemoryRecord>,
  id: string
): MemoryRecord | undefined {
  const snapshot = reviewed.get(id);
  if (!snapshot) return undefined;
  const current = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
  if (!current || current.pinned || !['active', 'candidate'].includes(current.status)) return undefined;
  if (!sameMemoryOwner(current, snapshot) ||
      current.version !== snapshot.version || current.content_rev !== snapshot.content_rev ||
      current.hash !== snapshot.hash || current.status !== snapshot.status ||
      current.updated_at !== snapshot.updated_at || current.type !== snapshot.type ||
      current.slot_key !== snapshot.slot_key ||
      current.content !== snapshot.content || current.summary !== snapshot.summary) return undefined;
  return current;
}
