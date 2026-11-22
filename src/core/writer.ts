export {
  generateId,
  truncateCodePoints,
  truncateToTokens,
  truncateExcerpt,
  type WriterLimits,
} from './writer/validate.js';

export {
  findActiveSlotOccupant,
  supersedeActiveSlot,
  type SupersedeSlotParams,
  type SupersedeSlotResult,
} from './writer/slot-policy.js';

export {
  upsertCandidate,
  addRelation,
  saveVersionSnapshot,
} from './writer/persistence.js';

export {
  approveCandidate,
  editContent,
  editMemory,
  rollback,
  forget,
  freeze,
  unfreeze,
  pin,
  unpin,
  applyUtility,
  confirmMemory,
  mergeMemories,
  restoreMemory,
  invalidateMemory,
  type EditMemoryPatch,
  type EditMemoryResult,
} from './writer/lifecycle.js';
