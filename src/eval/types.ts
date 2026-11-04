import type { MemoryType, MemoryStatus, SourceKind } from '../types.js';

export interface EvalCaseSetup {
  type: MemoryType;
  content: string;
  slot_key?: string | null;
  at?: string;
  source_kind?: SourceKind;
  pinned?: number;
  status?: MemoryStatus;
  utility?: number;
}

export interface EvalCaseExpect {
  include: string[];
  exclude?: string[];
  maxTokens?: number;
  expectStable?: string[];
}

export interface EvalCase {
  id: string;
  suite: 'factual' | 'temporal' | 'procedural' | 'implicit' | 'harvested';
  critical: boolean;
  now: string;
  workspace: string;
  setup: EvalCaseSetup[];
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
}

export interface SuiteMetrics {
  suite: string;
  totalCases: number;
  passedCases: number;
  recallAtInject: number;
  excludeViolations: number;
  emptyPrecision: number;
  criticalPassRate: number;
  criticalTotal: number;
  criticalPassed: number;
  avgInjectTokens: number;
  maxBudgetTokens: number;
  p95LatencyMs: number;
}

export interface EvalReport {
  timestamp: number;
  strategyVersion?: number;
  overall: SuiteMetrics;
  suites: Record<string, SuiteMetrics>;
  caseResults: Record<string, CaseResult>;
  mvpPassed: boolean;
}
