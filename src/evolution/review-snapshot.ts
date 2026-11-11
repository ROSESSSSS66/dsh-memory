import type { Db, MemoryRecord } from '../types.js';

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
