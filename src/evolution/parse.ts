import { redactSecrets } from '../core/privacy.js';
import type { CandidateInput, MemoryType, OriginKind, Scope } from '../types.js';
import type {
  CurateOutput,
  CurateUpdateItem,
  EvidenceLedger,
  JudgeOutput,
  LLMTaskKind,
  ParseResult,
  RawMemoryItem,
  RepairAction,
} from './types.js';

// 模型不得创建内部系统类型 'meta'
const VALID_MEMORY_TYPES = new Set<MemoryType>([
  'episodic',
  'semantic',
  'procedural',
  'belief',
  'preference',
  'goal',
  'failure',
]);

// 允许模型输出 'user' 或 'global' 并在 mapToCandidateInput 中安全降级为 'workspace'
const VALID_SCOPES = new Set<Scope>(['global', 'user', 'workspace', 'session']);
const VALID_SLOT_KEY_REGEX = /^[a-z0-9.:_-]+$/;
const VALID_MEMORY_ID_REGEX = /^m_[a-z0-9_]{4,32}$/i;
// core:* 为 Letta 常驻核心块保留命名空间，只能经用户/系统路径写入，模型输出不得占用
const RESERVED_SLOT_PREFIX = 'core:';
const WORKSPACE_PLACEHOLDER = '<workspace>';
const MAX_WORKSPACE_GAP = 260;
const MAX_WORKSPACE_PLACEHOLDERS = 4;
const MAX_ITEMS_SCAN = 20;

/**
 * 判定 quote 是否为 text 的连续子串，其中每个 <workspace> 占位符对应 1..260 个非换行字符。
 * P0 安全硬约束：
 * - 去除 <workspace> 后非占位文本长度必须 >= 8
 * - 至少包含一段长度 >= 4 的非占位文本，彻底封堵 "<workspace>" / "a<workspace>" 匹配任意文本的绕过
 * - 逐段线性扫描，杜绝回溯 ReDoS
 */
export function matchesWithWorkspaceGaps(text: string, quote: string): boolean {
  const nonPlaceholder = quote.replaceAll(WORKSPACE_PLACEHOLDER, '').trim();
  if (nonPlaceholder.length < 8) {
    return false;
  }

  const parts = quote.split(WORKSPACE_PLACEHOLDER);
  if (parts.length - 1 > MAX_WORKSPACE_PLACEHOLDERS) {
    return false;
  }
  if (!parts.some((p) => p.trim().length >= 4)) {
    return false;
  }

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
      if (
        lastReach > lastNewline &&
        s - lastReach <= MAX_WORKSPACE_GAP &&
        text.startsWith(part, s)
      ) {
        next[s + part.length] = 1;
      }
    }
    reach = next;
  }

  return reach.includes(1);
}

/**
 * 从带有前后杂文或包裹文本的字符串中，按 JSON 字符串转义规则提取最外层成对的 `{ ... }` JSON 对象。
 */
function extractBalancedJsonObject(input: string): string | null {
  let searchFrom = 0;
  while (searchFrom < input.length) {
    const start = input.indexOf('{', searchFrom);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;

    for (let i = start; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          matchedEnd = i;
          break;
        }
      }
    }

    if (matchedEnd !== -1) {
      const candidate = input.slice(start, matchedEnd + 1);
      try {
        const obj = JSON.parse(candidate);
        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
          return candidate;
        }
      } catch {}
    }

    searchFrom = start + 1;
  }

  return null;
}

export interface ParseOptions {
  taskKind: LLMTaskKind;
  evidenceLedger: EvidenceLedger;
  workspaceId: string;
  sessionId?: string;
}

/**
 * 清洗 LLM 原始输出以提取 JSON：
 * 1) 剥离 UTF-8 BOM
 * 2) 剥离推理模型生成的 <think>...</think> 思考块
 * 3) 剥离单行或多行 Markdown 代码围栏
 * 4) 若直接解析失败，按字符串转义感知提取最外层平衡的 { ... } JSON 对象
 */
