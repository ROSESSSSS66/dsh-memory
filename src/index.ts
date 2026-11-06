export { Config, apply, inject, name, default } from './dsh/plugin.js';
export { openDb } from './core/db.js';
export { autoBootstrapMemory } from './core/bootstrap.js';
export { weaveZettelkastenLinks, auditMemoryHealth, autoHealMemoryHealth } from './core/health.js';
export { computeFanAttenuation } from './retrieval/channels.js';
export { computeActRBaseActivation } from './retrieval/fuse.js';
