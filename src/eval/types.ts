import type {
  MemoryType,
  MemoryStatus,
  SourceKind,
  Scope,
  RelationType,
  VikingContextTier,
} from '../types.js';

export type EvalSuiteName =
  | 'factual'
  | 'temporal'
  | 'procedural'
  | 'implicit'
  | 'english_mixed'
  | 'isolation_multihop'
  | 'budget_viking'
  | 'harvested'
  | (string & {});

export interface EvalCaseRelation {
  fromIdx: number;
  toIdx: number;
  rel: RelationType;
}

export interface EvalCaseSetup {
  type: MemoryType;
  content: string;
  summary?: string;
  slot_key?: string | null;
  at?: string;
  source_kind?: SourceKind;
  pinned?: number;
  status?: MemoryStatus;
  utility?: number;
  scope?: Scope;
  workspaceId?: string;
  sessionId?: string;
  confidence?: number;
  valid_from?: number;
  valid_to?: number;
  invalidated_at?: number;
  frozen?: boolean;
  entities?: string[];
  importance?: number;
  relations?: EvalCaseRelation[];
}

export interface EvalCaseExpect {
  include: string[];
  exclude?: string[];
  maxTokens?: number;
  expectStable?: string[];
  targetSubstrings?: string[];
}

export interface EvalCase {
  id: string;
  suite: EvalSuiteName;
  critical: boolean;
  now: string;
  workspace: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
  dynamicBudgetTokens?: number;
  maxItems?: number;
  setup: EvalCaseSetup[];
  relations?: EvalCaseRelation[];
  query: string;
  expect: EvalCaseExpect;
}

export interface CaseResult {
  id: string;
  pass: boolean;
  includePass: boolean;
  excludePass: boolean;
  stablePass: boolean;
  budgetPass: boolean;
  emptyPass: boolean;
  dynamicTokens: number;
  stableTokens: number;
  latencyMs: number;
  injectedIds?: string[];
  injectedTexts?: string[];
  injectedTiers?: VikingContextTier[];
}

export type EvalCaseResult = CaseResult;

export interface SuiteMetrics {
  suite: string;
  totalCases: number;
  passedCases: number;
  recallAtInject: number;
  precisionAtInject: number;
  mrr: number;
  ndcgAtK: number;
  excludeViolations: number;
  emptyPrecision: number;
  criticalPassRate: number;
  criticalTotal: number;
  criticalPassed: number;
  avgInjectTokens: number;
  maxBudgetTokens: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface MvpGateStatus {
  hasCases: boolean;
  hasNonEmptyCases: boolean;
  recallAtInject: boolean;
  excludeViolations: boolean;
  emptyPrecision: boolean;
  avgInjectTokens: boolean;
  p95LatencyMs: boolean;
  allCriticalPassed: boolean;
  allBudgetPass: boolean;
  allImplicitStablePass: boolean;
}

export interface EvalReport {
  timestamp: number;
  strategyVersion?: number;
  overall: SuiteMetrics;
  suites: Record<string, SuiteMetrics>;
  caseResults: Record<string, CaseResult>;
  mvpPassed: boolean;
  mvpGates?: MvpGateStatus;
}

export interface ScaleBenchmarkQuery {
  id: string;
  query: string;
  critical?: boolean;
  expect: EvalCaseExpect;
}

export interface ScaleBenchmarkDataset {
  now: string;
  workspace: string;
  memories: EvalCaseSetup[];
  queries: ScaleBenchmarkQuery[];
}

export interface ScaleBenchmarkReport {
  memoryCount: number;
  setupMs: number;
  report: EvalReport;
}
