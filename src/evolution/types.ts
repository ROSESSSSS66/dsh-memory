import type { MemoryType, Scope, OriginKind, CandidateInput } from '../types.js';

export interface EvidenceLedgerEntry {
  seq: number; // 1..N request-local
  session_id: string;
  original_seq: number;
  kind: string;
  redacted_text: string;
  origin_kinds: OriginKind[];
  time: number;
}

export type EvidenceLedger = Map<number, EvidenceLedgerEntry>;

export interface RawEvidenceItem {
  seq: number;
  quote: string;
}

export interface RawMemoryItem {
  type: MemoryType;
  text: string;
  slot_key?: string | null;
  confidence: number;
  scope: Scope;
  evidence: RawEvidenceItem[];
}

export interface DistillOutput {
  items: RawMemoryItem[];
}

export interface ReflectOutput {
  items: RawMemoryItem[];
}

export interface ConsolidateOutput {
  items: RawMemoryItem[];
}

export type RepairAction = 'keep' | 'revise' | 'split' | 'invalidate';

export interface RepairOutput {
  action: RepairAction;
  reason: string;
  items: RawMemoryItem[];
}

export interface JudgeItem {
  id: string;
  relevant: 0 | 1 | 2;
  correct: 'supported' | 'contradicted' | 'unknown';
  harmful: 0 | 1 | 'unknown';
}

export interface JudgeOutput {
  items: JudgeItem[];
  verdict: 'potentially_useful' | 'neutral' | 'potentially_harmful' | 'unknown';
  score: number;
  reason: string;
}

export type LLMTaskKind = 'distill' | 'reflect' | 'consolidate' | 'repair' | 'judge';

export interface ReserveParams {
  jobKind: string;
  model: string;
  promptVersion: string;
  reservedTokens: number;
  now?: number;
}

export interface ReserveResult {
  reserved: boolean;
  ledgerId?: number;
  reason?: string;
}

export interface SettleParams {
  ledgerId: number;
  status: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  ok: number; // 1 or 0
  inTokens?: number;
  outTokens?: number;
  note?: string;
  now?: number;
}

export interface ParseResultSuccess<T = CandidateInput[]> {
  success: true;
  items: T;
  rawItems?: RawMemoryItem[];
  action?: RepairAction;
  reason?: string;
  judgeResult?: JudgeOutput;
  droppedNotes?: string[];
}

export interface ParseResultFailure {
  success: false;
  error: string;
  droppedNotes?: string[];
}

export type ParseResult<T = CandidateInput[]> = ParseResultSuccess<T> | ParseResultFailure;
