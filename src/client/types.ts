export type MemoryTypeUI =
  | 'preference'
  | 'semantic'
  | 'procedural'
  | 'episodic'
  | 'belief'
  | 'goal'
  | 'failure'
  | 'meta'
  | 'fact'
  | 'procedure'
  | string;

export type MemoryStatusUI =
  | 'active'
  | 'candidate'
  | 'archived'
  | 'superseded'
  | 'frozen'
  | 'rejected';

export type WorkspaceViewMode = 'memories' | 'core' | 'sandbox' | 'graph' | 'evolution';

export type ListDensityMode = 'card' | 'compact';

export interface MemoryRecordUI {
  id: string;
  type: MemoryTypeUI;
  scope: 'global' | 'workspace' | 'user' | 'session';
  workspace_id?: string | null;
  session_id?: string | null;
  slot_key?: string | null;
  content: string;
  summary: string;
  confidence: number;
  utility: number;
  importance?: number;
  status: MemoryStatusUI;
  source_kind?: string;
  pinned: number;
  use_count: number;
  success_count: number;
  fail_count: number;
  token_cost?: number;
  summary_cost?: number;
  version: number;
  content_rev: number;
  created_at: number;
  updated_at: number;
  last_used_at?: number | null;
}

export interface MemoryStatsUI {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  avgConfidence: number;
  avgUtility: number;
  pinnedCount?: number;
}

