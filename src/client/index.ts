import * as React from 'react';
import { MemoryApp } from './MemoryApp.js';
import { MemoryErrorBoundary } from './components/MemoryErrorBoundary.js';
import { getMessages, resolveUiLocale } from './i18n.js';
import type { MemoryHostAdapter, UiLocale } from './types.js';

interface HostContextLike {
  get?: (name: string) => unknown;
  effect?: (callback: () => unknown, label?: string) => unknown;
  inject?: (deps: string[], callback: (scoped: HostContextLike) => unknown) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => (() => void) | void;
  locale?: HostLocaleLike;
  connection?: HostConnectionLike;
  workspace?: { id?: string; current?: { id?: string } };
  slots?: {
    inject?: (name: string, callback: () => unknown) => unknown;
    register: (meta: Record<string, unknown>, render: (props?: unknown) => React.ReactNode) => unknown;
  };
}

interface HostLocaleLike {
  register?: (namespace: string, dict: Record<string, Record<string, string>>) => unknown;
  bind?: (namespace: string) => (key: string) => unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => (() => void) | void;
  subscribe?: (listener: (...args: unknown[]) => void) => (() => void) | void;
  current?: string;
  locale?: string;
  language?: string;
  lang?: string;
  value?: string;
  get?: () => unknown;
}

interface HostConnectionLike {
  baseURL?: string;
  baseUrl?: string;
  endpoint?: string;
  httpUrl?: string;
  url?: string;
  token?: string;
  headers?: Record<string, string>;
  getAuthHeaders?: () => Record<string, string> | undefined;
}

function BrainIcon({ size = 16 }: { size?: number }) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.8',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    React.createElement('path', {
      d: 'M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04z',
    }),
    React.createElement('path', {
      d: 'M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04z',
    })
  );
}

function getService<T>(ctx: HostContextLike | undefined, name: string): T | undefined {
  if (!ctx) return undefined;
  // On Cordis 4.x strict inject Proxy contexts, ctx.get(name) is the ONLY safe optional lookup;
  // never fall through to bare ctx[name], which throws "cannot get property <name> without inject".
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name) as T | undefined;
    } catch {
      return undefined;
    }
  }
  try {
    return (ctx as Record<string, unknown>)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

function resolveConnectionBaseUrl(conn: HostConnectionLike | undefined): string {
  if (!conn) return '';
  for (const raw of [conn.baseURL, conn.baseUrl, conn.endpoint, conn.httpUrl, conn.url]) {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (/^https?:\/\//i.test(trimmed)) {
        return trimmed.replace(/\/+$/, '');
      }
    }
  }
  return '';
}

function resolveConnectionHeaders(conn: HostConnectionLike | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!conn) return out;
  if (typeof conn.getAuthHeaders === 'function') {
    try {
      const dynamic = conn.getAuthHeaders();
      if (dynamic && typeof dynamic === 'object') {
        for (const [k, v] of Object.entries(dynamic)) {
          if (typeof v === 'string') out[k] = v;
        }
      }
    } catch {
      // ignore host header getter errors
    }
  }
  if (conn.headers && typeof conn.headers === 'object') {
    for (const [k, v] of Object.entries(conn.headers)) {
      if (typeof v === 'string' && !(k in out)) {
        out[k] = v;
      }
    }
  }
  if (
    typeof conn.token === 'string' &&
    conn.token.trim() &&
    !('Authorization' in out) &&
    !('authorization' in out)
  ) {
    out['Authorization'] = `Bearer ${conn.token.trim()}`;
  }
  return out;
}

function createHostFetchApi(ctx: HostContextLike | undefined) {
  return (path: string, init?: RequestInit): Promise<Response> => {
    const conn = getService<HostConnectionLike>(ctx, 'connection');
    const baseUrl = resolveConnectionBaseUrl(conn);
    const resolvedUrl =
      baseUrl && path.startsWith('/') ? `${baseUrl}${path}` : path;

    const authHeaders = resolveConnectionHeaders(conn);
    const mergedHeaders = new Headers(authHeaders);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
    }

    const hasHeaders = Array.from(mergedHeaders.keys()).length > 0;
    const requestInit: RequestInit = hasHeaders
      ? { ...init, headers: mergedHeaders }
      : { ...init };

    return fetch(resolvedUrl, requestInit);
  };
}

function resolveInitialWorkspaceId(ctx: HostContextLike | undefined): string | undefined {
  const ws = getService<{ id?: string; current?: { id?: string } }>(ctx, 'workspace');
  const candidate = ws?.current?.id ?? ws?.id;
  if (typeof candidate === 'string' && candidate.trim()) {
    return candidate.trim();
  }
  if (typeof window !== 'undefined' && window.location?.search) {
    try {
      const param = new URLSearchParams(window.location.search).get('workspaceId');
      if (param && param.trim()) return param.trim();
    } catch {
      // ignore malformed location
    }
  }
  return undefined;
}

