export { autoBootstrapMemory } from './core/bootstrap.js';
export { openDb } from './core/db.js';
export { auditMemoryHealth, autoHealMemoryHealth, weaveZettelkastenLinks } from './core/health.js';
// v0.10.0 Hindsight 4-Network Cognitive Reflection & Evolution APIs
export {
  classifyHindsightNetwork,
  computeEvidenceCalibratedConfidence,
  computeNetworkIntentBonus,
  DEFAULT_DISPOSITION,
  formatHindsightReflectReport,
  HINDSIGHT_NETWORK_LABELS,
  HINDSIGHT_NETWORK_TYPES,
  parseHindsightNetwork,
  runHindsightReflect,
  traceHindsightEvolution,
} from './core/hindsight.js';
export { isTokenMatch, stemToken } from './core/text.js';
export {
  clearRuntimeVectorCache,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from './core/vector.js';
// v0.10.0 OpenViking Virtual Context Filesystem & Tiered L0/L1/L2 APIs
export {
  browseVikingDirectory,
  buildInlineL1Overview,
  buildL0Abstract,
  buildTieredMemoryView,
  classifyVikingCategory,
  exportVikingContextTree,
  findInVikingTree,
  formatVikingEvolutionDiff,
  getVikingEvolutionDiff,
  importVikingContextTree,
  normalizeVikingUriInput,
  resolveMemoryByVikingUriOrId,
  resolveVikingUri,
  resolveVikingUrisBatch,
  syncAutonomousVikingTree,
  VIKING_CATEGORY_DESCRIPTIONS,
} from './core/viking.js';
export { apply, Config, default, inject, name } from './dsh/plugin.js';
export { JobRunner } from './jobs/runner.js';
export { computeFanAttenuation } from './retrieval/channels.js';
export { computeActRBaseActivation } from './retrieval/fuse.js';
export { computeMmrMarginalScore } from './retrieval/governor.js';
