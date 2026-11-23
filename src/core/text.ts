import crypto from 'node:crypto';
import { DEFAULTS } from '../config.js';

export const CJK_CHAR_REGEX =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const CJK_SEGMENT_REGEX =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const NON_CJK_WORD_CHAR_REGEX = /[\p{L}\p{N}_.\-/@:]/u;
const HAS_ALNUM_REGEX = /[\p{L}\p{N}]/u;

export const STOPWORDS = new Set([
  // 中文停用词
  '的',
  '了',
  '是',
  '在',
  '我',
  '你',
  '他',
  '她',
  '它',
  '这',
  '那',
  '就',
  '也',
  '都',
  '和',
  '与',
  '或',
  '但',
  '吗',
  '呢',
  '吧',
  '啊',
  // 英文停用词（扩展覆盖常见自然问句功能词、代词与助动词）
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'am',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'for',
  'and',
  'or',
  'but',
  'with',
  'from',
  'by',
  'at',
  'as',
  'into',
  'about',
  'over',
  'after',
  'before',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'i',
  'me',
  'my',
  'we',
  'us',
  'our',
  'you',
  'your',
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'their',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
  'do',
  'does',
  'did',
  'done',
  'have',
  'has',
  'had',
  'having',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'where',
  'when',
  'why',
  'how',
  'please',
  'help',
  'tell',
  'remember',
  'know',
  'need',
  'want',
  'just',
  'very',
  'really',
  'also',
  'then',
  'than',
  'so',
  'if',
  'not',
  'no',
  'yes',
  'any',
  'some',
  'all',
  'each',
  'more',
  'most',
  'such',
  'only',
  'own',
  'same',
  'too',
  'there',
  'here',
]);

/**
 * 1) s.normalize('NFKC')
 * 2) 转小写
 * 3) 连续空白折叠成一个空格
 * 4) 去掉首尾空白
 */
export function normalize(s: string): string {
  if (!s) return '';
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const SEP_SPLIT_REGEX = /[/.\-_@:]+/;
const HAS_SEP_REGEX = /[/.\-_@:]/;
const HAS_UPPER_REGEX = /[A-Z]/;

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 46 || // .
    code === 45 || // -
    code === 47 || // /
    code === 64 || // @
    code === 58 // :
  );
}

function isFastBmpCjk(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x3041 && code <= 0x3096) ||
    (code >= 0x30a1 && code <= 0x30fa) ||
    (code >= 0xac00 && code <= 0xd7af)
  );
}

/**
 * 先 NFKC + 折叠空白，保留大小写按 Unicode code point 扫描（完整支持 CJK Ext B–G 代理对）；
 * 对 BMP 常见 ASCII / CJK 走无正则整数码位快路径，每个最终 token 才转小写。输出保持原始顺序，不去重。
 */
