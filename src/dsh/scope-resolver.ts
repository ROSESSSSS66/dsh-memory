import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../types.js';
import {
  normalizeWorkspacePath,
  rememberWorkspacePath,
  resolveWorkspaceCwd,
  workspaceId,
} from '../core/scope.js';
import { isWorkspaceExcluded } from '../core/privacy.js';

const HEX_WORKSPACE_ID_RE = /^[0-9a-f]{16}$/i;

export function isWorkspaceHashId(value: string): boolean {
  return HEX_WORKSPACE_ID_RE.test(value.trim());
}

/**
 * 判断候选字符串是否像真实的本地文件系统路径（而非 16-hex 哈希 ID）
 */
export function isFilesystemPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || isWorkspaceHashId(trimmed)) return false;
  return (
    path.isAbsolute(trimmed) ||
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  );
}

export function extractSessionCwd(session: any): string {
  if (!session || typeof session !== 'object') return '';
  const direct = typeof session.cwd === 'string' ? session.cwd.trim() : '';
  if (direct) return direct;
  const headerCwd = typeof session.header?.cwd === 'string' ? session.header.cwd.trim() : '';
  if (headerCwd) return headerCwd;
  const ws = typeof session.workspaceId === 'string' ? session.workspaceId.trim() : '';
  return ws;
}

export function extractAgentCwd(agent: any): string {
  if (!agent || typeof agent !== 'object') return '';
  const direct = typeof agent.cwd === 'string' ? agent.cwd.trim() : '';
  if (direct) return direct;
  return extractSessionCwd(agent.session);
}

export function resolveCtxAgentCwd(ctx: any, sessionId?: string): string {
  try {
    const list = typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : undefined;
    if (Array.isArray(list) && list.length > 0 && sessionId) {
      // 仅认会话精确匹配的 agent：严禁回退到列表首个无关 agent 造成跨工作区串扰
      const matched = list.find((a: any) => a?.session?.id === sessionId);
      const matchedCwd = extractAgentCwd(matched);
      if (matchedCwd) return matchedCwd;
    }
  } catch {}
  return '';
}

export function resolveSessionWorkspaceId(db: Db | undefined, sessionId?: string): string {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!db || !sid) return '';
  try {
    const owner = db.get<{ workspace_id: string }>(
      "SELECT workspace_id FROM session_workspace_owners WHERE session_id = ? AND workspace_id != '' LIMIT 1",
      [sid]
    );
    if (owner?.workspace_id) return owner.workspace_id;
    const raw = db.get<{ workspace_id: string }>(
      "SELECT workspace_id FROM raw_events WHERE session_id = ? AND workspace_id != '' LIMIT 1",
      [sid]
    );
    return raw?.workspace_id || '';
  } catch {
    return '';
  }
}

/**
 * 规范化工作区路径并在观测到真实文件系统路径时登记 meta['ws_path:*'] 映射
 */
export function observeWorkspacePath(db: Db | undefined, rawCwd: string): string {
  const trimmed = (rawCwd || '').trim();
  if (!trimmed) return '';
  if (isWorkspaceHashId(trimmed)) {
    return trimmed.toLowerCase();
  }
  const normalized = normalizeWorkspacePath(trimmed);
  if (db && isFilesystemPath(trimmed)) {
    rememberWorkspacePath(db, trimmed);
  }
  return workspaceId(normalized || trimmed);
}

export interface RuntimeScopeInput {
  agent?: any;
  session?: any;
  sessionId?: string;
  cwd?: string;
  workspaceId?: string;
  turn?: number;
  position?: { turn?: number };
}

export interface ResolveRuntimeScopeOptions {
  /** 是否在无法确定任何工作区时回退 process.cwd()（默认 false：写操作必须 fail closed） */
  allowCwdFallback?: boolean;
  /** 当观测到真实本地路径时是否写入 meta['ws_path:*']（默认 true） */
  rememberPath?: boolean;
}

export interface ResolvedRuntimeScope {
  /** 是否已确定性地解析出工作区（路径或 workspaceId） */
  resolved: boolean;
  /** 原始 cwd 路径或工作区标识（未解析时为空字符串） */
  cwd: string;
  /** 规范化 16-hex workspaceId（未解析时为空字符串） */
  workspaceId: string;
  /** 真实本地文件系统路径（仅当原始输入或 meta 映射存在真实路径时提供） */
  workspacePath?: string;
  /** 会话 ID（若未提供显式 sessionId 则为 'default_session'） */
  sessId: string;
  /** 调用上下文显式携带的 sessionId */
  explicitSessionId?: string;
  /** 当前轮次号（缺省 0） */
  turn: number;
}

/**
 * 统一运行时作用域解析器（供 plugin / pre-step / tool-registry / job-handlers / commands 复用）：
 * - 按 agent -> session -> input.cwd -> ctx.agents(by sessionId) -> input.workspaceId -> session_workspace_owners/raw_events 顺序解析
 * - 默认绝不静默回退 process.cwd()，防止未知/排除工作区静默写入错误工作区
 * - 观测到真实路径时规范化并登记 ws_path:*
 */
