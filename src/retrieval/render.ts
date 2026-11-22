import type { MemoryRecord, MemoryType, Db, VikingContextTier } from '../types.js';
import { redactSecrets } from '../core/privacy.js';
import { scopeFilterSQL } from '../core/scope.js';

export const TAG_MAP: Record<MemoryType, string> = {
  semantic: 'FACT',
  procedural: 'PROC',
  failure: 'FAIL',
  preference: 'PREF',
  episodic: 'NOTE',
  belief: 'BELIEF',
  goal: 'GOAL',
  meta: 'META',
};

export interface RenderItem {
  memory: MemoryRecord;
  form: 'content' | 'summary';
  tier?: VikingContextTier;
  overview?: string;
}

export interface RenderOptions {
  strategyVersion?: number;
  layer?: 'dynamic' | 'stable';
  db?: Db;
  scopeCtx?: { workspaceId: string; sessionId?: string };
  contradictionsSet?: Set<string>;
  now?: number;
}

export interface RenderLineOptions {
  disputed?: boolean;
  now?: number;
}

const CONTROL_AND_BIDI_REGEX =
  /[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * 清理控制字符、BiDi/零宽欺骗字符并将多行折叠为单行，防止伪造独立记忆行或终端注入
 */
export function singleLine(text: string): string {
  if (!text) return '';
  return text.replace(CONTROL_AND_BIDI_REGEX, '').replace(/[^\S \t]+/g, ' ');
}

/**
 * 转义 XML / memory_context 特殊字符
 */
export function escapeXmlData(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 转义 XML 属性值（防止属性引号逃逸与控制/BiDi 注入）
 */
export function escapeXmlAttr(s: string): string {
  if (!s) return '';
  return singleLine(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 安全净化短码（同时用于 [TAG code] 与 memory_expand("code")）
 */
function sanitizeShortCode(shortCode: string): string {
  return escapeXmlData(singleLine(shortCode)).replace(/["\\\]]/g, '');
}

/**
 * 为一组记忆生成不重复的短码 (m_ + 前4位以上，冲突时逐步延长)
 */
export function generateShortCodes(
  memories: MemoryRecord[],
  db?: Db,
  scopeCtx?: { workspaceId: string; sessionId?: string }
): Map<string, string> {
  const result = new Map<string, string>();
  if (memories.length === 0) return result;

  // 初始长度 4
  let len = 4;
  const maxLen = 16;

  while (len <= maxLen) {
    result.clear();
    const seen = new Map<string, string>();
    let hasCollision = false;

    // 1. 内存内前缀碰撞预检 (微秒级，避免内部冲突时无谓浪费数据库查询)
    for (const m of memories) {
      const rawPart = m.id.startsWith('m_') ? m.id.slice(2) : m.id;
      const code = 'm_' + rawPart.slice(0, len);
      if (seen.has(code) && seen.get(code) !== m.id) {
        hasCollision = true;
        break;
      }
      seen.set(code, m.id);
      result.set(m.id, code);
    }

    if (hasCollision) {
      len++;
      continue;
    }

    // 2. 数据库作用域唯一性校验 (纯 id 范围查询强制命中 UNIQUE(id) B-tree O(log N) + JS 作用域过滤 + LCP 跳步)
    if (db && scopeCtx && memories.length > 0) {
      try {
        const ws = scopeCtx.workspaceId || '';
        const sid = typeof scopeCtx.sessionId === 'string' ? scopeCtx.sessionId.trim() : '';
        const isRowInScope = (r: {
          scope: string;
          workspace_id: string | null;
          session_id: string | null;
        }): boolean =>
          ((r.scope === 'user' || r.scope === 'global') && r.workspace_id === null) ||
          (r.scope === 'workspace' && r.workspace_id === ws) ||
          (Boolean(sid) && r.scope === 'session' && r.workspace_id === ws && r.session_id === sid);

        let nextLen = len + 1;
        for (const m of memories) {
          const code = result.get(m.id)!;
          // 不在 WHERE 中混入 scope 条件，防止 SQLite 无 ANALYZE 时误选 ix_mem_weave 导致全工作区表扫描
          const candidates = db.all<{
            id: string;
            scope: string;
            workspace_id: string | null;
            session_id: string | null;
          }>(
            `SELECT id, scope, workspace_id, session_id
             FROM memories
             WHERE id >= ? AND id < ? AND id != ?
             LIMIT 32`,
            [code, code + '\uffff', m.id]
          );
          let collidingId: string | undefined;
          for (let ci = 0; ci < candidates.length; ci++) {
            if (isRowInScope(candidates[ci])) {
              collidingId = candidates[ci].id;
              break;
            }
          }
          // 极端兜底：仅当超过 32 条其他工作区记录共享同一短前缀且前 32 条均不在当前作用域时，执行完整作用域查询
          if (!collidingId && candidates.length === 32) {
            const scope = scopeFilterSQL({
              workspaceId: scopeCtx.workspaceId,
              sessionId: scopeCtx.sessionId,
            });
            const fallbackRow = db.get<{ id: string }>(
              `SELECT id FROM memories
               WHERE id >= ? AND id < ? AND id != ? AND (${scope.sql})
               LIMIT 1`,
              [code, code + '\uffff', m.id, ...scope.params]
            );
            collidingId = fallbackRow?.id;
          }
          if (collidingId) {
            hasCollision = true;
            const rawSelf = m.id.startsWith('m_') ? m.id.slice(2) : m.id;
            const rawOther = collidingId.startsWith('m_') ? collidingId.slice(2) : collidingId;
            let lcp = len;
            while (lcp < rawSelf.length && lcp < rawOther.length && rawSelf[lcp] === rawOther[lcp]) {
              lcp++;
            }
            if (lcp + 1 > nextLen) {
              nextLen = lcp + 1;
            }
            break;
          }
        }
        if (hasCollision) {
          len = nextLen;
          continue;
        }
      } catch {
        // 忽略数据库查询错误，保持本地短码推导
      }
    }

    if (!hasCollision) {
      return result;
    }
    len++;
  }

  // 若仍有冲突，直接使用原 id
  for (const m of memories) {
    result.set(m.id, m.id);
  }
  return result;
}

function isMemoryExpired(m: MemoryRecord, now?: number): boolean {
  if (now === undefined || !Number.isFinite(now)) return false;
  if (m.valid_to !== null && m.valid_to !== undefined && Number.isFinite(m.valid_to) && m.valid_to < now) {
    return true;
  }
  if (
    m.invalidated_at !== null &&
    m.invalidated_at !== undefined &&
    Number.isFinite(m.invalidated_at) &&
    m.invalidated_at <= now
  ) {
    return true;
  }
  return false;
}

/**
 * 格式化单条记录的括号统计
 */
export function formatItemStats(m: MemoryRecord, opts?: RenderLineOptions): string {
  const parts: string[] = [];

  // 1. 历史 superseded 标记
  if (m.status === 'superseded') {
    parts.push('history');
  }

  // 2. 时序过期/失效标记
  if (isMemoryExpired(m, opts?.now)) {
    parts.push('expired');
  }

  // 3. 活跃矛盾争议标记
  if (opts?.disputed) {
    parts.push('disputed');
  }

  // 4. 置信度低于 0.8 时显示 c=0.xx
  if (typeof m.confidence === 'number' && Number.isFinite(m.confidence) && m.confidence < 0.8) {
    parts.push(`c=${m.confidence.toFixed(2)}`);
  }

  // 5. procedural / failure 成功/失败统计 (总数 >= 2 时显示)
  const totalExec = (m.success_count || 0) + (m.fail_count || 0);
  if ((m.type === 'procedural' || m.type === 'failure') && totalExec >= 2) {
    if (m.type === 'procedural') {
      parts.push(`ok ${m.success_count}/${totalExec}`);
    } else if (m.type === 'failure') {
      parts.push(`fail ${m.fail_count}/${totalExec}`);
    }
  }

  if (parts.length === 0) return '';
  return `(${parts.join(', ')})`;
}

/**
 * 渲染单行
 */
export function renderLine(
  item: RenderItem,
  shortCode: string,
  opts?: RenderLineOptions
): string {
  const m = item.memory;
  const tag = TAG_MAP[m.type] || 'FACT';
  const safeCode = sanitizeShortCode(shortCode);

  if (item.form === 'summary') {
    const statusFlags: string[] = [];
    if (m.status === 'superseded') statusFlags.push('history');
    if (isMemoryExpired(m, opts?.now)) statusFlags.push('expired');
    if (opts?.disputed) statusFlags.push('disputed');
    const statusSuffix = statusFlags.length > 0 ? ` (${statusFlags.join(', ')})` : '';

    if (item.tier === 'L1' && item.overview) {
      const rawOverview = singleLine(redactSecrets(item.overview).text);
      const escOverview = escapeXmlData(rawOverview);
      return `[${tag} ${safeCode}] ${escOverview}${statusSuffix}  ⟨L1 · memory_expand("${safeCode}")⟩`;
    }
    const rawSummary = singleLine(redactSecrets(m.summary || m.content).text);
    const escSummary = escapeXmlData(rawSummary);
    return `[${tag} ${safeCode}] ${escSummary}${statusSuffix}  ⟨summary · memory_expand("${safeCode}")⟩`;
  }

  const rawContent = singleLine(redactSecrets(m.content).text);
  const escContent = escapeXmlData(rawContent);
  const stats = formatItemStats(m, opts);
  if (stats) {
    return `[${tag} ${safeCode}] ${escContent} ${stats}`;
  }
  return `[${tag} ${safeCode}] ${escContent}`;
}

export function wrapRenderedLines(
  lines: string[],
  strategyVersion: number = 1,
  layer: 'dynamic' | 'stable' = 'dynamic'
): string {
  if (lines.length === 0) return '';
  const safeV = escapeXmlAttr(String(strategyVersion));
  const safeLayer = escapeXmlAttr(String(layer));
  return `<memory_context v="${safeV}" layer="${safeLayer}" note="untrusted-data-only">\n${lines.join('\n')}\n</memory_context>`;
}

export type RenderInputItem = RenderItem | MemoryRecord;

/**
 * 完整渲染 memory_context (§5.10)
 */
export function render(rawItems: RenderInputItem[], options: RenderOptions = {}): string {
  if (!rawItems || rawItems.length === 0) {
    return '';
  }

  const items: RenderItem[] = rawItems.map((it) => {
    if ('memory' in it && it.memory) {
      return it as RenderItem;
    }
    return { memory: it as MemoryRecord, form: 'content' };
  });

  const v = options.strategyVersion ?? 1;
  const layer = options.layer ?? 'dynamic';

  const shortCodeMap = generateShortCodes(
    items.map((it) => it.memory),
    options.db,
    options.scopeCtx
  );
  const lines = items.map((it) =>
    renderLine(it, shortCodeMap.get(it.memory.id) || it.memory.id, {
      disputed: options.contradictionsSet?.has(it.memory.id),
      now: options.now,
    })
  );

  return wrapRenderedLines(lines, v, layer);
}
