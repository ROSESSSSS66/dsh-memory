import { CJK_CHAR_REGEX } from './text.js';

/**
 * Token 估算：用于装箱排序和统计用的近似值
 * cjk  = 中日韩字符数
 * rest = 去掉 cjk 字符和空白后剩下的字符数
 * return Math.ceil(cjk * 0.75 + rest / 3.2) + 1
 */
export function estimateTokens(s: string): number {
  if (!s || s.length === 0) return 0;
  let cjk = 0;
  let rest = 0;

  for (const ch of s) {
    if (/\s/.test(ch)) continue;
    if (CJK_CHAR_REGEX.test(ch)) {
      cjk++;
    } else {
      rest++;
    }
  }

  if (cjk === 0 && rest === 0) return 0;
  return Math.ceil(cjk * 0.75 + rest / 3.2) + 1;
}

/**
 * 硬预算验证：已验证的 UTF-8 字节上界，用于硬预算守门
 */
export function budgetTokens(s: string): number {
  if (!s) return 0;
  return Buffer.byteLength(s, 'utf8');
}
