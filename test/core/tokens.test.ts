import { describe, it, expect } from 'vitest';
import { estimateTokens, budgetTokens } from '../../src/core/tokens.js';

describe('M1-T2: tokens.ts tests', () => {
  it('estimateTokens returns 0 for empty or whitespace string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });

  it('estimateTokens calculates CJK and non-CJK mixed text according to formula', () => {
    // "项目" (2 CJK), "PostgreSQL" (10 rest)
    // cjk = 2, rest = 10
    // Math.ceil(2 * 0.75 + 10 / 3.2) + 1 = Math.ceil(1.5 + 3.125) + 1 = Math.ceil(4.625) + 1 = 5 + 1 = 6
    const est = estimateTokens('项目 PostgreSQL');
    expect(est).toBe(6);
  });

  it('estimateTokens scales monotonically with content size', () => {
    const shortText = '短文本';
    const longText = '这是一个非常长非常长非常长的中文测试记忆正文，用于验证 token 估算值递增。';
    expect(estimateTokens(longText)).toBeGreaterThan(estimateTokens(shortText));
  });

  it('budgetTokens returns exact UTF-8 byte length', () => {
    expect(budgetTokens('')).toBe(0);
    expect(budgetTokens('abc')).toBe(3);
    expect(budgetTokens('中文')).toBe(6); // 2 * 3 bytes
  });
});
