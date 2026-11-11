import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from '../src/core/db.js';
import type { Db } from '../src/types.js';
import { DEFAULTS } from '../src/config.js';
import {
  registerWebRoutes,
  API_PREFIX,
  isTrustedOrigin,
  isAllowedHostHeader,
} from '../src/dsh/web.js';
import { redactSecrets, isSafeApiKeyEnvName } from '../src/core/privacy.js';
import { upsertCandidate, mergeMemories, freeze, confirmMemory } from '../src/core/writer.js';
import { applyReconciliation } from '../src/evolution/reconciler.js';
import { MemoryTools } from '../src/dsh/tools.js';
import { workspaceId } from '../src/core/scope.js';
import { IngestQueue } from '../src/ingest/queue.js';

function makeRes() {
  const out: { status: number; body: any } = { status: 0, body: null };
  const res: any = {
    writeHead: (code: number) => {
      out.status = code;
    },
    end: (data?: string) => {
      try {
        out.body = data ? JSON.parse(data) : null;
      } catch {
        out.body = data;
      }
    },
  };
  return { res, out };
}

function makeReq(opts: { method?: string; url: string; headers?: Record<string, string>; body?: unknown | Buffer }) {
  return {
    method: opts.method || 'GET',
    url: opts.url,
    headers: opts.headers,
    on: (event: string, cb: any) => {
      if (event === 'data' && opts.body !== undefined) {
        cb(Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body)));
      }
      if (event === 'end') cb();
    },
  } as any;
}

