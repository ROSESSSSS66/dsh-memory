import type { Db, MemoryRecord } from '../types.js';

/** Model confidence and model confirmation counts are not independent evidence. */
export function hasUserEvidence(db: Db, memory: MemoryRecord): boolean {
  return !!db.get(
    `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ?
     AND kind IN ('user', 'user_msg') LIMIT 1`,
    [memory.id, memory.content_rev]
  );
}
