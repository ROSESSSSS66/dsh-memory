import type { MemoryType, Scope, OriginKind, CandidateInput } from '../types.js';
import type {
  EvidenceLedger,
  LLMTaskKind,
  RawMemoryItem,
  RawEvidenceItem,
  ParseResult,
  RepairAction,
  JudgeOutput,
} from './types.js';
import { redactSecrets } from '../core/privacy.js';

const VALID_MEMORY_TYPES = new Set<MemoryType>([
  'episodic',
  'semantic',
  'procedural',
  'belief',
  'preference',
  'goal',
  'failure',
  'meta',
]);

const VALID_SCOPES = new Set<Scope>(['global', 'workspace', 'session']);
const VALID_SLOT_KEY_REGEX = /^[a-z0-9.:_-]+$/;

export interface ParseOptions {
  taskKind: LLMTaskKind;
  evidenceLedger: EvidenceLedger;
  workspaceId: string;
  sessionId?: string;
}

/**
 * 剥离外部包裹的单个代码围栏，且严格拒绝代码围栏前后的杂文
 */
export function cleanJsonText(raw: string): string {
  const trimmed = raw.trim();
  // 仅匹配包裹整个文本的代码围栏
  const fenceMatch = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

/**
 * 严格校验并解析 LLM 的输出 JSON
 */
export function parseOutput(raw: string, options: ParseOptions): ParseResult {
  const cleaned = cleanJsonText(raw);

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      success: false,
      error: 'json_parse_failed',
      droppedNotes: [(err as Error).message],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      success: false,
      error: 'root_not_object',
    };
  }

  // B-5: 回放裁判
  if (options.taskKind === 'judge') {
    return parseJudgeOutput(parsed);
  }

  // B-4: 修复
  if (options.taskKind === 'repair') {
    return parseRepairOutput(parsed, options);
  }

  // B-1 (distill), B-2 (reflect), B-3 (consolidate)
  if (!Array.isArray(parsed.items)) {
    return {
      success: false,
      error: 'items_missing_or_not_array',
    };
  }

  // 合法空 items 是成功 no-op
  if (parsed.items.length === 0) {
    return {
      success: true,
      items: [],
      rawItems: [],
    };
  }

  // 任务特定的条数硬上限
  if (options.taskKind === 'distill' && parsed.items.length > 5) {
    return {
      success: false,
      error: 'distill_max_items_exceeded',
    };
  }
  if (options.taskKind === 'reflect' && parsed.items.length > 2) {
    return {
      success: false,
      error: 'reflect_max_items_exceeded',
    };
  }
  if (options.taskKind === 'consolidate' && parsed.items.length > 1) {
    return {
      success: false,
      error: 'consolidate_max_items_exceeded',
    };
  }

  const { validItems, droppedNotes } = validateMemoryItems(parsed.items, options);

  if (parsed.items.length > 0 && validItems.length === 0) {
    return {
      success: false,
      error: 'all_items_invalid',
      droppedNotes,
    };
  }

  // 映射为 CandidateInput
  const candidateInputs = validItems.map(item =>
    mapToCandidateInput(item, options.evidenceLedger, {
      taskKind: options.taskKind,
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
    })
  );

  return {
    success: true,
    items: candidateInputs,
    rawItems: validItems,
    droppedNotes,
  };
}

/**
 * 校验并过滤 MemoryItem 列表
 */
function validateMemoryItems(
  rawList: any[],
  options: ParseOptions
): { validItems: RawMemoryItem[]; droppedNotes: string[] } {
  const validItems: RawMemoryItem[] = [];
  const droppedNotes: string[] = [];

  for (let i = 0; i < rawList.length; i++) {
    const rawItem = rawList[i];
    const validationError = validateSingleItem(rawItem, i, options);
    if (validationError) {
      droppedNotes.push(`item[${i}]: ${validationError}`);
      continue;
    }

    validItems.push(rawItem as RawMemoryItem);
  }

  return { validItems, droppedNotes };
}

/**
 * 单条 MemoryItem 校验
 */
