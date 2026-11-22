export {
  auditMemoryHealth,
  normSlot,
  type AuditMemoryHealthOptions,
  type MemoryHealthReport,
  type DuplicatePairItem,
  type DuplicatePair,
  type ContradictionItem,
  type StaleMemoryItem,
} from './health/audit.js';

export {
  weaveZettelkastenLinks,
  areScopesCompatibleForWeaving,
  type WeaveOptions,
  type WeaveResult,
} from './health/zettelkasten.js';

export {
  autoHealMemoryHealth,
  type AutoHealOptions,
  type AutoHealResult,
} from './health/auto-heal.js';

export {
  syncAutonomousCoreMemory,
  type CoreSyncOptions,
  type CoreSyncResult,
} from './health/core-sync.js';