interface MemoryStudioHostRootProps {
  ctx: HostContextLike | undefined;
  fetchApi: NonNullable<MemoryHostAdapter['fetchApi']>;
  initialWorkspaceId?: string;
}

function MemoryStudioHostRoot({
  ctx,
  fetchApi,
  initialWorkspaceId,
}: MemoryStudioHostRootProps) {
  const readLocale = React.useCallback((): UiLocale => {
    const loc = getService<HostLocaleLike>(ctx, 'locale');
    return resolveUiLocale(loc);
  }, [ctx]);

  const [locale, setLocale] = React.useState<UiLocale>(readLocale);

  React.useEffect(() => {
    setLocale(readLocale());
    const unsubscribers: Array<() => void> = [];
    const onLocaleUpdate = (next?: unknown) => {
      setLocale(next ? resolveUiLocale(next) : readLocale());
    };

    const loc = getService<HostLocaleLike>(ctx, 'locale');
    if (typeof loc?.subscribe === 'function') {
      const off = loc.subscribe(onLocaleUpdate);
      if (typeof off === 'function') unsubscribers.push(off);
    } else if (typeof loc?.on === 'function') {
      const off = loc.on('change', onLocaleUpdate);
      if (typeof off === 'function') unsubscribers.push(off);
    }

    if (typeof ctx?.on === 'function') {
      const off = ctx.on('locale/change', onLocaleUpdate);
      if (typeof off === 'function') unsubscribers.push(off);
    }

    return () => {
      for (const off of unsubscribers) {
        try {
          off();
        } catch {
          // ignore host cleanup errors
        }
      }
    };
  }, [ctx, readLocale]);

  return React.createElement(
    MemoryErrorBoundary,
    { locale },
    React.createElement(MemoryApp, {
      fetchApi,
      locale,
      initialWorkspaceId,
    })
  );
}

export const name = 'dsh-memory';
export const inject = ['slots'];

export function apply(ctx: HostContextLike) {
  const SIDEBAR_PANEL_ID = 'dsh-memory';
  const SIDEBAR_PANEL_ORDER = 15;

  const getLocale = () => getService<HostLocaleLike>(ctx, 'locale');

  // Bind locale dictionary lifecycle to the scope that owns it (fixes Cordis scope leak)
  const registerLocaleDict = (
    scope: HostContextLike | undefined,
    loc: HostLocaleLike | undefined
  ) => {
    if (!loc || typeof loc.register !== 'function') return;
    const register = () =>
      loc.register?.(SIDEBAR_PANEL_ID, {
        zh: { panel: getMessages('zh').panelLabel },
        en: { panel: getMessages('en').panelLabel },
      });
    if (typeof scope?.effect === 'function') {
      scope.effect(register, 'dsh-memory: dictionaries');
    } else {
      register();
    }
  };

  const initialLocale = getLocale();
  if (initialLocale) {
    registerLocaleDict(ctx, initialLocale);
  } else if (typeof ctx?.inject === 'function') {
    ctx.inject(['locale'], (scoped: HostContextLike) =>
      registerLocaleDict(scoped, getService<HostLocaleLike>(scoped, 'locale'))
    );
  }

  const getPanelLabel = () => {
    const loc = getLocale();
    if (loc && typeof loc.bind === 'function') {
      try {
        const value = loc.bind(SIDEBAR_PANEL_ID)('panel');
        if (typeof value === 'string' && value.trim()) return value;
      } catch {
        // fall through to localized default
      }
    }
    return getMessages(resolveUiLocale(loc)).panelLabel;
  };

  const fetchApi = createHostFetchApi(ctx);
  const initialWorkspaceId = resolveInitialWorkspaceId(ctx);

  ctx.slots?.inject?.('main', () => {
    return ctx.slots?.register(
      {
        name: 'main',
        key: SIDEBAR_PANEL_ID,
        locale: SIDEBAR_PANEL_ID,
      },
      () =>
        React.createElement(MemoryStudioHostRoot, {
          ctx,
          fetchApi,
          initialWorkspaceId,
        })
    );
  });

  ctx.slots?.inject?.('sidebar.panellist', () => {
    return ctx.slots?.register(
      {
        name: 'sidebar.panellist',
        id: SIDEBAR_PANEL_ID,
        order: SIDEBAR_PANEL_ORDER,
        label: getPanelLabel,
        locale: SIDEBAR_PANEL_ID,
      },
      (ownerProps: unknown) => {
        const size =
          ownerProps &&
          typeof ownerProps === 'object' &&
          'size' in ownerProps &&
          typeof (ownerProps as { size?: unknown }).size === 'number'
            ? (ownerProps as { size: number }).size
            : 16;
        return React.createElement(BrainIcon, { size });
      }
    );
  });
}

export default {
  name,
  inject,
  apply,
};
