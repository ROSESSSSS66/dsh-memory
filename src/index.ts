export { Config, apply, inject, name, default } from './dsh/plugin.js';
export { openDb } from './core/db.js';
export { autoBootstrapMemory } from './core/bootstrap.js';
export { weaveZettelkastenLinks, auditMemoryHealth, autoHealMemoryHealth } from './core/health.js';
export { stemToken, isTokenMatch } from './core/text.js';
export {
  primeRuntimeVectorCache,
  clearRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from './core/vector.js';
export { computeFanAttenuation } from './retrieval/channels.js';
export { computeActRBaseActivation } from './retrieval/fuse.js';
export { computeMmrMarginalScore } from './retrieval/governor.js';
export { JobRunner } from './jobs/runner.js';

// v0.10.0 Hindsight 4-Network Cognitive Reflection & Evolution APIs
export {
  DEFAULT_DISPOSITION,
  HINDSIGHT_NETWORK_TYPES,
  HINDSIGHT_NETWORK_LABELS,
  classifyHindsightNetwork,
  parseHindsightNetwork,
  computeNetworkIntentBonus,
  computeEvidenceCalibratedConfidence,
  runHindsightReflect,
  formatHindsightReflectReport,
  traceHindsightEvolution,
} from './core/hindsight.js';

// v0.10.0 OpenViking Virtual Context Filesystem & Tiered L0/L1/L2 APIs
export {
  VIKING_CATEGORY_DESCRIPTIONS,
  classifyVikingCategory,
  resolveVikingUri,
  resolveVikingUrisBatch,
  buildL0Abstract,
  buildInlineL1Overview,
  buildTieredMemoryView,
  normalizeVikingUriInput,
  resolveMemoryByVikingUriOrId,
  browseVikingDirectory,
  findInVikingTree,
  getVikingEvolutionDiff,
  formatVikingEvolutionDiff,
  exportVikingContextTree,
  importVikingContextTree,
  syncAutonomousVikingTree,
} from './core/viking.js';
