import fs from 'node:fs';
import path from 'node:path';
import {
  parseOriginKinds,
  type Db,
  type HindsightNetwork,
  type MemoryRecord,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type OriginKind,
  type RelationType,
  type Scope,
} from '../types.js';
import type { PluginConfig } from '../config.js';
import { workspaceId, scopeFilterSQL, resolveWorkspaceCwd } from '../core/scope.js';
import { isWorkspaceExcluded, redactSecrets } from '../core/privacy.js';
import { get, sources as getSources, history as getHistory } from '../core/store.js';
import {
  editMemory,
  forget,
  freeze,
  pin,
  upsertCandidate,
  type EditMemoryPatch,
  type EditMemoryResult,
} from '../core/writer.js';
import {
  atomicWriteFileSync,
  resolveTrashDir,
  safeFilenameId,
  trashMemory,
} from '../core/markdown.js';
import {
  classifyHindsightNetwork,
  traceHindsightEvolution,
  type HindsightEvolutionTrace,
} from '../core/hindsight.js';
import { resolveVikingUri, resolveVikingUrisBatch } from '../core/viking.js';
import {
  assertWorkspaceAllowed,
  expandExcludedWorkspaceIds,
  WorkspaceExcludedError,
} from './scope-guard.js';

export const VALID_MEMORY_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  'episodic',
  'semantic',
  'procedural',
  'belief',
  'preference',
  'goal',
  'failure',
  'meta',
]);

export const VALID_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  'session',
  'workspace',
  'user',
  'global',
]);

const SAFE_MEMORY_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
const DEFAULT_MAX_IMPORT_ITEMS = 5000;

const MEMORY_TYPE_ALIASES: Record<string, MemoryType> = {
  fact: 'semantic',
  facts: 'semantic',
  procedure: 'procedural',
  procedures: 'procedural',
  skill: 'procedural',
  skills: 'procedural',
  pref: 'preference',
  preferences: 'preference',
  event: 'episodic',
  events: 'episodic',
  error: 'failure',
  case: 'failure',
  cases: 'failure',
  opinion: 'belief',
  opinions: 'belief',
};

/**
 * 统一的记忆类型规范化函数（取代 web.ts / tools.ts / commands.ts 中各自维护的副本）
 */
export function normalizeMemoryType(
  input: unknown,
  fallback: MemoryType = 'semantic'
): MemoryType {
  if (typeof input !== 'string') return fallback;
  const normalized = input.trim().toLowerCase();
  if (!normalized) return fallback;
  const aliased = MEMORY_TYPE_ALIASES[normalized];
  if (aliased) return aliased;
  if (VALID_MEMORY_TYPES.has(normalized as MemoryType)) {
    return normalized as MemoryType;
  }
  return fallback;
}

export interface EditMemoryRecordOptions {
  actor: string;
  now?: number;
  cfg?: PluginConfig;
  scopeCtx?: { workspaceId: string; sessionId?: string };
}

/**
 * 作用域受控的记忆编辑入口：
 * - 强制校验 excludeWorkspaces 与 scopeCtx 归属
 * - 拒绝非核心记忆写入 core:* 槽位（大小写不敏感防御）
 * - 委托 writer.ts:editMemory() 执行 frozen 守卫、敏感信息检测、槽位取代与缓存更新
 */
