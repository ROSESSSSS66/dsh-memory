import type { MemoryType, Scope, OriginKind, CandidateInput } from '../types.js';
import type {
  EvidenceLedger,
  LLMTaskKind,
  RawMemoryItem,
  RawEvidenceItem,
  ParseResult,
  RepairAction,
  JudgeOutput,
  CurateOutput,
  CurateUpdateItem,
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
const VALID_MEMORY_ID_REGEX = /^m_[a-z0-9_]{4,32}$/i;
// core:* 为 Letta 常驻核心块保留命名空间，只能经用户/系统路径写入，模型输出不得占用
const RESERVED_SLOT_PREFIX = 'core:';
const WORKSPACE_PLACEHOLDER = '<workspace>';
const MAX_WORKSPACE_GAP = 260;

/**
 * 判定 quote 是否为 text 的连续子串，其中每个 <workspace> 占位符对应 1..260 个非换行字符。
 * 逐段线性扫描而非拼接正则：quote 由模型给出，多个占位符串联的 `[^\r\n]{1,260}` 会产生灾难性回溯，
 * 且该校验同步执行，任务超时与 AbortSignal 均无法打断。
 */
function matchesWithWorkspaceGaps(text: string, quote: string): boolean {
  const parts = quote.split(WORKSPACE_PLACEHOLDER);
  // reach[i] = 1 表示已匹配的前缀可以结束于 text 偏移 i
  let reach = new Uint8Array(text.length + 1);
  for (let s = 0; s + parts[0].length <= text.length; s++) {
    if (text.startsWith(parts[0], s)) reach[s + parts[0].length] = 1;
  }

  for (let p = 1; p < parts.length; p++) {
    const part = parts[p];
    const next = new Uint8Array(text.length + 1);
    let lastReach = -1;
    let lastNewline = -1;
    for (let s = 1; s + part.length <= text.length; s++) {
      if (reach[s - 1]) lastReach = s - 1;
      const prev = text.charCodeAt(s - 1);
      if (prev === 10 || prev === 13) lastNewline = s - 1;
      // 最近的可达偏移同时是间隔最短、最不可能跨行的候选
      if (lastReach > lastNewline && s - lastReach <= MAX_WORKSPACE_GAP && text.startsWith(part, s)) {
        next[s + part.length] = 1;
      }
    }
    reach = next;
  }

  return reach.includes(1);
}

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

  // B-6: 离线记忆治理与无效记忆淘汰 (curate-v1)
  if (options.taskKind === 'curate') {
    return parseCurateOutput(parsed);
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

  const rawDiscardList = Array.isArray(parsed.discard_ids)
    ? parsed.discard_ids
    : Array.isArray(parsed.obsolete_ids)
      ? parsed.obsolete_ids
      : [];
  const discardIds = Array.from(
    new Set<string>(
      rawDiscardList
        .filter((id: unknown): id is string => typeof id === 'string' && VALID_MEMORY_ID_REGEX.test(id.trim()))
        .map((id: string) => id.trim())
    )
  ).slice(0, 20);

  // 合法空 items 是成功 no-op (或仅包含 discardIds 淘汰指令)
  if (parsed.items.length === 0) {
    return {
      success: true,
      items: [],
      rawItems: [],
      ...(discardIds.length > 0 ? { discardIds } : {}),
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

  if (parsed.items.length > 0 && validItems.length === 0 && discardIds.length === 0) {
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
    ...(discardIds.length > 0 ? { discardIds } : {}),
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
    if (item.slot_key.startsWith(RESERVED_SLOT_PREFIX)) {
      return `reserved_slot_key: ${item.slot_key}`;
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
      const matchedWithWorkspacePlaceholder =
        trimmedQuote.includes(WORKSPACE_PLACEHOLDER) &&
        matchesWithWorkspaceGaps(entry.redacted_text, trimmedQuote);
      if (!matchedWithWorkspacePlaceholder) {
        return `evidence[${j}]_quote_not_substring_of_seq_${ev.seq}`;
      }
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
 * 解析 B-6 离线记忆治理输出 (curate-v1)
 */
function parseCurateOutput(parsed: any): ParseResult {
  const rawDiscards = Array.isArray(parsed.discard_ids) ? parsed.discard_ids : [];
  const discardIds = Array.from(
    new Set<string>(
      rawDiscards
        .filter((id: unknown): id is string => typeof id === 'string' && VALID_MEMORY_ID_REGEX.test(id.trim()))
        .map((id: string) => id.trim())
    )
  ).slice(0, 30);

  const rawUpdates = Array.isArray(parsed.updates) ? parsed.updates : [];
  const updates: CurateUpdateItem[] = [];

  for (const u of rawUpdates.slice(0, 15)) {
    if (!u || typeof u !== 'object') continue;
    const targetId = typeof u.target_id === 'string' ? u.target_id.trim() : '';
    if (!VALID_MEMORY_ID_REGEX.test(targetId)) continue;

    const text = typeof u.text === 'string' ? u.text.trim() : '';
    if (text.length < 8 || text.length > 800) continue;
    if (redactSecrets(text).hasSensitive) continue;

    // type / slot_key 缺省或非法时保持 undefined，由应用方沿用目标记忆原值（不得静默改型或清空槽位）
    const type: MemoryType | undefined =
      typeof u.type === 'string' && VALID_MEMORY_TYPES.has(u.type as MemoryType)
        ? (u.type as MemoryType)
        : undefined;

    const slotKey =
      typeof u.slot_key === 'string' &&
      u.slot_key.length <= 48 &&
      VALID_SLOT_KEY_REGEX.test(u.slot_key) &&
      !u.slot_key.startsWith(RESERVED_SLOT_PREFIX)
        ? u.slot_key
        : undefined;

    const confidence =
      typeof u.confidence === 'number' && Number.isFinite(u.confidence)
        ? Math.max(0.1, Math.min(1, u.confidence))
        : 0.85;

    const absorbIds = Array.isArray(u.absorb_ids)
      ? u.absorb_ids
          .filter(
            (id: unknown): id is string =>
              typeof id === 'string' && VALID_MEMORY_ID_REGEX.test(id.trim()) && id.trim() !== targetId
          )
          .map((id: string) => id.trim())
      : [];

    updates.push({
      target_id: targetId,
      absorb_ids: absorbIds,
      type,
      text,
      slot_key: slotKey,
      confidence,
    });
  }

  const curateResult: CurateOutput = {
    discard_ids: discardIds,
    updates,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : undefined,
  };

  return {
    success: true,
    items: [],
    discardIds,
    curateResult,
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
      // repair merely reinterprets historical excerpts via LLM, not direct live user confirmation
      kind: options.taskKind === 'repair' ? 'llm_repair' : entry.kind,
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

  const supersedesId =
    typeof item.supersedes_id === 'string' && VALID_MEMORY_ID_REGEX.test(item.supersedes_id.trim())
      ? item.supersedes_id.trim()
      : undefined;

  return {
    type: item.type,
    content: item.text.trim(),
    slot_key: item.slot_key || undefined,
    ...(supersedesId ? { supersedesId } : {}),
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
