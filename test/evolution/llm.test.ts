import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import {
  anonymizeWorkspacePaths,
  buildProtocolPayload,
  callOfflineLLM,
  clearHostLlmFallbackCache,
  isReasoningModel,
  parseRetryAfterMs,
  resetLlmCircuitBreaker,
  resolveDshHostLlmFallback,
  resolveEndpointAndProtocol,
  unquoteScalar,
} from '../../src/evolution/llm.js';
import { reserve, settle } from '../../src/evolution/ledger.js';
import type { Db } from '../../src/types.js';

describe('Evolution LLM Client (M3-T1)', () => {
  let db: Db;
  let baseCfg: PluginConfig;

  beforeEach(() => {
    resetLlmCircuitBreaker();
    clearHostLlmFallbackCache();
    db = openDb(':memory:');
    baseCfg = {
      ...DEFAULTS,
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.deepseek.com'],
      },
    };
  });

  afterEach(() => {
    resetLlmCircuitBreaker();
    clearHostLlmFallbackCache();
    db.close();
  });

  it('rejects without HTTP request when offlineConsent is false (未授权endpoint请求为0)', async () => {
    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}');
    };

    const cfgNoConsent: PluginConfig = {
      ...baseCfg,
      privacy: {
        offlineConsent: false,
        allowedOfflineEndpoints: ['https://api.deepseek.com'],
      },
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'System',
        userPrompt: 'User',
        maxOutputTokens: 2000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      cfgNoConsent
    );

    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('privacy_offline_consent_required');
    expect(fetchCount).toBe(0);
  });

  it('rejects without HTTP request when endpoint is not in allowed list (未授权endpoint请求为0)', async () => {
    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}');
    };

    const cfgUnallowed: PluginConfig = {
      ...baseCfg,
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://other-api.com'], // different origin
      },
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'System',
        userPrompt: 'User',
        maxOutputTokens: 2000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      cfgUnallowed
    );

    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('endpoint_not_allowed');
    expect(fetchCount).toBe(0);
  });

  it('fails reservation and makes 0 HTTP calls when tokens budget exceeded (已用199000、输入500、maxOutput1500时预留失败且HTTP=0)', async () => {
    const first = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-chat',
        promptVersion: 'distill-v2',
        reservedTokens: 199000,
      },
      baseCfg
    );
    settle(db, {
      ledgerId: first.ledgerId!,
      status: 'succeeded',
      ok: 1,
      inTokens: 100000,
      outTokens: 99000,
    });

    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}');
    };

    const input500Chars = 'A'.repeat(500);
    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'System',
        userPrompt: input500Chars,
        maxOutputTokens: 1500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('daily_tokens_exceeded');
    expect(fetchCount).toBe(0);
  });

  it('redacts secrets and anonymizes cwd in HTTP body and ledger (含密钥/PII的mock body和存储均无原值)', async () => {
    let capturedBody = '';
    const mockFetch: typeof fetch = async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const secretVal = 'sk-abcdef1234567890abcdef';
    const cwdVal = 'C:\\Users\\Alice\\Projects\\my-secret-repo';

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'System instructions',
        userPrompt: `Here is the config: api_key = "${secretVal}" in directory ${cwdVal}`,
        maxOutputTokens: 2000,
        cwd: cwdVal,
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(true);
    expect(capturedBody).not.toContain(secretVal);
    expect(capturedBody).toMatch(/\[REDACTED:(?:API_KEY|SECRET)\]/);
    expect(capturedBody).not.toContain(cwdVal);
    expect(capturedBody).toContain('<workspace>');

    const rows = db.all<{ note: string }>(`SELECT note FROM llm_ledger`);
    for (const r of rows) {
      if (r.note) {
        expect(r.note).not.toContain(secretVal);
        expect(r.note).not.toContain(cwdVal);
      }
    }
  });

  it('charges each retry attempt independently upon network error (网络重试逐次计费)', async () => {
    let attempt = 0;
    const mockFetch: typeof fetch = async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error('Connection reset');
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 1000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(true);
    expect(attempt).toBe(2);

    const rows = db.all<{ id: number; status: string; ok: number }>(
      'SELECT id, status, ok FROM llm_ledger ORDER BY id ASC'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('unknown');
    expect(rows[0].ok).toBe(0);
    expect(rows[1].status).toBe('succeeded');
    expect(rows[1].ok).toBe(1);
  });

  it('retains full quota as unknown when response is missing usage info (未知usage)', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
        }),
        { status: 200 }
      );
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 2000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(true);
    expect((res as any).usage).toBeUndefined();

    const row = db.get<{ status: string; note: string }>(
      'SELECT status, note FROM llm_ledger WHERE id = ?',
      [(res as any).ledgerId!]
    );
    expect(row?.status).toBe('unknown');
    expect(row?.note).toBe('missing_usage_info');
  });

  it('rejects without HTTP request when daily calls reach 40 (40次调用上限)', async () => {
    for (let i = 0; i < 40; i++) {
      const r = reserve(
        db,
        {
          jobKind: 'distill',
          model: 'deepseek-chat',
          promptVersion: 'distill-v2',
          reservedTokens: 10,
        },
        baseCfg
      );
      settle(db, { ledgerId: r.ledgerId!, status: 'succeeded', ok: 1, inTokens: 5, outTokens: 5 });
    }

    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}');
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 1000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(false);
    expect((res as any).error).toBe('daily_calls_exceeded');
    expect(fetchCount).toBe(0);
  });

  it('correctly handles messages protocol (Claude) sending ONLY x-api-key (no duplicate Authorization)', async () => {
    let capturedUrl = '';
    let capturedHeaders: any = {};
    let capturedBody: any = {};

    const mockFetch: typeof fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedHeaders = init.headers;
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"analysis":"ok"}' }],
          usage: { input_tokens: 120, output_tokens: 30 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const claudeCfg: PluginConfig = {
      ...baseCfg,
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.anthropic.com/v1',
        model: 'claude-3-5-sonnet',
        apiKey: 'sk-ant-test',
        apiKeyEnv: '',
        protocol: 'messages',
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.anthropic.com'],
      },
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 1000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      claudeCfg
    );

    expect(res.ok).toBe(true);
    expect((res as any).content).toBe('{"analysis":"ok"}');
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedHeaders['x-api-key']).toBe('sk-ant-test');
    expect(capturedHeaders['Authorization']).toBeUndefined();
    expect(capturedHeaders['anthropic-version']).toBe('2023-06-01');
    expect(capturedBody.system).toBe('Sys');
  });

  it('correctly handles responses protocol with json_object text format and response parsing', async () => {
    let capturedUrl = '';
    let capturedBody: any = {};

    const mockFetch: typeof fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          output_text: '{"result":"responses_ok"}',
          usage: { prompt_tokens: 80, completion_tokens: 25 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const respCfg: PluginConfig = {
      ...baseCfg,
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://www.dorodoro.xyz/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-doro-key',
        apiKeyEnv: '',
        protocol: 'responses',
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://www.dorodoro.xyz'],
      },
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 1000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      respCfg
    );

    expect(res.ok).toBe(true);
    expect((res as any).content).toBe('{"result":"responses_ok"}');
    expect(capturedUrl).toBe('https://www.dorodoro.xyz/v1/responses');
    expect(capturedBody.input).toBeDefined();
    expect(capturedBody.max_output_tokens).toBe(1000);
    expect(capturedBody.text).toEqual({ format: { type: 'json_object' } });
  });

  it('ignores reasoning blocks in responses output array and extracts only message output_text', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'reasoning',
              content: [{ type: 'reasoning_text', text: 'Internal chain of thought...' }],
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: '{"items":[]}' }],
            },
          ],
          usage: { input_tokens: 50, output_tokens: 80 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const respCfg: PluginConfig = {
      ...baseCfg,
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://www.dorodoro.xyz/v1',
        model: 'deepseek-v4.1-flash',
        apiKey: 'sk-doro-key',
        apiKeyEnv: '',
        protocol: 'responses',
      },
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://www.dorodoro.xyz'],
      },
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 1000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      respCfg
    );

    expect(res.ok).toBe(true);
    expect((res as any).content).toBe('{"items":[]}');
  });

  it('expands reserved_tokens when retrying after truncated missing_choice_content without CONTRACT_BREACH', async () => {
    let attempt = 0;
    const mockFetch: typeof fetch = async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(
          JSON.stringify({
            status: 'incomplete',
            output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'long thinking...' }] }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] }],
          usage: { input_tokens: 2500, output_tokens: 3200 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 2000,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(true);
    expect(attempt).toBe(2);

    const row = db.get<{ reserved_tokens: number; note: string | null }>(
      'SELECT reserved_tokens, note FROM llm_ledger WHERE id = ?',
      [(res as any).ledgerId]
    );
    expect(row?.reserved_tokens).toBeGreaterThanOrEqual(8192);
    expect(row?.note).toBeNull();
  });

  it('does not loop 3x on non-truncated missing_choice_content or provider error bodies, settling actual usage', async () => {
    let calls = 0;
    const mockFetchErrorBody: typeof fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: { message: 'Upstream gateway rejected request' },
          usage: { prompt_tokens: 42, completion_tokens: 0 },
        }),
        { status: 200 }
      );
    };

    const res1 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetchErrorBody,
      },
      baseCfg
    );
    expect(res1.ok).toBe(false);
    expect((res1 as any).error).toBe('provider_error_body');
    expect(calls).toBe(1);
    const row1 = db.get<{ status: string; in_tokens: number }>(
      'SELECT status, in_tokens FROM llm_ledger WHERE id = ?',
      [(res1 as any).ledgerId]
    );
    expect(row1).toEqual({ status: 'failed', in_tokens: 42 });

    // Empty content with finish_reason: 'stop' must NOT loop 3x
    calls = 0;
    const mockFetchEmptyStop: typeof fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: '' } }],
          usage: { prompt_tokens: 30, completion_tokens: 1 },
        }),
        { status: 200 }
      );
    };
    const res2 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetchEmptyStop,
      },
      baseCfg
    );
    expect(res2.ok).toBe(false);
    expect((res2 as any).error).toBe('missing_choice_content');
    expect(calls).toBe(1);
  });

  it('hardens resolveEndpointAndProtocol against credentials, query, hash, and path traversal', () => {
    expect(() => resolveEndpointAndProtocol('https://user:pass@api.deepseek.com/v1')).toThrow(
      'url_credentials_forbidden'
    );
    expect(() => resolveEndpointAndProtocol('https://api.deepseek.com/v1?x=/chat/completions')).toThrow(
      'url_query_or_hash_forbidden'
    );
    expect(() => resolveEndpointAndProtocol('https://api.deepseek.com/v1#frag')).toThrow(
      'url_query_or_hash_forbidden'
    );
    expect(() => resolveEndpointAndProtocol('file:///etc/passwd')).toThrow('unsupported_protocol');
    expect(resolveEndpointAndProtocol('https://api.deepseek.com/v1/sub/..').endpointUrl).toBe(
      'https://api.deepseek.com/v1/chat/completions'
    );
  });

  it('enforces assertSafeOutboundEndpoint SSRF guard on DNS resolution before fetch', async () => {
    let fetchCount = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCount++;
      return new Response('{}');
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
        lookupFn: async () => [{ address: '169.254.169.254' }],
      },
      baseCfg
    );

    expect(res.ok).toBe(false);
    expect((res as any).error).toContain('unsafe_endpoint');
    expect(fetchCount).toBe(0);
  });

  it('caps streaming response size at 2 MB and classifies JSON SyntaxError as non-retryable invalid_json_response', async () => {
    // 1. Oversized stream (> 2 MB) without Content-Length header
    let streamCalls = 0;
    const mockOversizedFetch: typeof fetch = async () => {
      streamCalls++;
      const chunk = new Uint8Array(600 * 1024).fill(65); // 600 KB
      const stream = new ReadableStream({
        start(controller) {
          for (let i = 0; i < 5; i++) controller.enqueue(chunk); // 3 MB total
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    };

    const resOversized = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockOversizedFetch,
      },
      baseCfg
    );
    expect(resOversized.ok).toBe(false);
    expect((resOversized as any).error).toBe('response_too_large');
    expect(streamCalls).toBe(1);

    // 2. Invalid JSON body -> non-retryable invalid_json_response (1 call, not 3)
    let jsonCalls = 0;
    const mockBadJsonFetch: typeof fetch = async () => {
      jsonCalls++;
      return new Response('not-valid-json{{{', { status: 200 });
    };

    const resBadJson = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockBadJsonFetch,
      },
      baseCfg
    );
    expect(resBadJson.ok).toBe(false);
    expect((resBadJson as any).error).toBe('invalid_json_response');
    expect(jsonCalls).toBe(1);
  });

  it('performs 1 capability-downgrade retry when HTTP 400 rejects response_format or temperature', async () => {
    const sentBodies: any[] = [];
    const mockFetch: typeof fetch = async (_url, init) => {
      const parsed = JSON.parse(String(init?.body || '{}'));
      sentBodies.push(parsed);
      if (sentBodies.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'Unsupported parameter: response_format' } }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items":[]}' } }],
          usage: { prompt_tokens: 40, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    };

    const res = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 500,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mockFetch,
      },
      baseCfg
    );

    expect(res.ok).toBe(true);
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].response_format).toEqual({ type: 'json_object' });
    expect(sentBodies[1].response_format).toBeUndefined();
    expect(sentBodies[1].temperature).toBeUndefined();
  });

  it('opens circuit breaker after 1 auth 401 failure or 3 consecutive 5xx failures and resets cleanly', async () => {
    let calls = 0;
    const mock401: typeof fetch = async () => {
      calls++;
      return new Response('Unauthorized', { status: 401 });
    };

    const r1 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 200,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mock401,
      },
      baseCfg
    );
    expect(r1.ok).toBe(false);
    expect((r1 as any).error).toBe('http_401');
    expect(calls).toBe(1);

    // Immediate next call is blocked by circuit breaker with 0 HTTP calls
    const r2 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 200,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mock401,
      },
      baseCfg
    );
    expect(r2.ok).toBe(false);
    expect((r2 as any).error).toBe('circuit_breaker_open');
    expect(calls).toBe(1);

    resetLlmCircuitBreaker();
    let fiveXxCalls = 0;
    const mock502: typeof fetch = async () => {
      fiveXxCalls++;
      return new Response('Bad Gateway', { status: 502 });
    };
    const r3 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 200,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mock502,
        jobDeadline: Date.now() + 2000,
      },
      baseCfg
    );
    expect(r3.ok).toBe(false);
    expect((r3 as any).error).toBe('http_502');
    expect((r3 as any).ledgerId).toBeGreaterThan(0);
    expect(fiveXxCalls).toBe(3);

    const r4 = await callOfflineLLM(
      db,
      {
        jobKind: 'distill',
        promptVersion: 'distill-v2',
        systemPrompt: 'Sys',
        userPrompt: 'Usr',
        maxOutputTokens: 200,
        cwd: '/ws/demo',
        workspaceId: 'ws1',
        fetchFn: mock502,
      },
      baseCfg
    );
    expect(r4.ok).toBe(false);
    expect((r4 as any).error).toBe('circuit_breaker_open');
    expect(fiveXxCalls).toBe(3);
  });

  it('classifies reasoning models accurately and builds OpenAI reasoning payloads properly', () => {
    expect(isReasoningModel('llama-v4-70b')).toBe(false);
    expect(isReasoningModel('deepseek-chat')).toBe(false);
    expect(isReasoningModel('o1-mini')).toBe(true);
    expect(isReasoningModel('o3')).toBe(true);
    expect(isReasoningModel('o4-mini')).toBe(true);
    expect(isReasoningModel('gpt-5')).toBe(true);
    expect(isReasoningModel('deepseek-r1')).toBe(true);
    expect(isReasoningModel('deepseek-reasoner')).toBe(true);
    expect(isReasoningModel('Qwen/QwQ-32B')).toBe(true);

    const o3Payload = JSON.parse(
      buildProtocolPayload('chat/completions', 'o3-mini', 'sys', 'usr', 1000).requestBody
    );
    expect(o3Payload.temperature).toBeUndefined();
    expect(o3Payload.max_tokens).toBeUndefined();
    expect(o3Payload.max_completion_tokens).toBe(1000);
  });

  it('never reads .credentials.yaml, normalizes baseURL across tiers, and avoids cross-provider model mismatch', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-llm-fallback-'));
    try {
      // Put secret ONLY in .credentials.yaml -> MUST be ignored!
      fs.writeFileSync(
        path.join(tmpHome, '.credentials.yaml'),
        'OPENAI_API_KEY: "sk-must-never-be-read-1234567890"\n'
      );
      fs.writeFileSync(
        path.join(tmpHome, 'cordis.patch.yml'),
        [
          '- id: agent-default-model',
          '  config:',
          '    provider: anthropic',
          '    model: claude-3-5-sonnet',
          '- id: llm-pi-ai',
          '  config:',
          '    providers:',
          '      anthropic:',
          '        baseURL: https://api.anthropic.com',
          '        apiKeyEnv: ANTHROPIC_API_KEY',
          '        api: anthropic-messages',
          '      openai:',
          '        baseURL: https://api.openai.com',
          '        apiKeyEnv: OPENAI_API_KEY',
          '        api: openai-completions',
        ].join('\n')
      );

      // Without .env or process.env, .credentials.yaml MUST NOT provide OPENAI_API_KEY
      expect(resolveDshHostLlmFallback('', { dshHome: tmpHome, env: {} })).toBeNull();

      // Now add OPENAI_API_KEY to .env with quoted inline comment; anthropic key still missing -> falls back to openai
      // Must NOT attach claude-3-5-sonnet to openai, and must normalize baseURL to /v1
      fs.writeFileSync(
        path.join(tmpHome, '.env'),
        'OPENAI_API_KEY="sk-openai-from-dotenv-123456" # trailing comment\n'
      );
      clearHostLlmFallbackCache();
      const fb = resolveDshHostLlmFallback('gpt-4o-mini', { dshHome: tmpHome, env: {} });
      expect(fb).not.toBeNull();
      expect(fb?.baseURL).toBe('https://api.openai.com/v1');
      expect(fb?.apiKey).toBe('sk-openai-from-dotenv-123456');
      expect(fb?.model).toBeUndefined();

      // Tier 1 normalization
      const t1 = resolveDshHostLlmFallback('', {
        dshHome: tmpHome,
        env: { OPENAI_BASE_URL: 'https://api.openai.com', OPENAI_API_KEY: 'sk-tier1' },
      });
      expect(t1?.baseURL).toBe('https://api.openai.com/v1');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('handles unquoteScalar, parseRetryAfterMs, and boundary-aware anonymizeWorkspacePaths cleanly', () => {
    expect(unquoteScalar('"abc # inside" # trailing')).toBe('abc # inside');
    expect(unquoteScalar("'sk-123' # comment")).toBe('sk-123');
    expect(unquoteScalar('plain_val # comment')).toBe('plain_val');

    expect(parseRetryAfterMs('3')).toBe(3000);
    const future = new Date(Date.now() + 5000).toUTCString();
    const delta = parseRetryAfterMs(future);
    expect(delta).not.toBeNull();
    expect(delta!).toBeGreaterThanOrEqual(2000);
    expect(delta!).toBeLessThanOrEqual(6000);

    // Path boundary awareness & short path skip & homedir anonymization
    expect(anonymizeWorkspacePaths('see /ws/app and /ws/app-other', '/ws/app', '/home/alice')).toBe(
      'see <workspace> and /ws/app-other'
    );
    expect(anonymizeWorkspacePaths('path /a/b stays intact', '/', '/home/alice')).toBe(
      'path /a/b stays intact'
    );
    expect(
      anonymizeWorkspacePaths('config at /home/alice/.bashrc', '/ws/proj', '/home/alice')
    ).toBe('config at <home>/.bashrc');
  });
});
