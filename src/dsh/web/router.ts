import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { ZodError } from 'zod';
import type { Db } from '../../types.js';
import type { PluginConfig } from '../../config.js';
import type { LookupFn } from '../../core/privacy.js';
import type { JobScheduler } from '../../jobs/scheduler.js';
import { WorkspaceExcludedError } from '../../service/index.js';
import { HttpError, sendJson } from './http.js';
import { securityHeaders } from './security.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RegisterWebRoutesOptions {
  scheduler?: JobScheduler;
  initialCfg?: PluginConfig;
  getLiveCfg?: () => PluginConfig;
  onConfigUpdated?: (nextCfg: PluginConfig) => void;
  activeWorkspaces?: () => string[];
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
}

export class BoundedHealthCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly map = new Map<string, { fp: string; at: number; health: unknown }>();

  constructor(maxEntries: number = 32, ttlMs: number = 60_000) {
    this.maxEntries = Math.max(1, maxEntries);
    this.ttlMs = Math.max(1_000, ttlMs);
  }

  get<T>(key: string, fp: string, now: number = Date.now()): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.fp !== fp || now - hit.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU touch
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.health as T;
  }

  set(key: string, fp: string, health: unknown, now: number = Date.now()): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    while (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { fp, at: now, health });
  }

  clear(): void {
    this.map.clear();
  }
}

export class SingleFlightGuard {
  private readonly active = new Set<string>();

  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.active.has(key)) {
      throw new HttpError(409, 'action_in_progress', `Action '${key}' is already in progress`);
    }
    this.active.add(key);
    try {
      return await fn();
    } finally {
      this.active.delete(key);
    }
  }
}

export interface WebRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  subPath: string;
  method: string;
  reqOrigin?: string;
  db: Db;
  cfg: PluginConfig;
  initialCfg: PluginConfig;
  options?: RegisterWebRoutesOptions;
  signal: AbortSignal;
  healthCache: BoundedHealthCache;
  singleFlight: SingleFlightGuard;
  onConfigMutated: () => void;
  getConfigRev: () => number;
}

export type RouteHandler = (rctx: WebRouteContext) => Promise<void> | void;

export interface RouteEntry {
  path: string;
  methods: Partial<Record<HttpMethod, RouteHandler>>;
}

export class WebRouter {
  private readonly routes = new Map<string, Partial<Record<HttpMethod, RouteHandler>>>();
  private readonly apiPrefix: string;

  constructor(apiPrefix: string) {
    this.apiPrefix = apiPrefix;
  }

  register(entries: RouteEntry[]): void {
    for (const entry of entries) {
      const existing = this.routes.get(entry.path) || {};
      this.routes.set(entry.path, { ...existing, ...entry.methods });
    }
  }

  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    reqOrigin: string | undefined,
    base: Omit<WebRouteContext, 'req' | 'res' | 'url' | 'subPath' | 'method' | 'reqOrigin'>
  ): Promise<void> {
    let reqUrl: URL;
    try {
      reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      sendJson(
        res,
        400,
        { ok: false, code: 'invalid_url', error: 'Malformed request URL' },
        reqOrigin
      );
      return;
    }

    const pathname = reqUrl.pathname;
    if (pathname !== this.apiPrefix && !pathname.startsWith(`${this.apiPrefix}/`)) {
      sendJson(
        res,
        404,
        { ok: false, code: 'not_found', error: `Not found: ${pathname}` },
        reqOrigin
      );
      return;
    }

    const subPath = pathname.slice(this.apiPrefix.length).replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase() as HttpMethod;

    const routeMethods = this.routes.get(subPath);
    if (!routeMethods) {
      sendJson(
        res,
        404,
        { ok: false, code: 'not_found', error: `Not found: ${pathname}` },
        reqOrigin
      );
      return;
    }

    const handler = routeMethods[method];
    if (!handler) {
      const allowed = [...Object.keys(routeMethods), 'OPTIONS'].join(', ');
      sendJson(
        res,
        405,
        {
          ok: false,
          code: 'method_not_allowed',
          error: `Method ${method} is not allowed on ${subPath}`,
        },
        reqOrigin,
        { Allow: allowed }
      );
      return;
    }

    const rctx: WebRouteContext = {
      ...base,
      req,
      res,
      url: reqUrl,
      subPath,
      method,
      reqOrigin,
    };

    try {
      await handler(rctx);
    } catch (err: unknown) {
      if ((res as any).writableEnded || (res as any).headersSent) {
        return;
      }
      this.handleError(res, err, reqOrigin);
    }
  }

  private handleError(res: ServerResponse, err: unknown, reqOrigin?: string): void {
    if (err instanceof HttpError) {
      sendJson(
        res,
        err.status,
        { ok: false, code: err.code, error: err.message },
        reqOrigin
      );
      return;
    }

    if (err instanceof WorkspaceExcludedError) {
      sendJson(
        res,
        403,
        { ok: false, code: 'workspace_excluded', error: err.message },
        reqOrigin
      );
      return;
    }

    if (err instanceof ZodError) {
      const first = err.issues[0];
      sendJson(
        res,
        400,
        {
          ok: false,
          code: 'validation_error',
          error: first?.message || 'Invalid request payload',
          issues: err.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        reqOrigin
      );
      return;
    }

    if (err instanceof Error) {
      if (err.message.startsWith('Ambiguous short id')) {
        sendJson(
          res,
          400,
          { ok: false, code: 'ambiguous_id', error: err.message },
          reqOrigin
        );
        return;
      }
      if (err.message === 'memory_is_frozen') {
        sendJson(
          res,
          409,
          { ok: false, code: 'memory_is_frozen', error: 'Memory is frozen and cannot be modified' },
          reqOrigin
        );
        return;
      }
      if (err.message === 'memory_not_found') {
        sendJson(
          res,
          404,
          { ok: false, code: 'memory_not_found', error: 'Memory not found' },
          reqOrigin
        );
        return;
      }
      if (err.message === 'cannot_assign_core_slot_key') {
        sendJson(
          res,
          400,
          {
            ok: false,
            code: 'cannot_assign_core_slot_key',
            error: 'Cannot assign core:* slot key via generic memory edit',
          },
          reqOrigin
        );
        return;
      }
      if (err.message === 'sensitive_content_detected') {
        sendJson(
          res,
          400,
          {
            ok: false,
            code: 'sensitive_content_detected',
            error: 'Sensitive credentials detected in content',
          },
          reqOrigin
        );
        return;
      }
      if (err.message === 'invalid_core_block') {
        sendJson(
          res,
          400,
          { ok: false, code: 'invalid_core_block', error: 'Invalid core memory block name' },
          reqOrigin
        );
        return;
      }
      if (err.message === 'workspace_excluded') {
        sendJson(
          res,
          403,
          {
            ok: false,
            code: 'workspace_excluded',
            error: 'Workspace is excluded by privacy configuration',
          },
          reqOrigin
        );
        return;
      }
    }

    // 500 绝不向客户端暴露内部错误堆栈或原始异常消息
    console.error('[dsh-memory web API error]', err);
    res.writeHead(500, {
      ...securityHeaders(reqOrigin),
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ ok: false, code: 'internal_error', error: 'Internal server error' }));
  }
}
