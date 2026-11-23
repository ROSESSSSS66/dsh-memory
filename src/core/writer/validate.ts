import crypto from 'node:crypto';
import { DEFAULTS } from '../../config.js';
import { type CandidateInput, type OriginKind, parseOriginKinds, type Scope } from '../../types.js';
import { redactSecrets } from '../privacy.js';
import { workspaceId } from '../scope.js';
import { contentHash } from '../text.js';
import { estimateTokens } from '../tokens.js';
import { hasUntrustedOrigin, isUntrustedSourceKind } from '../trust.js';

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const MAX_EXCERPT_CODE_POINTS = 300;

export interface WriterLimits {
  maxContentTokens?: number;
  maxSummaryTokens?: number;
  dupJaccard?: number;
}

export interface SanitizedSourceInput {
  session_id: string;
  seq: number;
  kind: string;
  excerpt: string | null;
}

export interface PreparedCandidate {
  c: CandidateInput;
  rawContent: string;
  rawSummary: string;
  contentTokens: number;
  summaryTokens: number;
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
  originKinds: OriginKind[];
  isExplicitUser: boolean;
  isTainted: boolean;
  initialStatus: 'active' | 'candidate';
  approved_at: number | null;
  approved_by: string | null;
  confidence: number;
  hash: string;
  slotKey: string | null;
  sanitizedSources: SanitizedSourceInput[];
}

/**
 * 使用密码学安全随机数生成 16 位 Crockford Base32 记忆 ID（均匀无偏，32 整除 256）
 */
export function generateId(): string {
  const bytes = crypto.randomBytes(16);
  let id = 'm_';
  for (let i = 0; i < 16; i++) {
    id += ID_ALPHABET[bytes[i] & 31];
  }
  return id;
}

/**
 * 按 Unicode 码点安全截断字符串，绝不劈断 UTF-16 代理对（Emoji / CJK Ext-B+）
 */
export function truncateCodePoints(str: string, maxCodePoints: number): string {
  if (!str || maxCodePoints <= 0) return '';
  let count = 0;
  let idx = 0;
  while (idx < str.length && count < maxCodePoints) {
    const cp = str.codePointAt(idx)!;
    idx += cp > 0xffff ? 2 : 1;
    count++;
  }
  return idx < str.length ? str.slice(0, idx) : str;
}

/**
 * 按 token 上限执行码点安全截断，保证 estimateTokens(result) <= maxTokens
 */