export interface OverviewResponse {
  ok: boolean;
  stats: MemoryStatsUI;
  dynamicBudgetTokens: number;
  stableBudgetTokens?: number;
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
    id?: number;
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
    direction?: 'outgoing' | 'incoming';
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
  type: 'memory' | 'entity' | string;
  memoryType?: string;
  scope?: string;
  status?: string;
  confidence?: number;
  utility?: number;
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

export interface CoreMemoryBlockUI {
  block: string;
  content: string;
  updated_at: number;
  version: number;
  id: string;
  tokens: number;
}

export interface CoreMemoryResponse {
  ok: boolean;
  blocks: CoreMemoryBlockUI[];
  totalTokens: number;
  stableBudgetTokens: number;
}

export interface StrategyConfigUI {
  rrfK: number;
  channelWeights: Record<string, number>;
  scoreWeights: Record<string, number>;
  minRelevance: number;
  dynamicBudgetTokens: number;
  maxItems: number;
}

export interface StrategyRecordUI {
  version: number;
  config: StrategyConfigUI;
  status: 'active' | 'retired' | 'candidate' | 'rejected';
  parent: number | null;
  eval_report: any | null;
  created_at: number;
  promoted_at: number | null;
}

export interface RepairProposalUI {
  id: number;
  jobId: number;
  memoryId: string;
  contentRev: number;
  action: 'revise' | 'split' | 'invalidate';
  candidateIds: string[];
  reason: string;
  status: 'candidate' | 'approved' | 'rejected';
  createdAt: number;
  expiresAt: number;
  approvedAt?: number | null;
  approvedBy?: string | null;
  targetSummary?: string;
  targetContent?: string;
  targetStatus?: string;
  candidates?: Array<{
    id: string;
    type: string;
    content: string;
    summary: string;
    slot_key?: string | null;
  }>;
}

export interface JobRecordUI {
  id: number;
  kind: string;
  key: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface EvolutionDataResponse {
  ok: boolean;
  activeStrategy: {
    version: number;
    config: StrategyConfigUI;
  };
  strategies: StrategyRecordUI[];
  repairProposals: RepairProposalUI[];
  recentJobs: JobRecordUI[];
  ledger: {
    day: string;
    callsCount: number;
    callsLimit: number;
    tokensConsumed: number;
    tokensLimit: number;
    tokensSettled: number;
    tokensPending: number;
  };
}

export interface EvalSuiteReportUI {
  overall: {
    totalCases: number;
    passedCases: number;
    recallAtInject: number;
    excludeViolations: number;
    emptyPrecision: number;
    criticalPassed: number;
    criticalTotal: number;
    criticalPassRate: number;
    avgInjectTokens: number;
    maxBudgetTokens: number;
    p95LatencyMs: number;
  };
  bySuite?: Record<
    string,
    {
      totalCases: number;
      passedCases: number;
      recallAtInject: number;
      avgInjectTokens: number;
    }
  >;
  mvpPassed: boolean;
}

export interface BackfillStatsUI {
  rawEvents: number;
  filteredEvents: number;
  privacyRejected: number;
  writableEvents: number;
  newEventsAdded: number;
  memoriesCreated: number;
  processedFiles: number;
}

export interface RecallSimulationItemUI {
  memory: MemoryRecordUI;
  form: 'content' | 'summary';
  score: number;
  tokens: number;
  matchedChannels: string[];
}

export interface RecallSimulationUI {
  query: string;
  latencyMs: number;
  dynamicTokens: number;
  block: string;
  plan: {
    tokens: string[];
    contentTokens: string[];
    entities: string[];
    intents: {
      temporal: boolean;
      causal: boolean;
      procedural: boolean;
      preference: boolean;
    };
    temporalBrowse: boolean;
    preferenceBrowse: boolean;
  };
  items: RecallSimulationItemUI[];
}

export interface InjectionAuditRecordUI {
  id: number;
  session_id: string;
  turn: number;
  memory_id: string;
  layer: string;
  rank: number;
  tokens: number;
  form: string;
  strategy_v: number;
  outcome: number | null;
  created_at: number;
  memory_type: string | null;
  memory_content: string | null;
  memory_summary: string | null;
  slot_key: string | null;
}

export interface SandboxResponseUI {
  ok: boolean;
  stableLayer: {
    text: string;
    stableTokens: number;
    stableBudgetTokens: number;
    visibleCount: number;
  };
  dynamicBudgetTokens: number;
  hardBudgetTokens: number;
  strategyVersion: number;
  recallSimulation: RecallSimulationUI | null;
  recentInjections: InjectionAuditRecordUI[];
}

export interface MemoryHealthReportUI {
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

export interface AutoHealResultUI {
  ftsRebuilt: boolean;
  embeddingsBackfilled: number;
  linksWeaved?: number;
  duplicatesMerged: number;
  contradictionsResolved: number;
  beforeScore: number;
  afterScore: number;
  afterGrade: 'A+' | 'A' | 'B' | 'C' | 'D';
  health: MemoryHealthReportUI;
}

export interface ReconcileResponseUI {
  ok: boolean;
  dryRun: boolean;
  decision: {
    action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
    targetId?: string;
    reason: string;
    confidence: number;
  };
  resultAction?: string;
  targetMemory?: MemoryRecordUI | null;
  memory?: MemoryRecordUI | null;
}

/**
 * 统一记忆类型视觉元数据（兼容后端 semantic/procedural 与别名 fact/procedure）
 */
export function getMemoryTypeMeta(rawType?: string): {
  key: string;
  label: string;
  shortLabel: string;
  tagClass: string;
  color: string;
} {
  const t = (rawType || 'semantic').toLowerCase();
  if (t === 'preference') {
    return {
      key: 'preference',
      label: '偏好习惯',
      shortLabel: '偏',
      tagClass: 'dshm-tag-preference',
      color: '#a855f7',
    };
  }
  if (t === 'procedural' || t === 'procedure') {
    return {
      key: 'procedural',
      label: '流程规范',
      shortLabel: '程',
      tagClass: 'dshm-tag-procedure',
      color: '#38bdf8',
    };
  }
  if (t === 'semantic' || t === 'fact') {
    return {
      key: 'semantic',
      label: '事实知识',
      shortLabel: '实',
      tagClass: 'dshm-tag-fact',
      color: '#10b981',
    };
  }
  if (t === 'episodic') {
    return {
      key: 'episodic',
      label: '情景事件',
      shortLabel: '景',
      tagClass: 'dshm-tag-episodic',
      color: '#f59e0b',
    };
  }
  if (t === 'failure') {
    return {
      key: 'failure',
      label: '避坑反思',
      shortLabel: '戒',
      tagClass: 'dshm-tag-failure',
      color: '#f43f5e',
    };
  }
  if (t === 'belief' || t === 'goal') {
    return {
      key: t,
      label: t === 'goal' ? '目标规划' : '核心信念',
      shortLabel: t === 'goal' ? '标' : '信',
      tagClass: 'dshm-tag-belief',
      color: '#6366f1',
    };
  }
  return {
    key: t,
    label: '通用语义',
    shortLabel: '识',
    tagClass: 'dshm-tag-semantic',
    color: '#94a3b8',
  };
}
