import crypto from 'node:crypto';
import { DEFAULTS } from '../config.js';

export const CJK_CHAR_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const CJK_SEGMENT_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export const STOPWORDS = new Set([
  // 中文停用词
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '这', '那', '就', '也', '都', '和', '与', '或', '但', '吗', '呢', '吧', '啊',
  // 英文停用词
  'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'with', 'this', 'that', 'it', 'be'
]);

/**
 * 1) s.normalize('NFKC')
 * 2) 转小写
 * 3) 连续空白折叠成一个空格
 * 4) 去掉首尾空白
 */
export function normalize(s: string): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 先 NFKC + 折叠空白，保留大小写扫描；每个最终 token 才转小写。
 * 不得先调用会丢失驼峰边界的 normalize。输出保持原始顺序，不去重
 */
export function segment(s: string): string[] {
  if (!s) return [];
  const text = s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const tokens: string[] = [];

  function addToken(tok: string) {
    let t = tok.toLowerCase();
    if (t.length > 64) {
      t = t.slice(0, 64);
    }
    if (t.length > 0 && !STOPWORDS.has(t)) {
      tokens.push(t);
    }
  }

  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    // 空白跳过
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // A. 中日韩字符段
    if (CJK_CHAR_REGEX.test(char)) {
      let cjkEnd = i;
      while (cjkEnd < len && CJK_CHAR_REGEX.test(text[cjkEnd])) {
        cjkEnd++;
      }
      const cjkPart = text.slice(i, cjkEnd);
      if (cjkPart.length === 1) {
        addToken(cjkPart);
      } else {
        // 重叠二元组 (bigram)
        for (let j = 0; j < cjkPart.length - 1; j++) {
          addToken(cjkPart.slice(j, j + 2));
        }
      }
      i = cjkEnd;
      continue;
    }

    // B. 非 CJK 单词段：按 Unicode code point 扫描 L/N/_ 与 . - / @ :
    // 遇到 A 中的字符必须结束当前段，不能让 \p{L} 吞掉相邻中文
    const nonCjkWordRegex = /[\p{L}\p{N}_.\-/@:]/u;
    if (nonCjkWordRegex.test(char)) {
      let wordEnd = i;
      while (wordEnd < len) {
        const nextChar = text[wordEnd];
        if (CJK_CHAR_REGEX.test(nextChar)) break; // 遇到中文立刻结束
        if (!nonCjkWordRegex.test(nextChar)) break; // 遇到空格或其他标点结束
        wordEnd++;
      }

      let rawSegment = text.slice(i, wordEnd);
      i = wordEnd;

      // 1) 去掉末尾的 . - / : 字符后，输出整段的小写形式（例如 "src/dsh/pre-step.ts"）
      const trimmedSegment = rawSegment.replace(/[.\-/:/]+$/, '');
      if (trimmedSegment.length > 0) {
        addToken(trimmedSegment);

        // 2) 如果整段包含 / . - _ @ : 中的任意字符，再按这些字符拆开，输出每个长度 >= 2 的部分
        if (/[/.\-_@:]/.test(trimmedSegment)) {
          const parts = trimmedSegment.split(/[/.\-_@:]+/).filter(p => p.length >= 2);
          for (const part of parts) {
            if (part.toLowerCase() !== trimmedSegment.toLowerCase()) {
              addToken(part);
            }

            // 3) 每个部分在保留大小写的原文上拆驼峰/缩写：
            // 先 /([A-Z]+)([A-Z][a-z])/g，再 /([a-z0-9])([A-Z])/g 插空格
            const splitCamel = part
              .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
              .replace(/([a-z0-9])([A-Z])/g, '$1 $2');

            const subwords = splitCamel.split(/\s+/).filter(w => w.length >= 2);
            for (const sw of subwords) {
              if (sw.toLowerCase() !== part.toLowerCase() && sw.toLowerCase() !== trimmedSegment.toLowerCase()) {
                addToken(sw);
              }
            }
          }
        } else {
          // 单一单词段拆驼峰
          const splitCamel = trimmedSegment
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
          const subwords = splitCamel.split(/\s+/).filter(w => w.length >= 2);
          for (const sw of subwords) {
            if (sw.toLowerCase() !== trimmedSegment.toLowerCase()) {
              addToken(sw);
            }
          }
        }
      }
      continue;
    }

    // C. 其他字符：丢弃
    i++;
  }

  return tokens;
}

export function ftsText(s: string): string {
  return segment(s).join(' ');
}

export function tokenSet(s: string): Set<string> {
  return new Set(segment(s));
}

/**
 * 轻量级英文词形还原 (Morphological Stemmer)
 * 将复数/常见词尾还原为词根（如 commits -> commit, dependencies -> dependency, configs -> config）
 */
