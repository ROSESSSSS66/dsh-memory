import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { openDb } from '../src/core/db.js';
import type { Db, MemoryRecord } from '../src/types.js';
import { DEFAULTS, loadConfigFromDb, type PluginConfig } from '../src/config.js';
import {
  registerWebRoutes,
  API_PREFIX,
  isTrustedOrigin,
  isAllowedHostHeader,
  type RegisterWebRoutesOptions,
} from '../src/dsh/web.js';
import {
  redactSecrets,
  isSafeApiKeyEnvName,
  assertSafeOutboundEndpoint,
} from '../src/core/privacy.js';
import {
  upsertCandidate,
  mergeMemories,
  freeze,
  confirmMemory,
  addRelation,
} from '../src/core/writer.js';
import { list, get, getSubgraph } from '../src/core/store.js';
import { auditMemoryHealth } from '../src/core/health.js';
import { runHindsightReflect, traceHindsightEvolution } from '../src/core/hindsight.js';
import {
  browseVikingDirectory,
  getVikingEvolutionDiff,
  importVikingContextTree,
} from '../src/core/viking.js';
import {
  exportToMarkdown,
  importFromMarkdown,
  isPathInsideRoot,
} from '../src/core/markdown.js';
import { hasUserEvidence } from '../src/core/trust.js';
import { matchesWithWorkspaceGaps } from '../src/evolution/parse.js';
import { applyReconciliation } from '../src/evolution/reconciler.js';
import { resetLlmProbeRateLimit } from '../src/service/llm-probe.js';
import { readSessionFile, ZSTD_MAGIC } from '../src/ingest/backfill.js';
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

