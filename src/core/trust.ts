import { parseOriginKinds, type Db, type MemoryRecord, type OriginKind } from '../types.js';

const UNTRUSTED_SOURCE_KINDS = new Set(['web', 'tool', 'tool_result', 'tool_call']);

/**
 * 判断来源或 origin_kinds 是否携带不可信外部污点 (web / tool)
 */
export function hasUntrustedOrigin(
  memoryOrOrigins: Pick<MemoryRecord, 'origin_kinds' | 'source_kind'> | readonly OriginKind[] | string
): boolean {
  if (Array.isArray(memoryOrOrigins) || typeof memoryOrOrigins === 'string') {
    const origins = parseOriginKinds(memoryOrOrigins);
    return origins.includes('web') || origins.includes('tool');
  }
  const rec = memoryOrOrigins as Pick<MemoryRecord, 'origin_kinds' | 'source_kind'>;
  if (rec.source_kind === 'web' || rec.source_kind === 'tool') return true;
  const origins = parseOriginKinds(rec.origin_kinds);
  return origins.includes('web') || origins.includes('tool');
}

/**
 * 将 memory_sources.kind 规范化为 OriginKind（未知来源一律回退 'system'，禁止回退 'user'）
 */
export function sourceKindToOriginKind(kind: string | null | undefined): OriginKind {
  const k = (kind || '').toLowerCase().trim();
  if (k === 'user' || k === 'user_msg') return 'user';
  if (k === 'assistant' || k === 'assistant_msg') return 'assistant';
  if (k === 'web') return 'web';
  if (k === 'tool' || k === 'tool_result' || k === 'tool_call') return 'tool';
  return 'system';
}

/**
 * 强独立用户证据判定：
 * 1. 当前 content_rev 必须存在显式 user/user_msg 证据；
 * 2. 同时该记忆不得携带任何 web/tool 污点（无论在 origin_kinds 还是当前 content_rev 的 memory_sources 中），
 *    防止混合 turn 里的工具/网页提示注入借普通用户消息洗白提权。
 */
export function hasUserEvidence(db: Db, memory: MemoryRecord): boolean {
  if (hasUntrustedOrigin(memory)) return false;

  const hasUser = !!db.get(
    `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ?
     AND kind IN ('user', 'user_msg') LIMIT 1`,
    [memory.id, memory.content_rev]
  );
  if (!hasUser) return false;

  const hasTaintedSource = !!db.get(
    `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ?
     AND kind IN ('web', 'tool', 'tool_result', 'tool_call') LIMIT 1`,
    [memory.id, memory.content_rev]
  );
  return !hasTaintedSource;
}

export function isUntrustedSourceKind(kind: string | null | undefined): boolean {
  return UNTRUSTED_SOURCE_KINDS.has((kind || '').toLowerCase().trim());
}
