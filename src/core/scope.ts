import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 1) path.resolve(cwd)
 * 2) Windows 下转小写
 * 3) 反斜杠替换成 /
 * 4) 去掉末尾的 /
 * 5) sha256 后取前 16 位十六进制
 */
export function workspaceId(cwd: string): string {
  if (!cwd) return '';
  if (/^[0-9a-f]{16}$/i.test(cwd)) return cwd.toLowerCase();
  let resolved = path.resolve(cwd);
  if (process.platform === 'win32') {
    resolved = resolved.toLowerCase();
  }
  resolved = resolved.replace(/\\/g, '/');
  while (resolved.length > 1 && resolved.endsWith('/')) {
    resolved = resolved.slice(0, -1);
  }

  return crypto
    .createHash('sha256')
    .update(resolved)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Scope 过滤 SQL
 * 返回：
 * "(scope IN ('user','global') OR (scope='workspace' AND workspace_id=?) OR (scope='session' AND workspace_id=? AND session_id=?))"
 * params = [workspaceId, workspaceId, sessionId]
 */
export function scopeFilterSQL(ctx: { workspaceId: string; sessionId?: string }): {
  sql: string;
  params: unknown[];
} {
  return {
    sql: "(scope IN ('user','global') OR (scope='workspace' AND workspace_id=?) OR (scope='session' AND workspace_id=? AND session_id=?))",
    params: [ctx.workspaceId || '', ctx.workspaceId || '', ctx.sessionId ?? ''],
  };
}
