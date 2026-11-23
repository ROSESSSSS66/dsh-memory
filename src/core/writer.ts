export {
  applyUtility,
  approveCandidate,
  confirmMemory,
  type EditMemoryPatch,
  type EditMemoryResult,
  editContent,
  editMemory,
  forget,
  freeze,
  invalidateMemory,
  mergeMemories,
  pin,
  restoreMemory,
  rollback,
  unfreeze,
  unpin,
} from './writer/lifecycle.js';
export {
  addRelation,
  saveVersionSnapshot,
  upsertCandidate,
} from './writer/persistence.js';
export {
  findActiveSlotOccupant,
  type SupersedeSlotParams,
  type SupersedeSlotResult,
  supersedeActiveSlot,
} from './writer/slot-policy.js';
export {
  generateId,
  truncateCodePoints,
  truncateExcerpt,
  truncateToTokens,
  type WriterLimits,
} from './writer/validate.js';
