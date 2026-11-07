import type { MemoryRecord, MemoryType, Db } from '../types.js';
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
}

export interface RenderOptions {
  strategyVersion?: number;
  layer?: 'dynamic' | 'stable';
  db?: Db;
  scopeCtx?: { workspaceId: string; sessionId?: string };
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

    // 2. 数据库作用域唯一性校验
    if (db && scopeCtx) {
      try {
        const scope = scopeFilterSQL({
          workspaceId: scopeCtx.workspaceId,
          sessionId: scopeCtx.sessionId || '',
        });
        for (const m of memories) {
          const code = result.get(m.id)!;
          const row = db.get<{ cnt: number }>(
            `SELECT COUNT(*) as cnt FROM memories WHERE id >= ? AND id < ? AND ${scope.sql} AND id != ?`,
            [code, code + '\uffff', ...scope.params, m.id]
          );
          if (row && row.cnt > 0) {
            hasCollision = true;
            break;
          }
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

/**
 * 格式化单条记录的括号统计
 */
export function formatItemStats(m: MemoryRecord): string {
  const parts: string[] = [];

  // 1. 历史 superseded 标记
  if (m.status === 'superseded') {
    parts.push('history');
  }

  // 2. 置信度低于 0.8 时显示 c=0.xx
  if (m.confidence < 0.8) {
    parts.push(`c=${m.confidence.toFixed(2)}`);
  }

  // 3. procedural / failure 成功/失败统计 (总数 >= 2 时显示)
  const totalExec = m.success_count + m.fail_count;
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
export function renderLine(item: RenderItem, shortCode: string): string {
  const m = item.memory;
  const tag = TAG_MAP[m.type] || 'FACT';

  if (item.form === 'summary') {
    const rawSummary = redactSecrets(m.summary || m.content).text;
    const escSummary = escapeXmlData(rawSummary);
    return `[${tag} ${shortCode}] ${escSummary}  ⟨summary · memory_expand("${shortCode}")⟩`;
  }

  const rawContent = redactSecrets(m.content).text;
  const escContent = escapeXmlData(rawContent);
  const stats = formatItemStats(m);
  if (stats) {
    return `[${tag} ${shortCode}] ${escContent} ${stats}`;
  }
  return `[${tag} ${shortCode}] ${escContent}`;
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
  const lines = items.map((it) => renderLine(it, shortCodeMap.get(it.memory.id) || it.memory.id));

  return `<memory_context v="${v}" layer="${layer}">\n${lines.join('\n')}\n</memory_context>`;
}