export function editMemoryRecord(
  db: Db,
  id: string,
  patch: EditMemoryPatch,
  opts: EditMemoryRecordOptions
): EditMemoryResult {
  const rawId = (id || '').trim();
  if (!rawId) {
    throw new Error('memory_not_found');
  }

  if (opts.cfg) {
    if (opts.scopeCtx?.workspaceId) {
      assertWorkspaceAllowed(opts.scopeCtx.workspaceId, opts.cfg, { db });
    }
    if (typeof patch.workspaceId === 'string' && patch.workspaceId.trim()) {
      assertWorkspaceAllowed(patch.workspaceId, opts.cfg, { db });
    }
  }

  const target = get(db, rawId, opts.scopeCtx);
  if (!target) {
    throw new Error('memory_not_found');
  }

  if (opts.cfg?.excludeWorkspaces?.length && target.workspace_id) {
    assertWorkspaceAllowed(target.workspace_id, opts.cfg, { db });
  }

  // 大小写不敏感防御：禁止通过 editMemoryRecord 将非核心记忆改为 core:* / CORE:* 槽位或篡改核心槽位名
  if (patch.slot_key !== undefined && patch.slot_key !== null) {
    const trimmedSlot = String(patch.slot_key).trim();
    const wasCore = Boolean(target.slot_key?.toLowerCase().startsWith('core:'));
    const willBeCore = trimmedSlot.toLowerCase().startsWith('core:');
    if (willBeCore && (!wasCore || trimmedSlot !== target.slot_key)) {
      throw new Error('cannot_assign_core_slot_key');
    }
  }

  // 若调用方把 global/user 记忆迁往 workspace/session 且未显式提供 workspaceId，优先使用 scopeCtx 而非 process.cwd()
  const effectivePatch: EditMemoryPatch = { ...patch };
  const targetScope = patch.scope ?? target.scope;
  if (
    (targetScope === 'workspace' || targetScope === 'session') &&
    !(typeof patch.workspaceId === 'string' && patch.workspaceId.trim()) &&
    !target.workspace_id &&
    opts.scopeCtx?.workspaceId
  ) {
    effectivePatch.workspaceId = opts.scopeCtx.workspaceId;
  }
  if (
    targetScope === 'session' &&
    !(typeof patch.sessionId === 'string' && patch.sessionId.trim()) &&
    !target.session_id &&
    opts.scopeCtx?.sessionId
  ) {
    effectivePatch.sessionId = opts.scopeCtx.sessionId;
  }

  return editMemory(
    db,
    target.id,
    effectivePatch,
    opts.actor,
    opts.now ?? Date.now(),
    opts.cfg
  );
}

export interface ForgetWithTrashOptions {
  actor: string;
  now?: number;
  scopeCtx?: { workspaceId: string; sessionId?: string };
  trashDir?: string;
  dataDir?: string;
}

export interface ForgetWithTrashResult {
  ok: boolean;
  id?: string;
  trashedPath?: string;
  error?: string;
}

function rollbackTrashFile(trashedPath: string | undefined, previousContent: string | undefined): void {
  if (!trashedPath) return;
  try {
    if (previousContent !== undefined) {
      atomicWriteFileSync(trashedPath, previousContent);
    } else if (fs.existsSync(trashedPath)) {
      fs.unlinkSync(trashedPath);
    }
  } catch {
    // ignore best-effort cleanup error
  }
}

/**
 * 安全的带回收站遗忘流程：
 * - 先经 store.get 按作用域查找，拒绝 frozen 记忆（不写 .trash 存根）
 * - 写入 .trash 备份后调用 writer.forget()；若 forget() 失败或返回 false，自动清理/回滚刚写入的 .trash 文件
 */
