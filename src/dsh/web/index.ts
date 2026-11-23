import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PluginConfig } from '../../config.js';
import type { Db } from '../../types.js';
import { sendJson } from './http.js';
import {
  BoundedHealthCache,
  type RegisterWebRoutesOptions,
  SingleFlightGuard,
  WebRouter,
} from './router.js';
import { createAdminRoutes } from './routes/admin.js';
import { createConfigRoutes } from './routes/config.js';
import { createCoreMemoryRoutes } from './routes/core-memory.js';
import { createEpistemicRoutes } from './routes/epistemic.js';
import { createMemoriesRoutes } from './routes/memories.js';
import { createOverviewRoutes } from './routes/overview.js';
import { enforceRequestSecurity } from './security.js';

export const API_PREFIX = '/api/dsh-memory';

export { maskApiKey, sanitizeConfigForClient } from './http.js';
export type { RegisterWebRoutesOptions } from './router.js';
export { isAllowedHostHeader, isTrustedOrigin, securityHeaders } from './security.js';

function cloneConfigSnapshot(cfg: PluginConfig): PluginConfig {
  return {
    ...cfg,
    offlineLLM: { ...cfg.offlineLLM },
    embedding: { ...cfg.embedding },
    privacy: {
      offlineConsent: !!cfg.privacy.offlineConsent,
      allowedOfflineEndpoints: [...(cfg.privacy.allowedOfflineEndpoints || [])],
    },
    excludeWorkspaces: [...(cfg.excludeWorkspaces || [])],
  };
}

/**
 * 注册 DSH Memory Studio Web API 路由（Option A 架构）：
 * - Studio 数据端点全部严格只读（含复合 ETag 缓存 `/studio-snapshot`）
 * - `/config` 与 `/llm/test` 提供安全校验后的离线模型配置与连通性测试
 * - 运维写端点统一受 `cfg.webAdminEnabled` 开关保护
 * - 内置插件级 AbortController 与 inFlight 请求追踪，disposer 先注销路由、发出中止信号并等待活跃请求排空，防止关闭 DB 竞态
 */
export function registerWebRoutes(
  ctx: any,
  db: Db,
  cfg: PluginConfig,
  options?: RegisterWebRoutesOptions
): () => Promise<void> {
  if (!ctx?.webServer?.register) {
    return async () => {};
  }

  const initialCfg = cloneConfigSnapshot(options?.initialCfg ?? cfg);
  const controller = new AbortController();
  const inFlight = new Set<Promise<void>>();
  const healthCache = new BoundedHealthCache(32, 60_000);
  const singleFlight = new SingleFlightGuard();

  let configRev = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const router = new WebRouter(API_PREFIX);
  router.register(createOverviewRoutes());
  router.register(createMemoriesRoutes());
  router.register(createCoreMemoryRoutes());
  router.register(createEpistemicRoutes());
  router.register(createConfigRoutes());
  router.register(createAdminRoutes());

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse, peer?: any) => {
      if (closed || controller.signal.aborted) {
        sendJson(res, 503, {
          ok: false,
          code: 'service_unavailable',
          error: 'Server is shutting down',
        });
        return;
      }

      const task = (async () => {
        const sec = enforceRequestSecurity(ctx, req, res, peer);
        if (!sec.ok) {
          sendJson(res, sec.status, {
            ok: false,
            code: sec.code,
            error: sec.error,
          });
          return;
        }
        if (sec.preflightHandled) {
          return;
        }

        const liveCfg = options?.getLiveCfg ? options.getLiveCfg() : cfg;
        await router.dispatch(req, res, sec.reqOrigin, {
          db,
          cfg: liveCfg,
          initialCfg,
          options,
          signal: controller.signal,
          healthCache,
          singleFlight,
          onConfigMutated: () => {
            configRev++;
            healthCache.clear();
          },
          getConfigRev: () => configRev,
        });
      })().finally(() => {
        inFlight.delete(task);
      });

      inFlight.add(task);
      await task;
    },
  });

  return () => {
    if (closePromise) return closePromise;
    closed = true;
    // 同步注销路由，兼容同步单测与即时卸载语义
    if (typeof dispose === 'function') {
      try {
        dispose();
      } catch {}
    }
    if (!controller.signal.aborted) {
      try {
        controller.abort('shutdown');
      } catch {}
    }
    closePromise = Promise.allSettled(Array.from(inFlight)).then(() => undefined);
    return closePromise;
  };
}