export function cleanJsonText(raw: string): string {
  let cleaned = (raw || '').replace(/^\uFEFF/, '').trim();
  // 移除 <think>...</think> 思考块（含未闭合前缀后的成对块）
  cleaned = cleaned.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '').trim();

  // 支持多行与单行代码围栏：```json\n{...}\n``` 或 ```json {...} ```
  const fenceMatch = /^```(?:json)?[\t ]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?[\t ]*```$/i.exec(cleaned);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // 直接可解析为 JSON 对象时直接返回
  try {
    const direct = JSON.parse(cleaned);
    if (typeof direct === 'object' && direct !== null && !Array.isArray(direct)) {
      return cleaned;
    }
  } catch {
    // 尝试提取最外层平衡的 { ... } JSON 对象
    const extracted = extractBalancedJsonObject(cleaned);
    if (extracted !== null) {
      return extracted;
    }
  }

  return cleaned;
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
        .filter(
          (id: unknown): id is string =>
            typeof id === 'string' && VALID_MEMORY_ID_REGEX.test(id.trim())
        )
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

  const droppedNotes: string[] = [];
  const itemsToScan =
    parsed.items.length > MAX_ITEMS_SCAN
      ? (() => {
          droppedNotes.push(`items_truncated_from_${parsed.items.length}_to_${MAX_ITEMS_SCAN}`);
          return parsed.items.slice(0, MAX_ITEMS_SCAN);
        })()
      : parsed.items;

  const validated = validateMemoryItems(itemsToScan, options);
  droppedNotes.push(...validated.droppedNotes);

  // 超出任务配额时平滑截断多余条目，而非整批失败丢弃全部有效记忆
  let validItems = validated.validItems;
  if (options.taskKind === 'distill' && validItems.length > 5) {
    droppedNotes.push(`distill_excess_items_sliced: kept 5 of ${validItems.length}`);
    validItems = validItems.slice(0, 5);
  } else if (options.taskKind === 'consolidate' && validItems.length > 1) {
    droppedNotes.push(`consolidate_excess_items_sliced: kept 1 of ${validItems.length}`);
    validItems = validItems.slice(0, 1);
  }

  if (parsed.items.length > 0 && validItems.length === 0 && discardIds.length === 0) {
    return {
      success: false,
      error: 'all_items_invalid',
      droppedNotes,
    };
  }

  // 映射为 CandidateInput
  const candidateInputs = validItems.map((item) =>
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

  // reflect 允许任意索引顺序，按类别配额限制：<=1 failure|procedural 且 <=1 belief
  let reflectFailureOrProcCount = 0;
  let reflectBeliefCount = 0;

  for (let i = 0; i < rawList.length; i++) {
    const rawItem = rawList[i];
    const validationError = validateSingleItem(rawItem, options);
    if (validationError) {
      droppedNotes.push(`item[${i}]: ${validationError}`);
      continue;
    }

    if (options.taskKind === 'reflect') {
      if (rawItem.type === 'failure' || rawItem.type === 'procedural') {
        if (reflectFailureOrProcCount >= 1) {
          droppedNotes.push(`item[${i}]: reflect_excess_failure_or_procedural_sliced`);
          continue;
        }
        reflectFailureOrProcCount++;
      } else if (rawItem.type === 'belief') {
        if (reflectBeliefCount >= 1) {
          droppedNotes.push(`item[${i}]: reflect_excess_belief_sliced`);
          continue;
        }
        reflectBeliefCount++;
      }
    }

    validItems.push(rawItem as RawMemoryItem);
  }

  return { validItems, droppedNotes };
}

/**
 * 单条 MemoryItem 校验
 */