export function truncateToTokens(str: string, maxTokens: number): string {
  if (!str || maxTokens <= 0) return '';
  if (estimateTokens(str) <= maxTokens) return str;

  const cps = Array.from(str);
  let lo = 0;
  let hi = cps.length;
  let best = '';

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = cps.slice(0, mid).join('').trimEnd();
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

/**
 * 将证据摘录安全截断至最多 maxCodePoints（默认 300）个 Unicode 码点
 */
export function truncateExcerpt(
  excerpt: string | null | undefined,
  maxCodePoints: number = MAX_EXCERPT_CODE_POINTS
): string | null {
  if (excerpt === undefined || excerpt === null || excerpt === '') return null;
  return truncateCodePoints(excerpt, maxCodePoints);
}

/**
 * 取正文首句作为摘要。英文句点仅在其后为空白或结尾时才算句末，
 * 否则 "Node.js"、"src/core/db.ts"、"v1.2.3" 会被截成 "Node." 这类无意义摘要。
 */
export function firstSentence(content: string): string {
  const match = content.match(/^[\s\S]*?(?:[。！？!?\n]|\.(?=\s|$))/);
  const sentence = match ? match[0].trim() : '';
  return sentence.length >= 8 ? sentence : truncateCodePoints(content, 80);
}

export function resolveScopeAndOwners(c: CandidateInput): {
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
} {
  let scope: Scope = c.scope || DEFAULTS.defaultScope;
  if (!c.scope) {
    if (c.type === 'preference') scope = 'user';
    else if (c.type === 'meta') scope = 'global';
    else scope = 'workspace';
  }

  let workspace_id: string | null = null;
  let session_id: string | null = null;

  if (scope === 'workspace') {
    workspace_id = c.workspaceId ? workspaceId(c.workspaceId) : workspaceId(process.cwd());
  } else if (scope === 'session') {
    workspace_id = c.workspaceId ? workspaceId(c.workspaceId) : workspaceId(process.cwd());
    session_id = c.sessionId || 'default_session';
  }

  return { scope, workspace_id, session_id };
}

export function deriveOriginKinds(c: CandidateInput): OriginKind[] {
  const originSet = new Set<OriginKind>(parseOriginKinds(c.origin_kinds));
  if (Array.isArray(c.sources)) {
    for (const s of c.sources) {
      const k = (s.kind || '').toLowerCase().trim();
      if (k === 'user' || k === 'user_msg') originSet.add('user');
      else if (k === 'tool' || k === 'tool_result' || k === 'tool_call') originSet.add('tool');
      else if (k === 'assistant' || k === 'assistant_msg') originSet.add('assistant');
      else if (k === 'web') originSet.add('web');
      else if (k === 'system' || k === 'system_msg') originSet.add('system');
    }
  }
  if (c.source_kind === 'web') originSet.add('web');
  if (c.source_kind === 'tool') originSet.add('tool');

  return Array.from(originSet);
}

export function validateAndPrepareCandidate(
  c: CandidateInput,
  now: number,
  cfg?: WriterLimits
): { ok: true; data: PreparedCandidate } | { ok: false; reason: string } {
  const maxContentTokens = cfg?.maxContentTokens ?? DEFAULTS.maxContentTokens;
  const maxSummaryTokens = cfg?.maxSummaryTokens ?? DEFAULTS.maxSummaryTokens;

  const rawContent = (c.content || '').trim();
  if (!rawContent) {
    return { ok: false, reason: 'empty_content' };
  }

  if (redactSecrets(rawContent).hasSensitive) {
    return { ok: false, reason: 'sensitive_content_detected' };
  }

  const contentTokens = estimateTokens(rawContent);
  if (contentTokens > maxContentTokens) {
    return { ok: false, reason: 'content_exceeds_max_tokens' };
  }

  let rawSummary = (c.summary || '').trim();
  if (!rawSummary) {
    rawSummary = firstSentence(rawContent);
  }
  if (redactSecrets(rawSummary).hasSensitive) {
    return { ok: false, reason: 'sensitive_content_detected' };
  }
  if (estimateTokens(rawSummary) > maxSummaryTokens) {
    rawSummary = truncateToTokens(rawSummary, maxSummaryTokens);
  }
  const summaryTokens = estimateTokens(rawSummary);

  if (!c.sources || !Array.isArray(c.sources) || c.sources.length === 0) {
    return { ok: false, reason: 'sources_required' };
  }
  // 隐私扫描必须在截断前覆盖完整 excerpt，避免敏感信息藏在 300 码点之后逃逸
  for (const s of c.sources) {
    if (s.excerpt && redactSecrets(s.excerpt).hasSensitive) {
      return { ok: false, reason: 'sensitive_content_detected' };
    }
  }
  const sanitizedSources: SanitizedSourceInput[] = c.sources.map((s) => ({
    session_id: s.session_id,
    seq: s.seq,
    kind: s.kind,
    excerpt: truncateExcerpt(s.excerpt),
  }));

  const { scope, workspace_id, session_id } = resolveScopeAndOwners(c);
  const originKinds = deriveOriginKinds(c);

  const isTainted =
    hasUntrustedOrigin({ origin_kinds: originKinds, source_kind: c.source_kind }) ||
    originKinds.includes('tool') ||
    originKinds.includes('web') ||
    c.source_kind === 'web' ||
    c.source_kind === 'tool' ||
    sanitizedSources.some((s) => isUntrustedSourceKind(s.kind));

  let isExplicitUser = false;
  if (
    (c.source_kind === 'user' && c.actor === 'user') ||
    (c.status === 'active' && (c.actor === 'user' || c.actor === 'system'))
  ) {
    isExplicitUser = true;
  }

  let initialStatus: 'active' | 'candidate' = 'candidate';
  let approved_at: number | null = null;
  let approved_by: string | null = null;

  if (isExplicitUser) {
    initialStatus = 'active';
    approved_at = now;
    approved_by = c.actor || 'user';
  }

  let confidence =
    typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  if (c.actor === 'llm') {
    confidence *= 0.8;
  }

  // P0 污点隔离：凡携带 web / tool 不可信来源，必须强制清空显式审批标记并降级为 candidate
  if (isTainted) {
    confidence = Math.min(confidence, 0.5);
    initialStatus = 'candidate';
    isExplicitUser = false;
    approved_at = null;
    approved_by = null;
  }

  const hash = contentHash(c.type, rawContent);
  const slotKey = c.slot_key ? c.slot_key.trim() || null : null;

  return {
    ok: true,
    data: {
      c,
      rawContent,
      rawSummary,
      contentTokens,
      summaryTokens,
      scope,
      workspace_id,
      session_id,
      originKinds,
      isExplicitUser,
      isTainted,
      initialStatus,
      approved_at,
      approved_by,
      confidence,
      hash,
      slotKey,
      sanitizedSources,
    },
  };
}