function validateSingleItem(item: any, index: number, options: ParseOptions): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return 'item_not_object';
  }

  // 1. type
  if (typeof item.type !== 'string' || !VALID_MEMORY_TYPES.has(item.type as MemoryType)) {
    return `invalid_type: ${item.type}`;
  }

  // 任务特有类型约束
  if (options.taskKind === 'reflect') {
    if (index === 0 && item.type !== 'failure' && item.type !== 'procedural') {
      return `reflect_first_item_must_be_failure_or_procedural: ${item.type}`;
    }
    if (index === 1 && item.type !== 'belief') {
      return `reflect_second_item_must_be_belief: ${item.type}`;
    }
  } else if (options.taskKind === 'consolidate') {
    if (item.type !== 'procedural') {
      return `consolidate_item_must_be_procedural: ${item.type}`;
    }
  }

  // 2. text
  if (typeof item.text !== 'string') {
    return 'text_not_string';
  }
  const trimmedText = item.text.trim();
  if (trimmedText.length < 8 || trimmedText.length > 800) {
    return `text_length_out_of_range: ${trimmedText.length}`;
  }

  // 隐私检测：item.text 不能包含未脱敏敏感信息
  const privacyCheck = redactSecrets(trimmedText);
  if (privacyCheck.hasSensitive) {
    return `text_contains_sensitive_data: ${privacyCheck.detectedKinds.join(',')}`;
  }

  // 3. slot_key (可选)
  if (item.slot_key !== undefined && item.slot_key !== null) {
    if (typeof item.slot_key !== 'string') {
      return 'slot_key_not_string';
    }
    if (item.slot_key.length > 48 || !VALID_SLOT_KEY_REGEX.test(item.slot_key)) {
      return `invalid_slot_key: ${item.slot_key}`;
    }
  }

  // 4. confidence
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
    return `invalid_confidence: ${item.confidence}`;
  }

  // 5. scope
  if (typeof item.scope !== 'string' || !VALID_SCOPES.has(item.scope as Scope)) {
    return `invalid_scope: ${item.scope}`;
  }

  // 6. evidence 数组
  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    return 'evidence_missing_or_empty';
  }

  for (let j = 0; j < item.evidence.length; j++) {
    const ev = item.evidence[j];
    if (typeof ev !== 'object' || ev === null) {
      return `evidence[${j}]_not_object`;
    }
    if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq < 1) {
      return `evidence[${j}]_invalid_seq: ${ev.seq}`;
    }
    if (typeof ev.quote !== 'string') {
      return `evidence[${j}]_quote_not_string`;
    }

    const trimmedQuote = ev.quote.trim();
    if (trimmedQuote.length < 4 || trimmedQuote.length > 200) {
      return `evidence[${j}]_quote_length_out_of_range: ${trimmedQuote.length}`;
    }

    if (trimmedQuote.includes('[REDACTED:')) {
      return `evidence[${j}]_quote_contains_redacted_placeholder`;
    }

    // 检查 seq 是否存在于本次实际发送的 evidenceLedger
    const entry = options.evidenceLedger.get(ev.seq);
    if (!entry) {
      return `evidence[${j}]_seq_not_in_ledger: ${ev.seq}`;
    }

    // 严格检查 quote 是否为该编号实际发送的脱敏文本的连续子串（区分大小写）
    if (!entry.redacted_text.includes(trimmedQuote)) {
      return `evidence[${j}]_quote_not_substring_of_seq_${ev.seq}`;
    }
  }

  return null;
}

/**
 * 解析 B-4 修复提案
 */
function parseRepairOutput(parsed: any, options: ParseOptions): ParseResult {
  const action = parsed.action as RepairAction;
  if (!['keep', 'revise', 'split', 'invalidate'].includes(action)) {
    return {
      success: false,
      error: `invalid_repair_action: ${parsed.action}`,
    };
  }

  if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0 || parsed.reason.length > 200) {
    return {
      success: false,
      error: 'invalid_repair_reason',
    };
  }

  if (!Array.isArray(parsed.items)) {
    return {
      success: false,
      error: 'repair_items_not_array',
    };
  }

  // 动作与条数初始契约校验
  if (action === 'keep' || action === 'invalidate') {
    if (parsed.items.length !== 0) {
      return {
        success: false,
        error: `action_${action}_requires_0_items`,
      };
    }
    return {
      success: true,
      action,
      reason: parsed.reason.trim(),
      items: [],
      rawItems: [],
    };
  }

  if (action === 'revise' && parsed.items.length !== 1) {
    return {
      success: false,
      error: 'action_revise_requires_exactly_1_item',
    };
  }

  if (action === 'split' && (parsed.items.length < 2 || parsed.items.length > 3)) {
    return {
      success: false,
      error: 'action_split_requires_2_or_3_items',
    };
  }

  // 校验具体 item
  const { validItems, droppedNotes } = validateMemoryItems(parsed.items, options);

  // B-4 丢弃后必须再次满足 action 的条数约束，否则整次失败
  if (action === 'revise' && validItems.length !== 1) {
    return {
      success: false,
      error: 'action_revise_failed_after_drop',
      droppedNotes,
    };
  }
  if (action === 'split' && (validItems.length < 2 || validItems.length > 3)) {
    return {
      success: false,
      error: 'action_split_failed_after_drop',
      droppedNotes,
    };
  }

  const candidateInputs = validItems.map(item =>
    mapToCandidateInput(item, options.evidenceLedger, {
      taskKind: 'repair',
      workspaceId: options.workspaceId,
      sessionId: options.sessionId,
    })
  );

  return {
    success: true,
    action,
    reason: parsed.reason.trim(),
    items: candidateInputs,
    rawItems: validItems,
    droppedNotes,
  };
}

