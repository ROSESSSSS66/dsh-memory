import { describe, it, expect } from 'vitest';
import {
  runCase,
  runEvalCase,
  runEvalSuite,
  runScaleBenchmark,
} from '../../src/eval/runner.js';
import { generateDataset, generateScaleDataset } from '../../src/eval/gen-dataset.js';
import { DEFAULTS } from '../../src/config.js';
import type { EvalCase } from '../../src/eval/types.js';

describe('Evaluation Runner v2 (§8.1)', () => {
  it('should expose runEvalCase alias identically to runCase', () => {
    expect(runEvalCase).toBe(runCase);
  });

  it('should pass factual retrieval with equal-utility distractors and record injectedTexts', () => {
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
          utility: 0.5,
        },
        {
          type: 'semantic',
          content: '前端构建产物默认输出到 dist/ 目录。',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
          utility: 0.5,
        },
        {
          type: 'semantic',
          content: '团队前端规范强制使用 ESLint 9 与 Prettier 格式化。',
          at: '2026-09-01T10:00:00+08:00',
          source_kind: 'user',
          utility: 0.5,
        },
      ],
      query: '请问项目主数据库使用的是什么？',
      expect: {
        include: ['PostgreSQL'],
        exclude: [],
      },
    };

    const res = runCase(testCase, undefined, DEFAULTS, { coldCache: true });
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
    expect(res.excludePass).toBe(true);
    expect(res.budgetPass).toBe(true);
    expect(res.injectedTexts?.length).toBeGreaterThan(0);
    expect(res.injectedTexts?.[0]).toContain('PostgreSQL');
    expect(res.injectedTiers?.length).toBe(res.injectedIds?.length);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('should prioritize latest superseded value and exclude invalidated_at records', () => {
    const tSep01 = new Date('2026-09-01T10:00:00+08:00').getTime();
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
        {
          type: 'semantic',
          content: '项目旧版数据库代理连接串使用 LegacyProxy-3306',
          at: '2026-08-15T10:00:00+08:00',
          invalidated_at: tSep01,
          source_kind: 'user',
        },
      ],
      query: '项目数据库连接串怎么配置？',
      expect: {
        include: ['PostgreSQL'],
        exclude: ['MySQL', 'LegacyProxy-3306'],
        maxTokens: 1600,
      },
    };

    const res = runCase(testCase);
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
    expect(res.excludePass).toBe(true);
  });

  it('should support scope, workspaceId, sessionId, frozen, status, and relations setup fields', () => {
    const graphCase: EvalCase = {
      id: 'runner-graph-iso-001',
      suite: 'isolation_multihop',
      critical: true,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/alpha',
      sessionId: 'sess_current',
      setup: [
        {
          type: 'semantic',
          content: '核心网关 PaymentService 超时时间设定为 4500ms。',
          scope: 'workspace',
          workspaceId: '/ws/alpha',
          entities: ['paymentservice'],
          frozen: true,
          confidence: 0.95,
          source_kind: 'user',
        },
        {
          type: 'procedural',
          content: '当 PaymentService 触发超时降级时，路由切换至 backup-pool-99 备用池。',
          scope: 'session',
          workspaceId: '/ws/alpha',
          sessionId: 'sess_current',
          entities: ['paymentservice', 'backup-pool-99'],
          source_kind: 'user',
        },
        {
          type: 'semantic',
          content: '其他工作区的 PaymentService 机密地址为 secret-beta.internal。',
          scope: 'workspace',
          workspaceId: '/ws/beta',
          source_kind: 'user',
        },
        {
          type: 'episodic',
          content: '其他会话的 PaymentService 临时标记为 OTHER_SESSION_LEAK。',
          scope: 'session',
          workspaceId: '/ws/alpha',
          sessionId: 'sess_other',
          source_kind: 'user',
        },
        {
          type: 'semantic',
          content: '未审批的 PaymentService 草案为 CANDIDATE_LEAK。',
          status: 'candidate',
          source_kind: 'llm_extract',
        },
      ],
      relations: [{ fromIdx: 0, toIdx: 1, rel: 'related' }],
      query: 'PaymentService 的超时时间和超时降级备用池是什么？',
      expect: {
        include: ['4500ms', 'backup-pool-99'],
        exclude: ['secret-beta.internal', 'OTHER_SESSION_LEAK', 'CANDIDATE_LEAK'],
      },
    };

    const res = runCase(graphCase);
    expect(res.pass).toBe(true);
    expect(res.includePass).toBe(true);
    expect(res.excludePass).toBe(true);
  });

  it('should enforce unified token budget and trigger L2 -> L1/L0 degradation under tight dynamic budget', () => {
    const ds = generateDataset();
    const tightCase = ds.find((c) => c.id === 'bv-degrade-001');
    expect(tightCase).toBeDefined();

    const res = runCase(tightCase!);
    expect(res.pass).toBe(true);
    expect(res.budgetPass).toBe(true);
    expect(res.dynamicTokens).toBeLessThanOrEqual(480);
    expect(res.stableTokens + res.dynamicTokens).toBeLessThanOrEqual(DEFAULTS.hardBudgetTokens);
    // At least one item should degrade below L2 (L1 or L0) under tight budget
    expect(res.injectedIds?.length ?? 0).toBeGreaterThan(0);
    expect(res.injectedTiers?.some((t) => t === 'L1' || t === 'L0')).toBe(true);
  });

  it('should pass full Eval v2 benchmark suite (152 unique cases) meeting all MVP gates', () => {
    const cases = generateDataset();
    const report = runEvalSuite(cases);

    expect(report.overall.totalCases).toBe(cases.length);
    expect(report.overall.excludeViolations).toBe(0);
    expect(report.overall.recallAtInject).toBeGreaterThanOrEqual(0.9);
    expect(report.overall.mrr).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.ndcgAtK).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.emptyPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.criticalPassed).toBe(report.overall.criticalTotal);
    expect(report.overall.p95LatencyMs).toBeLessThanOrEqual(50);
    expect(report.mvpPassed).toBe(true);
  });

  it('should execute runScaleBenchmark over hundreds of memories cleanly', () => {
    const scaleDataset = generateScaleDataset(300, 12345);
    const scaleRes = runScaleBenchmark(scaleDataset, undefined, DEFAULTS, { coldCache: true });

    expect(scaleRes.memoryCount).toBe(300);
    expect(scaleRes.setupMs).toBeGreaterThan(0);
    expect(scaleRes.report.overall.totalCases).toBe(scaleDataset.queries.length);
    expect(scaleRes.report.overall.recallAtInject).toBeGreaterThanOrEqual(0.8);
    expect(scaleRes.report.overall.excludeViolations).toBe(0);
  });
});