export function stemToken(token: string): string {
  const t = token.toLowerCase().trim();
  if (t.length < 4 || !/^[a-z]+$/.test(t)) return t;
  if (t.endsWith('ies') && t.length >= 5) {
    return `${t.slice(0, -3)}y`;
  }
  if (t.endsWith('es') && t.length >= 5 && /(?:s|x|z|ch|sh)es$/.test(t)) {
    return t.slice(0, -2);
  }
  if (t.endsWith('s') && !/(?:ss|us|is|os)$/.test(t)) {
    return t.slice(0, -1);
  }
  return t;
}

/**
 * 词元形态与复合词感知匹配 (Morphology & Compound Subword Match)
 * 支持精确命中、英文单复数词干对齐（如 commit <-> commits）及复合开发标识符前后缀对齐（如 commit <-> commitlint）
 */
export function isTokenMatch(queryToken: string, docTokens: Set<string>): boolean {
  const qt = queryToken.toLowerCase().trim();
  if (!qt) return false;
  if (docTokens.has(qt)) return true;

  if (qt.length >= 3 && /^[a-z0-9]+$/.test(qt)) {
    const qStem = stemToken(qt);
    if (docTokens.has(qStem)) return true;

    for (const dt of docTokens) {
      if (!/^[a-z0-9]+$/.test(dt)) continue;
      if (stemToken(dt) === qStem) return true;
      if (qt.length >= 4 && dt.length >= qt.length + 2 && (dt.startsWith(qt) || dt.endsWith(qt))) {
        return true;
      }
      if (dt.length >= 4 && qt.length >= dt.length + 2 && (qt.startsWith(dt) || qt.endsWith(dt))) {
        return true;
      }
    }
  }

  return false;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function contentHash(type: string, content: string): string {
  // sha256(type + '|' + NFKC/折叠空白/trim 后的 content)，保留大小写；前 32 位十六进制
  const normalizedContent = (content || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`${type}|${normalizedContent}`)
    .digest('hex')
    .slice(0, 32);
}

export function extractEntities(s: string, maxEntities: number = DEFAULTS.maxEntitiesPerText): string[] {
  if (!s) return [];
  const rawMatches: string[] = [];

  // 1. 文件路径
  const pathRegex1 = /(?:[a-zA-Z]:)?[\w.\-]*[\/\\][\w.\-\/\\]+\.\w{1,8}/g;
  const pathRegex2 = /\b[\w\-]+\.(ts|tsx|js|mjs|cjs|py|json|ya?ml|toml|md|sql|rs|go|java|cs|cpp|h)\b/g;
  let m: RegExpExecArray | null;

  while ((m = pathRegex1.exec(s)) !== null) rawMatches.push(m[0]);
  while ((m = pathRegex2.exec(s)) !== null) rawMatches.push(m[0]);

  // 2. 包名：/@[\w\-]+\/[\w\-.]+/g
  const pkgRegex = /@[\w\-]+\/[\w\-.]+/g;
  while ((m = pkgRegex.exec(s)) !== null) rawMatches.push(m[0]);

  // 3. 反引号包裹的代码：/`([^`\n]{2,60})`/g（取第 1 个分组）
  const codeRegex = /`([^`\n]{2,60})`/g;
  while ((m = codeRegex.exec(s)) !== null) rawMatches.push(m[1]);

  // 4. 错误码/常量：/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g 以及 /\b(?:(?:E|ERR|TS)\d{3,5}|E[A-Z]{5,15})\b/g
  const constRegex1 = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g;
  const constRegex2 = /\b(?:(?:E|ERR|TS)\d{3,5}|E[A-Z]{5,15})\b/g;
  while ((m = constRegex1.exec(s)) !== null) rawMatches.push(m[0]);
  while ((m = constRegex2.exec(s)) !== null) rawMatches.push(m[0]);

  // 5. 驼峰/帕斯卡标识符
  const camelRegex1 = /\b[a-z]+[A-Z][A-Za-z0-9]+\b/g;
  const camelRegex2 = /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]+\b/g;
  while ((m = camelRegex1.exec(s)) !== null) rawMatches.push(m[0]);
  while ((m = camelRegex2.exec(s)) !== null) rawMatches.push(m[0]);

  // 6. 主机名
  const hostRegex = /\b(?:[a-z0-9\-]+\.)+(?:com|cn|io|ai|dev|org|net|xyz)\b/gi;
  while ((m = hostRegex.exec(s)) !== null) rawMatches.push(m[0]);

  // 规范化（转小写、反斜杠替换成 /）后去重
  const resultSet = new Set<string>();
  for (const raw of rawMatches) {
    const norm = raw.toLowerCase().replace(/\\/g, '/');
    if (norm.length > 0) {
      resultSet.add(norm);
      if (resultSet.size >= maxEntities) break;
    }
  }

  return Array.from(resultSet);
}
