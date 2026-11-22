export type UiLocale = 'zh' | 'en';

export type LLMProtocolType = 'chat/completions' | 'responses' | 'messages';

export type EmbeddingProviderType = 'none' | 'openai-compatible';

export interface EmbeddingConfigData {
  provider: EmbeddingProviderType;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  apiKeyMasked?: string;
  hasApiKey?: boolean;
  dim: number;
  batchSize?: number;
  timeoutMs?: number;
}

export interface LLMConfigData {
  offlineLLM: {
    useDshLlm: boolean;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKeyMasked: string;
    hasApiKey: boolean;
    protocol?: LLMProtocolType;
  };
  privacy: {
    offlineConsent: boolean;
    allowedOfflineEndpoints: string[];
  };
  embedding?: EmbeddingConfigData;
  dailyLLMCalls: number;
  dailyLLMTokens: number;
  distillMaxInputTokens?: number;
}

export interface ConfigSavePayload {
  offlineLLM?: {
    useDshLlm: boolean;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKey?: string;
    clearApiKey?: boolean;
    protocol: LLMProtocolType;
  };
  privacy?: {
    offlineConsent: boolean;
  };
  embedding?: {
    provider: EmbeddingProviderType;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKey?: string;
    clearApiKey?: boolean;
    dim: number;
  };
  dailyLLMCalls?: number;
  dailyLLMTokens?: number;
  distillMaxInputTokens?: number;
}

export interface LLMTestPayload {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  protocol?: LLMProtocolType;
  useDshLlm?: boolean;
}

export interface LLMTestResult {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  error?: string;
  model?: string;
  protocol?: string;
}

export interface OverviewStatsData {
  stats: {
    total: number;
    active: number;
    candidate: number;
    superseded: number;
    archived: number;
    frozen?: number;
    byStatus?: Record<string, number>;
    byType: Record<string, number>;
  };
  dynamicBudgetTokens: number;
  stableBudgetTokens?: number;
  stableLayerTokens?: number;
  hardBudgetTokens?: number;
  pendingRepairsCount?: number;
  activeStrategyVersion?: number;
  coreMemoryCount?: number;
  ledger: {
    callsToday: number;
    tokensToday: number;
    maxDailyCalls: number;
    maxDailyTokens: number;
  };
  recentTelemetry: {
    injectionCount: number;
    avgTokens: number;
    correctionRate: number;
  };
}

export interface MemoryItem {
  id: string;
  type: string;
  status: string;
  content: string;
  summary: string;
  slot_key?: string | null;
  scope: string;
  workspace_id?: string | null;
  source_kind: string;
  confidence: number;
  utility: number;
  importance?: number;
  use_count: number;
  success_count?: number;
  fail_count?: number;
  token_cost: number;
  version: number;
  content_rev: number;
  pinned: number;
  created_at: number;
  updated_at: number;
  last_used_at?: number | null;
  vikingUri?: string;
  hindsightNetwork?: string;
}

export interface CoreMemoryBlock {
  block: string;
  id: string;
  content: string;
  updated_at?: number;
  version: number;
  tokens: number;
}

export interface JobLogItem {
  id: number;
  kind: string;
  key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface MemoryHealthReportData {
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  counts: {
    total: number;
    active: number;
    candidate: number;
    frozen: number;
    superseded: number;
    archived: number;
    pinned: number;
  };
  ftsConsistent: boolean;
  ftsCount: number;
  missingEmbeddingsCount?: number;
  embeddingsReadyCount?: number;
  orphanMemoriesCount?: number;
  duplicatePairs: Array<{
    sourceId: string;
    targetId: string;
    sourceSummary: string;
    targetSummary: string;
    similarity: number;
    slotKey: string | null;
    reason: 'same_slot_key' | 'high_lexical_overlap' | 'high_semantic_overlap';
  }>;
  contradictions: Array<{
    fromId: string;
    toId: string;
    fromSummary: string;
    toSummary: string;
  }>;
  staleMemories: Array<{
    id: string;
    type: string;
    summary: string;
    utility: number;
    daysUnused: number;
  }>;
  recommendations: string[];
  checkedAt: number;
}

export interface WorkspaceOption {
  workspaceId: string;
  path?: string;
  activeMemories: number;
}

export interface HindsightMentalModelItem {
  id: string;
  slot_key?: string | null;
  slotKey?: string | null;
  summary: string;
  confidence: number;
  utility?: number;
  type?: string;
  network?: string;
  derivedCount?: number;
  updated_at?: number;
  vikingUri?: string;
}

export interface HindsightSummaryData {
  networkCounts: {
    world: number;
    experience: number;
    observation: number;
    opinion: number;
  };
  mentalModels?: HindsightMentalModelItem[];
  existingModels?: HindsightMentalModelItem[];
}

export interface VikingCategorySummary {
  category: string;
  uri: string;
  count: number;
  description?: string;
  sampleAbstracts?: string[];
}

export interface VikingSummaryData {
  rootUri: string;
  totalMemories: number;
  categories: VikingCategorySummary[];
}

export interface StudioSnapshotResponse {
  ok: true;
  etag: string;
  workspaceId: string;
  workspaces: WorkspaceOption[];
  stats: OverviewStatsData;
  health: MemoryHealthReportData;
  coreMemory: {
    blocks: CoreMemoryBlock[];
    totalTokens: number;
    stableBudgetTokens: number;
    stableLayerTokens: number;
  };
  memories: {
    total: number;
    limit: number;
    offset: number;
    items: MemoryItem[];
  };
  evolution: {
    recentJobs: JobLogItem[];
    activeStrategyVersion: number;
  };
  hindsight: HindsightSummaryData;
  viking: VikingSummaryData;
}

export interface MemoryHostAdapter {
  fetchApi?: (path: string, init?: RequestInit) => Promise<Response>;
  locale?: UiLocale;
  initialWorkspaceId?: string;
}
