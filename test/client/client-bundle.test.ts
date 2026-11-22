import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(projectRoot, 'dist', 'client.js');
const buildScriptPath = path.join(projectRoot, 'scripts', 'build-client.mjs');

const nodeRequire = createRequire(import.meta.url);
const jsxRuntime = nodeRequire('react/jsx-runtime') as Record<string, unknown>;
const reactDom = nodeRequire('react-dom') as Record<string, unknown>;
const reactDomServer = nodeRequire('react-dom/server') as {
  renderToStaticMarkup: (element: React.ReactElement) => string;
};

interface ModuleLoaderRegistration {
  id: string;
  factory: (req: (id: string) => unknown) => ClientPluginExports;
}

interface ClientPluginExports {
  name: string;
  inject: string[];
  apply: (ctx: MockHostContext) => void;
  default?: {
    name: string;
    inject: string[];
    apply: (ctx: MockHostContext) => void;
  };
}

interface MockLocaleService {
  current?: string;
  register: ReturnType<typeof vi.fn>;
  bind: ReturnType<typeof vi.fn>;
}

interface RegisteredSlot {
  slotName: string;
  meta: Record<string, unknown>;
  render: (props?: unknown) => React.ReactElement;
}

interface MockHostContext {
  get?: (name: string) => unknown;
  effect?: ReturnType<typeof vi.fn>;
  inject?: ReturnType<typeof vi.fn>;
  locale?: MockLocaleService;
  connection?: { baseURL?: string; token?: string };
  workspace?: { id?: string };
  slots?: {
    inject: (name: string, callback: () => unknown) => unknown;
    register: (
      meta: Record<string, unknown>,
      render: (props?: unknown) => React.ReactElement
    ) => unknown;
  };
}

let bundleCode = '';

function loadBundleInVm(): {
  registration: ModuleLoaderRegistration;
  exports: ClientPluginExports;
} {
  let captured: ModuleLoaderRegistration | null = null;
  const load = vi.fn((reg: ModuleLoaderRegistration) => {
    captured = reg;
  });

  const sandbox = {
    window: {
      __ModuleLoader__: { load },
      location: { search: '' },
    },
    console,
    URL,
    URLSearchParams,
    Headers,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: vi.fn(),
  };

  vm.runInNewContext(bundleCode, sandbox, { filename: 'dist/client.js' });

  expect(load).toHaveBeenCalledTimes(1);
  if (!captured) {
    throw new Error('Expected window.__ModuleLoader__.load to be called');
  }
  const registration: ModuleLoaderRegistration = captured;

  const mockRequire = (id: string): unknown => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === 'react-dom') return reactDom;
    throw new Error(`Unexpected external require in client bundle: ${id}`);
  };

  const exports = registration.factory(mockRequire);
  return { registration, exports };
}

