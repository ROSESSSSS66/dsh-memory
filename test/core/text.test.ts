import { describe, it, expect } from 'vitest';
import {
  normalize,
  segment,
  ftsText,
  tokenSet,
  jaccard,
  contentHash,
  extractEntities,
  stemToken,
  isTokenMatch,
} from '../../src/core/text.js';

describe('M1-T2: text.ts required & additional tests', () => {
  // §5.1 必测用例 1
  it('§5.1 必测: segment("项目使用PostgreSQL数据库")', () => {
    const tokens = segment('项目使用PostgreSQL数据库');
    expect(tokens).toContain('项目');
    expect(tokens).toContain('使用');
    expect(tokens).toContain('postgresql');
    expect(tokens).toContain('数据');
    expect(tokens).toContain('据库');
    // 不得包含跨中英文边界的单词 token
    expect(tokens.some(t => /[\u4e00-\u9fa5]/.test(t) && /[a-zA-Z]/.test(t))).toBe(false);
  });

  // §5.1 必测用例 2
  it('§5.1 必测: segment("修改 src/dsh/pre-step.ts 里的 sessionListener")', () => {
    const tokens = segment('修改 src/dsh/pre-step.ts 里的 sessionListener');
    expect(tokens).toContain('src/dsh/pre-step.ts');
    expect(tokens).toContain('pre');
    expect(tokens).toContain('step');
    expect(tokens).toContain('session');
    expect(tokens).toContain('listener');
    expect(tokens).toContain('sessionlistener');
  });

  // §5.1 必测用例 3
  it('§5.1 必测: extractEntities("报错 ERR_MODULE_NOT_FOUND 在 @deepseek-ai/dsh-agent")', () => {
    const entities = extractEntities('报错 ERR_MODULE_NOT_FOUND 在 @deepseek-ai/dsh-agent');
    expect(entities).toContain('err_module_not_found');
    expect(entities).toContain('@deepseek-ai/dsh-agent');
  });

  // §5.1 必测用例 4
  it('§5.1 必测: jaccard(new Set(["a","b","c"]), new Set(["a","b","d"]))', () => {
    const res = jaccard(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'd']));
    expect(res).toBeCloseTo(0.5);
  });

  // §5.1 必测用例 5
  it('§5.1 必测: jaccard(tokenSet("a b c"), tokenSet("a b d"))', () => {
    // "a" 是停用词，丢弃后剩下 {"b", "c"} 和 {"b", "d"}
    // 交集为 {"b"} (大小 1)，并集为 {"b", "c", "d"} (大小 3)，Jaccard = 1/3
    const res = jaccard(tokenSet('a b c'), tokenSet('a b d'));
    expect(res).toBeCloseTo(1 / 3);
  });

  // 补充测试: normalize (至少3条)
  it('normalize handles NFKC, lowercase, whitespace folding, and empty input', () => {
    expect(normalize('  Ｈｅｌｌｏ   World！ \n ')).toBe('hello world!');
    expect(normalize('')).toBe('');
    expect(normalize('  A   B  C  ')).toBe('a b c');
  });

  // 补充测试: segment 英文停用词与驼峰拆分
  it('segment handles stopwords, acronyms, and paths', () => {
    const tokens = segment('The HTTPServer is in api/v1/auth_handler.go');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('is');
    expect(tokens).not.toContain('in');
    expect(tokens).toContain('httpserver');
    expect(tokens).toContain('http');
    expect(tokens).toContain('server');
    expect(tokens).toContain('api/v1/auth_handler.go');
    expect(tokens).toContain('auth');
    expect(tokens).toContain('handler');
  });

  // 补充测试: ftsText
  it('ftsText joins tokens with space', () => {
    expect(ftsText('')).toBe('');
    expect(ftsText('你好世界')).toBe('你好 好世 世界');
    expect(ftsText('PostgreSQL 16')).toBe('postgresql postgre sql 16');
  });

  // 补充测试: contentHash (至少3条)
  it('contentHash generates deterministic 32-hex hash preserving casing in content', () => {
    const h1 = contentHash('semantic', 'Hello World');
    const h2 = contentHash('semantic', 'Hello World');
    const h3 = contentHash('semantic', 'hello world');
    const h4 = contentHash('episodic', 'Hello World');

    expect(h1).toHaveLength(32);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3); // 大小写敏感
    expect(h1).not.toBe(h4); // type 不同
  });

  // 补充测试: extractEntities (路径、反引号代码、错误码、域名)
  it('extractEntities extracts file paths, backtick code, constants, and hostnames', () => {
    const text = '检查 `npm run build` 和 E1002 错误，访问 https://api.dorodoro.xyz/v1/test 以及 /etc/nginx/nginx.conf';
    const entities = extractEntities(text);
    expect(entities).toContain('npm run build');
    expect(entities).toContain('e1002');
    expect(entities).toContain('api.dorodoro.xyz');
    expect(entities).toContain('/etc/nginx/nginx.conf');
  });

  it('extractEntities limits to maxEntities and normalizes backslashes', () => {
    const text = 'C:\\workspace\\project\\config.json and D:\\data\\file.ts';
    const entities = extractEntities(text, 1);
    expect(entities).toHaveLength(1);
    expect(entities[0]).toContain('/');
    expect(entities[0]).not.toContain('\\');
  });

  it('v0.5.0: stemToken and isTokenMatch handle morphological variants and POSIX error entities', () => {
    expect(stemToken('commits')).toBe('commit');
    expect(stemToken('dependencies')).toBe('dependency');
    const docTokens = tokenSet('Git 提交强制使用 commitlint 校验 Conventional Commits 规范');
    expect(isTokenMatch('commit', docTokens)).toBe(true);
    const posixEntities = extractEntities('接口报错 ECONNREFUSED 与 EADDRINUSE 和 ETIMEDOUT');
    expect(posixEntities).toContain('econnrefused');
    expect(posixEntities).toContain('eaddrinuse');
    expect(posixEntities).toContain('etimedout');
  });
});