function validateSingleItem(item: any, options: ParseOptions): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return 'item_not_object';
  }

  // 1. type
  if (typeof item.type !== 'string' || !VALID_MEMORY_TYPES.has(item.type as MemoryType)) {
    return `invalid_type: ${item.type}`;
  }

  // 任务特有类型约束
  if (options.taskKind === 'reflect') {
    if (item.type !== 'failure' && item.type !== 'procedural' && item.type !== 'belief') {
      return `reflect_invalid_type: ${item.type}`;
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
  if (
    typeof item.confidence !== 'number' ||
    !Number.isFinite(item.confidence) ||
    item.confidence < 0 ||
    item.confidence > 1
  ) {
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

  const citedSessions = new Set<string>();

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

    // 同时支持匹配原始脱敏片段与带行前缀的完整渲染行（如 [T#1] tool=... / [E#1] (...)）
    const candidateTexts = [entry.redacted_text];
    if (entry.rendered_line && entry.rendered_line !== entry.redacted_text) {
      candidateTexts.push(entry.rendered_line);
    }

    const quoteMatched = candidateTexts.some(
      (sourceText) =>
        sourceText.includes(trimmedQuote) ||
        (trimmedQuote.includes(WORKSPACE_PLACEHOLDER) &&
          matchesWithWorkspaceGaps(sourceText, trimmedQuote))
    );
    if (!quoteMatched) {
      return `evidence[${j}]_quote_not_substring_of_seq_${ev.seq}`;
    }

    if (entry.session_id) {
      citedSessions.add(entry.session_id);
    }
  }

  // consolidate 必须引用覆盖 >= 3 个独立 session 的证据
  if (options.taskKind === 'consolidate' && citedSessions.size < 3) {
    return `consolidate_requires_at_least_3_distinct_sessions: got ${citedSessions.size}`;
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

  if (
    typeof parsed.reason !== 'string' ||
    parsed.reason.trim().length === 0 ||
    parsed.reason.length > 200
  ) {
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

  const candidateInputs = validItems.map((item) =>
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

  const validVerdicts = new Set([
    'potentially_useful',
    'neutral',
    'potentially_harmful',
    'unknown',
  ]);
  if (!validVerdicts.has(parsed.verdict)) {
    return { success: false, error: `invalid_judge_verdict: ${parsed.verdict}` };
  }

  if (
    typeof parsed.score !== 'number' ||
    !Number.isFinite(parsed.score) ||
    parsed.score < 0 ||
    parsed.score > 1
  ) {
    return { success: false, error: `invalid_judge_score: ${parsed.score}` };
  }

  if (
    typeof parsed.reason !== 'string' ||
    parsed.reason.trim().length === 0 ||
    parsed.reason.length > 200
  ) {
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
 * 要求至少包含合法的 discard_ids 数组或 updates 数组之一，拒绝无关垃圾 JSON 静默返回空成功。
 */
function parseCurateOutput(parsed: any): ParseResult {
  const hasDiscardArray = Array.isArray(parsed.discard_ids);
  const hasUpdatesArray = Array.isArray(parsed.updates);
  if (!hasDiscardArray && !hasUpdatesArray) {
    return {
      success: false,
      error: 'curate_missing_discard_ids_and_updates',
    };
  }

  const droppedNotes: string[] = [];

  const rawDiscards = hasDiscardArray ? parsed.discard_ids : [];
  const discardSet = new Set<string>();
  for (let i = 0; i < rawDiscards.length; i++) {
    const rawId = rawDiscards[i];
    if (typeof rawId !== 'string' || !VALID_MEMORY_ID_REGEX.test(rawId.trim())) {
      droppedNotes.push(`discard_ids[${i}]: invalid_memory_id`);
      continue;
    }
    discardSet.add(rawId.trim());
  }
  const discardIds = Array.from(discardSet).slice(0, 30);
  if (discardSet.size > 30) {
    droppedNotes.push(`discard_ids_sliced_from_${discardSet.size}_to_30`);
  }

  const rawUpdates = hasUpdatesArray ? parsed.updates : [];
  const updates: CurateUpdateItem[] = [];
  if (rawUpdates.length > 15) {
    droppedNotes.push(`updates_sliced_from_${rawUpdates.length}_to_15`);
  }

  const scanUpdates = rawUpdates.slice(0, 15);
  for (let i = 0; i < scanUpdates.length; i++) {
    const u = scanUpdates[i];
    if (!u || typeof u !== 'object' || Array.isArray(u)) {
      droppedNotes.push(`updates[${i}]: not_object`);
      continue;
    }
    const targetId = typeof u.target_id === 'string' ? u.target_id.trim() : '';
    if (!VALID_MEMORY_ID_REGEX.test(targetId)) {
      droppedNotes.push(`updates[${i}]: invalid_target_id`);
      continue;
    }

    const text = typeof u.text === 'string' ? u.text.trim() : '';
    if (text.length < 8 || text.length > 800) {
      droppedNotes.push(`updates[${i}]: text_length_out_of_range: ${text.length}`);
      continue;
    }
    const priv = redactSecrets(text);
    if (priv.hasSensitive) {
      droppedNotes.push(
        `updates[${i}]: text_contains_sensitive_data: ${priv.detectedKinds.join(',')}`
      );
      continue;
    }

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
      ? Array.from(
          new Set<string>(
            u.absorb_ids
              .filter(
                (id: unknown): id is string =>
                  typeof id === 'string' &&
                  VALID_MEMORY_ID_REGEX.test(id.trim()) &&
                  id.trim() !== targetId
              )
              .map((id: string) => id.trim())
          )
        )
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
    droppedNotes,
  };
}

/**
 * 将校验通过的 RawMemoryItem 映射为存储层的 CandidateInput
 * 注：writer.ts 对 actor === 'llm' 已统一执行 * 0.8 折扣，此处仅对 repair 叠加额外的 * 0.7 折扣，
 * 使最终落盘置信度严格为 raw * 0.8 (distill/reflect/consolidate) 与 raw * 0.56 (repair)，消除双重 0.8 折扣。
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
  let confidence = item.confidence;
  if (options.taskKind === 'repair') {
    confidence = confidence * 0.7;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  // 映射证据到真实 sources
  const sources = item.evidence.map((ev) => {
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
