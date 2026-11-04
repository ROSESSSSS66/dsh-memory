import type { Db, MemoryRecord, MemorySource, MemoryType, MemoryStatus, Scope } from '../types.js';

export interface ListFilter {
  type?: MemoryType;
  status?: MemoryStatus;
  scope?: Scope;
  workspaceId?: string;
  sessionId?: string;
  slotKey?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  avgConfidence: number;
  avgUtility: number;
}

/**
 * 按完整 ID 或短码获取单条记忆
 */
export function get(
  db: Db,
  idOrShortId: string,
  scopeCtx?: { workspaceId?: string; sessionId?: string }
): MemoryRecord | undefined {
  if (!idOrShortId) return undefined;

  // 完整 ID
  if (idOrShortId.startsWith('m_') && idOrShortId.length >= 18) {
    return db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [idOrShortId]);
  }

  // 短码查询: 必须以 m_ 开头
  const pattern = idOrShortId.startsWith('m_') ? idOrShortId + '%' : 'm_' + idOrShortId + '%';
  let sql = 'SELECT * FROM memories WHERE id LIKE ?';
  const params: unknown[] = [pattern];

  if (scopeCtx?.workspaceId) {
    sql += ' AND (workspace_id = ? OR workspace_id IS NULL)';
    params.push(scopeCtx.workspaceId);
  }

  const matches = db.all<MemoryRecord>(sql, params);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  // 歧义短码必须报错并列出候选
  const ids = matches.map(m => m.id).join(', ');
  throw new Error(`Ambiguous short id '${idOrShortId}', matches: ${ids}`);
}

/**
 * 条件列表查询
 */
export function list(db: Db, filter: ListFilter = {}): MemoryRecord[] {
  let sql = 'SELECT * FROM memories WHERE 1=1';
  const params: unknown[] = [];

  if (filter.type) {
    sql += ' AND type = ?';
    params.push(filter.type);
  }
  if (filter.status) {
    sql += ' AND status = ?';
    params.push(filter.status);
  }
  if (filter.scope) {
    sql += ' AND scope = ?';
    params.push(filter.scope);
  }
  if (filter.workspaceId) {
    sql += ' AND workspace_id = ?';
    params.push(filter.workspaceId);
  }
  if (filter.sessionId) {
    sql += ' AND session_id = ?';
    params.push(filter.sessionId);
  }
  if (filter.slotKey) {
    sql += ' AND slot_key = ?';
    params.push(filter.slotKey);
  }

  sql += ' ORDER BY created_at DESC';

  if (typeof filter.limit === 'number' && filter.limit > 0) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
    if (typeof filter.offset === 'number' && filter.offset > 0) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }
  }

  return db.all<MemoryRecord>(sql, params);
}

/**
 * 查询单条记忆的历史版本快照
 */
export function history(
  db: Db,
  id: string
): { version: number; snapshot: any; reason: string; actor: string; created_at: number }[] {
  const rows = db.all<{
    version: number;
    snapshot: string;
    reason: string;
    actor: string;
    created_at: number;
  }>('SELECT version, snapshot, reason, actor, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version ASC', [id]);

  return rows.map(r => ({
    version: r.version,
    snapshot: JSON.parse(r.snapshot),
    reason: r.reason,
    actor: r.actor,
    created_at: r.created_at,
  }));
}

/**
 * 查询单条记忆关联的原始 Session 证据
 */
export function sources(db: Db, id: string, contentRev?: number): MemorySource[] {
  if (typeof contentRev === 'number') {
    return db.all<MemorySource>(
      'SELECT * FROM memory_sources WHERE memory_id = ? AND content_rev = ? ORDER BY created_at ASC',
      [id, contentRev]
    );
  }
  return db.all<MemorySource>(
    'SELECT * FROM memory_sources WHERE memory_id = ? ORDER BY created_at ASC',
    [id]
  );
}

/**
 * 统计概况
 */
export function stats(db: Db, workspaceIdFilter?: string): MemoryStats {
  let baseSql = 'SELECT status, type, confidence, utility FROM memories';
  const params: unknown[] = [];
  if (workspaceIdFilter) {
    baseSql += ' WHERE workspace_id = ? OR workspace_id IS NULL';
    params.push(workspaceIdFilter);
  }

  const rows = db.all<{ status: string; type: string; confidence: number; utility: number }>(baseSql, params);

  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};
  let totalConf = 0;
  let totalUtil = 0;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byType[r.type] = (byType[r.type] || 0) + 1;
    totalConf += r.confidence;
    totalUtil += r.utility;
  }

  const total = rows.length;
  return {
    total,
    byStatus,
    byType,
    avgConfidence: total > 0 ? totalConf / total : 0,
    avgUtility: total > 0 ? totalUtil / total : 0,
  };
}
