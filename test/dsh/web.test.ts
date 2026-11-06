import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../../src/core/db.js';
import { registerWebRoutes, API_PREFIX } from '../../src/dsh/web.js';
import { upsertCandidate } from '../../src/core/writer.js';
import { DEFAULTS } from '../../src/config.js';
import type { Db } from '../../src/types.js';

describe('Web Server API & Sidebar Backend (web.ts)', () => {
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-test-'));
    testDbPath = path.join(tempDir, 'test.db');
    db = openDb(testDbPath);
  });

  afterEach(() => {
    try {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('should register prefix route with ctx.webServer', () => {
    const unlisten = registerWebRoutes(mockCtx, db, DEFAULTS);
    expect(registeredHandler).toBeTypeOf('function');
    unlisten();
    expect(registeredHandler).toBeNull();
  });

  it('should handle /overview endpoint and return stats and ledger', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    // Insert a test memory
    upsertCandidate(
      db,
      {
        type: 'preference',
        content: 'Test preferred coding convention in TypeScript.',
        scope: 'global',
        confidence: 0.9,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );

    let statusCode = 0;
    let headers: any = {};
    let responseBody = '';

    const mockRes: any = {
      writeHead: (code: number, h: any) => {
        statusCode = code;
        headers = h;
      },
      end: (data: string) => {
        responseBody = data;
      },
    };

    const mockReq: any = {
      method: 'GET',
      url: '/api/dsh-memory/overview',
    };

    await registeredHandler(mockReq, mockRes);

    expect(statusCode).toBe(200);
    const json = JSON.parse(responseBody);
    expect(json.ok).toBe(true);
    expect(json.stats.total).toBe(1);
    expect(json.dynamicBudgetTokens).toBe(1600);
    expect(json.ledger).toBeDefined();
  });

  it('should handle /memories list with search and filter', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    upsertCandidate(
      db,
      {
        type: 'procedural',
        content: 'Run pnpm build before executing vitest.',
        scope: 'global',
        confidence: 0.95,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );

    let responseBody = '';
    const mockRes: any = {
      writeHead: () => {},
      end: (data: string) => {
        responseBody = data;
      },
    };

    const mockReq: any = {
      method: 'GET',
      url: '/api/dsh-memory/memories?q=vitest',
    };

    await registeredHandler(mockReq, mockRes);
    const json = JSON.parse(responseBody);
    expect(json.ok).toBe(true);
    expect(json.total).toBe(1);
    expect(json.items[0].content).toContain('vitest');
  });

  it('should handle /action pin and unpin', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    const upRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Database uses node:sqlite with FTS5.',
        scope: 'global',
        confidence: 0.95,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );

    expect(upRes.action).not.toBe('rejected');
    const memoryId = (upRes as { id: string }).id;

    // Helper to send POST
    const sendPost = async (body: any) => {
      let result = '';
      const req: any = {
        method: 'POST',
        url: '/api/dsh-memory/action',
        on: (event: string, cb: any) => {
          if (event === 'data') cb(Buffer.from(JSON.stringify(body)));
          if (event === 'end') cb();
        },
      };
      const res: any = {
        writeHead: () => {},
        end: (data: string) => {
          result = data;
        },
      };
      await registeredHandler(req, res);
      return JSON.parse(result);
    };

    // 1. Pin
    const pinRes = await sendPost({ action: 'pin', id: memoryId });
    expect(pinRes.ok).toBe(true);
    expect(pinRes.pinned).toBe(true);

    // 2. Unpin
    const unpinRes = await sendPost({ action: 'unpin', id: memoryId });
    expect(unpinRes.ok).toBe(true);
    expect(unpinRes.pinned).toBe(false);
  });

  it('should handle /config GET and POST', async () => {
    const liveCfg = { ...DEFAULTS };
    registerWebRoutes(mockCtx, db, liveCfg);

    // 1. GET /config
    let getBody = '';
    const getReq: any = { method: 'GET', url: '/api/dsh-memory/config' };
    const getRes: any = { writeHead: () => {}, end: (d: string) => { getBody = d; } };
    await registeredHandler(getReq, getRes);
    const getJson = JSON.parse(getBody);
    expect(getJson.ok).toBe(true);
    expect(getJson.config.offlineLLM.model).toBe(DEFAULTS.offlineLLM.model);

    // 2. POST /config
    const postReqData = {
      offlineLLM: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-test1234567890',
      },
      privacy: {
        offlineConsent: true,
      },
      dailyLLMCalls: 50,
    };
    let postBody = '';
    const postReq: any = {
      method: 'POST',
      url: '/api/dsh-memory/config',
      on: (event: string, cb: any) => {
        if (event === 'data') cb(Buffer.from(JSON.stringify(postReqData)));
        if (event === 'end') cb();
      },
    };
    const postRes: any = { writeHead: () => {}, end: (d: string) => { postBody = d; } };
    await registeredHandler(postReq, postRes);
    const postJson = JSON.parse(postBody);
    expect(postJson.ok).toBe(true);
    expect(postJson.config.offlineLLM.baseURL).toBe('https://api.deepseek.com/v1');
    expect(postJson.config.offlineLLM.model).toBe('deepseek-chat');
    expect(postJson.config.offlineLLM.hasApiKey).toBe(true);
    expect(postJson.config.offlineLLM.apiKeyMasked).toBe('sk-****7890');
    expect(postJson.config.privacy.offlineConsent).toBe(true);
    expect(postJson.config.dailyLLMCalls).toBe(50);

    // Live cfg should be mutated in memory
    expect(liveCfg.offlineLLM.baseURL).toBe('https://api.deepseek.com/v1');
    expect(liveCfg.offlineLLM.apiKey).toBe('sk-test1234567890');
    expect(liveCfg.dailyLLMCalls).toBe(50);
  });

  it('should handle /llm/test endpoint with mock fetch', async () => {
    const liveCfg = { ...DEFAULTS };
    registerWebRoutes(mockCtx, db, liveCfg);

    // Mock global fetch
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).fetch = async (url: string, init: any) => {
        expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
        expect(init.headers['Authorization']).toBe('Bearer sk-valid-key');
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
        };
      };

      let testBody = '';
      const testReq: any = {
        method: 'POST',
        url: '/api/dsh-memory/llm/test',
        on: (event: string, cb: any) => {
          if (event === 'data') {
            cb(
              Buffer.from(
                JSON.stringify({
                  baseURL: 'https://api.deepseek.com/v1',
                  model: 'deepseek-chat',
                  apiKey: 'sk-valid-key',
                })
              )
            );
          }
          if (event === 'end') cb();
        },
      };
      const testRes: any = { writeHead: () => {}, end: (d: string) => { testBody = d; } };
      await registeredHandler(testReq, testRes);
      const testJson = JSON.parse(testBody);
      expect(testJson.ok).toBe(true);
      expect(testJson.status).toBe(200);
      expect(testJson.latencyMs).toBeTypeOf('number');
      expect(testJson.model).toBe('deepseek-chat');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle /llm/test with messages and responses protocol', async () => {
    const liveCfg = { ...DEFAULTS };
    registerWebRoutes(mockCtx, db, liveCfg);

    const originalFetch = globalThis.fetch;
    try {
      const calls: { url: string; headers: any; body: any }[] = [];
      (globalThis as any).fetch = async (url: string, init: any) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      };

      // 1. messages protocol
      let msgResBody = '';
      const msgReq: any = {
        method: 'POST',
        url: '/api/dsh-memory/llm/test',
        on: (event: string, cb: any) => {
          if (event === 'data') {
            cb(
              Buffer.from(
                JSON.stringify({
                  baseURL: 'https://api.anthropic.com/v1',
                  model: 'claude-3-5-sonnet-20241022',
                  apiKey: 'sk-ant-test',
                  protocol: 'messages',
                })
              )
            );
          }
          if (event === 'end') cb();
        },
      };
      await registeredHandler(msgReq, { writeHead: () => {}, end: (d: string) => { msgResBody = d; } });
      const msgJson = JSON.parse(msgResBody);
      expect(msgJson.ok).toBe(true);
      expect(msgJson.protocol).toBe('messages');
      expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
      expect(calls[0].headers['x-api-key']).toBe('sk-ant-test');
      expect(calls[0].headers['anthropic-version']).toBe('2023-06-01');

      // 2. responses protocol
      let respResBody = '';
      const respReq: any = {
        method: 'POST',
        url: '/api/dsh-memory/llm/test',
        on: (event: string, cb: any) => {
          if (event === 'data') {
            cb(
              Buffer.from(
                JSON.stringify({
                  baseURL: 'https://www.dorodoro.xyz/v1',
                  model: 'deepseek-chat',
                  apiKey: 'sk-doro-test',
                  protocol: 'responses',
                })
              )
            );
          }
          if (event === 'end') cb();
        },
      };
      await registeredHandler(respReq, { writeHead: () => {}, end: (d: string) => { respResBody = d; } });
      const respJson = JSON.parse(respResBody);
      expect(respJson.ok).toBe(true);
      expect(respJson.protocol).toBe('responses');
      expect(calls[1].url).toBe('https://www.dorodoro.xyz/v1/responses');
      expect(calls[1].body.input).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should handle edit, rollback, batch actions and export/import endpoints', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    // 1. Create a memory
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
    const memId = (createRes as any).id;

    // 2. Test edit action
    let editBody = '';
    const editReq: any = {
      method: 'POST',
      url: '/api/dsh-memory/action',
      on: (ev: string, cb: any) => {
        if (ev === 'data') {
          cb(Buffer.from(JSON.stringify({ action: 'edit', id: memId, content: 'Updated knowledge content text.' })));
        }
        if (ev === 'end') cb();
      },
    };
    await registeredHandler(editReq, { writeHead: () => {}, end: (d: string) => { editBody = d; } });
    const editJson = JSON.parse(editBody);
    expect(editJson.ok).toBe(true);
    expect(editJson.version).toBe(2);

    // 3. Test rollback action
    let rbBody = '';
    const rbReq: any = {
      method: 'POST',
      url: '/api/dsh-memory/action',
      on: (ev: string, cb: any) => {
        if (ev === 'data') {
          cb(Buffer.from(JSON.stringify({ action: 'rollback', id: memId, targetVersion: 1 })));
        }
        if (ev === 'end') cb();
      },
    };
    await registeredHandler(rbReq, { writeHead: () => {}, end: (d: string) => { rbBody = d; } });
    const rbJson = JSON.parse(rbBody);
    expect(rbJson.ok).toBe(true);

    // 4. Test batch action (batch pin)
    let batchBody = '';
    const batchReq: any = {
      method: 'POST',
      url: '/api/dsh-memory/action',
      on: (ev: string, cb: any) => {
        if (ev === 'data') {
          cb(Buffer.from(JSON.stringify({ action: 'batch', subAction: 'pin', ids: [memId] })));
        }
        if (ev === 'end') cb();
      },
    };
    await registeredHandler(batchReq, { writeHead: () => {}, end: (d: string) => { batchBody = d; } });
    const batchJson = JSON.parse(batchBody);
    expect(batchJson.ok).toBe(true);
    expect(batchJson.affected).toBe(1);

    // 5. Test export endpoint (JSON)
    let expBody = '';
    const expReq: any = {
      method: 'GET',
      url: '/api/dsh-memory/export',
    };
    await registeredHandler(expReq, { writeHead: () => {}, end: (d: string) => { expBody = d; } });
    const expJson = JSON.parse(expBody);
    expect(expJson.ok).toBe(true);
    expect(expJson.memories.length).toBeGreaterThanOrEqual(1);

    // 6. Test import endpoint (JSON)
    let impBody = '';
    const impReq: any = {
      method: 'POST',
      url: '/api/dsh-memory/import',
      on: (ev: string, cb: any) => {
        if (ev === 'data') {
          cb(
            Buffer.from(
              JSON.stringify({
                items: [
                  { content: 'Imported test item 1 for system', type: 'procedure' },
                  { content: 'Imported test item 2 for system', type: 'preference', pinned: true },
                ],
              })
            )
          );
        }
        if (ev === 'end') cb();
      },
    };
    await registeredHandler(impReq, { writeHead: () => {}, end: (d: string) => { impBody = d; } });
    const impJson = JSON.parse(impBody);
    expect(impJson.ok).toBe(true);
    expect(impJson.imported).toBe(2);
  });

  it('should handle /core-memory GET and POST (set & append) and status=pinned filter', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    const sendReq = async (method: string, url: string, body?: any) => {
      let out = '';
      const req: any = {
        method,
        url,
        on: (ev: string, cb: any) => {
          if (ev === 'data' && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (ev === 'end') cb();
        },
      };
      await registeredHandler(req, { writeHead: () => {}, end: (d: string) => { out = d; } });
      return JSON.parse(out);
    };

    // 1. Set human core block
    const setRes = await sendReq('POST', '/api/dsh-memory/core-memory', {
      block: 'human',
      content: 'Name: Alice, Role: Principal Architect',
      mode: 'set',
    });
    expect(setRes.ok).toBe(true);
    expect(setRes.block).toBe('human');

    // 2. Append to human core block
    const appRes = await sendReq('POST', '/api/dsh-memory/core-memory', {
      block: 'human',
      content: 'Timezone: UTC+8',
      mode: 'append',
    });
    expect(appRes.ok).toBe(true);

    // 3. GET /core-memory
    const getCore = await sendReq('GET', '/api/dsh-memory/core-memory');
    expect(getCore.ok).toBe(true);
    expect(Array.isArray(getCore.blocks)).toBe(true);
    const humanBlock = getCore.blocks.find((b: any) => b.block === 'human');
    expect(humanBlock).toBeDefined();
    expect(humanBlock.id).toBeTruthy();
    expect(humanBlock.content).toContain('Principal Architect');
    expect(humanBlock.content).toContain('Timezone: UTC+8');

    // 4. Filter by status=pinned on /memories (core memory blocks are pinned by default)
    const pinnedRes = await sendReq('GET', '/api/dsh-memory/memories?status=pinned');
    expect(pinnedRes.ok).toBe(true);
    expect(pinnedRes.total).toBeGreaterThanOrEqual(1);
    expect(pinnedRes.items.every((m: any) => m.pinned === 1)).toBe(true);
  });

  it('should handle /evolution endpoint and strategy evolution actions', async () => {
    registerWebRoutes(mockCtx, db, DEFAULTS);

    const sendReq = async (method: string, url: string, body?: any) => {
      let out = '';
      const req: any = {
        method,
        url,
        on: (ev: string, cb: any) => {
          if (ev === 'data' && body !== undefined) {
            cb(Buffer.from(JSON.stringify(body)));
          }
          if (ev === 'end') cb();
        },
      };
      await registeredHandler(req, { writeHead: () => {}, end: (d: string) => { out = d; } });
      return JSON.parse(out);
    };

    const evoRes = await sendReq('GET', '/api/dsh-memory/evolution');
    expect(evoRes.ok).toBe(true);
    expect(evoRes.activeStrategy).toBeDefined();
    expect(Array.isArray(evoRes.strategies)).toBe(true);
    expect(Array.isArray(evoRes.repairProposals)).toBe(true);

    const evolveRes = await sendReq('POST', '/api/dsh-memory/action', {
      action: 'evolve-strategy',
    });
    expect(evolveRes.ok).toBe(true);
    expect(evolveRes.result).toBeDefined();

    // Test /sandbox endpoint (Letta ADE Context Inspector & 5-Channel Recall Playground)
    upsertCandidate(
      db,
      {
        type: 'preference',
        content: 'Always use TypeScript strict mode and functional components.',
        scope: 'global',
        confidence: 0.95,
        source_kind: 'user',
        origin_kinds: ['user'],
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
      },
      Date.now()
    );

    const sandboxRes = await sendReq('POST', '/api/dsh-memory/sandbox', {
      query: 'TypeScript strict mode 偏好',
    });
    expect(sandboxRes.ok).toBe(true);
    expect(sandboxRes.stableLayer).toBeDefined();
    expect(sandboxRes.recallSimulation).toBeDefined();
    expect(sandboxRes.recallSimulation.items.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(sandboxRes.recentInjections)).toBe(true);
  });
});