export function segment(s: string): string[] {
  if (!s) return [];
  const text = s.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) return [];

  const len = text.length;
  const tokens: string[] = [];

  function addToken(tok: string, knownAlnum: boolean = false) {
    let t = tok.toLowerCase();
    if (t.length > 64) {
      t = t.slice(0, 64);
    }
    if (t.length > 0 && (knownAlnum || HAS_ALNUM_REGEX.test(t)) && !STOPWORDS.has(t)) {
      tokens.push(t);
    }
  }

  function classifyCodeUnit(idx: number): { kind: 0 | 1 | 2 | 3; step: number } {
    const code = text.charCodeAt(idx);
    if (code === 32) return { kind: 0, step: 1 }; // whitespace (already collapsed to ' ')
    if (code < 0x80) {
      return { kind: isAsciiWordChar(code) ? 2 : 3, step: 1 };
    }
    if (isFastBmpCjk(code)) {
      return { kind: 1, step: 1 };
    }
    // High surrogate pair (e.g. CJK Ext B-G)
    const isSurrogate = code >= 0xd800 && code <= 0xdbff && idx + 1 < len;
    const step = isSurrogate ? 2 : 1;
    const ch = isSurrogate ? text.slice(idx, idx + 2) : text[idx];
    if (CJK_CHAR_REGEX.test(ch)) return { kind: 1, step };
    if (NON_CJK_WORD_CHAR_REGEX.test(ch)) return { kind: 2, step };
    return { kind: 3, step };
  }

  let i = 0;
  while (i < len) {
    const first = classifyCodeUnit(i);
    if (first.kind === 0 || first.kind === 3) {
      i += first.step;
      continue;
    }

    // A. 中日韩字符段（快速 BMP 路径零数组分配；含代理对时自动切换 code-point 切片）
    if (first.kind === 1) {
      const start = i;
      let hasSurrogate = first.step === 2;
      i += first.step;
      while (i < len) {
        const c = text.charCodeAt(i);
        if (isFastBmpCjk(c)) {
          i++;
          continue;
        }
        if (c < 0x80) break;
        const next = classifyCodeUnit(i);
        if (next.kind !== 1) break;
        if (next.step === 2) hasSurrogate = true;
        i += next.step;
      }

      if (!hasSurrogate) {
        const cjkLen = i - start;
        if (cjkLen === 1) {
          addToken(text[start], true);
        } else {
          for (let j = start; j < i - 1; j++) {
            addToken(text.slice(j, j + 2), true);
          }
        }
      } else {
        const cpChars = Array.from(text.slice(start, i));
        if (cpChars.length === 1) {
          addToken(cpChars[0], true);
        } else {
          for (let j = 0; j < cpChars.length - 1; j++) {
            addToken(cpChars[j] + cpChars[j + 1], true);
          }
        }
      }
      continue;
    }

    // B. 非 CJK 单词段
    const wordStart = i;
    i += first.step;
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c < 0x80) {
        if (!isAsciiWordChar(c)) break;
        i++;
        continue;
      }
      if (isFastBmpCjk(c)) break;
      const next = classifyCodeUnit(i);
      if (next.kind !== 2) break;
      i += next.step;
    }

    const rawSegment = text.slice(wordStart, i);
    // 去掉末尾的 . - / : 以及首尾孤立标点（保留 @package 前缀与 /abs/path 前缀）
    const trimmedSegment = rawSegment.replace(/[.\-/:]+$/, '');
    if (trimmedSegment.length > 0 && HAS_ALNUM_REGEX.test(trimmedSegment)) {
      const lowerTrimmed = trimmedSegment.toLowerCase();
      addToken(trimmedSegment, true);

      if (HAS_SEP_REGEX.test(trimmedSegment)) {
        const parts = trimmedSegment.split(SEP_SPLIT_REGEX);
        for (let pIdx = 0; pIdx < parts.length; pIdx++) {
          const part = parts[pIdx];
          if (part.length < 2) continue;
          const lowerPart = part.toLowerCase();
          if (lowerPart !== lowerTrimmed) {
            addToken(part);
          }
          if (HAS_UPPER_REGEX.test(part)) {
            const splitCamel = part
              .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
              .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
            const subwords = splitCamel.split(' ');
            for (let sIdx = 0; sIdx < subwords.length; sIdx++) {
              const sw = subwords[sIdx];
              if (sw.length < 2) continue;
              const lowerSw = sw.toLowerCase();
              if (lowerSw !== lowerPart && lowerSw !== lowerTrimmed) {
                addToken(sw);
              }
            }
          }
        }
      } else if (HAS_UPPER_REGEX.test(trimmedSegment)) {
        const splitCamel = trimmedSegment
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2');
        const subwords = splitCamel.split(' ');
        for (let sIdx = 0; sIdx < subwords.length; sIdx++) {
          const sw = subwords[sIdx];
          if (sw.length < 2) continue;
          if (sw.toLowerCase() !== lowerTrimmed) {
            addToken(sw);
          }
        }
      }
    }
  }

  return tokens;
}

/**
 * 供 SQLite FTS5 unicode61 索引的预切分串：
 * 对含路径/标点分隔符的整段（如 src/dsh/pre-step.ts），因 unicode61 会再次拆出子段，
 * 若已存在其拆分后的子词元则仅保留一份，避免路径/标识符在 BM25 中产生 2-3x TF 虚高。
 */
export function ftsText(s: string): string {
  const segs = segment(s);
  if (segs.length === 0) return '';
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    const tok = segs[i];
    if (/[/.\-_@:]/.test(tok)) {
      // 保留拆分后的独立子词元（紧随其后产生），跳过会被 unicode61 二次分裂重复计频的整串
      const parts = tok.split(/[/.\-_@:]+/).filter((p) => p.length >= 2 && HAS_ALNUM_REGEX.test(p));
      if (parts.length >= 2) {
        continue;
      }
    }
    out.push(tok);
  }
  return out.join(' ');
}

export function tokenSet(s: string): Set<string> {
  return new Set(segment(s));
}

/**
 * 轻量级英文词形还原 (Morphological Stemmer)
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
  if (t.endsWith('s') && !/(?:ss|us|is|os|ys)$/.test(t)) {
    return t.slice(0, -1);
  }
  return t;
}

/**
 * 预计算词干集合，避免在 isTokenMatch 中 O(|Q|×|D|) 重复调用 stemToken
 */
export function buildStemmedTokenSet(docTokens: Set<string>): Set<string> {
  const stemmed = new Set<string>();
  for (const dt of docTokens) {
    if (dt.length >= 3 && /^[a-z0-9]+$/.test(dt)) {
      stemmed.add(stemToken(dt));
    }
  }
  return stemmed;
}

/**
 * 词元形态与复合词感知匹配 (Morphology & Compound Subword Match)
 * 收紧子词匹配规则：禁止 4 字任意 endsWith 误配（如 port <-> export/report/support），
 * 仅允许 >= 5 字前缀复合词对齐（如 commit <-> commitlint）。
 */
