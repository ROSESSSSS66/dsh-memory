import { describe, it, expect } from 'vitest';
import { runCase, runEvalSuite } from '../../src/eval/runner.js';
import type { EvalCase } from '../../src/eval/types.js';

describe('Evaluation Runner (§8.1)', () => {
  it('should pass factual retrieval test with distractors', () => {
    const testCase: EvalCase = {
      id: 'fact-001',
      suite: 'factual',
      critical: true,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/demo',
      setup: [
        {
          type: 'semantic',
          content: '本项目核心主数据库使用的是 PostgreSQL 16 关系型数据库。',
          slot_key: 'project.database',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
        },
        {
          type: 'semantic',
          content: '前端构建产物默认输出到 dist/ 目录。',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
        },
        {
          type: 'semantic',
          content: '团队前端规范强制使用 ESLint 9 与 Prettier 格式化。',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
        },
      ],
      query: '请问项目主数据库使用的是什么？',
      expect: {
        include: ['PostgreSQL'],
        exclude: [],
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
    expect(res.excludePass).toBe(true);
    expect(res.budgetPass).toBe(true);
  });

  it('should correctly prioritize latest superseded value in temporal slot test', () => {
    const testCase: EvalCase = {
      id: 'temp-001',
      suite: 'temporal',
      critical: true,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/demo',
      setup: [
        {
          type: 'semantic',
          content: '项目数据库是 MySQL 8',
          slot_key: 'project.database',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
        },
        {
          type: 'semantic',
          content: '项目数据库已迁移到 PostgreSQL 16',
          slot_key: 'project.database',
          at: '2026-09-20T10:00:00+08:00',
          source_kind: 'user',
        },
      ],
      query: '数据库连接串怎么写？',
      expect: {
        include: ['PostgreSQL'],
        exclude: ['MySQL'],
        maxTokens: 1600,
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
    expect(res.excludePass).toBe(true);
  });

  it('should inject both failure and procedural memories on error query', () => {
    const testCase: EvalCase = {
      id: 'proc-001',
      suite: 'procedural',
      critical: false,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/demo',
      setup: [
        {
          type: 'failure',
          content: '构建失败：TypeScript TS2307 找不到模块 @deepseek-ai/dsh',
          at: '2026-09-10T10:00:00+08:00',
          source_kind: 'user',
        },
        {
          type: 'procedural',
          content: '当 TS2307 报找不到 @deepseek-ai/dsh 时，执行 pnpm install 即可解决',
          at: '2026-09-10T10:05:00+08:00',
          source_kind: 'user',
        },
      ],
      query: '编译报错 TS2307 找不到模块 @deepseek-ai/dsh 怎么处理？',
      expect: {
        include: ['TS2307', 'pnpm install'],
        exclude: [],
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
  });

  it('should satisfy expectStable for implicit pinned preferences', () => {
    const testCase: EvalCase = {
      id: 'impl-001',
      suite: 'implicit',
      critical: true,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/demo',
      setup: [
        {
          type: 'preference',
          content: '用户偏好使用简洁明了的步骤，禁止繁琐的寒暄与废话。',
          pinned: 1,
          status: 'active',
          at: '2026-08-01T10:00:00+08:00',
          source_kind: 'user',
        },
      ],
      query: '今天天气怎么样？',
      expect: {
        include: [],
        exclude: [],
        expectStable: ['简洁明了'],
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.stablePass).toBe(true);
    expect(res.emptyPass).toBe(true);
  });

  it('should return empty dynamic injection for unrelated threshold query', () => {
    const testCase: EvalCase = {
      id: 'thresh-001',
      suite: 'factual',
      critical: false,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/demo',
      setup: [
        {
          type: 'semantic',
          content: '本项目核心主数据库使用的是 PostgreSQL 16 关系型数据库。',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
        },
      ],
      query: '今天北京的天气怎么样？',
      expect: {
        include: [],
        exclude: [],
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.emptyPass).toBe(true);
  });
});
