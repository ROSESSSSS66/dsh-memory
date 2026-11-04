import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { callOfflineLLM } from '../../src/evolution/llm.js';
import { reserve, settle } from '../../src/evolution/ledger.js';
import type { Db } from '../../src/types.js';

describe('Evolution LLM Client (M3-T1)', () => {
  let db: Db;
  let baseCfg: PluginConfig;

  beforeEach(() => {
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
    // 模拟已消耗 199,000 tokens
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

    // 输入约 500 字，maxOutput 1500 -> 预留需求 > 1500 + 200 = 1700，总消耗将超 200,000
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
          choices: [
            {
              message: {
                content: '{"items": []}',
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
          },
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

    // 检查发出的 HTTP 请求体
    expect(capturedBody).not.toContain(secretVal);
    expect(capturedBody).toContain('[REDACTED:SECRET]');
    expect(capturedBody).not.toContain(cwdVal);
    expect(capturedBody).toContain('<workspace>');

    // 检查账本表无敏感词
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

    // 确认账本中有两条独立的记录
    const rows = db.all<{ id: number; status: string; ok: number }>(
      'SELECT id, status, ok FROM llm_ledger ORDER BY id ASC'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('unknown'); // 第一次网络异常
    expect(rows[0].ok).toBe(0);
    expect(rows[1].status).toBe('succeeded'); // 第二次重试成功
    expect(rows[1].ok).toBe(1);
  });

  it('retains full quota as unknown when response is missing usage info (未知usage)', async () => {
    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"items": []}' } }],
          // 无 usage 字段
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
    // 模拟当日已完成 40 次调用
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
});
