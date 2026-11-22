import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import {
  registerWebRoutes,
  API_PREFIX,
  isTrustedOrigin,
  isAllowedHostHeader,
  maskApiKey,
  type RegisterWebRoutesOptions,
} from '../../src/dsh/web.js';
import { upsertCandidate, freeze } from '../../src/core/writer.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { resetLlmProbeRateLimit } from '../../src/service/index.js';
import { workspaceId } from '../../src/core/scope.js';
import type { Db } from '../../src/types.js';

function cloneDefaults(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    ...DEFAULTS,
    ...overrides,
    offlineLLM: { ...DEFAULTS.offlineLLM, ...(overrides.offlineLLM || {}) },
    embedding: { ...DEFAULTS.embedding, ...(overrides.embedding || {}) },
    privacy: {
      offlineConsent: overrides.privacy?.offlineConsent ?? DEFAULTS.privacy.offlineConsent,
      allowedOfflineEndpoints: [
        ...(overrides.privacy?.allowedOfflineEndpoints ?? DEFAULTS.privacy.allowedOfflineEndpoints),
      ],
    },
    excludeWorkspaces: [...(overrides.excludeWorkspaces ?? DEFAULTS.excludeWorkspaces)],
  };
}

interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  json: any;
}

describe('Web Server API & Modular Studio Backend (src/dsh/web/*)', () => {
  let db: Db;
  let testDbPath: string;
  let tempDir: string;
  let registeredHandler: any = null;

  const mockCtx = {
    webServer: {
      register: (options: any) => {
        if (options.path === API_PREFIX) {
          registeredHandler = options.handler;
        }
        return () => {
          registeredHandler = null;
        };
      },
    },
  };

  const mount = (cfg: PluginConfig = cloneDefaults(), options?: RegisterWebRoutesOptions) =>
    registerWebRoutes(mockCtx, db, cfg, options);

  const invoke = async (
    method: string,
    url: string,
    opts?: {
      body?: unknown;
      headers?: Record<string, string>;
      peer?: any;
      handler?: any;
    }
  ): Promise<InvokeResult> => {
    let status = 0;
    let headers: Record<string, string> = {};
    let rawBody = '';

    const req: any = {
      method,
      url,
      headers: opts?.headers,
      on: (event: string, cb: any) => {
        if (event === 'data' && opts?.body !== undefined) {
          cb(
            Buffer.isBuffer(opts.body)
              ? opts.body
              : typeof opts.body === 'string'
                ? Buffer.from(opts.body)
                : Buffer.from(JSON.stringify(opts.body))
          );
        }
        if (event === 'end') cb();
      },
    };
    const res: any = {
      writeHead: (code: number, h: Record<string, string> = {}) => {
        status = code;
        headers = h;
      },
      end: (data?: string) => {
        if (typeof data === 'string') rawBody = data;
      },
    };

    const h = opts?.handler || registeredHandler;
    await h(req, res, opts?.peer);
    let json: any = null;
    try {
      json = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      json = null;
    }
    return { status, headers, rawBody, json };
  };

  beforeEach(() => {
    resetLlmProbeRateLimit();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-test-'));
    testDbPath = path.join(tempDir, 'test.db');
    db = openDb(testDbPath);
    registeredHandler = null;
  });

  afterEach(() => {
    resetLlmProbeRateLimit();
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should register prefix route and drain in-flight requests on dispose', async () => {
    const unlisten = mount(cloneDefaults());
    expect(registeredHandler).toBeTypeOf('function');

    // Verify synchronous unregister + Promise return
    const p = unlisten();
    expect(registeredHandler).toBeNull();
    await expect(p).resolves.toBeUndefined();
  });

  it('should emit security headers, reject Sec-Fetch-Site: cross-site, enforce strict MIME & 405 Method Not Allowed', async () => {
    mount(cloneDefaults());

    const okRes = await invoke('GET', `${API_PREFIX}/overview`);
    expect(okRes.status).toBe(200);
    expect(okRes.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(okRes.headers['X-Frame-Options']).toBe('DENY');
    expect(okRes.headers['Content-Security-Policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
    expect(okRes.headers['Vary']).toBe('Origin');

    // Sec-Fetch-Site: cross-site -> 403
    const crossSite = await invoke('GET', `${API_PREFIX}/overview`, {
      headers: { host: '127.0.0.1:13600', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.json.code).toBe('cross_site_denied');

    // Strict MIME parsing: application/jsonx must be rejected with 415
    const badMime = await invoke('POST', `${API_PREFIX}/config`, {
      headers: { host: '127.0.0.1:13600', 'content-type': 'application/jsonx' },
      body: { dailyLLMCalls: 30 },
    });
    expect(badMime.status).toBe(415);

    // application/json; charset=utf-8 is accepted
    const goodMime = await invoke('POST', `${API_PREFIX}/config`, {
      headers: { host: '127.0.0.1:13600', 'content-type': 'application/json; charset=utf-8' },
      body: { dailyLLMCalls: 35 },
    });
    expect(goodMime.status).toBe(200);

    // 405 Method Not Allowed with Allow header
    const wrongMethod = await invoke('POST', `${API_PREFIX}/overview`, {
      headers: { host: '127.0.0.1:13600', 'content-type': 'application/json' },
      body: {},
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers['Allow']).toContain('GET');
  });

  it('should handle read-only /overview, /memories (with vikingUri & hindsightNetwork), /memory, /workspaces, /evolution', async () => {
    mount(cloneDefaults());

    const up1 = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: 'Run pnpm build before executing vitest in CI pipelines.',
        scope: 'global',
        confidence: 0.95,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );
    expect(up1.action).not.toBe('rejected');
    const memId = (up1 as { id: string }).id;

    // 1. GET /overview
    const ov = await invoke('GET', `${API_PREFIX}/overview`);
    expect(ov.status).toBe(200);
    expect(ov.json.ok).toBe(true);
    expect(ov.json.stats.total).toBe(1);
    expect(ov.json.dynamicBudgetTokens).toBe(1600);
    expect(ov.json.ledger).toBeDefined();
    expect(ov.json.recentTelemetry).toBeDefined();

    // 2. GET /memories with search + stripMemoryForApi enrichment
    const listRes = await invoke('GET', `${API_PREFIX}/memories?q=vitest`);
    expect(listRes.status).toBe(200);
    expect(listRes.json.ok).toBe(true);
    expect(listRes.json.total).toBe(1);
    expect(listRes.json.items[0].content).toContain('vitest');
    expect(listRes.json.items[0].vikingUri).toMatch(/^viking:\/\//);
    expect(listRes.json.items[0].hindsightNetwork).toBe('observation');
    expect(listRes.json.items[0].embedding).toBeUndefined();

    // 3. GET /memory detail
    const det = await invoke('GET', `${API_PREFIX}/memory?id=${memId}`);
    expect(det.status).toBe(200);
    expect(det.json.ok).toBe(true);
    expect(det.json.memory.id).toBe(memId);
    expect(det.json.memory.vikingUri).toMatch(/^viking:\/\//);
    expect(det.json.memory.hindsightNetwork).toBe('observation');
    expect(det.json.hindsightTrace).toBeDefined();
    expect(Array.isArray(det.json.sources)).toBe(true);

    // 4. GET /workspaces
    const wsRes = await invoke('GET', `${API_PREFIX}/workspaces`);
    expect(wsRes.status).toBe(200);
    expect(wsRes.json.ok).toBe(true);
    expect(Array.isArray(wsRes.json.workspaces)).toBe(true);

    // 5. GET /evolution must be strictly read-only (NO initDefaultStrategy insert into strategies table!)
    const beforeStrategies = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM strategies')?.c ?? 0;
    expect(beforeStrategies).toBe(0);
    const evoRes = await invoke('GET', `${API_PREFIX}/evolution`);
    expect(evoRes.status).toBe(200);
    expect(evoRes.json.ok).toBe(true);
    expect(evoRes.json.activeStrategy.version).toBe(1);
    const afterStrategies = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM strategies')?.c ?? 0;
    expect(afterStrategies).toBe(0);
  });

  it('should serve composite /studio-snapshot with ETag and 304 Not Modified', async () => {
    mount(cloneDefaults());

    upsertCandidate(
      db,
      {
        type: 'preference',
        content: 'Prefer strict TypeScript with NodeNext ESM imports.',
        scope: 'global',
        confidence: 0.92,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's_snap', seq: 1, kind: 'user' }],
      },
      Date.now()
    );

    const first = await invoke('GET', `${API_PREFIX}/studio-snapshot`);
    expect(first.status).toBe(200);
    expect(first.json.ok).toBe(true);
    expect(first.headers['ETag']).toBeTruthy();
    expect(first.json.etag).toBe(first.headers['ETag']);
    expect(first.json.stats).toBeDefined();
    expect(first.json.health).toBeDefined();
    expect(first.json.coreMemory).toBeDefined();
    expect(first.json.memories.items).toHaveLength(1);
    expect(first.json.memories.items[0].vikingUri).toMatch(/^viking:\/\//);
    expect(first.json.memories.items[0].hindsightNetwork).toBe('opinion');
    expect(first.json.evolution).toBeDefined();
    expect(first.json.hindsight.networkCounts).toBeDefined();
    expect(first.json.hindsight.networkCounts.opinion).toBeGreaterThanOrEqual(1);
    expect(first.json.viking.rootUri).toBe('viking://');
    expect(Array.isArray(first.json.viking.categories)).toBe(true);
    expect(Array.isArray(first.json.workspaces)).toBe(true);

    // Same ETag -> 304 Not Modified
    const cached = await invoke('GET', `${API_PREFIX}/studio-snapshot`, {
      headers: { host: '127.0.0.1:13600', 'if-none-match': first.headers['ETag'] },
    });
    expect(cached.status).toBe(304);
    expect(cached.rawBody).toBe('');
    expect(cached.headers['ETag']).toBe(first.headers['ETag']);

    // Mutate DB -> ETag changes and returns 200
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Studio snapshot invalidates ETag whenever memories change.',
        scope: 'global',
        confidence: 0.9,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's_snap', seq: 2, kind: 'user' }],
      },
      Date.now() + 10
    );
    const refreshed = await invoke('GET', `${API_PREFIX}/studio-snapshot`, {
      headers: { host: '127.0.0.1:13600', 'if-none-match': first.headers['ETag'] },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers['ETag']).not.toBe(first.headers['ETag']);
    expect(refreshed.json.memories.items).toHaveLength(2);
  });

  it('should keep GET /hindsight and GET /viking strictly read-only (no CSRF-via-GET)', async () => {
    mount(cloneDefaults());

    const ws = workspaceId(tempDir);
    const now = Date.now();
    // Seed 3 related memories on the same topic so autoSynthesize=true would normally write a model
    for (let i = 1; i <= 3; i++) {
      upsertCandidate(
        db,
        {
          type: i === 1 ? 'semantic' : i === 2 ? 'procedural' : 'preference',
          content: `Deployment pipeline rule #${i} for docker buildx caching.`,
          scope: 'workspace',
          workspaceId: ws,
          confidence: 0.85,
          source_kind: 'user',
          origin_kinds: ['user'],
          actor: 'user',
          entities: ['docker', 'buildx'],
          sources: [{ session_id: `s_h${i}`, seq: 1, kind: 'user' }],
        },
        now + i
      );
    }

    const beforeCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM memories')?.c ?? 0;
    const hsGet = await invoke(
      'GET',
      `${API_PREFIX}/hindsight?workspaceId=${ws}&synthesize=1&calibrate=1`
    );
    expect(hsGet.status).toBe(200);
    expect(hsGet.json.ok).toBe(true);
    expect(hsGet.json.report.synthesizedModels).toHaveLength(0);

    const afterCount = db.get<{ c: number }>('SELECT COUNT(*) AS c FROM memories')?.c ?? 0;
    expect(afterCount).toBe(beforeCount);

    // GET /viking does not compute diff unless diff=1
    const vkBasic = await invoke('GET', `${API_PREFIX}/viking?workspaceId=${ws}`);
    expect(vkBasic.status).toBe(200);
    expect(vkBasic.json.ok).toBe(true);
    expect(vkBasic.json.diff).toBeNull();

    const vkDiff = await invoke('GET', `${API_PREFIX}/viking?workspaceId=${ws}&diff=1`);
    expect(vkDiff.status).toBe(200);
    expect(vkDiff.json.diff).toBeDefined();
    expect(vkDiff.json.diff).not.toBeNull();
  });

  it('should gate all admin write/ops endpoints behind webAdminEnabled (403 web_admin_disabled when false)', async () => {
    mount(cloneDefaults({ webAdminEnabled: false }));

    const checks: Array<[string, string, unknown?]> = [
      ['POST', `${API_PREFIX}/action`, { action: 'pin', id: 'm_1' }],
      ['POST', `${API_PREFIX}/import`, { items: [{ content: 'Test item 1234' }] }],
      ['GET', `${API_PREFIX}/export`],
      ['POST', `${API_PREFIX}/reconcile`, { content: 'Reconcile test item' }],
      ['POST', `${API_PREFIX}/core-memory`, { block: 'human', content: 'Alice' }],
      ['GET', `${API_PREFIX}/graph`],
      ['GET', `${API_PREFIX}/sandbox`],
      ['POST', `${API_PREFIX}/sandbox`, { query: 'test' }],
      ['POST', `${API_PREFIX}/hindsight/reflect`, {}],
    ];

    for (const [method, url, body] of checks) {
      const res = await invoke(method, url, { body });
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.json.ok).toBe(false);
      expect(res.json.code).toBe('web_admin_disabled');
    }
  });

  it('should handle /action pin, unpin, edit (protecting frozen & core:*), forget, rollback, batch, export, import when webAdminEnabled=true', async () => {
    mount(cloneDefaults({ webAdminEnabled: true }));

    const createRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Original knowledge content here.',
        scope: 'global',
        confidence: 0.9,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );
    expect(createRes.action).not.toBe('rejected');
    const memId = (createRes as { id: string }).id;

    // 1. Pin & Unpin
    const pinRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'pin', id: memId },
    });
    expect(pinRes.status).toBe(200);
    expect(pinRes.json).toMatchObject({ ok: true, pinned: true });

    const unpinRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'unpin', id: memId },
    });
    expect(unpinRes.status).toBe(200);
    expect(unpinRes.json).toMatchObject({ ok: true, pinned: false });

    // 2. Edit + core:* slot_key protection
    const badCoreSlot = await invoke('POST', `${API_PREFIX}/action`, {
      body: {
        action: 'edit',
        id: memId,
        content: 'Trying to hijack core slot key.',
        slot_key: 'CORE:human',
      },
    });
    expect(badCoreSlot.status).toBe(400);
    expect(badCoreSlot.json.code).toBe('cannot_assign_core_slot_key');

    const editRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'edit', id: memId, content: 'Updated knowledge content text.' },
    });
    expect(editRes.status).toBe(200);
    expect(editRes.json.ok).toBe(true);
    expect(editRes.json.version).toBe(4);
    expect(editRes.json.content_rev).toBe(2);
    expect(editRes.json.memory.embedding).toBeUndefined();

    // 3. Rollback
    const rbRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'rollback', id: memId, targetVersion: 1 },
    });
    expect(rbRes.status).toBe(200);
    expect(rbRes.json.ok).toBe(true);

    // 4. Freeze protects against edit (409) and forget (409)
    freeze(db, memId, 'user');
    const editFrozen = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'edit', id: memId, content: 'Should fail on frozen memory.' },
    });
    expect(editFrozen.status).toBe(409);
    expect(editFrozen.json.code).toBe('memory_is_frozen');

    const forgetFrozen = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'forget', id: memId },
    });
    expect(forgetFrozen.status).toBe(409);
    expect(forgetFrozen.json.code).toBe('memory_is_frozen');

    // Unfreeze then batch pin
    await invoke('POST', `${API_PREFIX}/action`, { body: { action: 'unfreeze', id: memId } });
    const batchRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'batch', subAction: 'pin', ids: [memId, 'm_nonexistent'] },
    });
    expect(batchRes.status).toBe(200);
    expect(batchRes.json.affected).toBe(1);
    expect(batchRes.json.total).toBe(2);
    expect(Array.isArray(batchRes.json.results)).toBe(true);

    // 5. Export (JSON version 0.11.0 & Markdown CSP sandbox)
    const expJson = await invoke('GET', `${API_PREFIX}/export`);
    expect(expJson.status).toBe(200);
    expect(expJson.json.ok).toBe(true);
    expect(expJson.json.version).toBe('0.11.0');
    expect(expJson.json.memories.length).toBeGreaterThanOrEqual(1);
    expect(expJson.json.memories[0].embedding).toBeUndefined();

    const expMd = await invoke('GET', `${API_PREFIX}/export?format=markdown`);
    expect(expMd.status).toBe(200);
    expect(expMd.headers['Cache-Control']).toBe('no-store, no-cache, must-revalidate');
    expect(expMd.headers['Content-Security-Policy']).toBe('sandbox');
    expect(expMd.rawBody).toContain('# DSH 长期记忆知识库导出');

    // 6. Import via importJsonMemories (preserves candidate & frozen, guards core:*)
    const impRes = await invoke('POST', `${API_PREFIX}/import`, {
      body: {
        items: [
          { content: 'Imported active procedure for builds', type: 'procedure' },
          { content: 'Imported frozen preference rule', type: 'preference', status: 'frozen', pinned: true },
          { content: 'Imported pending candidate note', type: 'semantic', status: 'candidate' },
          { content: 'Attempted core block override', type: 'preference', slot_key: 'core:human' },
        ],
      },
    });
    expect(impRes.status).toBe(200);
    expect(impRes.json.ok).toBe(true);
    expect(impRes.json.imported).toBe(3);
    expect(impRes.json.skipped).toBe(1);

    const frozenImported = db.get<{ status: string }>(
      "SELECT status FROM memories WHERE content LIKE '%Imported frozen preference%'"
    );
    expect(frozenImported?.status).toBe('frozen');
    const candImported = db.get<{ status: string }>(
      "SELECT status FROM memories WHERE content LIKE '%Imported pending candidate%'"
    );
    expect(candImported?.status).toBe('candidate');
  });

  it('should enqueue heavy actions to JobScheduler (202 Accepted) and enforce activeWorkspaces on bootstrap', async () => {
    const enqueuedJobs: Array<{ kind: string; key: string; payload: any }> = [];
    const fakeScheduler: any = {
      enqueue: (kind: string, key: string, payload?: any) => {
        enqueuedJobs.push({ kind, key, payload });
        return true;
      },
    };
    mount(cloneDefaults({ webAdminEnabled: true }), {
      scheduler: fakeScheduler,
      activeWorkspaces: () => [tempDir],
    });

    // Heavy actions enqueue onto scheduler -> 202 Accepted
    for (const action of ['distill', 'consolidate', 'curate', 'maintain', 'evolve-strategy']) {
      const r = await invoke('POST', `${API_PREFIX}/action`, { body: { action } });
      expect(r.status, action).toBe(202);
      expect(r.json.ok).toBe(true);
      expect(r.json.queued).toBe(true);
      expect(r.json.jobKey).toBeTruthy();
    }
    expect(enqueuedJobs).toHaveLength(5);

    // Bootstrap rejects arbitrary untrusted workspacePath -> 403
    const badBoot = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'bootstrap', workspacePath: path.join(os.tmpdir(), 'evil-unregistered-dir') },
    });
    expect(badBoot.status).toBe(403);
    expect(badBoot.json.code).toBe('untrusted_workspace_path');
  });

  it('should handle /core-memory POST, /reconcile, /health, /sandbox when webAdminEnabled=true', async () => {
    mount(cloneDefaults({ webAdminEnabled: true }));

    // Core memory set & append
    const setRes = await invoke('POST', `${API_PREFIX}/core-memory`, {
      body: { block: 'human', content: 'Name: Alice, Role: Principal Architect', mode: 'set' },
    });
    expect(setRes.status).toBe(200);
    expect(setRes.json.ok).toBe(true);
    expect(setRes.json.block).toBe('human');
    expect(setRes.json.blocks[0].tokens).toBeGreaterThan(0);

    const appRes = await invoke('POST', `${API_PREFIX}/core-memory`, {
      body: { block: 'human', content: 'Timezone: UTC+8', mode: 'append' },
    });
    expect(appRes.status).toBe(200);

    const getCore = await invoke('GET', `${API_PREFIX}/core-memory`);
    expect(getCore.status).toBe(200);
    const humanBlock = getCore.json.blocks.find((b: any) => b.block === 'human');
    expect(humanBlock.content).toContain('Principal Architect');
    expect(humanBlock.content).toContain('Timezone: UTC+8');

    // Reconcile dryRun & apply
    const previewAdd = await invoke('POST', `${API_PREFIX}/reconcile`, {
      body: { content: '项目构建工具统一使用 Vite 6', type: 'semantic', slot_key: 'bundler', dryRun: true },
    });
    expect(previewAdd.status).toBe(200);
    expect(previewAdd.json.decision.action).toBe('ADD');

    const applyAdd = await invoke('POST', `${API_PREFIX}/reconcile`, {
      body: { content: '项目构建工具统一使用 Vite 6', type: 'semantic', slot_key: 'bundler', dryRun: false },
    });
    expect(applyAdd.status).toBe(200);
    expect(applyAdd.json.memory.id).toBeTruthy();

    const previewUpdate = await invoke('POST', `${API_PREFIX}/reconcile`, {
      body: { content: '项目构建工具已升级为 Rspack', type: 'semantic', slot_key: 'bundler', dryRun: true },
    });
    expect(previewUpdate.json.decision.action).toBe('UPDATE');
    expect(previewUpdate.json.decision.targetId).toBe(applyAdd.json.memory.id);

    // Health check (strictly read-only)
    const healthRes = await invoke('GET', `${API_PREFIX}/health`);
    expect(healthRes.status).toBe(200);
    expect(healthRes.json.health.score).toBeGreaterThanOrEqual(80);
    expect(healthRes.json.health.ftsConsistent).toBe(true);

    // Sandbox strips embeddings
    const sandboxRes = await invoke('POST', `${API_PREFIX}/sandbox`, {
      body: { query: 'Vite 6 构建工具' },
    });
    expect(sandboxRes.status).toBe(200);
    expect(sandboxRes.json.recallSimulation.items.length).toBeGreaterThanOrEqual(1);
    expect(sandboxRes.json.recallSimulation.items[0].memory.embedding).toBeUndefined();
    expect(sandboxRes.json.recallSimulation.items[0].memory.vikingUri).toMatch(/^viking:\/\//);

    // Strategy evolution fallback when no scheduler is passed
    const evolveRes = await invoke('POST', `${API_PREFIX}/action`, {
      body: { action: 'evolve-strategy' },
    });
    expect(evolveRes.status).toBe(200);
    expect(evolveRes.json.result).toBeDefined();
  });

  it('should enforce maskApiKey, P0 2-step API key clearing, and safe URL validation on /config', async () => {
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey('short-key-12')).toBe('********');
    expect(maskApiKey('sk-test1234567890')).toBe('sk-****7890');

    const liveCfg = cloneDefaults();
    let updatedHookCount = 0;
    mount(liveCfg, {
      initialCfg: cloneDefaults(),
      onConfigUpdated: () => {
        updatedHookCount++;
      },
    });

    // 1. GET /config exposes embedding & webAdminEnabled without raw keys
    const getRes = await invoke('GET', `${API_PREFIX}/config`);
    expect(getRes.status).toBe(200);
    expect(getRes.json.config.embedding).toBeDefined();
    expect(getRes.json.config.webAdminEnabled).toBe(false);

    // 2. Save initial endpoint + key (including key containing '****')
    const save1 = await invoke('POST', `${API_PREFIX}/config`, {
      body: {
        offlineLLM: {
          baseURL: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          apiKey: 'sk-test1234567890',
        },
        embedding: {
          provider: 'openai-compatible',
          baseURL: 'https://api.openai.com/v1',
          model: 'text-embedding-3-small',
          dim: 1536,
          apiKey: 'sk-emb-secret123456',
        },
        privacy: { offlineConsent: true },
        dailyLLMCalls: 50,
      },
    });
    expect(save1.status).toBe(200);
    expect(save1.json.config.offlineLLM.hasApiKey).toBe(true);
    expect(save1.json.config.offlineLLM.apiKeyMasked).toBe('sk-****7890');
    expect(save1.json.config.embedding.hasApiKey).toBe(true);
    expect(liveCfg.offlineLLM.apiKey).toBe('sk-test1234567890');
    expect(updatedHookCount).toBe(1);

    // 3. P0 2-Step Attack Step 1: clearing baseURL MUST immediately clear apiKey
    const clearUrl = await invoke('POST', `${API_PREFIX}/config`, {
      body: { offlineLLM: { baseURL: '' } },
    });
    expect(clearUrl.status).toBe(200);
    expect(clearUrl.json.config.offlineLLM.hasApiKey).toBe(false);
    expect(liveCfg.offlineLLM.apiKey).toBe('');

    // 4. Re-set key, then transition useDshLlm -> true MUST clear apiKey
    await invoke('POST', `${API_PREFIX}/config`, {
      body: {
        offlineLLM: {
          baseURL: 'https://api.deepseek.com/v1',
          apiKey: 'sk-contains****stars9999',
        },
      },
    });
    expect(liveCfg.offlineLLM.apiKey).toBe('sk-contains****stars9999');

    const switchHost = await invoke('POST', `${API_PREFIX}/config`, {
      body: { offlineLLM: { useDshLlm: true } },
    });
    expect(switchHost.status).toBe(200);
    expect(switchHost.json.config.offlineLLM.hasApiKey).toBe(false);
    expect(liveCfg.offlineLLM.apiKey).toBe('');

    // 5. Cross-origin embedding.baseURL change MUST clear embedding.apiKey
    const embCrossOrigin = await invoke('POST', `${API_PREFIX}/config`, {
      body: { embedding: { baseURL: 'https://evil.example/v1' } },
    });
    expect(embCrossOrigin.status).toBe(200);
    expect(embCrossOrigin.json.config.embedding.hasApiKey).toBe(false);
    expect(liveCfg.embedding.apiKey).toBe('');

    // 6. Reject query/hash/userinfo/metadata IP in baseURL
    for (const badUrl of [
      'https://api.deepseek.com/v1?foo=bar',
      'https://api.deepseek.com/v1#frag',
      'https://user:pass@api.deepseek.com/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
    ]) {
      const bad = await invoke('POST', `${API_PREFIX}/config`, {
        body: { offlineLLM: { baseURL: badUrl } },
      });
      expect(bad.status, badUrl).toBe(400);
    }
  });

  it('should enforce consent, allowlist, and SSRF protection on /llm/test and succeed when authorized', async () => {
    const calls: Array<{ url: string; headers: any; body: any }> = [];
    const mockFetch: any = async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        body: { cancel: async () => {} },
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    };

    // 1. Consent disabled -> 403
    mount(cloneDefaults({ privacy: { offlineConsent: false, allowedOfflineEndpoints: [] } }), {
      fetchFn: mockFetch,
    });
    const noConsent = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-valid-key',
      },
    });
    expect(noConsent.status).toBe(403);
    expect(noConsent.json.code).toBe('privacy_offline_consent_required');
    expect(calls).toHaveLength(0);

    // 2. SSRF metadata IP blocked even with consent=true -> 403
    const cfgConsent = cloneDefaults({
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: [
          'https://api.deepseek.com',
          'https://api.anthropic.com',
          'https://www.dorodoro.xyz',
          'http://169.254.169.254',
        ],
      },
    });
    mount(cfgConsent, { fetchFn: mockFetch });

    const ssrfRes = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: { baseURL: 'http://169.254.169.254/latest/meta-data', apiKey: 'sk-x' },
    });
    expect(ssrfRes.status).toBe(403);
    expect(ssrfRes.json.code).toBe('blocked_ip_range');
    expect(calls).toHaveLength(0);

    // 3. Unlisted endpoint blocked -> 403 endpoint_not_allowed
    const unlisted = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: { baseURL: 'https://unapproved.example/v1', apiKey: 'sk-x' },
    });
    expect(unlisted.status).toBe(403);
    expect(unlisted.json.code).toBe('endpoint_not_allowed');

    // 4. Authorized chat/completions, messages, responses protocols succeed
    const rChat = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-valid-key',
      },
    });
    expect(rChat.status).toBe(200);
    expect(rChat.json.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(calls[0].headers['Authorization']).toBe('Bearer sk-valid-key');

    const rMsg = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: {
        baseURL: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet-20241022',
        apiKey: 'sk-ant-test',
        protocol: 'messages',
      },
    });
    expect(rMsg.status).toBe(200);
    expect(rMsg.json.protocol).toBe('messages');
    expect(calls[1].headers['x-api-key']).toBe('sk-ant-test');
    expect(calls[1].headers['anthropic-version']).toBe('2023-06-01');

    const rResp = await invoke('POST', `${API_PREFIX}/llm/test`, {
      body: {
        baseURL: 'https://www.dorodoro.xyz/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-doro-test',
        protocol: 'responses',
      },
    });
    expect(rResp.status).toBe(200);
    expect(rResp.json.protocol).toBe('responses');
    expect(calls[2].url).toBe('https://www.dorodoro.xyz/v1/responses');
    expect(calls[2].body.input).toBeDefined();
  });

  it('should tighten origin/host guards, fix owner-peer + custom Host, and fail closed on connection guard error', async () => {
    // Tightened isTrustedOrigin & isAllowedHostHeader
    expect(isTrustedOrigin('dsh-app://app')).toBe(true);
    expect(isTrustedOrigin('dsh-app://evil')).toBe(false);
    expect(isTrustedOrigin('file:///etc/passwd')).toBe(false);
    expect(isTrustedOrigin('app://evil')).toBe(false);
    expect(isTrustedOrigin('http://192.168.1.50:13600', '192.168.1.50:13600')).toBe(true);
    expect(isTrustedOrigin('http://192.168.1.99:13600', '192.168.1.50:13600')).toBe(false);
    expect(isTrustedOrigin('http://127.0.0.1:9999', '127.0.0.1:13600')).toBe(false);
    expect(isTrustedOrigin('http://127.0.0.1:13600', '127.0.0.1:13600')).toBe(true);
    expect(isAllowedHostHeader('999.999.999.999:8080')).toBe(false);
    expect(isAllowedHostHeader('127.999.0.1:8080')).toBe(false);
    expect(isAllowedHostHeader('127.0.0.1:13600')).toBe(true);

    mount(cloneDefaults());

    // Owner peer + custom Host header MUST succeed (fixes owner-peer + custom Host bug!)
    const ownerCustomHost = await invoke('GET', `${API_PREFIX}/stats`, {
      headers: { host: 'my-dsh-box.local:13600', origin: 'http://my-dsh-box.local:13600' },
      peer: { principal: { kind: 'owner' }, signal: { aborted: false } },
    });
    expect(ownerCustomHost.status).toBe(200);
    expect(ownerCustomHost.json.ok).toBe(true);

    // Guest peer or aborted peer -> 403
    const guestRes = await invoke('GET', `${API_PREFIX}/stats`, {
      headers: { host: '127.0.0.1:13600' },
      peer: { principal: { kind: 'guest' }, signal: { aborted: false } },
    });
    expect(guestRes.status).toBe(403);

    const abortedRes = await invoke('GET', `${API_PREFIX}/stats`, {
      headers: { host: '127.0.0.1:13600' },
      peer: { principal: { kind: 'owner' }, signal: { aborted: true } },
    });
    expect(abortedRes.status).toBe(403);

    // Throwing ctx.get('connection') MUST fail closed with 403
    let throwingHandler: any = null;
    registerWebRoutes(
      {
        webServer: {
          register: (opts: any) => {
            throwingHandler = opts.handler;
            return () => {};
          },
        },
        get: () => {
          throw new Error('connection service crashed');
        },
      },
      db,
      cloneDefaults()
    );
    const failClosedRes = await invoke('GET', `${API_PREFIX}/stats`, {
      headers: { host: '127.0.0.1:13600' },
      handler: throwingHandler,
    });
    expect(failClosedRes.status).toBe(403);
    expect(failClosedRes.json.code).toBe('connection_guard_error');
  });

  it('should reject stream error (400), aborted (499), and oversized body (413) in readBodyJson', async () => {
    mount(cloneDefaults());

    const runWithStream = (emitFn: (req: EventEmitter) => void) =>
      new Promise<InvokeResult>((resolve) => {
        const req: any = new EventEmitter();
        req.method = 'POST';
        req.url = `${API_PREFIX}/config`;
        req.headers = { host: '127.0.0.1:13600', 'content-type': 'application/json' };
        let status = 0;
        let headers: Record<string, string> = {};
        const res: any = {
          writeHead: (code: number, h: Record<string, string> = {}) => {
            status = code;
            headers = h;
          },
          end: (data?: string) => {
            const rawBody = data || '';
            resolve({ status, headers, rawBody, json: rawBody ? JSON.parse(rawBody) : null });
          },
        };
        void registeredHandler(req, res);
        emitFn(req);
      });

    const errRes = await runWithStream((req) => req.emit('error', new Error('ECONNRESET')));
    expect(errRes.status).toBe(400);
    expect(errRes.json.code).toBe('request_stream_error');

    const abortRes = await runWithStream((req) => req.emit('aborted'));
    expect(abortRes.status).toBe(499);
    expect(abortRes.json.code).toBe('request_aborted');

    const bigRes = await runWithStream((req) => {
      req.emit('data', Buffer.alloc(1024 * 1024 + 16, 0x20));
    });
    expect(bigRes.status).toBe(413);
    expect(bigRes.json.code).toBe('body_too_large');
  });

  it('should resolve DSH DEEPSEEK_API_KEY host fallback in /llm/test when useDshLlm=true & offlineConsent=true', async () => {
    const prevBase = process.env.DEEPSEEK_BASE_URL;
    const prevKey = process.env.DEEPSEEK_API_KEY;
    const prevDshUrl = process.env.DSH_LLM_BASE_URL;
    const prevOpenAiUrl = process.env.OPENAI_BASE_URL;
    const prevAnthropicUrl = process.env.ANTHROPIC_BASE_URL;

    process.env.DSH_LLM_BASE_URL = '';
    process.env.OPENAI_BASE_URL = '';
    process.env.ANTHROPIC_BASE_URL = '';
    process.env.DEEPSEEK_BASE_URL = '';
    process.env.DEEPSEEK_API_KEY = 'sk-ds-host-fallback-test';

    try {
      const mockFetch: any = async (url: string, init: any) => {
        expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
        expect(init.headers['Authorization']).toBe('Bearer sk-ds-host-fallback-test');
        return {
          ok: true,
          status: 200,
          body: { cancel: async () => {} },
          json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
        };
      };

      mount(
        cloneDefaults({
          offlineLLM: { ...DEFAULTS.offlineLLM, useDshLlm: true, baseURL: '', apiKey: '' },
          privacy: { offlineConsent: true, allowedOfflineEndpoints: [] },
        }),
        { fetchFn: mockFetch }
      );

      const res = await invoke('POST', `${API_PREFIX}/llm/test`, {
        headers: { 'content-type': 'application/json' },
        body: { useDshLlm: true },
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json.model).toBe('deepseek-chat');
    } finally {
      if (prevBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
      else process.env.DEEPSEEK_BASE_URL = prevBase;
      if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevKey;
      if (prevDshUrl === undefined) delete process.env.DSH_LLM_BASE_URL;
      else process.env.DSH_LLM_BASE_URL = prevDshUrl;
      if (prevOpenAiUrl === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prevOpenAiUrl;
      if (prevAnthropicUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevAnthropicUrl;
    }
  });

  it('should enforce excludeWorkspaces 403, allow explicit POST /hindsight/reflect, and sanitize 500 errors', async () => {
    const secretWsDir = path.join(tempDir, 'secret-repo');
    fs.mkdirSync(secretWsDir, { recursive: true });
    const secretWsId = workspaceId(secretWsDir);

    mount(
      cloneDefaults({
        webAdminEnabled: true,
        excludeWorkspaces: [secretWsDir],
      })
    );

    for (const ep of [
      `/overview?workspaceId=${secretWsId}`,
      `/memories?workspaceId=${secretWsId}`,
      `/studio-snapshot?workspaceId=${secretWsId}`,
      `/viking?workspaceId=${secretWsId}`,
      `/hindsight?workspaceId=${secretWsId}`,
    ]) {
      const r = await invoke('GET', `${API_PREFIX}${ep}`);
      expect(r.status, ep).toBe(403);
      expect(r.json.code).toBe('workspace_excluded');
    }

    // Explicit POST /hindsight/reflect works on non-excluded workspace
    const allowedWsDir = path.join(tempDir, 'public-repo');
    fs.mkdirSync(allowedWsDir, { recursive: true });
    const allowedWsId = workspaceId(allowedWsDir);
    const reflectRes = await invoke('POST', `${API_PREFIX}/hindsight/reflect`, {
      body: { workspaceId: allowedWsId, autoSynthesize: true, persistCalibration: true },
    });
    expect(reflectRes.status).toBe(200);
    expect(reflectRes.json.ok).toBe(true);
    expect(reflectRes.json.report.networkCounts).toBeDefined();

    // Unhandled 500 error MUST NOT leak internal details
    let brokenHandler: any = null;
    const brokenDb: any = {
      get: () => {
        throw new Error('SECRET_SQL_INTERNAL_DETAIL_XYZ');
      },
      all: () => {
        throw new Error('SECRET_SQL_INTERNAL_DETAIL_XYZ');
      },
    };
    registerWebRoutes(
      {
        webServer: {
          register: (o: any) => {
            brokenHandler = o.handler;
            return () => {};
          },
        },
      },
      brokenDb,
      cloneDefaults()
    );
    const err500 = await invoke('GET', `${API_PREFIX}/overview`, { handler: brokenHandler });
    expect(err500.status).toBe(500);
    expect(err500.json.error).toBe('Internal server error');
    expect(err500.rawBody).not.toContain('SECRET_SQL_INTERNAL_DETAIL_XYZ');
  });
});
