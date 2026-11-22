import { describe, it, expect } from 'vitest';
import { estimateTokens, budgetTokens, utf8ByteLength } from '../../src/core/tokens.js';

describe('M1-T2: tokens.ts tests', () => {
  it('estimateTokens returns 0 for empty or whitespace string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(0);
  });

  it('estimateTokens calculates CJK and non-CJK mixed text according to formula', () => {
    const est = estimateTokens('项目 PostgreSQL');
    expect(est).toBe(6);
  });

  it('estimateTokens scales monotonically with content size', () => {
    const shortText = '短文本';
    const longText = '这是一个非常长非常长非常长的中文测试记忆正文，用于验证 token 估算值递增。';
    expect(estimateTokens(longText)).toBeGreaterThan(estimateTokens(shortText));
  });

  it('budgetTokens returns calibrated token upper bound (no 3.94x CJK UTF-8 penalty)', () => {
    expect(budgetTokens('')).toBe(0);
    expect(budgetTokens('abc')).toBeGreaterThanOrEqual(estimateTokens('abc'));
    expect(budgetTokens('中文')).toBe(Math.ceil(estimateTokens('中文') * 1.2));
    const zhSentence = '本项目后端服务统一运行在端口 8080，数据库采用 PostgreSQL 16 且禁用原生 C++ 依赖';
    expect(budgetTokens(zhSentence)).toBeLessThan(utf8ByteLength(zhSentence));
    expect(budgetTokens(zhSentence)).toBeGreaterThanOrEqual(estimateTokens(zhSentence));
  });

  it('utf8ByteLength returns exact UTF-8 byte length', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
  });
});