beforeAll(() => {
  if (!fs.existsSync(bundlePath)) {
    execFileSync(process.execPath, [buildScriptPath], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  }
  bundleCode = fs.readFileSync(bundlePath, 'utf8');
});

describe('dist/client.js bundle', () => {
  it("contains 'use strict' inside the ModuleLoader factory", () => {
    expect(bundleCode.length).toBeGreaterThan(1000);
    expect(bundleCode).toMatch(
      /factory:\s*function\(require\)\s*\{\s*'use strict';/
    );
  });

  it('safely no-ops when window is undefined or __ModuleLoader__ is absent', () => {
    expect(() => {
      vm.runInNewContext(bundleCode, { console }, { filename: 'no-window.js' });
    }).not.toThrow();

    expect(() => {
      vm.runInNewContext(
        bundleCode,
        { window: {}, console },
        { filename: 'no-loader.js' }
      );
    }).not.toThrow();
  });

  it('registers sidebar panel and bilingual locale dict on scoped ctx.effect without leaking outer ctx.effect, and mounts <MemoryApp /> without throwing', () => {
    const { registration, exports } = loadBundleInVm();

    expect(registration.id).toBe('dsh-memory');
    expect(exports.name).toBe('dsh-memory');
    expect(exports.inject).toEqual(['slots']);
    expect(typeof exports.apply).toBe('function');

    const registeredSlots: RegisteredSlot[] = [];
    const outerEffect = vi.fn();
    const scopedEffect = vi.fn((cb: () => unknown) => cb());
    const delayedLocale: {
      cb: ((scoped: MockHostContext) => unknown) | null;
    } = { cb: null };

    const localeRegister = vi.fn();
    const localeBind = vi.fn(
      (_ns: string) => (key: string) => (key === 'panel' ? 'Memory' : '')
    );
    let currentLocale: MockLocaleService | undefined;

    const slots = {
      inject: vi.fn((_slotName: string, callback: () => unknown) => {
        const res = callback();
        return res;
      }),
      register: vi.fn(
        (
          meta: Record<string, unknown>,
          render: (props?: unknown) => React.ReactElement
        ) => {
          registeredSlots.push({
            slotName: String(meta.name ?? ''),
            meta,
            render,
          });
        }
      ),
    };

    const outerCtx: MockHostContext = {
      get: (serviceName: string) => {
        if (serviceName === 'locale') return currentLocale;
        if (serviceName === 'slots') return slots;
        if (serviceName === 'connection') {
          return { baseURL: 'http://127.0.0.1:4310', token: 'tok-test' };
        }
        if (serviceName === 'workspace') return { id: 'ws-sandbox' };
        return undefined;
      },
      effect: outerEffect,
      inject: vi.fn((deps: string[], cb: (scoped: MockHostContext) => unknown) => {
        if (deps.includes('locale')) {
          delayedLocale.cb = cb;
        }
      }),
      slots,
    };

    // Apply plugin when locale service is not yet available (delayed inject path)
    exports.apply(outerCtx);

    // Outer ctx.effect must NOT be called before or during delayed locale injection
    expect(outerEffect).not.toHaveBeenCalled();
    expect(outerCtx.inject).toHaveBeenCalledWith(
      ['locale'],
      expect.any(Function)
    );
    expect(delayedLocale.cb).not.toBeNull();

    // Simulate delayed Cordis locale service availability with its own scoped ctx
    currentLocale = {
      current: 'en',
      register: localeRegister,
      bind: localeBind,
    };
    const scopedCtx: MockHostContext = {
      locale: currentLocale,
      effect: scopedEffect,
    };
    delayedLocale.cb?.(scopedCtx);

    // Scoped ctx.effect registers bilingual dictionary; outer ctx.effect remains untouched (zero leak)
    expect(outerEffect).not.toHaveBeenCalled();
    expect(scopedEffect).toHaveBeenCalledTimes(1);
    expect(scopedEffect).toHaveBeenCalledWith(
      expect.any(Function),
      'dsh-memory: dictionaries'
    );
    expect(localeRegister).toHaveBeenCalledWith('dsh-memory', {
      zh: { panel: '长期记忆' },
      en: { panel: 'Memory' },
    });

    // Verify both 'main' and 'sidebar.panellist' slots were registered
    const sidebarSlot = registeredSlots.find(
      (s) => s.slotName === 'sidebar.panellist'
    );
    const mainSlot = registeredSlots.find((s) => s.slotName === 'main');

    expect(sidebarSlot).toBeDefined();
    expect(sidebarSlot?.meta).toMatchObject({
      name: 'sidebar.panellist',
      id: 'dsh-memory',
      order: 15,
      locale: 'dsh-memory',
    });
    const labelFn = sidebarSlot?.meta.label as (() => string) | undefined;
    expect(labelFn?.()).toBe('Memory');

    // Render sidebar icon via React.createElement without throwing
    const iconElement = sidebarSlot!.render({ size: 18 });
    expect(React.isValidElement(iconElement)).toBe(true);
    const iconHtml = reactDomServer.renderToStaticMarkup(iconElement);
    expect(iconHtml).toContain('<svg');
    expect(iconHtml).toContain('width="18"');

    // Mount <MemoryApp /> through the registered 'main' slot via React.createElement without throwing
    expect(mainSlot).toBeDefined();
    expect(mainSlot?.meta).toMatchObject({
      name: 'main',
      key: 'dsh-memory',
      locale: 'dsh-memory',
    });
    const mainElement = mainSlot!.render();
    expect(React.isValidElement(mainElement)).toBe(true);

    const renderedHtml = reactDomServer.renderToStaticMarkup(mainElement);
    expect(renderedHtml).toContain('dshm-studio');
    expect(renderedHtml).toContain('Long-Term Memory');
    expect(renderedHtml).toContain('Model Settings');
  });

  it('registers bilingual dictionary directly on ctx.effect when locale is already present', () => {
    const { exports } = loadBundleInVm();

    const localeRegister = vi.fn();
    const ctxEffect = vi.fn((cb: () => unknown) => cb());
    const slots = {
      inject: vi.fn((_name: string, cb: () => unknown) => cb()),
      register: vi.fn(),
    };
    const locale: MockLocaleService = {
      current: 'zh',
      register: localeRegister,
      bind: vi.fn(() => () => '长期记忆'),
    };

    exports.apply({
      get: (key: string) => {
        if (key === 'locale') return locale;
        if (key === 'slots') return slots;
        return undefined;
      },
      effect: ctxEffect,
      slots,
    });

    expect(ctxEffect).toHaveBeenCalledTimes(1);
    expect(ctxEffect).toHaveBeenCalledWith(
      expect.any(Function),
      'dsh-memory: dictionaries'
    );
    expect(localeRegister).toHaveBeenCalledWith('dsh-memory', {
      zh: { panel: '长期记忆' },
      en: { panel: 'Memory' },
    });
  });

  it('activates cleanly on a strict Cordis 4.1 Proxy that throws on un-injected locale/workspace/connection access', () => {
    const { exports } = loadBundleInVm();

    const registeredSlots: RegisteredSlot[] = [];
    const slots = {
      inject: vi.fn((slotName: string, cb: () => unknown) => {
        cb();
        return slotName;
      }),
      register: vi.fn(
        (meta: Record<string, unknown>, render: (props?: unknown) => React.ReactElement) => {
          registeredSlots.push({
            slotName: String(meta.name || ''),
            meta,
            render,
          });
          return () => {};
        }
      ),
    };

    const allowedKeys = new Set<PropertyKey>(['get', 'effect', 'inject', 'on', 'slots']);
    const rawCtx: MockHostContext = {
      get: (key: string) => (key === 'slots' ? slots : undefined),
      effect: vi.fn((cb: () => unknown) => cb()),
      inject: vi.fn(),
      slots,
    };

    const strictProxy = new Proxy(rawCtx, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !allowedKeys.has(prop)) {
          throw new Error(`cannot get property "${prop}" without inject`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(() => exports.apply(strictProxy)).not.toThrow();

    const sidebarSlot = registeredSlots.find((s) => s.slotName === 'sidebar.panellist');
    const mainSlot = registeredSlots.find((s) => s.slotName === 'main');
    expect(sidebarSlot).toBeDefined();
    expect(mainSlot).toBeDefined();

    const labelFn = sidebarSlot?.meta.label as (() => string) | undefined;
    expect(() => labelFn?.()).not.toThrow();
    expect(() => reactDomServer.renderToStaticMarkup(mainSlot!.render())).not.toThrow();
  });
});
