/**
 * 快速码点区间判定（零正则分配），准确覆盖 CJK 表意文字、假名、韩文及全角标点
 */
function isCjkIdeograph(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x20000 && cp <= 0x2ebef) || // CJK Ext B-F
    (cp >= 0x30000 && cp <= 0x323af) || // CJK Ext G-H
    (cp >= 0xf900 && cp <= 0xfaff) // CJK Compatibility
  );
}

function isKanaOrHangulOrCjkPunct(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK Punctuation + Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xff00 && cp <= 0xffef) // Fullwidth forms
  );
}

function isWhitespace(cp: number): boolean {
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    cp === 0x0c ||
    cp === 0x0b ||
    cp === 0x3000
  );
}

function isAsciiPunctOrSymbol(cp: number): boolean {
  return (
    (cp >= 0x21 && cp <= 0x2f) ||
    (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) ||
    (cp >= 0x7b && cp <= 0x7e)
  );
}

/**
 * Token 估算：用于装箱排序、预算规划与统计（无正则热路径优化）
 * - CJK 汉字: ~0.75 tok/char（与 BPE 实测及既有估算兼容）
 * - 假名/韩文/全角标点: ~0.9 tok/char
 * - ASCII 标点/代码符号/换行: ~0.45 tok/char（防止密集 JSON/代码被严重低估）
 * - 普通 ASCII 词字符: ~1 / 3.2 tok/char
 */
export function estimateTokens(s: string): number {
  if (!s || s.length === 0) return 0;

  let cjk = 0;
  let kanaPunct = 0;
  let asciiWord = 0;
  let symbols = 0;
  let newlines = 0;

  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;

    if (cp === 0x0a) {
      newlines++;
      continue;
    }
    if (isWhitespace(cp)) continue;

    if (isCjkIdeograph(cp)) {
      cjk++;
    } else if (isKanaOrHangulOrCjkPunct(cp)) {
      kanaPunct++;
    } else if (isAsciiPunctOrSymbol(cp)) {
      symbols++;
    } else {
      asciiWord++;
    }
  }

  if (cjk === 0 && kanaPunct === 0 && asciiWord === 0 && symbols === 0) return 0;
  const raw = cjk * 0.75 + kanaPunct * 0.9 + asciiWord / 3.2 + symbols * 0.45 + newlines * 0.25;
  return Math.ceil(raw) + 1;
}

/**
 * 统一预算守门口径：基于校准估算的保守 token 上界（1.2x 安全余量，绝不按 UTF-8 3字节惩罚中文）
 * 与 estimateTokens 同量纲，彻底消除 stable/dynamic/hard 预算的 3.94x 中文缩水与单位错位。
 */
export function budgetTokens(s: string): number {
  if (!s || s.length === 0) return 0;
  const est = estimateTokens(s);
  if (est === 0) return 0;
  return Math.ceil(est * 1.2);
}

/**
 * 底层 UTF-8 字节长度（仅用于磁盘/HTTP 载荷大小守卫，不再用于 prompt token 预算）
 */
export function utf8ByteLength(s: string): number {
  if (!s) return 0;
  return Buffer.byteLength(s, 'utf8');
}
