export {
  WorkspaceExcludedError,
  resolveScopedContext,
  assertWorkspaceAllowed,
  expandExcludedWorkspaceIds,
  listActiveWorkspaces,
  type ResolvedScope,
  type ActiveWorkspaceInfo,
  type ResolveScopeOptions,
} from './scope-guard.js';

export {
  VALID_MEMORY_TYPES,
  VALID_SCOPES,
  normalizeMemoryType,
  editMemoryRecord,
  forgetWithTrash,
  getMemoryDetail,
  importJsonMemories,
  queryInjectionTelemetry7d,
  stripMemoryForApi,
  type EditMemoryRecordOptions,
  type ForgetWithTrashOptions,
  type ForgetWithTrashResult,
  type MemoryVersionEntry,
  type MemoryRelationDetail,
  type GetMemoryDetailOptions,
  type MemoryDetailResult,
  type ImportJsonMemoriesOptions,
  type ImportJsonMemoriesResult,
  type InjectionTelemetry7d,
  type QueryTelemetryOptions,
  type ApiMemoryRecord,
} from './memory-service.js';

export {
  runUnifiedMaintenance,
  type UnifiedMaintenanceOptions,
  type UnifiedMaintenanceResult,
} from './maintenance-service.js';

export {
  probeOfflineLLM,
  resetLlmProbeRateLimit,
  type LlmProbeRequest,
  type LlmProbeResult,
  type LlmProbeOptions,
} from './llm-probe.js';
