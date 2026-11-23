import type { PluginConfig } from '../config.js';
import { isWorkspaceExcluded } from '../core/privacy.js';
import { resolveWorkspaceCwd, workspaceId } from '../core/scope.js';
import type { Db } from '../types.js';

export interface ResolvedScope {
  rawWorkspace?: string;
  workspaceId: string;
  sessionId?: string;
  excluded: boolean;
}

export interface ActiveWorkspaceInfo {
  workspaceId: string;
  path?: string;
  activeMemories: number;
}

export interface ResolveScopeOptions {
  fallbackCwd?: boolean;
  db?: Db;
}

export class WorkspaceExcludedError extends Error {
  public readonly code = 'WORKSPACE_EXCLUDED' as const;
  public readonly rawWorkspace?: string;
  public readonly workspaceId: string;

  constructor(rawWorkspace: string | undefined, resolvedWorkspaceId: string) {
    super(
      `Workspace '${rawWorkspace || resolvedWorkspaceId || 'unknown'}' is excluded by privacy configuration`
    );
    this.name = 'WorkspaceExcludedError';
    this.rawWorkspace = rawWorkspace;
    this.workspaceId = resolvedWorkspaceId;
  }
}

/**
 * 解析并校验工作区与会话作用域：
 * - 不在未传 rawWorkspace 时静默回退 process.cwd()（仅在显式 fallbackCwd: true 时回退）
 * - 同时对原始路径、16-hex workspaceId 以及 meta 中登记的本地路径执行 excludeWorkspaces 检查
 */
export function resolveScopedContext(
  rawWorkspace: string | undefined,
  sessionId: string | undefined,
  cfg: PluginConfig,
  options?: ResolveScopeOptions
): ResolvedScope {
  const trimmedRaw = typeof rawWorkspace === 'string' ? rawWorkspace.trim() : '';
  const effectiveRaw = trimmedRaw || (options?.fallbackCwd ? process.cwd() : '');
  const resolvedWsId = effectiveRaw ? workspaceId(effectiveRaw) : '';
  const trimmedSession = typeof sessionId === 'string' ? sessionId.trim() : '';
  const normalizedSessionId = trimmedSession || undefined;

  const excludeList = cfg?.excludeWorkspaces || [];
  let excluded = false;

  if (excludeList.length > 0) {
    if (effectiveRaw && isWorkspaceExcluded(effectiveRaw, excludeList)) {
      excluded = true;
    } else if (resolvedWsId && isWorkspaceExcluded(resolvedWsId, excludeList)) {
      excluded = true;
    } else if (resolvedWsId && options?.db) {
      const mappedPath = resolveWorkspaceCwd(options.db, resolvedWsId);
      if (mappedPath && isWorkspaceExcluded(mappedPath, excludeList)) {
        excluded = true;
      }
    }
  }

  return {
    rawWorkspace: effectiveRaw || undefined,
    workspaceId: resolvedWsId,
    sessionId: normalizedSessionId,
    excluded,
  };
}

/**
 * 断言工作区未被 excludeWorkspaces 屏蔽，否则抛出强类型 WorkspaceExcludedError
 */
export function assertWorkspaceAllowed(
  rawWorkspace: string | undefined,
  cfg: PluginConfig,
  options?: ResolveScopeOptions
): void {
  const resolved = resolveScopedContext(rawWorkspace, undefined, cfg, options);
  if (resolved.excluded) {
    throw new WorkspaceExcludedError(resolved.rawWorkspace, resolved.workspaceId);
  }
}

/**
 * 将 excludeWorkspaces 展开为 SQL IN (...) 可用的精确 ID/原值集合
 * （包含直接条目、16-hex 哈希，以及 meta['ws_path:*'] 下命中子目录前缀排除的工作区哈希）
 */
export function expandExcludedWorkspaceIds(db: Db, excludeWorkspaces: string[] = []): string[] {
  if (!excludeWorkspaces || excludeWorkspaces.length === 0) return [];

  const excluded = new Set<string>();
  for (const rawItem of excludeWorkspaces) {
    if (typeof rawItem !== 'string') continue;
    const trimmed = rawItem.trim();
    if (!trimmed) continue;
    excluded.add(trimmed);
    const hashed = workspaceId(trimmed);
    if (hashed) excluded.add(hashed);
  }

  try {
    const pathRows = db.all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key LIKE 'ws_path:%'"
    );
    for (const row of pathRows) {
      const mappedWsId = row.key.slice('ws_path:'.length).trim().toLowerCase();
      if (!mappedWsId) continue;
      if (
        isWorkspaceExcluded(mappedWsId, excludeWorkspaces) ||
        (row.value && isWorkspaceExcluded(row.value, excludeWorkspaces))
      ) {
        excluded.add(mappedWsId);
      }
    }
  } catch {
    // meta table may not contain ws_path entries
  }

  return Array.from(excluded);
}

/**
 * 枚举所有未被 excludeWorkspaces 排除的活跃工作区（聚合 memories 与 meta ws_path:* 映射），
 * 供 Studio UI 工作区选择器及全局运维任务使用。
 */
export function listActiveWorkspaces(db: Db, cfg: PluginConfig): ActiveWorkspaceInfo[] {
  const excludeList = cfg?.excludeWorkspaces || [];
  const workspaces = new Map<
    string,
    { path?: string; activeMemories: number; registered: boolean }
  >();

  const memRows = db.all<{ workspace_id: string; active_cnt: number | null }>(
    `SELECT workspace_id,
            SUM(CASE WHEN status IN ('active', 'frozen') THEN 1 ELSE 0 END) AS active_cnt
     FROM memories
     WHERE workspace_id IS NOT NULL AND workspace_id != ''
     GROUP BY workspace_id`
  );

  for (const row of memRows) {
    const wsId = workspaceId(row.workspace_id);
    if (!wsId) continue;
    const cnt = Number(row.active_cnt || 0);
    const existing = workspaces.get(wsId);
    if (existing) {
      existing.activeMemories += cnt;
    } else {
      workspaces.set(wsId, { activeMemories: cnt, registered: false });
    }
  }

  try {
    const metaRows = db.all<{ key: string; value: string }>(
      "SELECT key, value FROM meta WHERE key LIKE 'ws_path:%'"
    );
    for (const row of metaRows) {
      const wsId = row.key.slice('ws_path:'.length).trim().toLowerCase();
      if (!wsId) continue;
      const wsPath =
        typeof row.value === 'string' && row.value.trim() ? row.value.trim() : undefined;
      const existing = workspaces.get(wsId);
      if (existing) {
        if (wsPath) existing.path = wsPath;
        existing.registered = true;
      } else {
        workspaces.set(wsId, { path: wsPath, activeMemories: 0, registered: true });
      }
    }
  } catch {
    // ignore if meta has no ws_path rows
  }

  const results: ActiveWorkspaceInfo[] = [];
  for (const [wsId, info] of workspaces.entries()) {
    // 跳过既无活跃/冻结记忆又未在 ws_path:* 登记的历史废弃工作区
    if (info.activeMemories <= 0 && !info.registered) continue;

    if (
      excludeList.length > 0 &&
      (isWorkspaceExcluded(wsId, excludeList) ||
        (info.path ? isWorkspaceExcluded(info.path, excludeList) : false))
    ) {
      continue;
    }

    results.push({
      workspaceId: wsId,
      ...(info.path ? { path: info.path } : {}),
      activeMemories: info.activeMemories,
    });
  }

  results.sort(
    (a, b) => b.activeMemories - a.activeMemories || a.workspaceId.localeCompare(b.workspaceId)
  );
  return results;
}
