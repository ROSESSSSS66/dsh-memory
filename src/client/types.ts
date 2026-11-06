export interface MemoryRecordUI {
  id: string;
  type: 'fact' | 'preference' | 'procedure' | 'semantic' | string;
  scope: 'global' | 'workspace';
  workspace_id?: string;
  session_id?: string;
  slot_key?: string;
  content: string;
  summary: string;
  confidence: number;
  utility: number;
  status: 'active' | 'candidate' | 'archived' | 'superseded' | 'frozen';
  pinned: number;
  use_count: number;
  success_count: number;
  fail_count: number;
  version: number;
  content_rev: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryStatsUI {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  avgConfidence: number;
  avgUtility: number;
}

export interface OverviewResponse {
  ok: boolean;
  stats: MemoryStatsUI;
  dynamicBudgetTokens: number;
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

export interface ListResponse {
  ok: boolean;
  total: number;
  limit: number;
  offset: number;
  items: MemoryRecordUI[];
}

export interface MemoryDetailResponse {
  ok: boolean;
  memory: MemoryRecordUI;
  sources: Array<{
    id: number;
    memory_id: string;
    session_id: string;
    seq: number;
    kind: string;
    excerpt?: string;
  }>;
  history: Array<{
    version: number;
    snapshot: any;
    reason: string;
    actor: string;
    created_at: number;
  }>;
  relations: Array<{
    to_id: string;
    rel: string;
  }>;
}

export interface LLMConfigUI {
  offlineLLM: {
    useDshLlm: boolean;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKeyMasked?: string;
    hasApiKey?: boolean;
    protocol?: 'chat/completions' | 'responses' | 'messages';
  };
  privacy: {
    offlineConsent: boolean;
    allowedOfflineEndpoints: string[];
  };
  dailyLLMCalls: number;
  dailyLLMTokens: number;
  distillMaxInputTokens: number;
  dynamicBudgetTokens?: number;
  hardBudgetTokens?: number;
  stableBudgetTokens?: number;
  defaultScope?: string;
}

export interface LLMTestResponse {
  ok: boolean;
  latencyMs?: number;
  status?: number;
  model?: string;
  protocol?: string;
  error?: string;
}

export interface GraphNodeUI {
  id: string;
  label: string;
  type: string;
  pinned?: number;
  connections?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface GraphLinkUI {
  source: string;
  target: string;
  rel: string;
}

export interface GraphDataUI {
  nodes: GraphNodeUI[];
  links: GraphLinkUI[];
  stats: {
    totalNodes: number;
    memoryNodes: number;
    entityNodes: number;
    totalLinks: number;
  };
}

export interface ExportResponse {
  ok: boolean;
  version: string;
  exportedAt: number;
  total: number;
  memories: MemoryRecordUI[];
}

export interface ImportResult {
  ok: boolean;
  imported: number;
  skipped: number;
  total: number;
}