export function resolveRuntimeScope(
  ctx: any,
  db: Db | undefined,
  input?: RuntimeScopeInput,
  options?: ResolveRuntimeScopeOptions
): ResolvedRuntimeScope {
  const agent = input?.agent;
  const session = input?.session || agent?.session;
  const rawSessionId =
    (typeof input?.sessionId === 'string' && input.sessionId.trim()) ||
    (typeof session?.id === 'string' && session.id.trim()) ||
    '';

  const rawTurn =
    typeof input?.turn === 'number' && Number.isFinite(input.turn)
      ? input.turn
      : typeof input?.position?.turn === 'number' && Number.isFinite(input.position.turn)
        ? input.position.turn
        : typeof agent?.position?.turn === 'number' && Number.isFinite(agent.position.turn)
          ? agent.position.turn
          : 0;

  let rawCwd =
    extractAgentCwd(agent) ||
    extractSessionCwd(session) ||
    (typeof input?.cwd === 'string' ? input.cwd.trim() : '') ||
    resolveCtxAgentCwd(ctx, rawSessionId || undefined) ||
    (typeof input?.workspaceId === 'string' ? input.workspaceId.trim() : '') ||
    resolveSessionWorkspaceId(db, rawSessionId || undefined);

  if (!rawCwd && options?.allowCwdFallback === true) {
    rawCwd = process.cwd();
  }

  if (!rawCwd) {
    return {
      resolved: false,
      cwd: '',
      workspaceId: '',
      sessId: rawSessionId || 'default_session',
      explicitSessionId: rawSessionId || undefined,
      turn: rawTurn,
    };
  }

  const shouldRemember = options?.rememberPath !== false;
  let wsId: string;
  let workspacePath: string | undefined;

  if (isWorkspaceHashId(rawCwd)) {
    wsId = rawCwd.toLowerCase();
    workspacePath = db ? resolveWorkspaceCwd(db, wsId) : undefined;
  } else {
    const normalized = normalizeWorkspacePath(rawCwd);
    wsId = workspaceId(normalized || rawCwd);
    if (isFilesystemPath(rawCwd)) {
      workspacePath = path.resolve(rawCwd);
      if (shouldRemember && db) {
        rememberWorkspacePath(db, rawCwd);
      }
    }
  }

  return {
    resolved: Boolean(wsId),
    cwd: rawCwd,
    workspaceId: wsId,
    ...(workspacePath ? { workspacePath } : {}),
    sessId: rawSessionId || 'default_session',
    explicitSessionId: rawSessionId || undefined,
    turn: rawTurn,
  };
}

/**
 * 综合检查已解析作用域（含原始路径、16-hex ID 及 meta 登记路径）是否命中 excludeWorkspaces
 */
export function isResolvedScopeExcluded(
  scope: Pick<ResolvedRuntimeScope, 'cwd' | 'workspaceId' | 'workspacePath'>,
  excludeWorkspaces: string[] | undefined,
  db?: Db
): boolean {
  if (!excludeWorkspaces || excludeWorkspaces.length === 0) return false;
  if (scope.cwd && isWorkspaceExcluded(scope.cwd, excludeWorkspaces)) return true;
  if (scope.workspaceId && isWorkspaceExcluded(scope.workspaceId, excludeWorkspaces)) return true;
  if (scope.workspacePath && isWorkspaceExcluded(scope.workspacePath, excludeWorkspaces)) return true;
  if (db && scope.workspaceId) {
    const mapped = resolveWorkspaceCwd(db, scope.workspaceId);
    if (mapped && isWorkspaceExcluded(mapped, excludeWorkspaces)) return true;
  }
  return false;
}

/**
 * 检查任意工作区标识（路径或 16-hex ID）是否命中 excludeWorkspaces（含 meta 映射路径）
 */
export function isWorkspaceOrMappedExcluded(
  rawWorkspace: string | undefined,
  excludeWorkspaces: string[] | undefined,
  db?: Db
): boolean {
  if (!excludeWorkspaces || excludeWorkspaces.length === 0) return false;
  const trimmed = (rawWorkspace || '').trim();
  if (!trimmed) return false;
  if (isWorkspaceExcluded(trimmed, excludeWorkspaces)) return true;
  const wsId = workspaceId(trimmed);
  if (wsId && isWorkspaceExcluded(wsId, excludeWorkspaces)) return true;
  if (db && wsId) {
    const mapped = resolveWorkspaceCwd(db, wsId);
    if (mapped && isWorkspaceExcluded(mapped, excludeWorkspaces)) return true;
  }
  return false;
}

function isExistingDirectory(candidate: string | undefined): string | undefined {
  const trimmed = (candidate || '').trim();
  if (!trimmed || isWorkspaceHashId(trimmed)) return undefined;
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return resolved;
    }
  } catch {}
  return undefined;
}

/**
 * 为 CLI 导出/导入/初始化解析工作区本地目录：
 * 优先取 ctx.cwd -> ctx.workspaceId(真实目录) -> meta['ws_path:*'] -> 最后回退 process.cwd()
 */
export function resolveWorkspaceDir(
  ctx?: { cwd?: string; workspaceId?: string },
  db?: Db
): string {
  const directCwd = isExistingDirectory(ctx?.cwd);
  if (directCwd) return directCwd;

  const directWs = isExistingDirectory(ctx?.workspaceId);
  if (directWs) return directWs;

  if (db && ctx?.workspaceId) {
    const wsId = workspaceId(ctx.workspaceId);
    const mapped = isExistingDirectory(resolveWorkspaceCwd(db, wsId));
    if (mapped) return mapped;
  }

  return process.cwd();
}
