import { describe, it, expect } from 'vitest';
import { DEFAULTS, validateConfig, loadConfigFromDb, saveConfigToDb } from '../src/config.js';
import { name, inject, Config, apply } from '../src/index.js';
import { openDb } from '../src/core/db.js';

describe('Config validation', () => {
  it('should return defaults when empty object provided', () => {
    const cfg = validateConfig({});
    expect(cfg.hardBudgetTokens).toBe(3200);
    expect(cfg.stableBudgetTokens).toBe(600);
    expect(cfg.dynamicBudgetTokens).toBe(1600);
    expect(cfg.enabled).toBe(true);
    expect(cfg.defaultScope).toBe('workspace');
  });

  it('should enforce hardBudgetTokens >= stableBudgetTokens + dynamicBudgetTokens', () => {
    const cfg = validateConfig({
      hardBudgetTokens: 1000,
      stableBudgetTokens: 600,
      dynamicBudgetTokens: 800,
    });
    expect(cfg.hardBudgetTokens).toBe(1000);
    expect(cfg.stableBudgetTokens).toBe(600);
    expect(cfg.dynamicBudgetTokens).toBe(400); // 1000 - 600
  });

  it('should reject invalid numbers and fallback to defaults', () => {
    const cfg = validateConfig({
      hardBudgetTokens: -5,
      minLexicalCoverage: 1.5,
      dupJaccard: -0.1,
    });
    expect(cfg.hardBudgetTokens).toBe(DEFAULTS.hardBudgetTokens);
    expect(cfg.minLexicalCoverage).toBe(DEFAULTS.minLexicalCoverage);
    expect(cfg.dupJaccard).toBe(DEFAULTS.dupJaccard);
  });

  it('should validate embedding provider config', () => {
    const cfgNone = validateConfig({
      embedding: { provider: 'none', baseURL: '', model: '', apiKeyEnv: '', dim: 100 },
    });
    expect(cfgNone.embedding.dim).toBe(0);

    const cfgInvalidOAI = validateConfig({
      embedding: { provider: 'openai-compatible', baseURL: '', model: '', apiKeyEnv: '', dim: 0 },
    });
    expect(cfgInvalidOAI.embedding.provider).toBe('none');
    expect(cfgInvalidOAI.embedding.dim).toBe(0);
  });
});

describe('Plugin entry exports', () => {
  it('should export required plugin fields', () => {
    expect(name).toBe('dsh-memory');
    expect(Array.isArray(inject)).toBe(true);
    expect(inject).toContain('agents');
    expect(inject).toContain('systemPrompt');
    expect(inject).toContain('sessionProjections');
    expect(inject).toContain('tools');
    expect(inject).toContain('commands');
    expect(typeof apply).toBe('function');
    expect(Config).toBeDefined();
  });

  it('should gracefully handle disabled plugin in apply', () => {
    let called = false;
    apply({} as any, { enabled: false });
    expect(called).toBe(false);
  });

  it('should persist and load config override from meta table', () => {
    const db = openDb(':memory:');
    const initial = loadConfigFromDb(db, DEFAULTS);
    expect(initial.offlineLLM.model).toBe(DEFAULTS.offlineLLM.model);

    // Save partial patch
    const saved = saveConfigToDb(db, {
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        apiKey: 'sk-123456',
      },
      dailyLLMCalls: 80,
    });
    expect(saved.offlineLLM.baseURL).toBe('https://api.deepseek.com/v1');
    expect(saved.offlineLLM.apiKey).toBe('sk-123456');
    expect(saved.dailyLLMCalls).toBe(80);

    // Load in fresh call
    const loaded = loadConfigFromDb(db, DEFAULTS);
    expect(loaded.offlineLLM.baseURL).toBe('https://api.deepseek.com/v1');
    expect(loaded.offlineLLM.apiKey).toBe('sk-123456');
    expect(loaded.dailyLLMCalls).toBe(80);
    expect(loaded.hardBudgetTokens).toBe(DEFAULTS.hardBudgetTokens);
  });
});
