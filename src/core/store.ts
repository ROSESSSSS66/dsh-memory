import type {
  Db,
  MemoryRecord,
  MemorySource,
  MemoryType,
  MemoryStatus,
  Scope,
  GraphData,
  GraphNode,
  GraphLink,
} from '../types.js';
import { workspaceId } from './scope.js';

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

/**
 * 获取知识图谱拓扑数据 (灵感汲取自 qwert702/dsh-memory 与 omdsh-dev/dsh-mnemon)
 */
export function getGraphData(
  db: Db,
  options?: {
    workspaceId?: string;
    scope?: Scope;
    limit?: number;
    includeEntities?: boolean;
    status?: MemoryStatus[];
  }
): GraphData {
  const limit = Math.max(1, Math.min(200, options?.limit ?? 80));
  const includeEntities = options?.includeEntities ?? true;
  const statuses = options?.status || ['active', 'candidate', 'frozen', 'superseded'];
  const statusPlaceholders = statuses.map(() => '?').join(', ');

  let memSql = `SELECT * FROM memories WHERE status IN (${statusPlaceholders})`;
  const params: any[] = [...statuses];

  if (options?.scope) {
    memSql += ' AND scope = ?';
    params.push(options.scope);
  }
  if (options?.workspaceId) {
    const wsId = workspaceId(options.workspaceId);
    memSql += ' AND (workspace_id = ? OR workspace_id IS NULL)';
    params.push(wsId);
  }

  memSql += ' ORDER BY pinned DESC, updated_at DESC LIMIT ?';
  params.push(limit);

  const memRows = db.all<MemoryRecord>(memSql, params);
  const memIds = new Set(memRows.map((m) => m.id));

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const connectionCounts = new Map<string, number>();

  function bumpConn(id: string) {
    connectionCounts.set(id, (connectionCounts.get(id) || 0) + 1);
  }

  // 1. 添加 Memory 节点
  for (const m of memRows) {
    const shortLabel = (m.summary || m.content).slice(0, 36).replace(/[\r\n]+/g, ' ');
    nodes.push({
      id: m.id,
      label: `[${m.type.toUpperCase()}] ${shortLabel}`,
      type: 'memory',
      memoryType: m.type,
      scope: m.scope,
      status: m.status,
      confidence: m.confidence,
      utility: m.utility,
      pinned: m.pinned,
    });
  }

  // 2. 关系 Links (supersedes, contradicts, derived_from, related)
  if (memRows.length > 0) {
    const placeholders = memRows.map(() => '?').join(', ');
    const relRows = db.all<{ from_id: string; to_id: string; rel: string }>(
      `SELECT from_id, to_id, rel FROM memory_relations
       WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`,
      [...memRows.map((m) => m.id), ...memRows.map((m) => m.id)]
    );

    for (const r of relRows) {
      if (memIds.has(r.from_id) && memIds.has(r.to_id)) {
        links.push({
          source: r.from_id,
          target: r.to_id,
          rel: r.rel,
        });
        bumpConn(r.from_id);
        bumpConn(r.to_id);
      }
    }
  }

  // 3. 关联实体 Links (mentions)
  if (includeEntities && memRows.length > 0) {
    const placeholders = memRows.map(() => '?').join(', ');
    const entRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      memRows.map((m) => m.id)
    );

    // 统计实体出现频次，优先关联共享实体
    const entCounts = new Map<string, number>();
    for (const r of entRows) {
      entCounts.set(r.entity, (entCounts.get(r.entity) || 0) + 1);
    }

    const addedEntities = new Set<string>();
    // 只保留出现 >= 1 次且限制最多 30 个实体节点
    const topEntities = Array.from(entCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30);

    const validEntSet = new Set(topEntities.map((t) => t[0]));

    for (const r of entRows) {
      if (!validEntSet.has(r.entity)) continue;

      const entNodeId = `ent_${r.entity.replace(/[^a-zA-Z0-9_]/g, '_')}`;
      if (!addedEntities.has(entNodeId)) {
        addedEntities.add(entNodeId);
        nodes.push({
          id: entNodeId,
          label: `@${r.entity}`,
          type: 'entity',
        });
      }

      links.push({
        source: r.memory_id,
        target: entNodeId,
        rel: 'mentions',
      });
      bumpConn(r.memory_id);
      bumpConn(entNodeId);
    }
  }

  // 设置每个节点的实际连接度
  for (const n of nodes) {
    n.connections = connectionCounts.get(n.id) || 0;
  }

  return {
    nodes,
    links,
    stats: {
      totalNodes: nodes.length,
      memoryNodes: memRows.length,
      entityNodes: nodes.length - memRows.length,
      totalLinks: links.length,
    },
  };
}

/**
 * 将图谱拓扑数据渲染为 Mermaid 格式 (便于在会话与报告中可视化)
 */
export function renderMermaidGraph(graph: GraphData, maxNodes: number = 25): string {
  if (graph.nodes.length === 0) {
    return '*(记忆库为空，暂无知识图谱拓扑)*';
  }

  // 按连接度与 pinned 排序，选取最核心的节点
  const selectedNodes = [...graph.nodes]
    .sort((a, b) => (b.pinned || 0) * 10 + (b.connections || 0) - ((a.pinned || 0) * 10 + (a.connections || 0)))
    .slice(0, maxNodes);

  const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
  const selectedLinks = graph.links.filter(
    (l) => selectedNodeIds.has(l.source) && selectedNodeIds.has(l.target)
  );

  const lines: string[] = ['flowchart TD'];

  for (const n of selectedNodes) {
    // 清洗字符，Mermaid 节点标签使用双引号并移除特殊字符
    const cleanLabel = n.label.replace(/["\(\)\[\]\{\}\<\>]/g, ' ').replace(/\s+/g, ' ').trim();
    const safeId = n.id.replace(/[^a-zA-Z0-9_]/g, '_');

    if (n.type === 'entity') {
      lines.push(`  ${safeId}["🏷️ ${cleanLabel}"]`);
    } else {
      const pinIcon = n.pinned ? '📌 ' : '';
      lines.push(`  ${safeId}["${pinIcon}${cleanLabel}"]`);
    }
  }

  for (const l of selectedLinks) {
    const sId = l.source.replace(/[^a-zA-Z0-9_]/g, '_');
    const tId = l.target.replace(/[^a-zA-Z0-9_]/g, '_');
    lines.push(`  ${sId} -->|${l.rel}| ${tId}`);
  }

  return '```mermaid\n' + lines.join('\n') + '\n```';
}