export function isTokenMatch(
  queryToken: string,
  docTokens: Set<string>,
  precomputedStems?: Set<string>
): boolean {
  const qt = queryToken.toLowerCase().trim();
  if (!qt) return false;
  if (docTokens.has(qt)) return true;

  if (qt.length >= 3 && /^[a-z0-9]+$/.test(qt)) {
    const qStem = stemToken(qt);
    if (docTokens.has(qStem)) return true;
    if (precomputedStems && precomputedStems.has(qStem)) return true;

    for (const dt of docTokens) {
      if (dt.length < 3 || !/^[a-z0-9]+$/.test(dt)) continue;
      if (!precomputedStems && stemToken(dt) === qStem) return true;
      if (qt.length >= 5 && dt.length >= qt.length + 2 && dt.startsWith(qt)) {
        return true;
      }
      if (dt.length >= 5 && qt.length >= dt.length + 2 && qt.startsWith(dt)) {
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
  const normalizedContent = (content || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return crypto
    .createHash('sha256')
    .update(`${type}|${normalizedContent}`)
    .digest('hex')
    .slice(0, 32);
}

const GENERIC_E_WORDS = new Set([
  'example',
  'examples',
  'enable',
  'enabled',
  'enabling',
  'engine',
  'export',
  'exports',
  'execute',
  'executed',
  'express',
  'extract',
  'expected',
  'explore',
  'extends',
  'external',
  'element',
  'elements',
  'endpoint',
  'endpoints',
  'encoding',
  'encrypt',
  'entries',
  'environment',
]);

export function extractEntities(
  s: string,
  maxEntities: number = DEFAULTS.maxEntitiesPerText
): string[] {
  if (!s || maxEntities <= 0) return [];

  // 分类抽取并按配额均衡收集，防止大量文件路径挤爆错误码/主机名/标识符配额
  const buckets: string[][] = [[], [], [], [], [], []];
  let m: RegExpExecArray | null;

  // 剥离 URL scheme 前缀副本避免 pathRegex1 把 https://a.com/x/y.html 误抽成 //a.com/x/y.html
  const sNoUrls = s.replace(/\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s'"<>()]+/gi, ' ');

  // 1. 文件路径（非回溯分段写法）
  const pathRegex1 = /(?:[a-zA-Z]:)?(?:[\w.-]+)?(?:[/\\][\w.-]+)+\.\w{1,8}\b/g;
  const pathRegex2 =
    /\b[\w-]+\.(ts|tsx|js|mjs|cjs|py|json|ya?ml|toml|md|sql|rs|go|java|cs|cpp|h)\b/g;
  while ((m = pathRegex1.exec(sNoUrls)) !== null) buckets[0].push(m[0]);
  while ((m = pathRegex2.exec(sNoUrls)) !== null) buckets[0].push(m[0]);

  // 2. 包名
  const pkgRegex = /@[\w-]+\/[\w\-.]+/g;
  while ((m = pkgRegex.exec(s)) !== null) buckets[1].push(m[0]);

  // 3. 反引号包裹的命令或标识符
  const codeRegex = /`([^`\n]{2,60})`/g;
  while ((m = codeRegex.exec(s)) !== null) {
    const inner = m[1].trim();
    // 排除明显自然语言长句（空格过多）
    if (inner && inner.split(/\s+/).length <= 5) {
      buckets[2].push(inner);
    }
  }

  // 4. 错误码/常量
  const constRegex1 = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g;
  const constRegex2 = /\b(?:(?:E|ERR|TS)\d{3,5}|E[A-Z]{5,15})\b/g;
  while ((m = constRegex1.exec(s)) !== null) buckets[3].push(m[0]);
  while ((m = constRegex2.exec(s)) !== null) {
    if (!GENERIC_E_WORDS.has(m[0].toLowerCase())) {
      buckets[3].push(m[0]);
    }
  }

  // 5. 驼峰/帕斯卡标识符
  const camelRegex1 = /\b[a-z]+[A-Z][A-Za-z0-9]+\b/g;
  const camelRegex2 = /\b[A-Z][a-z]+[A-Z][A-Za-z0-9]+\b/g;
  while ((m = camelRegex1.exec(s)) !== null) buckets[4].push(m[0]);
  while ((m = camelRegex2.exec(s)) !== null) buckets[4].push(m[0]);

  // 6. 主机名（扩展 .corp / .internal / .local / .app / .cloud / 常见 ccTLD）
  const hostRegex =
    /\b(?:[a-z0-9-]+\.)+(?:com|cn|io|ai|dev|org|net|xyz|app|cloud|corp|internal|local|lan|sh|gg|co|uk|jp|de|fr)\b/gi;
  while ((m = hostRegex.exec(s)) !== null) buckets[5].push(m[0]);

  // 轮询配额（首轮每类最多取 6 个，余量按序补满至 maxEntities）
  const resultSet = new Set<string>();
  const perBucketQuota = Math.max(2, Math.ceil(maxEntities / 3));
  const overflow: string[] = [];

  for (const bucket of buckets) {
    let taken = 0;
    for (const raw of bucket) {
      const norm = raw.toLowerCase().replace(/\\/g, '/').trim();
      if (!norm) continue;
      if (taken < perBucketQuota && resultSet.size < maxEntities) {
        if (!resultSet.has(norm)) {
          resultSet.add(norm);
          taken++;
        }
      } else {
        overflow.push(norm);
      }
    }
  }

  for (const norm of overflow) {
    if (resultSet.size >= maxEntities) break;
    resultSet.add(norm);
  }

  return Array.from(resultSet);
}