export function forgetWithTrash(
  db: Db,
  idOrShortId: string,
  opts: ForgetWithTrashOptions
): ForgetWithTrashResult {
  const rawId = (idOrShortId || '').trim();
  if (!rawId) {
    return { ok: false, error: 'memory_id_required' };
  }

  let mem: MemoryRecord | undefined;
  try {
    mem = get(db, rawId, opts.scopeCtx);
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!mem) {
    return { ok: false, error: 'memory_not_found' };
  }

  if (mem.status === 'frozen') {
    return { ok: false, id: mem.id, error: 'memory_is_frozen' };
  }

  const effectiveTrashDir = opts.trashDir ?? resolveTrashDir(db, opts.dataDir);
  let trashedPath: string | undefined;
  let previousTrashContent: string | undefined;

  if (effectiveTrashDir) {
    const expectedPath = path.join(effectiveTrashDir, `${safeFilenameId(mem.id)}.md`);
    try {
      const st = fs.lstatSync(expectedPath);
      if (st.isFile() && !st.isSymbolicLink()) {
        previousTrashContent = fs.readFileSync(expectedPath, 'utf8');
      }
    } catch {
      // file does not exist yet
    }

    try {
      const trashRes = trashMemory(db, mem.id, effectiveTrashDir);
      if (trashRes.trashed) {
        trashedPath = trashRes.path;
      }
    } catch (err: unknown) {
      return {
        ok: false,
        id: mem.id,
        error: `trash_backup_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const ok = forget(db, mem.id, opts.actor, opts.now ?? Date.now());
    if (!ok) {
      rollbackTrashFile(trashedPath, previousTrashContent);
      return { ok: false, id: mem.id, error: 'forget_failed' };
    }
    return { ok: true, id: mem.id, ...(trashedPath ? { trashedPath } : {}) };
  } catch (err: unknown) {
    rollbackTrashFile(trashedPath, previousTrashContent);
    return {
      ok: false,
      id: mem.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MemoryVersionEntry {
  version: number;
  snapshot: unknown;
  reason: string;
  actor: string;
  created_at: number;
}

export interface MemoryRelationDetail {
  from_id: string;
  to_id: string;
  other_id: string;
  rel: RelationType;
  direction: 'outgoing' | 'incoming';
  other_summary: string;
  other_status: MemoryStatus;
  other_type: MemoryType;
  created_at: number;
}

export interface GetMemoryDetailOptions {
  scopeCtx?: { workspaceId: string; sessionId?: string };
  excludeWorkspaces?: string[];
}

export interface MemoryDetailResult {
  memory: MemoryRecord;
  sources: MemorySource[];
  versions: MemoryVersionEntry[];
  relations: MemoryRelationDetail[];
  hindsightTrace: HindsightEvolutionTrace;
  vikingUri: string;
  hindsightNetwork: HindsightNetwork;
}

function buildMemoryExcludeClause(
  excludedIds: string[],
  tableAlias?: string
): { sql: string; params: string[] } {
  if (excludedIds.length === 0) return { sql: '1 = 1', params: [] };
  const p = tableAlias ? `${tableAlias}.` : '';
  const ph = excludedIds.map(() => '?').join(', ');
  return {
    sql: `(COALESCE(${p}workspace_id, '') NOT IN (${ph})
      AND NOT EXISTS (
        SELECT 1 FROM memory_sources ms
        JOIN session_workspace_owners swo ON swo.session_id = ms.session_id
        WHERE ms.memory_id = ${p}id AND swo.workspace_id IN (${ph})
      ))`,
    params: [...excludedIds, ...excludedIds],
  };
}

/**
 * 获取单条记忆完整详情（含来源证据、版本历史、受作用域隔离的拓扑关系、Hindsight 演化轨迹与 OpenViking URI）
 */
export function getMemoryDetail(
  db: Db,
  idOrShortId: string,
  opts: GetMemoryDetailOptions = {}
): MemoryDetailResult | null {
  const rawId = (idOrShortId || '').trim();
  if (!rawId) return null;

  const excludeWorkspaces = opts.excludeWorkspaces || [];
  if (
    excludeWorkspaces.length > 0 &&
    opts.scopeCtx?.workspaceId &&
    isWorkspaceExcluded(opts.scopeCtx.workspaceId, excludeWorkspaces)
  ) {
    return null;
  }

  const mem = get(db, rawId, opts.scopeCtx);
  if (!mem) return null;

  const excludedIds = expandExcludedWorkspaceIds(db, excludeWorkspaces);
  if (excludedIds.length > 0) {
    if (mem.workspace_id) {
      if (isWorkspaceExcluded(mem.workspace_id, excludeWorkspaces)) return null;
      const mappedPath = resolveWorkspaceCwd(db, mem.workspace_id);
      if (mappedPath && isWorkspaceExcluded(mappedPath, excludeWorkspaces)) return null;
    }
    const selfExclude = buildMemoryExcludeClause(excludedIds, 'm');
    const visible = db.get<{ ok: number }>(
      `SELECT 1 AS ok FROM memories m WHERE m.id = ? AND ${selfExclude.sql}`,
      [mem.id, ...selfExclude.params]
    );
    if (!visible) return null;
  }

  const srcList = getSources(db, mem.id, mem.content_rev);
  const versions = getHistory(db, mem.id);

  // 对 memory_relations 关联的目标节点强制执行 scopeFilterSQL + excludeWorkspaces 隔离
  const targetClauses: string[] = [];
  const targetParams: unknown[] = [];

  if (opts.scopeCtx) {
    const sf = scopeFilterSQL(
      {
        workspaceId: workspaceId(opts.scopeCtx.workspaceId),
        sessionId: opts.scopeCtx.sessionId,
      },
      'm'
    );
    targetClauses.push(sf.sql);
    targetParams.push(...sf.params);
  }
  if (excludedIds.length > 0) {
    const ex = buildMemoryExcludeClause(excludedIds, 'm');
    targetClauses.push(ex.sql);
    targetParams.push(...ex.params);
  }
  const targetWhereSuffix = targetClauses.length > 0 ? ` AND ${targetClauses.join(' AND ')}` : '';

  const outRows = db.all<{
    from_id: string;
    to_id: string;
    rel: RelationType;
    created_at: number;
    other_summary: string;
    other_status: MemoryStatus;
    other_type: MemoryType;
  }>(
    `SELECT r.from_id, r.to_id, r.rel, r.created_at,
            m.summary AS other_summary, m.status AS other_status, m.type AS other_type
     FROM memory_relations r
     JOIN memories m ON m.id = r.to_id
     WHERE r.from_id = ?${targetWhereSuffix}
     ORDER BY r.created_at DESC`,
    [mem.id, ...targetParams]
  );

  const inRows = db.all<{
    from_id: string;
    to_id: string;
    rel: RelationType;
    created_at: number;
    other_summary: string;
    other_status: MemoryStatus;
    other_type: MemoryType;
  }>(
    `SELECT r.from_id, r.to_id, r.rel, r.created_at,
            m.summary AS other_summary, m.status AS other_status, m.type AS other_type
     FROM memory_relations r
     JOIN memories m ON m.id = r.from_id
     WHERE r.to_id = ?${targetWhereSuffix}
     ORDER BY r.created_at DESC`,
    [mem.id, ...targetParams]
  );

  const relations: MemoryRelationDetail[] = [
    ...outRows.map((r) => ({
      from_id: r.from_id,
      to_id: r.to_id,
      other_id: r.to_id,
      rel: r.rel,
      direction: 'outgoing' as const,
      other_summary: redactSecrets(r.other_summary || '').text,
      other_status: r.other_status,
      other_type: r.other_type,
      created_at: r.created_at,
    })),
    ...inRows.map((r) => ({
      from_id: r.from_id,
      to_id: r.to_id,
      other_id: r.from_id,
      rel: r.rel,
      direction: 'incoming' as const,
      other_summary: redactSecrets(r.other_summary || '').text,
      other_status: r.other_status,
      other_type: r.other_type,
      created_at: r.created_at,
    })),
  ];

  const hindsightTrace = traceHindsightEvolution(
    db,
    mem,
    opts.scopeCtx || excludeWorkspaces.length > 0
      ? {
          workspaceId: opts.scopeCtx?.workspaceId,
          sessionId: opts.scopeCtx?.sessionId,
          excludeWorkspaces,
        }
      : undefined
  );

  const uriMap = resolveVikingUrisBatch(db, [mem]);
  const vikingUri = uriMap.get(mem.id) || resolveVikingUri(mem);
  const hindsightNetwork = classifyHindsightNetwork(mem.type, mem.slot_key);

  const { embedding: _embedding, ...cleanMem } = mem;

  return {
    memory: cleanMem,
    sources: srcList,
    versions,
    relations,
    hindsightTrace,
    vikingUri,
    hindsightNetwork,
  };
}

export interface ImportJsonMemoriesOptions {
  workspaceId?: string;
  sessionId?: string;
  trusted?: boolean;
  actor?: 'user' | 'maintenance' | 'system';
  now?: number;
  cfg?: PluginConfig;
  allowCrossWorkspace?: boolean;
  maxItems?: number;
}

export interface ImportJsonMemoriesResult {
  imported: number;
  merged: number;
  skipped: number;
  errors: string[];
}

function isSafeMemoryId(raw: unknown): boolean {
  return typeof raw === 'string' && SAFE_MEMORY_ID_REGEX.test(raw.trim());
}

/**
 * 统一的 JSON 记忆导入入口（取代 web.ts 与 commands.ts 各自维护的双轨导入逻辑）：
 * - 全部路由至 writer.ts:upsertCandidate() 并在单事务（逐条 SAVEPOINT）中执行
 * - 完整保留 candidate 状态（传 source_kind='system', actor='maintenance' 防自动晋升）
 * - 仅在 trusted=true 时允许 core:* 槽位、meta 类型、pinned 与 frozen 还原
 * - allowCrossWorkspace=false 时严格约束跨工作区/跨会话边界
 * - 校验 ID 格式并一致拒绝含明文密钥或 [REDACTED:] 占位符的条目
 */
export function importJsonMemories(
  db: Db,
  rawItems: unknown[],
  opts: ImportJsonMemoriesOptions = {}
): ImportJsonMemoriesResult {
  const errors: string[] = [];
  if (!Array.isArray(rawItems)) {
    return { imported: 0, merged: 0, skipped: 0, errors: ['invalid_items_array'] };
  }

  const maxItems =
    typeof opts.maxItems === 'number' && Number.isInteger(opts.maxItems) && opts.maxItems > 0
      ? opts.maxItems
      : DEFAULT_MAX_IMPORT_ITEMS;

  if (rawItems.length > maxItems) {
    return {
      imported: 0,
      merged: 0,
      skipped: rawItems.length,
      errors: [`exceeds_max_items:${maxItems}`],
    };
  }

  const excludeWorkspaces = opts.cfg?.excludeWorkspaces || [];
  if (opts.workspaceId && excludeWorkspaces.length > 0) {
    try {
      assertWorkspaceAllowed(opts.workspaceId, opts.cfg!, { db });
    } catch (err) {
      if (err instanceof WorkspaceExcludedError) {
        return {
          imported: 0,
          merged: 0,
          skipped: rawItems.length,
          errors: ['workspace_excluded'],
        };
      }
      throw err;
    }
  }

  const trusted = opts.trusted === true;
  const allowCrossWorkspace = opts.allowCrossWorkspace === true;
  const requestedActor = opts.actor ?? 'user';
  const now = opts.now ?? Date.now();
  const targetWsId = opts.workspaceId ? workspaceId(opts.workspaceId) : undefined;
  const targetSessionId =
    typeof opts.sessionId === 'string' && opts.sessionId.trim() ? opts.sessionId.trim() : undefined;

  // 按 updated_at 从旧到新回放，防止旧值覆盖同槽位新值
  const indexedItems = rawItems.map((item, originalIndex) => ({ item, originalIndex }));
  indexedItems.sort((a, b) => {
    const ta =
      a.item && typeof a.item === 'object' ? Number((a.item as Record<string, unknown>).updated_at) || 0 : 0;
    const tb =
      b.item && typeof b.item === 'object' ? Number((b.item as Record<string, unknown>).updated_at) || 0 : 0;
    return ta - tb || a.originalIndex - b.originalIndex;
  });

  let imported = 0;
  let merged = 0;
  let skipped = 0;

  db.transaction(() => {
    for (let idx = 0; idx < indexedItems.length; idx++) {
      const { item: rawItem, originalIndex } = indexedItems[idx];
      const itemLabel = `item[${originalIndex}]`;

      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        skipped++;
        errors.push(`${itemLabel}: invalid_item_object`);
        continue;
      }

      const item = rawItem as Record<string, unknown>;

      // 1. 校验可选 ID 格式，拒绝路径遍历/控制字符/异常长 ID
      if (item.id !== undefined && item.id !== null && item.id !== '') {
        if (!isSafeMemoryId(item.id)) {
          skipped++;
          errors.push(`${itemLabel}: invalid_id_format`);
          continue;
        }
      }

      // 2. 已归档/被取代/被拒绝的历史记录不得借导入复活
      const rawStatus = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
      if (rawStatus === 'superseded' || rawStatus === 'archived' || rawStatus === 'rejected') {
        skipped++;
        continue;
      }
      if (
        rawStatus &&
        rawStatus !== 'active' &&
        rawStatus !== 'candidate' &&
        rawStatus !== 'frozen'
      ) {
        skipped++;
        errors.push(`${itemLabel}: invalid_status:${rawStatus}`);
        continue;
      }

      // 3. 正文与摘要非空及密钥严格拒绝（绝不静默脱敏后落库）
      const rawContentStr =
        typeof item.content === 'string' && item.content.trim()
          ? item.content.trim()
          : typeof item.summary === 'string' && item.summary.trim()
            ? item.summary.trim()
            : '';

      if (!rawContentStr) {
        skipped++;
        errors.push(`${itemLabel}: empty_content`);
        continue;
      }

      if (redactSecrets(rawContentStr).hasSensitive || rawContentStr.includes('[REDACTED:')) {
        skipped++;
        errors.push(`${itemLabel}: sensitive_content_detected`);
        continue;
      }

      const rawSummaryStr =
        typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : undefined;
      if (
        rawSummaryStr &&
        (redactSecrets(rawSummaryStr).hasSensitive || rawSummaryStr.includes('[REDACTED:'))
      ) {
        skipped++;
        errors.push(`${itemLabel}: sensitive_content_detected`);
        continue;
      }

      // 4. 类型与槽位安全策略
      const memType = normalizeMemoryType(item.type, 'semantic');
      if (!trusted && memType === 'meta') {
        skipped++;
        errors.push(`${itemLabel}: untrusted_meta_rejected`);
        continue;
      }

      const rawSlotKey =
        typeof item.slot_key === 'string' && item.slot_key.trim() ? item.slot_key.trim() : null;
      if (rawSlotKey && rawSlotKey.toLowerCase().startsWith('core:') && !trusted) {
        skipped++;
        errors.push(`${itemLabel}: core_slot_requires_trusted_import`);
        continue;
      }

      // 5. 作用域与工作区边界隔离
      let itemScope: Scope | undefined;
      if (item.scope !== undefined && item.scope !== null && item.scope !== '') {
        const s = typeof item.scope === 'string' ? item.scope.trim().toLowerCase() : '';
        if (!VALID_SCOPES.has(s as Scope)) {
          skipped++;
          errors.push(`${itemLabel}: invalid_scope:${String(item.scope)}`);
          continue;
        }
        itemScope = s as Scope;
      }

      const rawItemWs =
        typeof item.workspace_id === 'string' && item.workspace_id.trim()
          ? item.workspace_id.trim()
          : typeof item.workspaceId === 'string' && item.workspaceId.trim()
            ? item.workspaceId.trim()
            : undefined;
      const resolvedItemWs = rawItemWs ? workspaceId(rawItemWs) : undefined;

      const rawItemSess =
        typeof item.session_id === 'string' && item.session_id.trim()
          ? item.session_id.trim()
          : typeof item.sessionId === 'string' && item.sessionId.trim()
            ? item.sessionId.trim()
            : undefined;

      if (!allowCrossWorkspace && targetWsId) {
        if (resolvedItemWs && resolvedItemWs !== targetWsId) {
          skipped++;
          errors.push(`${itemLabel}: cross_workspace_forbidden`);
          continue;
        }
        if (itemScope === 'session' && targetSessionId && rawItemSess && rawItemSess !== targetSessionId) {
          skipped++;
          errors.push(`${itemLabel}: cross_session_forbidden`);
          continue;
        }
      }

      // 非受信任且不允许跨工作区时，将 global/user 或未指定作用域收敛至目标 workspace，防止全局投毒
      let effectiveScope: Scope | undefined = itemScope;
      if (!allowCrossWorkspace && !trusted && targetWsId) {
        if (!effectiveScope || effectiveScope === 'global' || effectiveScope === 'user') {
          effectiveScope = 'workspace';
        }
      } else if (!effectiveScope && (resolvedItemWs || targetWsId)) {
        effectiveScope = 'workspace';
      }

      const effectiveWsId =
        effectiveScope === 'user' || effectiveScope === 'global'
          ? undefined
          : allowCrossWorkspace
            ? resolvedItemWs || targetWsId
            : targetWsId || resolvedItemWs;

      const effectiveSessionId =
        effectiveScope === 'session'
          ? allowCrossWorkspace
            ? rawItemSess || targetSessionId || 'json_import_session'
            : targetSessionId || rawItemSess || 'json_import_session'
          : undefined;

      // 无论 allowCrossWorkspace 是否开启，均严格拒绝向排除工作区写入
      if (effectiveWsId && excludeWorkspaces.length > 0) {
        if (
          isWorkspaceExcluded(effectiveWsId, excludeWorkspaces) ||
          (rawItemWs ? isWorkspaceExcluded(rawItemWs, excludeWorkspaces) : false)
        ) {
          skipped++;
          errors.push(`${itemLabel}: workspace_excluded`);
          continue;
        }
        const mappedPath = resolveWorkspaceCwd(db, effectiveWsId);
        if (mappedPath && isWorkspaceExcluded(mappedPath, excludeWorkspaces)) {
          skipped++;
          errors.push(`${itemLabel}: workspace_excluded`);
          continue;
        }
      }

      // 6. 实体校验
      let validEntities: string[] | undefined;
      if (Array.isArray(item.entities)) {
        const cleanedEnts: string[] = [];
        let entSensitive = false;
        for (const rawEnt of item.entities.slice(0, 32)) {
          if (typeof rawEnt !== 'string') continue;
          const trimmedEnt = rawEnt.trim();
          if (!trimmedEnt) continue;
          if (redactSecrets(trimmedEnt).hasSensitive || trimmedEnt.includes('[REDACTED:')) {
            entSensitive = true;
            break;
          }
          cleanedEnts.push(trimmedEnt);
        }
        if (entSensitive) {
          skipped++;
          errors.push(`${itemLabel}: sensitive_content_detected`);
          continue;
        }
        if (cleanedEnts.length > 0) validEntities = cleanedEnts;
      }

      // 7. 保留 candidate 状态（传 source_kind='system', actor='maintenance' 防止 writer.ts 误晋升为 active）
      const keepCandidate = rawStatus === 'candidate' || requestedActor === 'maintenance';
      const wantFrozen = rawStatus === 'frozen';

      const parsedOrigins = parseOriginKinds(item.origin_kinds);
      const effectiveOrigins: OriginKind[] =
        parsedOrigins.length > 0
          ? parsedOrigins
          : keepCandidate
            ? ['system']
            : requestedActor === 'user'
              ? ['user']
              : ['system'];

      const rawConfidence =
        typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? Math.max(0, Math.min(1, item.confidence))
          : keepCandidate
            ? 0.5
            : trusted
              ? 0.9
              : 0.8;

      const rawImportance =
        typeof item.importance === 'number' && Number.isFinite(item.importance)
          ? Math.max(1, Math.min(10, Math.round(item.importance)))
          : undefined;

      const validFrom =
        typeof item.valid_from === 'number' && Number.isFinite(item.valid_from)
          ? item.valid_from
          : undefined;
      const validTo =
        typeof item.valid_to === 'number' && Number.isFinite(item.valid_to)
          ? item.valid_to
          : undefined;

      try {
        db.transaction(() => {
          const upsertRes = upsertCandidate(
            db,
            {
              type: memType,
              content: rawContentStr,
              summary: rawSummaryStr,
              slot_key: rawSlotKey,
              scope: effectiveScope,
              workspaceId: effectiveWsId,
              sessionId: effectiveSessionId,
              source_kind: keepCandidate ? 'system' : requestedActor === 'user' ? 'user' : 'system',
              origin_kinds: effectiveOrigins,
              confidence: rawConfidence,
              importance: rawImportance,
              valid_from: validFrom,
              valid_to: validTo,
              status: keepCandidate ? 'candidate' : 'active',
              actor: keepCandidate ? 'maintenance' : requestedActor,
              entities: validEntities,
              sources: [
                {
                  session_id: effectiveSessionId || 'json_import',
                  seq: idx + 1,
                  kind: keepCandidate ? 'system' : requestedActor === 'user' ? 'user' : 'system',
                },
              ],
            },
            now,
            opts.cfg
          );

          if (upsertRes.action === 'rejected') {
            skipped++;
            errors.push(`${itemLabel}: ${upsertRes.reason}`);
            return;
          }

          if (upsertRes.action === 'merged') {
            merged++;
          } else {
            imported++;
          }

          if (trusted && !keepCandidate) {
            if (item.pinned === 1 || item.pinned === true) {
              pin(db, upsertRes.id, requestedActor, now);
            }
            if (wantFrozen) {
              freeze(db, upsertRes.id, requestedActor, now);
            }
          }
        });
      } catch (err: unknown) {
        skipped++;
        errors.push(`${itemLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return { imported, merged, skipped, errors };
}

export interface InjectionTelemetry7d {
  totalInjections: number;
  totalTokens: number;
  avgTokens: number;
  hitRate: number;
  positiveRate: number;
  negativeRate: number;
  totalTurns: number;
  correctionRate: number;
}

export interface QueryTelemetryOptions {
  workspaceId?: string;
  excludeWorkspaces?: string[];
  now?: number;
}

function roundPct(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

/**
 * 近 7 天注入与轮次遥测统计（单一真相源，取代 web.ts 与 commands.ts 重复 SQL）：
 * - 通过 session_workspace_owners 严格按 workspaceId 过滤
 * - 尊重 excludeWorkspaces（含 ws_path:* 子目录前缀排除）
 */
export function queryInjectionTelemetry7d(
  db: Db,
  opts: QueryTelemetryOptions = {}
): InjectionTelemetry7d {
  const empty: InjectionTelemetry7d = {
    totalInjections: 0,
    totalTokens: 0,
    avgTokens: 0,
    hitRate: 0,
    positiveRate: 0,
    negativeRate: 0,
    totalTurns: 0,
    correctionRate: 0,
  };

  const now = opts.now ?? Date.now();
  const sevenDaysAgo = now - 7 * 86_400_000;
  const excludeWorkspaces = opts.excludeWorkspaces || [];

  const rawWs = typeof opts.workspaceId === 'string' ? opts.workspaceId.trim() : '';
  const targetWsId = rawWs ? workspaceId(rawWs) : undefined;

  if (targetWsId && excludeWorkspaces.length > 0) {
    if (
      isWorkspaceExcluded(rawWs, excludeWorkspaces) ||
      isWorkspaceExcluded(targetWsId, excludeWorkspaces)
    ) {
      return empty;
    }
    const mappedPath = resolveWorkspaceCwd(db, targetWsId);
    if (mappedPath && isWorkspaceExcluded(mappedPath, excludeWorkspaces)) {
      return empty;
    }
  }

  const excludedIds = expandExcludedWorkspaceIds(db, excludeWorkspaces);

  const buildSessionFilter = (alias: string): { sql: string; params: string[] } => {
    const clauses: string[] = [];
    const params: string[] = [];
    if (targetWsId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM session_workspace_owners swo WHERE swo.session_id = ${alias}.session_id AND swo.workspace_id = ?)`
      );
      params.push(targetWsId);
    }
    if (excludedIds.length > 0) {
      const ph = excludedIds.map(() => '?').join(', ');
      clauses.push(
        `NOT EXISTS (SELECT 1 FROM session_workspace_owners swo_ex WHERE swo_ex.session_id = ${alias}.session_id AND swo_ex.workspace_id IN (${ph}))`
      );
      params.push(...excludedIds);
    }
    return {
      sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
      params,
    };
  };

  const injFilter = buildSessionFilter('i');
  const injAgg = db.get<{
    cnt: number | null;
    total_tokens: number | null;
    neg_turns: number | null;
    pos_turns: number | null;
    hit_turns: number | null;
    attributed_turns: number | null;
  }>(
    `SELECT
       COUNT(*) AS cnt,
       SUM(t) AS total_tokens,
       SUM(neg) AS neg_turns,
       SUM(pos) AS pos_turns,
       SUM(hit) AS hit_turns,
       SUM(attr) AS attributed_turns
     FROM (
       SELECT
         SUM(i.tokens) AS t,
         MAX(CASE WHEN i.outcome IS NOT NULL AND i.outcome <= -0.5 THEN 1 ELSE 0 END) AS neg,
         MAX(CASE WHEN i.outcome IS NOT NULL AND i.outcome >= 0.5 THEN 1 ELSE 0 END) AS pos,
         MAX(CASE WHEN i.used = 1 THEN 1 ELSE 0 END) AS hit,
         MAX(CASE WHEN i.used IS NOT NULL THEN 1 ELSE 0 END) AS attr
       FROM injections i
       WHERE i.created_at >= ? AND i.layer = 'dynamic'${injFilter.sql}
       GROUP BY i.session_id, i.turn
     )`,
    [sevenDaysAgo, ...injFilter.params]
  );

  const tmFilter = buildSessionFilter('tm');
  const tmAgg = db.get<{ total_turns: number | null; corr_turns: number | null }>(
    `SELECT
       COUNT(*) AS total_turns,
       SUM(CASE WHEN tm.correction != 0 THEN 1 ELSE 0 END) AS corr_turns
     FROM turn_metrics tm
     WHERE tm.created_at >= ?${tmFilter.sql}`,
    [sevenDaysAgo, ...tmFilter.params]
  );

  const totalInjections = Number(injAgg?.cnt || 0);
  const totalTokens = Number(injAgg?.total_tokens || 0);
  const negTurns = Number(injAgg?.neg_turns || 0);
  const posTurns = Number(injAgg?.pos_turns || 0);
  const hitTurns = Number(injAgg?.hit_turns || 0);
  const attributedTurns = Number(injAgg?.attributed_turns || 0);

  const tmTotalTurns = Number(tmAgg?.total_turns || 0);
  const tmCorrTurns = Number(tmAgg?.corr_turns || 0);

  const totalTurns = tmTotalTurns > 0 ? Math.max(tmTotalTurns, totalInjections) : totalInjections;
  const avgTokens = totalInjections > 0 ? Math.round(totalTokens / totalInjections) : 0;

  const hitRate =
    attributedTurns > 0
      ? roundPct(hitTurns, totalInjections)
      : tmTotalTurns > 0
        ? roundPct(totalInjections, totalTurns)
        : 0;

  const positiveRate = roundPct(posTurns, totalInjections);
  const negativeRate = roundPct(negTurns, totalInjections);

  const correctionRate =
    tmTotalTurns > 0 && tmCorrTurns > 0
      ? roundPct(tmCorrTurns, totalTurns)
      : totalInjections > 0
        ? roundPct(negTurns, totalInjections)
        : 0;

  return {
    totalInjections,
    totalTokens,
    avgTokens,
    hitRate,
    positiveRate,
    negativeRate,
    totalTurns,
    correctionRate,
  };
}

export type ApiMemoryRecord = Omit<MemoryRecord, 'embedding'> & {
  vikingUri: string;
  hindsightNetwork: HindsightNetwork;
};

/**
 * 批量为 API 响应剥离 embedding BLOB，并确定性附加 vikingUri 与 hindsightNetwork（无 N+1 查询）
 */
export function stripMemoryForApi(
  db: Db | undefined,
  records: MemoryRecord[]
): ApiMemoryRecord[] {
  if (!records || records.length === 0) return [];

  const uriMap = db ? resolveVikingUrisBatch(db, records) : undefined;

  return records.map((m) => {
    const { embedding: _embedding, ...rest } = m;
    return {
      ...rest,
      vikingUri: uriMap?.get(m.id) ?? resolveVikingUri(m),
      hindsightNetwork: classifyHindsightNetwork(m.type, m.slot_key),
    };
  });
}