describe('Security hardening', () => {
  let db: Db;
  let tmpDir: string;
  let handler: any;
  const cfg = () => JSON.parse(JSON.stringify(DEFAULTS));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-test-'));
    db = openDb(path.join(tmpDir, 'sec.db'));
    registerWebRoutes(
      {
        webServer: {
          register: (o: any) => {
            handler = o.handler;
            return () => {};
          },
        },
      },
      db,
      cfg()
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('does not follow redirects during the web LLM connection test', async () => {
    const fetchFn = vi.fn(async () => new Response('', {
      status: 307, headers: { location: 'https://unapproved.invalid' },
    }));
    vi.stubGlobal('fetch', fetchFn);
    const { res, out } = makeRes();
    await handler(makeReq({
      method: 'POST', url: `${API_PREFIX}/llm/test`,
      headers: { 'content-type': 'application/json' },
      body: { baseURL: 'https://approved.invalid/v1', apiKeyEnv: '', apiKey: 'synthetic-test-key' },
    }), res);
    expect(out.body.ok).toBe(false);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn.mock.calls[0]).toEqual([
      'https://approved.invalid/v1/chat/completions',
      expect.objectContaining({ redirect: 'manual' }),
    ]);
  });

  describe('Web API origin / host / CSRF guards', () => {
    it('rejects Origin: null and non-loopback origins', () => {
      expect(isTrustedOrigin('null')).toBe(false);
      expect(isTrustedOrigin('https://evil.example')).toBe(false);
      expect(isTrustedOrigin('http://localhost.evil.example')).toBe(false);
      expect(isTrustedOrigin('http://127.0.0.1:5173')).toBe(true);
      expect(isTrustedOrigin('http://localhost:3000')).toBe(true);
      expect(isTrustedOrigin('http://[::1]:3000')).toBe(true);
      expect(isTrustedOrigin(undefined)).toBe(true);
    });

    it('blocks DNS-rebinding Host headers but allows loopback / IP literals', () => {
      expect(isAllowedHostHeader('evil.example:8080')).toBe(false);
      expect(isAllowedHostHeader('127.0.0.1:8080')).toBe(true);
      expect(isAllowedHostHeader('localhost:8080')).toBe(true);
      expect(isAllowedHostHeader('192.168.1.10:8080')).toBe(true);
      expect(isAllowedHostHeader('[::1]:8080')).toBe(true);
    });

    it('returns 403 for a rebinding Host on /export', async () => {
      const { res, out } = makeRes();
      await handler(makeReq({ url: `${API_PREFIX}/export`, headers: { host: 'attacker.example:4000' } }), res);
      expect(out.status).toBe(403);
    });

    it('returns 403 for Origin: null requests', async () => {
      const { res, out } = makeRes();
      await handler(
        makeReq({ url: `${API_PREFIX}/export`, headers: { host: '127.0.0.1:4000', origin: 'null' } }),
        res
      );
      expect(out.status).toBe(403);
    });

    it('rejects non-JSON POST bodies (simple-request CSRF) with 415', async () => {
      const { res, out } = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { host: '127.0.0.1:4000', 'content-type': 'text/plain' },
          body: { offlineLLM: { baseURL: 'https://evil.example/v1' } },
        }),
        res
      );
      expect(out.status).toBe(415);
    });

    it('returns 413 for oversized bodies', async () => {
      const { res, out } = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/import`,
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          body: Buffer.alloc(1024 * 1024 + 10, 0x20),
        }),
        res
      );
      expect(out.status).toBe(413);
    });

    it('refuses arbitrary env var names as API key source and non-http base URLs', async () => {
      const r1 = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { 'content-type': 'application/json' },
          body: { offlineLLM: { apiKeyEnv: 'AWS_SECRET_ACCESS' } },
        }),
        r1.res
      );
      expect(r1.out.status).toBe(400);

      const r2 = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { 'content-type': 'application/json' },
          body: { offlineLLM: { baseURL: 'file:///etc/passwd' } },
        }),
        r2.res
      );
      expect(r2.out.status).toBe(400);

      const r3 = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { 'content-type': 'application/json' },
          body: { offlineLLM: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        }),
        r3.res
      );
      expect(r3.out.status).toBe(200);
      expect(r3.out.body.config.offlineLLM.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    });

    it('validates batch actions and counts only real successes', async () => {
      const { res, out } = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/action`,
          body: { action: 'batch', subAction: 'pin', ids: ['m_doesnotexist', 42] },
        }),
        res
      );
      expect(out.status).toBe(200);
      expect(out.body.affected).toBe(0);
      expect(out.body.total).toBe(1);

      const bad = makeRes();
      await handler(
        makeReq({ method: 'POST', url: `${API_PREFIX}/action`, body: { action: 'batch', subAction: 'drop', ids: ['x'] } }),
        bad.res
      );
      expect(bad.out.status).toBe(400);
    });

    it('treats LIKE wildcards in search literally', async () => {
      upsertCandidate(db, {
        type: 'semantic',
        content: 'Normal memory about deployment pipelines',
        scope: 'global',
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        actor: 'user',
        sources: [{ session_id: 's', seq: 1, kind: 'user' }],
      });
      const { res, out } = makeRes();
      await handler(makeReq({ url: `${API_PREFIX}/memories?q=%25` }), res);
      expect(out.status).toBe(200);
      expect(out.body.total).toBe(0);
    });
  });

  describe('Secret redaction & env-name allowlist', () => {
    it('detects additional vendor key formats', () => {
      const samples = [
        'AIzaSyA1234567890abcdefghijklmnopqrstuv',
        'sk_live_' + 'a'.repeat(24),
        'glpat-' + 'b'.repeat(20),
        'hf_' + 'c'.repeat(34),
        'ASIA' + 'ABCDEFGHIJKLMNOP',
      ];
      for (const s of samples) {
        const r = redactSecrets(`token ${s} end`);
        expect(r.hasSensitive, s).toBe(true);
        expect(r.text).not.toContain(s);
      }
    });

    it('allows only *_API_KEY / *_KEY / *_TOKEN env names', () => {
      expect(isSafeApiKeyEnvName('DEEPSEEK_API_KEY')).toBe(true);
      expect(isSafeApiKeyEnvName('MY_TOKEN')).toBe(true);
      expect(isSafeApiKeyEnvName('PATH')).toBe(false);
      expect(isSafeApiKeyEnvName('AWS_SECRET_ACCESS')).toBe(false);
      expect(isSafeApiKeyEnvName('BAD-NAME_KEY')).toBe(false);
    });
  });

  describe('Ingest queue resilience', () => {
    it('skips a single invalid event without dropping the rest of the batch', async () => {
      const queue = new IngestQueue(db, cfg(), { batchSize: 1000, flushIntervalMs: 60_000 });
      const base = { workspace_id: 'ws', type: 'user/message', time: Date.now(), is_error: 0 };
      queue.push({ ...base, session_id: 'q1', seq: 1, origin_kind: 'user', text: 'first event' } as any);
      queue.push({ ...base, session_id: 'q1', seq: 2, origin_kind: 'INVALID', text: 'bad event' } as any);
      queue.push({ ...base, session_id: 'q1', seq: 3, origin_kind: 'assistant', text: 'third event' } as any);
      const inserted = await queue.flush();
      await queue.close();
      expect(inserted).toBe(2);
      const rows = db.all(`SELECT seq FROM raw_events WHERE session_id = 'q1' ORDER BY seq`);
      expect(rows.map((r: any) => r.seq)).toEqual([1, 3]);
    });
  });

  describe('Model trust boundary', () => {
    const ws = workspaceId('sec-ws');

    function userMemory(content: string, slot?: string) {
      const r = upsertCandidate(db, {
        type: 'semantic',
        content,
        slot_key: slot,
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        actor: 'user',
        sources: [{ session_id: 's', seq: 1, kind: 'user' }],
      });
      return (r as any).id as string;
    }

    it('untrusted reconcile DELETE / UPDATE never destroys active memories', () => {
      const targetId = userMemory('数据库使用 PostgreSQL 16 作为主存储');
      const llmCandidate = {
        type: 'semantic' as const,
        content: '数据库不再使用 PostgreSQL，已全部迁移',
        scope: 'workspace' as const,
        workspaceId: ws,
        source_kind: 'assistant' as const,
        origin_kinds: ['assistant' as const],
        confidence: 0.8,
        status: 'active' as const,
        sources: [{ session_id: 's', seq: 2, kind: 'assistant' }],
        actor: 'llm' as const,
      };

      const del = applyReconciliation(db, llmCandidate, { action: 'DELETE', targetId, reason: 'negation', confidence: 0.9 });
      expect(del.action).toBe('conflict_pending');
      expect(db.get('SELECT status FROM memories WHERE id = ?', [targetId]).status).toBe('active');

      const upd = applyReconciliation(
        db,
        { ...llmCandidate, content: '数据库升级到 PostgreSQL 17 并启用分区表' },
        { action: 'UPDATE', targetId, reason: 'evolve', confidence: 0.9 }
      );
      expect(upd.action).toBe('conflict_pending');
      expect(db.get('SELECT status FROM memories WHERE id = ?', [targetId]).status).toBe('active');
    });

    it('trusted (user) reconcile DELETE still archives', () => {
      const targetId = userMemory('旧的部署脚本放在 scripts/deploy-old.sh');
      const res = applyReconciliation(
        db,
        {
          type: 'semantic',
          content: '旧的部署脚本已删除',
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          origin_kinds: ['user'],
          confidence: 0.9,
          sources: [{ session_id: 's', seq: 3, kind: 'user' }],
          actor: 'user',
        },
        { action: 'DELETE', targetId, reason: 'negation', confidence: 0.9 }
      );
      expect(res.action).toBe('superseded');
      expect(db.get('SELECT status FROM memories WHERE id = ?', [targetId]).status).toBe('archived');
    });

    it('non-user actors cannot merge away frozen or pinned memories; dead targets are refused', () => {
      const a = userMemory('前端构建工具统一使用 Vite 5');
      const b = userMemory('前端构建工具统一使用 Vite 5，并开启 SWC 插件');
      freeze(db, a, 'user');
      expect(mergeMemories(db, a, b, 'dedupe', 'llm').success).toBe(false);
      expect(db.get('SELECT status FROM memories WHERE id = ?', [a]).status).toBe('frozen');

      const c = userMemory('CI 使用 GitHub Actions 运行单元测试');
      const d = userMemory('CI 使用 GitHub Actions 运行单元测试与 lint');
      expect(mergeMemories(db, c, d, 'dedupe', 'user').success).toBe(true);
      // c 已被 supersede，不能再作为目标
      const e = userMemory('CI 缓存 node_modules 以加速构建');
      expect(mergeMemories(db, e, c, 'dedupe', 'user').success).toBe(false);
    });

    it('LLM confirm does not self-approve its own notes', () => {
      const tools = new MemoryTools({ db, cfg: cfg() });
      const noteRes = tools.note(
        { content: '项目统一使用 pnpm 作为包管理器', kind: 'fact' },
        { workspaceId: ws, sessionId: 's1', turn: 1 }
      );
      const noteId = noteRes.split(' ').pop()!;
      const r = confirmMemory(db, noteId, 'llm');
      expect(r.success).toBe(true);
      expect(db.get('SELECT status FROM memories WHERE id = ?', [noteId]).status).toBe('candidate');
      confirmMemory(db, noteId, 'user');
      expect(db.get('SELECT status FROM memories WHERE id = ?', [noteId]).status).toBe('active');
    });

    it('reconcile tool maps kind=fact/procedure to valid memory types instead of crashing', () => {
      const tools = new MemoryTools({ db, cfg: cfg() });
      const out = tools.unified(
        { action: 'reconcile', content: '测试框架统一使用 Vitest 运行', kind: 'procedure' },
        { workspaceId: ws, sessionId: 's1' }
      );
      expect(out).toContain('Reconciled');
      const row = db.get(`SELECT type FROM memories WHERE content LIKE '%Vitest%'`);
      expect(row.type).toBe('procedural');
    });
  });
});
