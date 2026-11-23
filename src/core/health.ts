export {
  type AuditMemoryHealthOptions,
  auditMemoryHealth,
  type ContradictionItem,
  type DuplicatePair,
  type DuplicatePairItem,
  type MemoryHealthReport,
  normSlot,
  type StaleMemoryItem,
} from './health/audit.js';
export {
  type AutoHealOptions,
  type AutoHealResult,
  autoHealMemoryHealth,
} from './health/auto-heal.js';
export {
  type CoreSyncOptions,
  type CoreSyncResult,
  syncAutonomousCoreMemory,
} from './health/core-sync.js';
export {
  areScopesCompatibleForWeaving,
  type WeaveOptions,
  type WeaveResult,
  weaveZettelkastenLinks,
} from './health/zettelkasten.js';