/**
 * 解析 B-5 回放裁判输出
 */
function parseJudgeOutput(parsed: any): ParseResult {
  if (!Array.isArray(parsed.items)) {
    return { success: false, error: 'judge_items_not_array' };
  }

  const validVerdicts = new Set(['potentially_useful', 'neutral', 'potentially_harmful', 'unknown']);
  if (!validVerdicts.has(parsed.verdict)) {
    return { success: false, error: `invalid_judge_verdict: ${parsed.verdict}` };
  }

  if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 1) {
    return { success: false, error: `invalid_judge_score: ${parsed.score}` };
  }

  if (typeof parsed.reason !== 'string' || parsed.reason.trim().length === 0 || parsed.reason.length > 200) {
    return { success: false, error: 'invalid_judge_reason' };
  }

  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    if (typeof item !== 'object' || item === null) {
      return { success: false, error: `judge_item[${i}]_not_object` };
    }
    if (typeof item.id !== 'string' || !item.id) {
      return { success: false, error: `judge_item[${i}]_invalid_id` };
    }
    if (![0, 1, 2].includes(item.relevant)) {
      return { success: false, error: `judge_item[${i}]_invalid_relevant` };
    }
    if (!['supported', 'contradicted', 'unknown'].includes(item.correct)) {
      return { success: false, error: `judge_item[${i}]_invalid_correct` };
    }
    if (![0, 1, 'unknown'].includes(item.harmful)) {
      return { success: false, error: `judge_item[${i}]_invalid_harmful` };
    }
  }

  const judgeResult: JudgeOutput = {
    items: parsed.items,
    verdict: parsed.verdict,
    score: parsed.score,
    reason: parsed.reason.trim(),
  };

  return {
    success: true,
    judgeResult,
    items: [],
  };
}

/**
 * 将校验通过的 RawMemoryItem 映射为存储层的 CandidateInput
 */
export function mapToCandidateInput(
  item: RawMemoryItem,
  evidenceLedger: EvidenceLedger,
  options: {
    taskKind: LLMTaskKind;
    workspaceId: string;
    sessionId?: string;
  }
): CandidateInput {
  // confidence 折扣：一般乘 0.8，B-4 再乘 0.7
  let confidence = item.confidence * 0.8;
  if (options.taskKind === 'repair') {
    confidence = confidence * 0.7;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  // 映射证据到真实 sources
  const sources = item.evidence.map(ev => {
    const entry = evidenceLedger.get(ev.seq)!;
    return {
      session_id: entry.session_id,
      seq: entry.original_seq,
      kind: entry.kind,
      excerpt: ev.quote.trim(),
    };
  });

  // 从 evidenceLedger 真实派生 origin_kinds
  const originSet = new Set<OriginKind>();
  for (const ev of item.evidence) {
    const entry = evidenceLedger.get(ev.seq)!;
    for (const ok of entry.origin_kinds) {
      originSet.add(ok);
    }
  }

  // Scope 约束：LLM 提出的 scope 不能提权至 global/user
  let scope: Scope = item.scope;
  if (scope === 'global' || scope === 'user') {
    scope = 'workspace';
  }

  return {
    type: item.type,
    content: item.text.trim(),
    slot_key: item.slot_key || undefined,
    scope,
    workspaceId: options.workspaceId,
    sessionId: scope === 'session' ? options.sessionId : undefined,
    source_kind: 'llm_extract',
    confidence,
    origin_kinds: Array.from(originSet),
    sources,
    actor: 'llm',
    status: 'candidate',
  };
}
