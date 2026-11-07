export interface OverviewStatsData {
  stats: {
    total: number;
    active: number;
    candidate: number;
    superseded: number;
    archived: number;
    frozen?: number;
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
}

export interface CoreMemoryBlock {
  block: string;
  id: string;
  content: string;
  updated_at?: number;
  updatedAt?: number;
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
