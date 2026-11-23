import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../types.js';

/**
 * 规范化路径（消除 Windows \\?\ 长路径前缀、尝试解析符号链接/junction/8.3 短路径、统一分隔符与大小写）
 */
export function normalizeWorkspacePath(cwd: string): string {
  if (!cwd) return '';
  let input = cwd.trim();
  if (!input) return '';

  // 剥离 Windows 扩展长路径前缀 \\?\ 或 //?/
  if (input.startsWith('\\\\?\\UNC\\') || input.startsWith('//?/UNC/')) {
    input = '\\\\' + input.slice(8);
  } else if (input.startsWith('\\\\?\\') || input.startsWith('//?/')) {
    input = input.slice(4);
  }

  let resolved = path.resolve(input);
  try {
    resolved =
      typeof fs.realpathSync.native === 'function'
        ? fs.realpathSync.native(resolved)
        : fs.realpathSync(resolved);
  } catch {
    // 目录尚不存在或无权访问时回退 path.resolve 结果
  }

  if (resolved.startsWith('\\\\?\\UNC\\')) {
    resolved = '\\\\' + resolved.slice(8);
  } else if (resolved.startsWith('\\\\?\\')) {
    resolved = resolved.slice(4);
  }

  if (process.platform === 'win32' || process.platform === 'darwin') {
    resolved = resolved.toLowerCase();
  }
  resolved = resolved.replace(/\\/g, '/');
  while (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * 1) 16 位十六进制工作区 ID 直接小写透传
 * 2) 规范化路径（resolve + realpathSync + Windows/macOS 小写 + '/' + 去尾斜杠）
 * 3) sha256 后取前 16 位十六进制
 */
export function workspaceId(cwd: string): string {
  if (!cwd) return '';
  const trimmed = cwd.trim();
  if (!trimmed) return '';
  if (/^[0-9a-f]{16}$/i.test(trimmed)) return trimmed.toLowerCase();

  const normalized = normalizeWorkspacePath(trimmed);
  if (!normalized) return '';

  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * 在 meta 中登记 workspace_id -> 本地规范化路径（仅本地匿名化使用，不随导出外泄）
 */
export function rememberWorkspacePath(db: Db, rawPath: string): string {
  const trimmed = (rawPath || '').trim();
  if (!trimmed || /^[0-9a-f]{16}$/i.test(trimmed)) return workspaceId(trimmed);
  const wsId = workspaceId(trimmed);
  if (!wsId) return '';
  try {
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      `ws_path:${wsId}`,
      path.resolve(trimmed),
    ]);
  } catch {}
  return wsId;
}

/**
 * 将路径或 16-hex workspaceId 解析为真实本地路径（用于离线脱敏/受控同步；找不到返回 undefined）
 */
export function resolveWorkspaceCwd(
  db: Db | undefined,
  workspaceIdOrPath?: string
): string | undefined {
  const raw = (workspaceIdOrPath || '').trim();
  if (!raw) return undefined;
  if (!/^[0-9a-f]{16}$/i.test(raw)) {
    return path.resolve(raw);
  }
  if (!db) return undefined;
  try {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      `ws_path:${raw.toLowerCase()}`,
    ]);
    if (row?.value) return row.value;
  } catch {}
  return undefined;
}

/**
 * Scope 过滤 SQL
 * - 有 sessionId: "(scope IN ('user','global') OR (scope='workspace' AND workspace_id=?) OR (scope='session' AND workspace_id=? AND session_id=?))"
 * - 无 sessionId: "(scope IN ('user','global') OR (scope='workspace' AND workspace_id=?))" — 严格阻止跨会话泄漏
 */
export function scopeFilterSQL(
  ctx: { workspaceId: string; sessionId?: string },
  tableAlias?: string
): {
  sql: string;
  params: unknown[];
} {
  const p = tableAlias ? `${tableAlias}.` : '';
  const ws = ctx.workspaceId || '';
  const sid = typeof ctx.sessionId === 'string' ? ctx.sessionId.trim() : '';

  if (sid) {
    return {
      sql: `(${p}scope IN ('user','global') OR (${p}scope='workspace' AND ${p}workspace_id=?) OR (${p}scope='session' AND ${p}workspace_id=? AND ${p}session_id=?))`,
      params: [ws, ws, sid],
    };
  }
  return {
    sql: `(${p}scope IN ('user','global') OR (${p}scope='workspace' AND ${p}workspace_id=?))`,
    params: [ws],
  };
}
