export type MemoryType =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'belief'
  | 'preference'
  | 'goal'
  | 'failure'
  | 'meta';

export type MemoryStatus =
  | 'candidate'
  | 'active'
  | 'superseded'
  | 'archived'
  | 'rejected'
  | 'frozen';

export type SourceKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'web'
  | 'llm_extract'
  | 'rule'
  | 'system';

export type OriginKind = 'user' | 'assistant' | 'tool' | 'web' | 'system';

export type Scope = 'session' | 'workspace' | 'user' | 'global';

export type RelationType = 'supersedes' | 'derived_from' | 'contradicts' | 'related';

export interface MemoryRef {
  id: string;
  contentRev: number;
}

export interface MemorySource {
  memory_id: string;
  content_rev: number;
  session_id: string;
  seq: number;
  kind: string;
  excerpt?: string | null;
  created_at: number;
}

export interface MemoryRecord {
  rowid_?: number;
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  content: string;
  summary: string;
  slot_key?: string | null;
  scope: Scope;
  workspace_id?: string | null;
  session_id?: string | null;
  origin_kinds: OriginKind[];
  approved_at?: number | null;
  approved_by?: string | null;
  source_kind: SourceKind;
  confidence: number;
  utility: number;
  use_count: number;
  success_count: number;
  fail_count: number;
  token_cost: number;
  summary_cost: number;
  hash: string;
  version: number;
  content_rev: number;
  pinned: number; // 0 | 1
  valid_from?: number | null;
  valid_to?: number | null;
  created_at: number;
  updated_at: number;
  last_used_at?: number | null;
  last_repair_at?: number | null;
  embedding?: Uint8Array | null;
  importance?: number; // 1..10, 默认 5 (Stanford Generative Agents / Zep)
  invalidated_at?: number | null; // Zep 时序失效时间戳
}

export interface CandidateInput {
  type: MemoryType;
  content: string;
  summary?: string;
  slot_key?: string | null;
  scope?: Scope;
  workspaceId?: string;
  sessionId?: string;
  source_kind: SourceKind;
  confidence: number;
  origin_kinds: OriginKind[];
  sources: {
    session_id: string;
    seq: number;
    kind: string;
    excerpt?: string;
    content_rev?: number;
  }[];
  entities?: string[];
  valid_from?: number | null;
  valid_to?: number | null;
  importance?: number; // 1..10
  status?: 'candidate' | 'active';
  actor: 'rule' | 'llm' | 'user' | 'lab' | 'maintenance';
}

export type UpsertResult =
  | { action: 'inserted'; id: string }
  | { action: 'merged'; id: string }
  | { action: 'superseded'; id: string; oldId: string }
  | { action: 'conflict_pending'; id: string; withId: string }
  | { action: 'rejected'; reason: string };

export type ReconcileAction = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export interface ReconcileDecision {
  action: ReconcileAction;
  targetId?: string;
  reason: string;
  confidence: number;
}

export type CoreMemoryBlock = 'human' | 'persona' | 'project' | string;

export interface CoreMemoryEntry {
  block: CoreMemoryBlock;
  content: string;
  updated_at: number;
  version: number;
  id: string;
}

export type ChannelName = 'lexical' | 'entity' | 'typed' | 'temporal' | 'preference' | 'vector';

export interface StrategyConfig {
  rrfK: number;
  channelWeights: Record<ChannelName, number>;
  scoreWeights: {
    relevance: number;
    confidence: number;
    utility: number;
    freshness: number;
    consistency: number;
    specificity: number;
    importance?: number;
  };
  minRelevance: number;
  dynamicBudgetTokens: number;
  maxItems: number;
}

export interface QueryPlan {
  text: string;
  tokens: string[];
  contentTokens: string[];
  entities: string[];
  contextEntities: string[];
  intents: {
    temporal: boolean;
    causal: boolean;
    procedural: boolean;
    preference: boolean;
  };
  timeRange?: { from: number; to: number };
  temporalBrowse: boolean;
  preferenceBrowse: boolean;
  now: number;
}

export interface RawEvent {
  session_id: string;
  seq: number;
  workspace_id: string;
  type: string;
  time: number;
  turn?: number | null;
  role?: 'user' | 'assistant' | 'tool' | 'system' | 'compaction' | null;
  origin_kind: OriginKind;
  tool_name?: string | null;
  is_error: number;
  text?: string | null;
  processed: number;
}

export interface DbResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Db {
  exec(sql: string): void;
  run(sql: string, params?: any[]): DbResult;
  get<T = any>(sql: string, params?: any[]): T | undefined;
  all<T = any>(sql: string, params?: any[]): T[];
  prepare(sql: string): {
    run(...params: any[]): DbResult;
    get(...params: any[]): any;
    all(...params: any[]): any[];
  };
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface Context {
  on(event: string, callback: (...args: any[]) => any, options?: { prepend?: boolean }): () => void;
  emit(event: string, ...args: any[]): void;
  [key: string]: any;
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'memory' | 'entity';
  memoryType?: MemoryType;
  scope?: Scope;
  status?: MemoryStatus;
  confidence?: number;
  utility?: number;
  pinned?: number;
  connections?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  rel: string; // 'supersedes' | 'derived_from' | 'contradicts' | 'related' | 'mentions'
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  stats: {
    totalNodes: number;
    memoryNodes: number;
    entityNodes: number;
    totalLinks: number;
  };
}

export interface MarkdownFrontmatter {
  id: string;
  type: MemoryType;
  scope: Scope;
  status: MemoryStatus;
  summary: string;
  slot_key?: string | null;
  workspace_id?: string | null;
  session_id?: string | null;
  confidence: number;
  utility: number;
  pinned: number;
  entities?: string[];
  created_at?: string;
  updated_at?: string;
}

