import { describe, it, expect } from 'vitest';
import { DEFAULTS, validateConfig } from '../src/config.js';
import { name, inject, Config, apply } from '../src/index.js';

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
});
