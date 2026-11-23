import { hasUserEvidence } from '../core/trust.js';
import { type Db, hydrateMemoryRow, type MemoryRecord, type MemoryRow } from '../types.js';

/**
 * 模型发起的 discard / supersede / 原地 curate 均不得修改或淘汰以下受保护记忆：
 * - frozen 或 pinned 记忆
 * - 用户/系统已确认或带有干净用户证据的 active 记忆
 * （与 reconciler 的 isTrustedReconcileInput 保持同一信任边界；candidate 与无用户证据记忆仍可治理）
 */
export function isProtectedFromModelDiscard(db: Db, memory: MemoryRecord): boolean {
  if (memory.status === 'frozen' || memory.pinned === 1) {
    return true;
  }
  return (
    memory.status === 'active' &&
    (memory.approved_by === 'user' ||
      memory.approved_by === 'system' ||
      hasUserEvidence(db, memory))
  );
}

export function sameMemoryOwner(a: MemoryRecord, b: MemoryRecord): boolean {
  return (
    a.scope === b.scope &&
    (a.workspace_id || '') === (b.workspace_id || '') &&
    (a.session_id || '') === (b.session_id || '')
  );
}

/** Must be called inside the write transaction, after the asynchronous model request. */
export function getUnchangedReviewedMemory(
  db: Db,
  reviewed: Map<string, MemoryRecord>,
  id: string
): MemoryRecord | undefined {
  const snapshot = reviewed.get(id);
  if (!snapshot) return undefined;
  const current = hydrateMemoryRow(db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]));
  if (!current || current.pinned || !['active', 'candidate'].includes(current.status)) {
    return undefined;
  }
  if (
    !sameMemoryOwner(current, snapshot) ||
    current.version !== snapshot.version ||
    current.content_rev !== snapshot.content_rev ||
    current.hash !== snapshot.hash ||
    current.status !== snapshot.status ||
    current.updated_at !== snapshot.updated_at ||
    current.type !== snapshot.type ||
    (current.slot_key ?? null) !== (snapshot.slot_key ?? null) ||
    (current.approved_by ?? null) !== (snapshot.approved_by ?? null) ||
    (current.approved_at ?? null) !== (snapshot.approved_at ?? null) ||
    current.content !== snapshot.content ||
    current.summary !== snapshot.summary
  ) {
    return undefined;
  }
  return current;
}
