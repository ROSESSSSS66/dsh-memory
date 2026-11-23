import {
  type Db,
  type GraphData,
  type GraphLink,
  type GraphNode,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type Scope,
} from '../types.js';
import { scopeFilterSQL, workspaceId } from './scope.js';

const MEMORY_COLUMNS_NO_EMBEDDING =
  'rowid_, id, type, status, content, summary, slot_key, scope, workspace_id, session_id, origin_kinds, approved_at, approved_by, source_kind, confidence, utility, use_count, success_count, fail_count, token_cost, summary_cost, hash, version, content_rev, pinned, valid_from, valid_to, importance, invalidated_at, created_at, updated_at, last_used_at, last_repair_at';

const GRAPH_MEMORY_COLUMNS =
  'id, type, scope, status, summary, content, confidence, utility, pinned, workspace_id, session_id';

const DEFAULT_LIST_CAP = 10000;
const SHORT_ID_PREFIX_LIMIT = 6;

interface GraphMemoryRow {
  id: string;
  type: MemoryType;
  scope: Scope;
  status: MemoryStatus;
  summary: string;
  content: string;
  confidence: number;
  utility: number;
  pinned: number;
  workspace_id: string | null;
  session_id: string | null;
}

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
  pinnedCount?: number;
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function entityNodeId(entity: string): string {
  return `ent_${fnv1a32(entity).toString(36)}`;
}

/**
 * 按完整 ID 或短码获取单条记忆：
 * 先走主键/唯一索引精确匹配，再走前缀范围查询（LIMIT 6），同时兼容 m_* 与非 m_* 自定义 ID。
 */
export function get(
  db: Db,
  idOrShortId: string,
  scopeCtx?: { workspaceId?: string; sessionId?: string }
): MemoryRecord | undefined {
  const raw = (idOrShortId || '').trim();
  if (!raw) return undefined;

  const hasScope = Boolean(
    scopeCtx && (scopeCtx.workspaceId !== undefined || scopeCtx.sessionId !== undefined)
  );
  const scopeClause = hasScope
    ? scopeFilterSQL({
        workspaceId: workspaceId(scopeCtx!.workspaceId || ''),
        sessionId: scopeCtx!.sessionId,
      })
    : null;

  // 1. 精确匹配优先（支持任意完整 ID，包括 m_* 与非 m_*）
  const exactSql = scopeClause
    ? `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING} FROM memories WHERE id = ? AND ${scopeClause.sql} LIMIT 1`
    : `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING} FROM memories WHERE id = ? LIMIT 1`;
  const exactParams: unknown[] = scopeClause ? [raw, ...scopeClause.params] : [raw];
  const exactMatch = db.get<MemoryRow>(exactSql, exactParams);
  if (exactMatch) {
    return hydrateMemoryRow(exactMatch);
  }

  // 2. 前缀范围查询（强制 LIMIT 6 避免短前缀扫库）
  const queryPrefix = (prefix: string): MemoryRow[] => {
    const sql = scopeClause
      ? `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING} FROM memories WHERE id >= ? AND id < ? AND ${scopeClause.sql} LIMIT ${SHORT_ID_PREFIX_LIMIT}`
      : `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING} FROM memories WHERE id >= ? AND id < ? LIMIT ${SHORT_ID_PREFIX_LIMIT}`;
    const params: unknown[] = scopeClause
      ? [prefix, `${prefix}\uffff`, ...scopeClause.params]
      : [prefix, `${prefix}\uffff`];
    return db.all<MemoryRow>(sql, params);
  };

  let matches: MemoryRow[];
  if (raw.startsWith('m_')) {
    matches = queryPrefix(raw);
  } else {
    const directMatches = queryPrefix(raw);
    const prefixedMatches = queryPrefix(`m_${raw}`);
    if (directMatches.length === 0) {
      matches = prefixedMatches;
    } else if (prefixedMatches.length === 0) {
      matches = directMatches;
    } else {
      const seen = new Set<string>();
      matches = [];
      for (const row of [...directMatches, ...prefixedMatches]) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          matches.push(row);
          if (matches.length >= SHORT_ID_PREFIX_LIMIT) break;
        }
      }
    }
  }

  if (matches.length === 0) return undefined;
  if (matches.length === 1) return hydrateMemoryRow(matches[0]);

  // 歧义短码必须报错并列出候选
  const ids = matches.map((m) => m.id).join(', ');
  throw new Error(`Ambiguous short id '${idOrShortId}', matches: ${ids}`);
}

/**
 * 条件列表查询（显式投影省略 embedding，严格遵循 scopeFilterSQL 隔离跨会话记忆）
 */