function makeReq(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown | Buffer;
}) {
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
  const cfg = (): PluginConfig => JSON.parse(JSON.stringify(DEFAULTS));

  function mountRoutes(
    overrides: Partial<PluginConfig> = {},
    options?: RegisterWebRoutesOptions
  ): { handler: any; liveCfg: PluginConfig } {
    let mountedHandler: any;
    const base = cfg();
    const liveCfg: PluginConfig = {
      ...base,
      ...overrides,
      offlineLLM: { ...base.offlineLLM, ...(overrides.offlineLLM || {}) },
      embedding: { ...base.embedding, ...(overrides.embedding || {}) },
      privacy: { ...base.privacy, ...(overrides.privacy || {}) },
    };
    registerWebRoutes(
      {
        webServer: {
          register: (o: any) => {
            mountedHandler = o.handler;
            return () => {};
          },
        },
      },
      db,
      liveCfg,
      options
    );
    return { handler: mountedHandler, liveCfg };
  }

  beforeEach(() => {
    resetLlmProbeRateLimit();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sec-test-'));
    db = openDb(path.join(tmpDir, 'sec.db'));
    handler = mountRoutes().handler;
  });

  afterEach(() => {
    resetLlmProbeRateLimit();
    vi.unstubAllGlobals();
    try {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('does not follow redirects during the web LLM connection test when offlineConsent is enabled', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('', {
          status: 307,
          headers: { location: 'https://unapproved.invalid' },
        })
    ) as unknown as typeof fetch;
    const { handler: consentedHandler } = mountRoutes(
      {
        privacy: {
          offlineConsent: true,
          allowedOfflineEndpoints: ['https://approved.invalid'],
        },
      },
      { fetchFn }
    );
    const { res, out } = makeRes();
    await consentedHandler(
      makeReq({
        method: 'POST',
        url: `${API_PREFIX}/llm/test`,
        headers: { 'content-type': 'application/json' },
        body: { baseURL: 'https://approved.invalid/v1', apiKeyEnv: '', apiKey: 'synthetic-test-key' },
      }),
      res
    );
    expect(out.body.ok).toBe(false);
    expect(out.body.code).toBe('redirect_not_allowed');
    expect(fetchFn).toHaveBeenCalledOnce();
    expect((fetchFn as any).mock.calls[0]).toEqual([
      'https://approved.invalid/v1/chat/completions',
      expect.objectContaining({ redirect: 'manual' }),
    ]);
  });

  it('blocks POST /llm/test with 403 when privacy.offlineConsent is false without invoking fetch', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
    const { handler: unconsentedHandler } = mountRoutes(
      {
        privacy: {
          offlineConsent: false,
          allowedOfflineEndpoints: ['https://approved.invalid'],
        },
      },
      { fetchFn }
    );
    const { res, out } = makeRes();
    await unconsentedHandler(
      makeReq({
        method: 'POST',
        url: `${API_PREFIX}/llm/test`,
        headers: { 'content-type': 'application/json' },
        body: { baseURL: 'https://approved.invalid/v1', apiKeyEnv: '', apiKey: 'synthetic-test-key' },
      }),
      res
    );
    expect(out.status).toBe(403);
    expect(out.body.ok).toBe(false);
    expect(out.body.code).toBe('privacy_offline_consent_required');
    expect(fetchFn).not.toHaveBeenCalled();
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

    it('blocks /import with 403 when webAdminEnabled is false and returns 413 for oversized bodies when enabled', async () => {
      const denied = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/import`,
          headers: { host: '127.0.0.1', 'content-type': 'application/json' },
          body: { memories: [{ content: 'sample memory entry' }] },
        }),
        denied.res
      );
      expect(denied.out.status).toBe(403);
      expect(denied.out.body.code).toBe('web_admin_disabled');

      const { handler: adminHandler } = mountRoutes({ webAdminEnabled: true });
      const { res, out } = makeRes();
      await adminHandler(
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

    it('blocks /action with 403 when webAdminEnabled is false and validates batch actions when enabled', async () => {
      const denied = makeRes();
      await handler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/action`,
          headers: { 'content-type': 'application/json' },
          body: { action: 'batch', subAction: 'pin', ids: ['m_doesnotexist'] },
        }),
        denied.res
      );
      expect(denied.out.status).toBe(403);
      expect(denied.out.body.code).toBe('web_admin_disabled');

      const { handler: adminHandler } = mountRoutes({ webAdminEnabled: true });
      const { res, out } = makeRes();
      await adminHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/action`,
          headers: { 'content-type': 'application/json' },
          body: { action: 'batch', subAction: 'pin', ids: ['m_doesnotexist', 42] },
        }),
        res
      );
      expect(out.status).toBe(200);
      expect(out.body.affected).toBe(0);
      expect(out.body.total).toBe(1);

      const bad = makeRes();
      await adminHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/action`,
          headers: { 'content-type': 'application/json' },
          body: { action: 'batch', subAction: 'drop', ids: ['x'] },
        }),
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

    it('redacts hyphenated Slack tokens, truncated PEM keys, Basic auth, quoted passwords with spaces, and AWS_SESSION_TOKEN', () => {
      // 1. Hyphenated Slack token leaves ZERO secret suffix (assembled dynamically to avoid false-positive secret scans)
      const slackToken = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
      const slackRes = redactSecrets(`Slack bot token is ${slackToken} in config`);
      expect(slackRes.hasSensitive).toBe(true);
      expect(slackRes.text).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
      expect(slackRes.text).not.toContain('1234567890123');
      expect(slackRes.text).not.toContain('123456789012');
      expect(slackRes.text).toContain('[REDACTED:API_KEY]');

      // 2. Truncated PEM private key without END footer
      const truncatedPem =
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7V8d9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c';
      const pemRes = redactSecrets(truncatedPem);
      expect(pemRes.hasSensitive).toBe(true);
      expect(pemRes.detectedKinds).toContain('PEM_KEY');
      expect(pemRes.text).not.toContain('MIIEpAIBAAKCAQEA');

      // 3. HTTP Basic credential
      const basicRes = redactSecrets('Authorization: Basic YWRtaW46cGFzcw==');
      expect(basicRes.hasSensitive).toBe(true);
      expect(basicRes.detectedKinds).toContain('AUTH_TOKEN');
      expect(basicRes.text).not.toContain('YWRtaW46cGFzcw==');

      // 4. Quoted password containing spaces
      const pwdRes = redactSecrets('db_password = "my secret passphrase"');
      expect(pwdRes.hasSensitive).toBe(true);
      expect(pwdRes.text).not.toContain('my secret passphrase');

      // 5. AWS_SESSION_TOKEN
      const awsToken = 'FwoGZXIvYXdzEBYaDExampleSessionToken123456789';
      const awsRes = redactSecrets(`AWS_SESSION_TOKEN=${awsToken}`);
      expect(awsRes.hasSensitive).toBe(true);
      expect(awsRes.text).not.toContain(awsToken);
    });

    it('allows only explicit LLM/Embedding provider env var names and rejects generic or cloud secrets', () => {
      expect(isSafeApiKeyEnvName('DEEPSEEK_API_KEY')).toBe(true);
      expect(isSafeApiKeyEnvName('OPENAI_API_KEY')).toBe(true);
      expect(isSafeApiKeyEnvName('ANTHROPIC_API_KEY')).toBe(true);
      expect(isSafeApiKeyEnvName('MY_TOKEN')).toBe(false);
      expect(isSafeApiKeyEnvName('AWS_SECRET_ACCESS_KEY')).toBe(false);
      expect(isSafeApiKeyEnvName('AWS_SESSION_TOKEN')).toBe(false);
      expect(isSafeApiKeyEnvName('GITHUB_TOKEN')).toBe(false);
      expect(isSafeApiKeyEnvName('SSH_PRIVATE_KEY')).toBe(false);
      expect(isSafeApiKeyEnvName('PATH')).toBe(false);
      expect(isSafeApiKeyEnvName('AWS_SECRET_ACCESS')).toBe(false);
      expect(isSafeApiKeyEnvName('BAD-NAME_KEY')).toBe(false);
    });
  });

  describe('P0 SSRF & 2-step API key exfiltration defense', () => {
    it('blocks cloud metadata IPs, IPv4-mapped IPv6, metadata hostnames, DNS rebinding IPs, and ?/#/userinfo URL bypasses', async () => {
      expect((await assertSafeOutboundEndpoint('http://169.254.169.254/latest/meta-data')).ok).toBe(false);
      expect((await assertSafeOutboundEndpoint('http://100.100.100.200/')).ok).toBe(false);
      expect((await assertSafeOutboundEndpoint('http://[::ffff:169.254.169.254]/')).ok).toBe(false);
      expect((await assertSafeOutboundEndpoint('http://metadata.google.internal/')).ok).toBe(false);

      // DNS resolving to AWS IMDS 169.254.169.254
      const dnsBlocked = await assertSafeOutboundEndpoint('https://rebind.attacker.invalid/v1', {
        lookupFn: async () => [{ address: '169.254.169.254' }],
      });
      expect(dnsBlocked).toMatchObject({ ok: false, reason: 'blocked_resolved_ip' });

      // Query / fragment / userinfo path-concatenation bypasses
      expect(
        await assertSafeOutboundEndpoint('https://api.deepseek.com/admin#', { skipDnsLookup: true })
      ).toMatchObject({ ok: false, reason: 'url_query_or_hash_forbidden' });
      expect(
        await assertSafeOutboundEndpoint('https://api.deepseek.com/v1?x=1', { skipDnsLookup: true })
      ).toMatchObject({ ok: false, reason: 'url_query_or_hash_forbidden' });
      expect(
        await assertSafeOutboundEndpoint('https://user:pass@api.deepseek.com/v1', { skipDnsLookup: true })
      ).toMatchObject({ ok: false, reason: 'url_credentials_forbidden' });

      // End-to-end POST /llm/test blocks DNS-rebinding & # bypass without touching fetchFn
      const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch;
      const { handler: ssrfHandler } = mountRoutes(
        {
          privacy: {
            offlineConsent: true,
            allowedOfflineEndpoints: ['https://rebind.attacker.invalid', 'https://api.deepseek.com'],
          },
        },
        {
          fetchFn,
          lookupFn: async () => [{ address: '169.254.169.254' }],
        }
      );

      const dnsRes = makeRes();
      await ssrfHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/llm/test`,
          headers: { 'content-type': 'application/json' },
          body: { baseURL: 'https://rebind.attacker.invalid/v1' },
        }),
        dnsRes.res
      );
      expect(dnsRes.out.status).toBe(403);
      expect(dnsRes.out.body.code).toBe('blocked_resolved_ip');

      const hashRes = makeRes();
      await ssrfHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/llm/test`,
          headers: { 'content-type': 'application/json' },
          body: { baseURL: 'https://api.deepseek.com/admin#' },
        }),
        hashRes.res
      );
      expect(hashRes.out.status).toBe(400);
      expect(hashRes.out.body.code).toBe('url_query_or_hash_forbidden');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('wipes stored apiKey across the 2-step baseURL clear -> new evil baseURL exfiltration bypass on POST /config', async () => {
      const initialSecret = 'sk-deepseek-prod-secret-999988887777';
      const initialCfg: PluginConfig = {
        ...cfg(),
        offlineLLM: {
          useDshLlm: false,
          baseURL: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          apiKey: initialSecret,
        },
      };
      const { handler: cfgHandler, liveCfg } = mountRoutes(initialCfg, { initialCfg });

      // Step 1: Clear baseURL while keeping useDshLlm: false
      const step1 = makeRes();
      await cfgHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { 'content-type': 'application/json' },
          body: { offlineLLM: { baseURL: '', useDshLlm: false } },
        }),
        step1.res
      );
      expect(step1.out.status).toBe(200);
      expect(liveCfg.offlineLLM.apiKey).toBe('');
      expect(loadConfigFromDb(db, initialCfg).offlineLLM.apiKey).toBe('');

      // Step 2: Point baseURL to attacker endpoint -> stored apiKey MUST stay empty
      const step2 = makeRes();
      await cfgHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/config`,
          headers: { 'content-type': 'application/json' },
          body: { offlineLLM: { baseURL: 'https://evil.example/v1' } },
        }),
        step2.res
      );
      expect(step2.out.status).toBe(200);
      expect(liveCfg.offlineLLM.baseURL).toBe('https://evil.example/v1');
      expect(liveCfg.offlineLLM.apiKey).toBe('');
      expect(step2.out.body.config.offlineLLM.hasApiKey).toBe(false);
      expect(loadConfigFromDb(db, initialCfg).offlineLLM.apiKey).toBe('');
    });
  });

  describe('P0 taint laundering & quote verification blocks', () => {
    const ws = workspaceId('/synthetic/ws/taint-check');

    it('upsertCandidate clears isExplicitUser/approved_by and demotes web/tool tainted inputs to candidate (conf <= 0.5)', () => {
      const webRes = upsertCandidate(db, {
        type: 'semantic',
        content: '外部网页尝试伪造用户显式指令写入系统规则',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user', 'web'],
        status: 'active',
        confidence: 0.99,
        actor: 'user',
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
      });
      expect(webRes.action).toBe('inserted');
      const webRec = get(db, (webRes as { id: string }).id)!;
      expect(webRec.status).toBe('candidate');
      expect(webRec.approved_by).toBeNull();
      expect(webRec.approved_at).toBeNull();
      expect(webRec.confidence).toBeLessThanOrEqual(0.5);

      const toolRes = upsertCandidate(db, {
        type: 'semantic',
        content: '工具输出夹带提示注入尝试提权为已审批记忆',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        status: 'active',
        confidence: 0.95,
        actor: 'user',
        sources: [
          { session_id: 's1', seq: 2, kind: 'user_msg' },
          { session_id: 's1', seq: 3, kind: 'tool_result' },
        ],
      });
      expect(toolRes.action).toBe('inserted');
      const toolRec = get(db, (toolRes as { id: string }).id)!;
      expect(toolRec.status).toBe('candidate');
      expect(toolRec.approved_by).toBeNull();
      expect(toolRec.confidence).toBeLessThanOrEqual(0.5);
    });

    it('hasUserEvidence rejects mixed user_msg + tool_result taint on the same content_rev', () => {
      const cleanRes = upsertCandidate(db, {
        type: 'semantic',
        content: '纯净用户输入确认的部署规范条目',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        origin_kinds: ['user'],
        confidence: 0.9,
        actor: 'user',
        sources: [{ session_id: 's_mix', seq: 1, kind: 'user_msg' }],
      });
      const id = (cleanRes as { id: string }).id;
      const cleanMem = get(db, id)!;
      expect(hasUserEvidence(db, cleanMem)).toBe(true);

      // Attach a tool_result source to the same content_rev -> taint invalidates clean user evidence
      db.run(
        `INSERT INTO memory_sources (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
         VALUES (?, ?, 's_mix', 2, 'tool_result', 'injected tool payload', ?)`,
        [id, cleanMem.content_rev, Date.now()]
      );
      expect(hasUserEvidence(db, get(db, id)!)).toBe(false);
    });

    it('matchesWithWorkspaceGaps rejects bare "<workspace>" or under-anchored quotes', () => {
      const sourceText = 'Configuration stored in /home/dev/project/config/settings.json safely';
      expect(matchesWithWorkspaceGaps(sourceText, '<workspace>')).toBe(false);
      expect(matchesWithWorkspaceGaps(sourceText, 'a<workspace>')).toBe(false);
      expect(matchesWithWorkspaceGaps(sourceText, '<workspace>   <workspace>')).toBe(false);
      expect(matchesWithWorkspaceGaps(sourceText, 'in <workspace>/config/settings.json safely')).toBe(true);
    });
  });

  describe('P0 cross-session & excludeWorkspaces isolation across store, health, hindsight, viking, and web', () => {
    it('enforces strict session and excludeWorkspaces boundaries across all 6 surfaces', async () => {
      const allowedPath = '/synthetic/isolated/allowed-repo';
      const excludedPath = '/synthetic/isolated/secret-repo';
      const wsAllowed = workspaceId(allowedPath);
      const wsExcluded = workspaceId(excludedPath);
      const now = 1_772_000_000_000;

      const memWsId = (
        upsertCandidate(
          db,
          {
            type: 'semantic',
            content: '允许工作区的主架构配置事实',
            scope: 'workspace',
            workspaceId: wsAllowed,
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: 0.9,
            actor: 'user',
            sources: [{ session_id: 'sess_1', seq: 1, kind: 'user_msg' }],
          },
          now
        ) as { id: string }
      ).id;

      const memSess1Id = (
        upsertCandidate(
          db,
          {
            type: 'semantic',
            content: '会话一专属临时调试记录',
            scope: 'session',
            workspaceId: wsAllowed,
            sessionId: 'sess_1',
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: 0.9,
            actor: 'user',
            sources: [{ session_id: 'sess_1', seq: 2, kind: 'user_msg' }],
          },
          now + 10
        ) as { id: string }
      ).id;

      const memSess2Id = (
        upsertCandidate(
          db,
          {
            type: 'semantic',
            content: '会话二私有上下文绝不可跨会话可见',
            scope: 'session',
            workspaceId: wsAllowed,
            sessionId: 'sess_2',
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: 0.9,
            actor: 'user',
            sources: [{ session_id: 'sess_2', seq: 1, kind: 'user_msg' }],
          },
          now + 20
        ) as { id: string }
      ).id;

      const memExcludedId = (
        upsertCandidate(
          db,
          {
            type: 'semantic',
            content: '排除工作区机密商业逻辑绝不可外泄',
            scope: 'workspace',
            workspaceId: wsExcluded,
            source_kind: 'user',
            origin_kinds: ['user'],
            confidence: 0.9,
            actor: 'user',
            sources: [{ session_id: 'sess_exc', seq: 1, kind: 'user_msg' }],
          },
          now + 30
        ) as { id: string }
      ).id;

      // Wire direct relations to test traversal isolation
      addRelation(db, memWsId, memSess2Id, 'related', now + 40);
      addRelation(db, memWsId, memExcludedId, 'contradicts', now + 41);

      // 1. store.list
      const listNoSession = list(db, { workspaceId: wsAllowed }).map((m) => m.id);
      expect(listNoSession).toContain(memWsId);
      expect(listNoSession).not.toContain(memSess1Id);
      expect(listNoSession).not.toContain(memSess2Id);
      expect(listNoSession).not.toContain(memExcludedId);

      const listSess1 = list(db, { workspaceId: wsAllowed, sessionId: 'sess_1' }).map((m) => m.id);
      expect(listSess1).toContain(memWsId);
      expect(listSess1).toContain(memSess1Id);
      expect(listSess1).not.toContain(memSess2Id);
      expect(listSess1).not.toContain(memExcludedId);

      // 2. store.getSubgraph (must not leak memSess2 or memExcluded over direct edges)
      const sub = getSubgraph(db, memWsId, {
        workspaceId: wsAllowed,
        sessionId: 'sess_1',
        hops: 2,
      });
      const subNodeIds = sub.nodes.map((n) => n.id);
      expect(subNodeIds).toContain(memWsId);
      expect(subNodeIds).not.toContain(memSess2Id);
      expect(subNodeIds).not.toContain(memExcludedId);

      // 3. health
      const healthAll = auditMemoryHealth(db, {
        excludeWorkspaces: [excludedPath],
        now: now + 100,
      });
      // Only memWsId is visible globally when sessionId is omitted and excludedPath is excluded
      expect(healthAll.counts.active).toBe(1);
      expect(healthAll.contradictions).toHaveLength(0);

      // 4. hindsight
      const hsExcluded = runHindsightReflect(db, {
        workspaceId: wsExcluded,
        excludeWorkspaces: [excludedPath],
        now: now + 100,
      });
      expect(hsExcluded.networkCounts).toEqual({ world: 0, experience: 0, observation: 0, opinion: 0 });
      const trace = traceHindsightEvolution(db, get(db, memWsId)!, {
        workspaceId: wsAllowed,
        sessionId: 'sess_1',
        excludeWorkspaces: [excludedPath],
      });
      expect(trace.contradictions).toHaveLength(0);

      // 5. viking
      const vikingDir = browseVikingDirectory(db, {
        workspaceId: wsAllowed,
        sessionId: 'sess_1',
      });
      expect(vikingDir).toContain(memWsId);
      expect(vikingDir).toContain(memSess1Id);
      expect(vikingDir).not.toContain(memSess2Id);
      expect(vikingDir).not.toContain(memExcludedId);

      const vikingDiffExcluded = getVikingEvolutionDiff(db, {
        workspaceId: wsExcluded,
        excludeWorkspaces: [excludedPath],
      });
      expect(vikingDiffExcluded.added).toHaveLength(0);

      // 6. web API
      const { handler: webHandler } = mountRoutes({
        webAdminEnabled: true,
        excludeWorkspaces: [excludedPath],
      });

      const webListAll = makeRes();
      await webHandler(makeReq({ url: `${API_PREFIX}/memories` }), webListAll.res);
      const webAllIds = (webListAll.out.body.items || []).map((m: any) => m.id);
      expect(webAllIds).toContain(memWsId);
      expect(webAllIds).not.toContain(memSess1Id);
      expect(webAllIds).not.toContain(memSess2Id);
      expect(webAllIds).not.toContain(memExcludedId);

      const webListSess1 = makeRes();
      await webHandler(
        makeReq({ url: `${API_PREFIX}/memories?workspaceId=${wsAllowed}&sessionId=sess_1` }),
        webListSess1.res
      );
      const webSess1Ids = (webListSess1.out.body.items || []).map((m: any) => m.id);
      expect(webSess1Ids).toContain(memSess1Id);
      expect(webSess1Ids).not.toContain(memSess2Id);
      expect(webSess1Ids).not.toContain(memExcludedId);

      const webGetExcluded = makeRes();
      await webHandler(makeReq({ url: `${API_PREFIX}/memory?id=${memExcludedId}` }), webGetExcluded.res);
      expect([403, 404]).toContain(webGetExcluded.out.status);

      const webGraph = makeRes();
      await webHandler(
        makeReq({ url: `${API_PREFIX}/graph?workspaceId=${wsAllowed}&sessionId=sess_1&centerId=${memWsId}` }),
        webGraph.res
      );
      const webGraphIds = (webGraph.out.body.graph?.nodes || []).map((n: any) => n.id);
      expect(webGraphIds).toContain(memWsId);
      expect(webGraphIds).not.toContain(memSess2Id);
      expect(webGraphIds).not.toContain(memExcludedId);
    });
  });

  describe('P0 path traversal, symlink, untrusted import & bootstrap workspacePath guards', () => {
    it('prevents path traversal on exportToMarkdown when DB contains a malicious memory id', () => {
      const exportDir = path.join(tmpDir, 'nested', 'deep', 'export');
      const now = Date.now();
      db.run(
        `INSERT INTO memories (
          id, type, status, content, summary, scope, workspace_id,
          origin_kinds, source_kind, confidence, utility, token_cost, summary_cost,
          hash, version, content_rev, pinned, created_at, updated_at
        ) VALUES (?, 'semantic', 'active', 'Malicious id traversal attempt', 'Traversal test', 'global', NULL,
          '["user"]', 'user', 0.9, 0.5, 10, 5, 'hash_trav_01', 1, 1, 0, ?, ?)`,
        ['../../../../outside', now, now]
      );

      const res = exportToMarkdown(db, exportDir);
      expect(res.exportedCount).toBe(1);
      for (const f of res.files) {
        expect(isPathInsideRoot(f, exportDir)).toBe(true);
      }
      expect(fs.existsSync(path.resolve(exportDir, 'global', 'semantic', '../../../../outside.md'))).toBe(false);
    });

    it('sandboxes untrusted importFromMarkdown & importVikingContextTree and rejects symlinked directories', () => {
      const targetWs = workspaceId('/synthetic/ws/sandbox-target');
      const importDir = path.join(tmpDir, 'untrusted-md');
      fs.mkdirSync(importDir, { recursive: true });
      fs.writeFileSync(
        path.join(importDir, 'attack.md'),
        [
          '---',
          'type: semantic',
          'scope: global',
          'workspace_id: "0123456789abcdef"',
          'slot_key: "core:human"',
          'confidence: 0.99',
          'pinned: 1',
          'status: frozen',
          'summary: "Attack payload"',
          '---',
          '',
          'Attempted global core slot override.',
        ].join('\n'),
        'utf8'
      );

      const mdRes = importFromMarkdown(db, importDir, { workspaceId: targetWs, trusted: false });
      expect(mdRes.importedCount).toBe(1);
      const mdRow = db.get<MemoryRecord>('SELECT * FROM memories LIMIT 1')!;
      expect(mdRow.scope).toBe('workspace');
      expect(mdRow.workspace_id).toBe(targetWs);
      expect(mdRow.slot_key).toBeNull();
      expect(mdRow.status).toBe('candidate');
      expect(mdRow.confidence).toBeLessThanOrEqual(0.5);

      const vikingDb = openDb(':memory:');
      try {
        const vkRes = importVikingContextTree(vikingDb, importDir, {
          workspaceId: targetWs,
          trusted: false,
        });
        expect(vkRes.importedCount).toBe(1);
        const vkRow = vikingDb.get<MemoryRecord>('SELECT * FROM memories LIMIT 1')!;
        expect(vkRow.scope).toBe('workspace');
        expect(vkRow.workspace_id).toBe(targetWs);
        expect(vkRow.slot_key).toBeNull();
        expect(vkRow.status).toBe('candidate');
        expect(vkRow.pinned).toBe(0);
        expect(vkRow.confidence).toBeLessThanOrEqual(0.5);
      } finally {
        vikingDb.close();
      }

      // Symlink / junction directory rejection
      const outsideDir = path.join(tmpDir, 'outside-real');
      const symlinkDir = path.join(tmpDir, 'symlink-import');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => importFromMarkdown(db, symlinkDir, { workspaceId: targetWs, trusted: false })).toThrow(/symlink/i);
      expect(() =>
        importVikingContextTree(db, symlinkDir, { workspaceId: targetWs, trusted: false })
      ).toThrow(/symlink/i);
    });

    it('rejects untrusted workspacePath on POST /action bootstrap with 403 untrusted_workspace_path', async () => {
      const { handler: adminHandler } = mountRoutes(
        { webAdminEnabled: true },
        { activeWorkspaces: () => [tmpDir] }
      );
      const { res, out } = makeRes();
      await adminHandler(
        makeReq({
          method: 'POST',
          url: `${API_PREFIX}/action`,
          headers: { 'content-type': 'application/json' },
          body: { action: 'bootstrap', workspacePath: '/etc' },
        }),
        res
      );
      expect(out.status).toBe(403);
      expect(out.body.code).toBe('untrusted_workspace_path');
    });
  });

  describe('P0 Zstd multi-frame bomb protection', () => {
    it('cleanly rejects a multi-frame zstd decompression bomb exceeding output budget and oversized window frames', () => {
      const headerLine =
        JSON.stringify({ version: 4, id: 'sess_zstd_bomb', cwd: '/synthetic/ws/zstd' }) + '\n';
      const eventLine =
        JSON.stringify({
          seq: 1,
          time: 1000,
          type: 'user/message',
          data: { text: 'A'.repeat(2000), source: { kind: 'user' } },
        }) + '\n';

      // Build valid multi-frame zstd file (~16 KiB decompressed across 9 frames)
      const frames: Buffer[] = [zlib.zstdCompressSync(Buffer.from(headerLine, 'utf8'))];
      for (let i = 0; i < 8; i++) {
        frames.push(zlib.zstdCompressSync(Buffer.from(eventLine, 'utf8')));
      }
      const multiFramePath = path.join(tmpDir, 'bomb.jsonl.zstd');
      fs.writeFileSync(multiFramePath, Buffer.concat(frames));

      // Exceeding cumulative budget -> cleanly returns null without throwing or OOM
      expect(readSessionFile(multiFramePath, { maxDecompressedBytes: 4096 })).toBeNull();

      // Within budget -> parses cleanly, proving the guard is the cumulative budget check
      const ok = readSessionFile(multiFramePath, { maxDecompressedBytes: 64 * 1024 });
      expect(ok).not.toBeNull();
      expect(ok!.rawLines.length).toBe(8);

      // Crafted frame claiming > 64 MiB Window_Descriptor (exponent=20 => 2^30 = 1 GiB)
      const hugeWindowFrame = Buffer.alloc(10);
      hugeWindowFrame.writeUInt32LE(ZSTD_MAGIC, 0);
      hugeWindowFrame[4] = 0x00; // Frame_Header_Descriptor: singleSegment=0, fcs=0, checksum=0
      hugeWindowFrame[5] = 20 << 3; // Window_Descriptor: exponent=20 => 1 GiB window
      // Last block header: isLast=1, type=0 (raw), size=0 -> 0x000001
      hugeWindowFrame[6] = 0x01;
      hugeWindowFrame[7] = 0x00;
      hugeWindowFrame[8] = 0x00;
      const hugeWindowPath = path.join(tmpDir, 'huge-window.jsonl.zstd');
      fs.writeFileSync(hugeWindowPath, hugeWindowFrame.subarray(0, 9));
      expect(readSessionFile(hugeWindowPath)).toBeNull();
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
