import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { PluginConfig } from '../../config.js';
import { isWorkspaceExcluded, memoryPrivacyFilterSQL } from '../../core/privacy.js';
import { workspaceId } from '../../core/scope.js';
import {
  assertWorkspaceAllowed,
  expandExcludedWorkspaceIds,
  listActiveWorkspaces,
  WorkspaceExcludedError,
} from '../../service/index.js';
import type { Db } from '../../types.js';
import { securityHeaders } from './security.js';

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;

export class HttpError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  reqOrigin?: string,
  extraHeaders?: Record<string, string>
): void {
  res.writeHead(status, {
    ...securityHeaders(reqOrigin),
    'Content-Type': 'application/json; charset=utf-8',
    ...(extraHeaders || {}),
  });
  res.end(JSON.stringify(payload));
}

/**
 * 健壮的 JSON 请求体读取：
 * - 超过 maxBytes 立即停止累积并拒绝 413 body_too_large
 * - 监听 error -> 400 request_stream_error（绝不静默返回 {}）
 * - 监听 aborted -> 499 request_aborted
 * - 读超时（默认 10s, unref）-> 408 request_timeout
 */
export function readBodyJson(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
  timeoutMs: number = DEFAULT_BODY_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  if (!req || typeof req.on !== 'function') {
    return Promise.resolve({});
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const off =
        typeof (req as any).off === 'function'
          ? (req as any).off.bind(req)
          : typeof (req as any).removeListener === 'function'
            ? (req as any).removeListener.bind(req)
            : null;
      if (off) {
        off('data', onData);
        off('end', onEnd);
        off('error', onError);
        off('aborted', onAborted);
      }
    };

    const fail = (err: HttpError) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      cleanup();
      reject(err);
    };

    const succeed = (value: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'body_too_large', `Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(buf);
    };

    const onEnd = () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        chunks.length = 0;
        if (!raw) {
          succeed({});
          return;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(new HttpError(400, 'invalid_json_object', 'Request body must be a JSON object'));
          return;
        }
        succeed(parsed as Record<string, unknown>);
      } catch {
        fail(new HttpError(400, 'invalid_json', 'Request body is not valid JSON'));
      }
    };

    const onError = () => {
      fail(new HttpError(400, 'request_stream_error', 'Request stream error'));
    };

    const onAborted = () => {
      fail(new HttpError(499, 'request_aborted', 'Request aborted by client'));
    };

    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        fail(new HttpError(408, 'request_timeout', 'Request body read timed out'));
      },
      Math.max(100, timeoutMs)
    );
    timer.unref?.();

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * 仅在密钥长度 >= 16 时展示前 3 后 4 位，短密钥统一全脱敏为 '********'，空串返回 ''
 */
export function maskApiKey(key?: string): string {
  if (!key) return '';
  if (key.length < 16) return '********';
  return `${key.slice(0, 3)}****${key.slice(-4)}`;
}

export interface SanitizedClientConfig {
  offlineLLM: {
    useDshLlm: boolean;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKeyMasked: string;
    hasApiKey: boolean;
    protocol: 'chat/completions' | 'responses' | 'messages';
  };
  embedding: {
    provider: 'none' | 'openai-compatible';
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKeyMasked: string;
    hasApiKey: boolean;
    dim: number;
    batchSize: number;
    timeoutMs: number;
  };
  privacy: {
    offlineConsent: boolean;
    allowedOfflineEndpoints: string[];
  };
  dailyLLMCalls: number;
  dailyLLMTokens: number;
  distillMaxInputTokens: number;
  dynamicBudgetTokens: number;
  hardBudgetTokens: number;
  stableBudgetTokens: number;
  defaultScope: PluginConfig['defaultScope'];
  webAdminEnabled: boolean;
}

export function sanitizeConfigForClient(cfg: PluginConfig): SanitizedClientConfig {
  return {
    offlineLLM: {
      useDshLlm: !!cfg.offlineLLM.useDshLlm,
      baseURL: cfg.offlineLLM.baseURL || '',
      model: cfg.offlineLLM.model || 'deepseek-chat',
      apiKeyEnv: cfg.offlineLLM.apiKeyEnv || '',
      apiKeyMasked: maskApiKey(cfg.offlineLLM.apiKey),
      hasApiKey: !!cfg.offlineLLM.apiKey,
      protocol: cfg.offlineLLM.protocol || 'chat/completions',
    },
    embedding: {
      provider: cfg.embedding?.provider || 'none',
      baseURL: cfg.embedding?.baseURL || '',
      model: cfg.embedding?.model || '',
      apiKeyEnv: cfg.embedding?.apiKeyEnv || '',
      apiKeyMasked: maskApiKey(cfg.embedding?.apiKey),
      hasApiKey: !!cfg.embedding?.apiKey,
      dim: cfg.embedding?.dim ?? 0,
      batchSize: cfg.embedding?.batchSize ?? 32,
      timeoutMs: cfg.embedding?.timeoutMs ?? 15_000,
    },
    privacy: {
      offlineConsent: !!cfg.privacy.offlineConsent,
      allowedOfflineEndpoints: cfg.privacy.allowedOfflineEndpoints || [],
    },
    dailyLLMCalls: cfg.dailyLLMCalls,
    dailyLLMTokens: cfg.dailyLLMTokens,
    distillMaxInputTokens: cfg.distillMaxInputTokens,
    dynamicBudgetTokens: cfg.dynamicBudgetTokens,
    hardBudgetTokens: cfg.hardBudgetTokens,
    stableBudgetTokens: cfg.stableBudgetTokens,
    defaultScope: cfg.defaultScope,
    webAdminEnabled: !!cfg.webAdminEnabled,
  };
}

export interface WebScope {
  rawWorkspace?: string;
  /** 显式传入并已规范化的 workspaceId（未传参时为 undefined，表示全局/全工作区聚合） */
  wsId?: string;
  /** 供 stableLayer / core-memory / viking / hindsight 使用的默认非排除 workspaceId */
  defaultWsId: string;
  sessionId?: string;
}

function resolveDefaultAllowedWsId(cfg: PluginConfig, db: Db): string {
  const excludeList = cfg.excludeWorkspaces || [];
  const cwd = process.cwd();
  if (!excludeList.length || !isWorkspaceExcluded(cwd, excludeList)) {
    return workspaceId(cwd);
  }
  const active = listActiveWorkspaces(db, cfg);
  return active[0]?.workspaceId || '';
}

export function resolveWebScopeValues(
  rawWorkspace: string | undefined,
  rawSessionId: string | undefined,
  cfg: PluginConfig,
  db: Db
): WebScope {
  const trimmedWs = typeof rawWorkspace === 'string' ? rawWorkspace.trim() : '';
  const trimmedSession = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';

  if (trimmedWs) {
    try {
      assertWorkspaceAllowed(trimmedWs, cfg, { db });
    } catch (err) {
      if (err instanceof WorkspaceExcludedError) {
        throw new HttpError(403, 'workspace_excluded', err.message);
      }
      throw err;
    }
    const resolved = workspaceId(trimmedWs);
    return {
      rawWorkspace: trimmedWs,
      wsId: resolved,
      defaultWsId: resolved,
      sessionId: trimmedSession || undefined,
    };
  }

  return {
    rawWorkspace: undefined,
    wsId: undefined,
    defaultWsId: resolveDefaultAllowedWsId(cfg, db),
    sessionId: trimmedSession || undefined,
  };
}

/**
 * 统一解析查询参数中的 workspaceId / sessionId，并强制执行 excludeWorkspaces 守卫
 */
export function resolveWebScope(url: URL, cfg: PluginConfig, db: Db): WebScope {
  const rawWs = url.searchParams.get('workspaceId') || undefined;
  const rawSession = url.searchParams.get('sessionId') || undefined;
  return resolveWebScopeValues(rawWs, rawSession, cfg, db);
}

/**
 * 构造针对 memories 表的隐私排除过滤片段（同时覆盖 ws_path:* 子目录前缀与来源会话归属）
 */
export function buildPrivacyWhereSQL(
  db: Db,
  cfg: PluginConfig,
  tableAlias?: string
): { sql: string; params: string[] } {
  const expanded = expandExcludedWorkspaceIds(db, cfg.excludeWorkspaces || []);
  if (expanded.length === 0) return { sql: '1 = 1', params: [] };
  const priv = memoryPrivacyFilterSQL(expanded);
  if (priv.params.length === 0) return { sql: '1 = 1', params: [] };
  const sql = tableAlias ? priv.sql.replace(/\bmemories\./g, `${tableAlias}.`) : priv.sql;
  return { sql, params: priv.params };
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function isSameOriginUrl(urlA?: string, urlB?: string): boolean {
  if (!urlA || !urlB) return false;
  try {
    return new URL(urlA.trim()).origin === new URL(urlB.trim()).origin;
  } catch {
    return false;
  }
}