export function list(db: Db, filter: ListFilter = {}): MemoryRecord[] {
  let sql = `SELECT ${MEMORY_COLUMNS_NO_EMBEDDING} FROM memories WHERE 1=1`;
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
  if (filter.workspaceId !== undefined) {
    const sf = scopeFilterSQL({
      workspaceId: workspaceId(filter.workspaceId),
      sessionId: filter.sessionId,
    });
    sql += ` AND ${sf.sql}`;
    params.push(...sf.params);
  } else if (filter.sessionId !== undefined) {
    const sid = filter.sessionId.trim();
    if (sid) {
      sql += " AND (scope IN ('user','global') OR (scope='session' AND session_id=?))";
      params.push(sid);
    } else {
      sql += " AND scope IN ('user','global')";
    }
  }
  if (filter.slotKey) {
    sql += ' AND slot_key = ?';
    params.push(filter.slotKey);
  }

  sql += ' ORDER BY created_at DESC';

  const hasLimit =
    typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0;
  const hasOffset =
    typeof filter.offset === 'number' && Number.isFinite(filter.offset) && filter.offset > 0;

  if (hasLimit) {
    sql += ' LIMIT ?';
    params.push(Math.floor(filter.limit!));
    if (hasOffset) {
      sql += ' OFFSET ?';
      params.push(Math.floor(filter.offset!));
    }
  } else if (hasOffset) {
    sql += ' LIMIT -1 OFFSET ?';
    params.push(Math.floor(filter.offset!));
  } else {
    sql += ' LIMIT ?';
    params.push(DEFAULT_LIST_CAP);
  }

  return db.all<MemoryRow>(sql, params).map((row) => hydrateMemoryRow(row));
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
  }>(
    'SELECT version, snapshot, reason, actor, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version ASC',
    [id]
  );

  return rows.map((r) => ({
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
 * 统计概况（纯 SQL 聚合，严禁将全表拉入 V8 堆；传入 workspaceId/sessionId 时严格走 scopeFilterSQL 防会话泄漏）
 */
export function stats(db: Db, workspaceIdFilter?: string, sessionIdFilter?: string): MemoryStats {
  let whereSql = '';
  let params: unknown[] = [];

  if (workspaceIdFilter) {
    const sf = scopeFilterSQL({
      workspaceId: workspaceId(workspaceIdFilter),
      sessionId: sessionIdFilter,
    });
    whereSql = ` WHERE ${sf.sql}`;
    params = sf.params;
  } else if (sessionIdFilter) {
    whereSql = " WHERE (scope IN ('user','global') OR (scope='session' AND session_id=?))";
    params = [sessionIdFilter];
  }

  const agg = db.get<{
    total: number;
    avg_conf: number | null;
    avg_util: number | null;
    pinned_count: number | null;
  }>(
    `SELECT
       COUNT(*) AS total,
       AVG(confidence) AS avg_conf,
       AVG(utility) AS avg_util,
       SUM(CASE WHEN pinned != 0 AND status IN ('active', 'frozen') THEN 1 ELSE 0 END) AS pinned_count
     FROM memories${whereSql}`,
    params
  );

  const statusRows = db.all<{ status: string; cnt: number }>(
    `SELECT status, COUNT(*) AS cnt FROM memories${whereSql} GROUP BY status`,
    params
  );
  const typeRows = db.all<{ type: string; cnt: number }>(
    `SELECT type, COUNT(*) AS cnt FROM memories${whereSql} GROUP BY type`,
    params
  );

  const byStatus: Record<string, number> = {};
  for (const r of statusRows) {
    byStatus[r.status] = Number(r.cnt);
  }
  const byType: Record<string, number> = {};
  for (const r of typeRows) {
    byType[r.type] = Number(r.cnt);
  }

  const total = Number(agg?.total ?? 0);
  return {
    total,
    byStatus,
    byType,
    avgConfidence: total > 0 && agg?.avg_conf != null ? Number(agg.avg_conf) : 0,
    avgUtility: total > 0 && agg?.avg_util != null ? Number(agg.avg_util) : 0,
    pinnedCount: Number(agg?.pinned_count ?? 0),
  };
}

/**
 * 获取知识图谱拓扑数据 (灵感汲取自 qwert702/dsh-memory 与 omdsh-dev/dsh-mnemon)
 */
export function getGraphData(
  db: Db,
  options?: {
    workspaceId?: string;
    sessionId?: string;
    scope?: Scope;
    limit?: number;
    includeEntities?: boolean;
    status?: MemoryStatus[];
  }
): GraphData {
  const rawLimit = options?.limit ?? 80;
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 80;
  const includeEntities = options?.includeEntities ?? true;
  const statuses = options?.status || ['active', 'candidate', 'frozen', 'superseded'];
  if (statuses.length === 0) {
    return {
      nodes: [],
      links: [],
      stats: { totalNodes: 0, memoryNodes: 0, entityNodes: 0, totalLinks: 0 },
    };
  }
  const statusPlaceholders = statuses.map(() => '?').join(', ');

  let memSql = `SELECT ${GRAPH_MEMORY_COLUMNS} FROM memories WHERE status IN (${statusPlaceholders})`;
  const params: unknown[] = [...statuses];

  if (options?.scope) {
    memSql += ' AND scope = ?';
    params.push(options.scope);
  }
  if (options?.workspaceId) {
    const sf = scopeFilterSQL({
      workspaceId: workspaceId(options.workspaceId),
      sessionId: options.sessionId,
    });
    memSql += ` AND ${sf.sql}`;
    params.push(...sf.params);
  } else if (options?.sessionId) {
    memSql += " AND (scope IN ('user','global') OR (scope='session' AND session_id=?))";
    params.push(options.sessionId);
  }

  memSql += ' ORDER BY pinned DESC, updated_at DESC LIMIT ?';
  params.push(limit);

  const memRows = db.all<GraphMemoryRow>(memSql, params);
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
    const memIdList = memRows.map((m) => m.id);
    const placeholders = memIdList.map(() => '?').join(', ');
    const relRows = db.all<{ from_id: string; to_id: string; rel: string }>(
      `SELECT from_id, to_id, rel FROM memory_relations
       WHERE from_id IN (${placeholders}) AND to_id IN (${placeholders})`,
      [...memIdList, ...memIdList]
    );

    for (const r of relRows) {
      if (!memIds.has(r.from_id) || !memIds.has(r.to_id)) continue;
      links.push({
        source: r.from_id,
        target: r.to_id,
        rel: r.rel,
      });
      bumpConn(r.from_id);
      bumpConn(r.to_id);
    }
  }

  // 3. 关联实体 Links (mentions)
  if (includeEntities && memRows.length > 0) {
    const memIdList = memRows.map((m) => m.id);
    const placeholders = memIdList.map(() => '?').join(', ');
    const entRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      memIdList
    );

    // 统计实体出现频次并按确定性字典序破平，优先保留共享实体
    const entCounts = new Map<string, number>();
    for (const r of entRows) {
      entCounts.set(r.entity, (entCounts.get(r.entity) || 0) + 1);
    }

    const topEntities = Array.from(entCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 30);

    const validEntSet = new Set(topEntities.map((t) => t[0]));
    const addedEntities = new Set<string>();

    for (const r of entRows) {
      if (!validEntSet.has(r.entity)) continue;

      const entNodeId = entityNodeId(r.entity);
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
 * 提取指定中心记忆节点的 K-Hop (1~2 跳) 局部知识子图 (Ego-Network Subgraph)
 * 将 scope 与 status 约束下推至 BFS 每一跳 SQL，根除跨工作区/跨会话邻居泄漏与无效节点占额。
 */
export function getSubgraph(
  db: Db,
  centerIdOrShortId: string,
  options?: {
    workspaceId?: string;
    sessionId?: string;
    hops?: 1 | 2;
    maxNodes?: number;
    includeEntities?: boolean;
    status?: MemoryStatus[];
  }
): GraphData {
  const hasScope = options?.workspaceId !== undefined || options?.sessionId !== undefined;
  const wsId = options?.workspaceId ? workspaceId(options.workspaceId) : undefined;
  const center = get(
    db,
    centerIdOrShortId,
    hasScope ? { workspaceId: wsId, sessionId: options?.sessionId } : undefined
  );
  if (!center) {
    return {
      nodes: [],
      links: [],
      stats: { totalNodes: 0, memoryNodes: 0, entityNodes: 0, totalLinks: 0 },
    };
  }

  const hops = options?.hops === 2 ? 2 : 1;
  const maxNodes = Math.max(2, Math.min(80, options?.maxNodes ?? 25));
  const includeEntities = options?.includeEntities ?? true;
  const statuses =
    options?.status && options.status.length > 0
      ? options.status
      : (['active', 'candidate', 'frozen', 'superseded'] as MemoryStatus[]);
  const statusPlaceholders = statuses.map(() => '?').join(', ');

  const neighborScope = hasScope
    ? wsId !== undefined
      ? scopeFilterSQL({ workspaceId: wsId, sessionId: options?.sessionId }, 'm')
      : {
          sql: "(m.scope IN ('user','global') OR (m.scope='session' AND m.session_id=?))",
          params: [options?.sessionId || ''],
        }
    : null;

  const visitedIds = new Set<string>([center.id]);
  let frontier = [center.id];

  for (let h = 0; h < hops && frontier.length > 0 && visitedIds.size < maxNodes; h++) {
    const fPlaceholders = frontier.map(() => '?').join(', ');
    const scopeSqlSuffix = neighborScope ? ` AND ${neighborScope.sql}` : '';
    const scopeParams = neighborScope ? neighborScope.params : [];

    const neighborRows = db.all<{ neighbor_id: string }>(
      `SELECT r.to_id AS neighbor_id
       FROM memory_relations r
       JOIN memories m ON m.id = r.to_id
       WHERE r.from_id IN (${fPlaceholders})
         AND m.status IN (${statusPlaceholders})${scopeSqlSuffix}
       UNION
       SELECT r.from_id AS neighbor_id
       FROM memory_relations r
       JOIN memories m ON m.id = r.from_id
       WHERE r.to_id IN (${fPlaceholders})
         AND m.status IN (${statusPlaceholders})${scopeSqlSuffix}
       ORDER BY neighbor_id ASC`,
      [...frontier, ...statuses, ...scopeParams, ...frontier, ...statuses, ...scopeParams]
    );

    const nextFrontier: string[] = [];
    for (const row of neighborRows) {
      if (!visitedIds.has(row.neighbor_id) && visitedIds.size < maxNodes) {
        visitedIds.add(row.neighbor_id);
        nextFrontier.push(row.neighbor_id);
      }
    }
    frontier = nextFrontier;
  }

  const idArr = Array.from(visitedIds);
  const placeholders = idArr.map(() => '?').join(', ');
  const memRows = db.all<GraphMemoryRow>(
    `SELECT ${GRAPH_MEMORY_COLUMNS} FROM memories WHERE id IN (${placeholders})`,
    idArr
  );
  const validNodeIdSet = new Set(memRows.map((m) => m.id));

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const connectionCounts = new Map<string, number>();
  const bumpConn = (id: string) => connectionCounts.set(id, (connectionCounts.get(id) || 0) + 1);

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
      pinned: m.id === center.id ? 1 : m.pinned,
    });
  }

  const validIdList = Array.from(validNodeIdSet);
  if (validIdList.length > 0) {
    const validPlaceholders = validIdList.map(() => '?').join(', ');
    const relRows = db.all<{ from_id: string; to_id: string; rel: string }>(
      `SELECT from_id, to_id, rel FROM memory_relations
       WHERE from_id IN (${validPlaceholders}) AND to_id IN (${validPlaceholders})`,
      [...validIdList, ...validIdList]
    );
    for (const r of relRows) {
      links.push({ source: r.from_id, target: r.to_id, rel: r.rel });
      bumpConn(r.from_id);
      bumpConn(r.to_id);
    }

    if (includeEntities) {
      const entRows = db.all<{ memory_id: string; entity: string }>(
        `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${validPlaceholders})`,
        validIdList
      );
      const entCounts = new Map<string, number>();
      for (const r of entRows) {
        entCounts.set(r.entity, (entCounts.get(r.entity) || 0) + 1);
      }
      const topEntities = Array.from(entCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20);
      const validEntSet = new Set(topEntities.map(([ent]) => ent));
      const addedEntities = new Set<string>();

      for (const r of entRows) {
        if (!validEntSet.has(r.entity)) continue;
        const entNodeId = entityNodeId(r.entity);
        if (!addedEntities.has(entNodeId)) {
          addedEntities.add(entNodeId);
          nodes.push({ id: entNodeId, label: `@${r.entity}`, type: 'entity' });
        }
        links.push({ source: r.memory_id, target: entNodeId, rel: 'mentions' });
        bumpConn(r.memory_id);
        bumpConn(entNodeId);
      }
    }
  }

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
    .sort(
      (a, b) =>
        (b.pinned || 0) * 10 + (b.connections || 0) - ((a.pinned || 0) * 10 + (a.connections || 0))
    )
    .slice(0, maxNodes);

  const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
  const selectedLinks = graph.links.filter(
    (l) => selectedNodeIds.has(l.source) && selectedNodeIds.has(l.target)
  );

  const lines: string[] = ['flowchart TD'];

  for (const n of selectedNodes) {
    // 清洗字符，Mermaid 节点标签使用双引号并移除特殊字符
    const cleanLabel = n.label
      .replace(/["()[\]{}<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
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
