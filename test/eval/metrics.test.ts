import { describe, it, expect } from 'vitest';
import {
  calculateSuiteMetrics,
  computeSuiteMetrics,
  buildEvalReport,
} from '../../src/eval/metrics.js';
import type { EvalCase, CaseResult } from '../../src/eval/types.js';

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    suite: 'factual',
    critical: false,
    now: '2026-10-01T10:00:00Z',
    workspace: '/ws/test',
    setup: [],
    query: `query-${overrides.id}`,
    expect: { include: ['target'], exclude: [] },
    ...overrides,
  };
}

function makeResult(overrides: Partial<CaseResult> & { id: string }): CaseResult {
  return {
    pass: true,
    includePass: true,
    excludePass: true,
    stablePass: true,
    budgetPass: true,
    emptyPass: true,
    dynamicTokens: 100,
    stableTokens: 50,
    latencyMs: 10,
    injectedIds: ['m1'],
    injectedTexts: ['[FACT m_1] target value'],
    ...overrides,
  };
}

describe('Evaluation Metrics v2 (§8.3)', () => {
  const dummyCases: EvalCase[] = [
    makeCase({ id: 'c1', critical: true, expect: { include: ['target'], exclude: [] } }),
    makeCase({ id: 'c2', critical: false, expect: { include: ['target'], exclude: ['forbidden'] } }),
    makeCase({ id: 'c3', critical: true, expect: { include: [], exclude: [] } }),
  ];

  it('should expose computeSuiteMetrics alias identically to calculateSuiteMetrics', () => {
    expect(computeSuiteMetrics).toBe(calculateSuiteMetrics);
  });

  it('should accurately calculate suite metrics including IR ranking metrics for perfect pass', () => {
    const results: Record<string, CaseResult> = {
      c1: makeResult({
        id: 'c1',
        dynamicTokens: 100,
        stableTokens: 50,
        latencyMs: 15,
        injectedIds: ['m1'],
        injectedTexts: ['[FACT m_1] target hit'],
      }),
      c2: makeResult({
        id: 'c2',
        dynamicTokens: 120,
        stableTokens: 50,
        latencyMs: 25,
        injectedIds: ['m2'],
        injectedTexts: ['[FACT m_2] target hit'],
      }),
      c3: makeResult({
        id: 'c3',
        dynamicTokens: 0,
        stableTokens: 50,
        latencyMs: 10,
        injectedIds: [],
        injectedTexts: [],
      }),
    };

    const metrics = calculateSuiteMetrics('factual', dummyCases, results);
    expect(metrics.totalCases).toBe(3);
    expect(metrics.passedCases).toBe(3);
    expect(metrics.recallAtInject).toBe(1.0);
    expect(metrics.precisionAtInject).toBe(1.0);
    expect(metrics.mrr).toBe(1.0);
    expect(metrics.ndcgAtK).toBe(1.0);
    expect(metrics.excludeViolations).toBe(0);
    expect(metrics.emptyPrecision).toBe(1.0);
    expect(metrics.criticalTotal).toBe(2);
    expect(metrics.criticalPassed).toBe(2);
    expect(metrics.criticalPassRate).toBe(1.0);
    expect(metrics.avgInjectTokens).toBe(110);
    expect(metrics.maxBudgetTokens).toBe(170);
    expect(metrics.p50LatencyMs).toBe(15);
    expect(metrics.p95LatencyMs).toBe(25);
  });

  it('should compute exact Precision@Inject, MRR, and NDCG@K across ranked injectedTexts', () => {
    const cases: EvalCase[] = [
      // Rank 2 hit out of 2 injected -> P@Inj=0.5, RR=0.5, NDCG=1/log2(3)≈0.6309
      makeCase({ id: 'r1', expect: { include: ['alpha'] } }),
      // Rank 3 hit out of 3 injected -> P@Inj=1/3, RR=1/3, NDCG=1/log2(4)=0.5
      makeCase({ id: 'r2', expect: { include: ['beta'] } }),
      // Multi-target ['gamma', 'delta']: rank 1 hits gamma, rank 2 is distractor (misses delta)
      // -> P@Inj=0.5, RR=1.0, DCG=1, IDCG=1+1/log2(3), NDCG=1/(1+1/log2(3))≈0.6131
      makeCase({ id: 'r3', expect: { include: ['gamma', 'delta'] } }),
    ];

    const results: Record<string, CaseResult> = {
      r1: makeResult({
        id: 'r1',
        injectedIds: ['d1', 't1'],
        injectedTexts: ['distractor one', 'contains alpha value'],
      }),
      r2: makeResult({
        id: 'r2',
        injectedIds: ['d1', 'd2', 't2'],
        injectedTexts: ['noise A', 'noise B', 'contains beta value'],
      }),
      r3: makeResult({
        id: 'r3',
        pass: false,
        includePass: false,
        injectedIds: ['t3', 'd3'],
        injectedTexts: ['contains gamma only', 'unrelated distractor'],
      }),
    };

    const m = calculateSuiteMetrics('factual', cases, results);

    const expectedPrecision = (0.5 + 1 / 3 + 0.5) / 3;
    const expectedMrr = (0.5 + 1 / 3 + 1.0) / 3;
    const ndcg1 = 1 / Math.log2(3);
    const ndcg2 = 1 / Math.log2(4);
    const ndcg3 = 1 / (1 + 1 / Math.log2(3));
    const expectedNdcg = (ndcg1 + ndcg2 + ndcg3) / 3;

    expect(m.precisionAtInject).toBeCloseTo(expectedPrecision, 3);
    expect(m.mrr).toBeCloseTo(expectedMrr, 3);
    expect(m.ndcgAtK).toBeCloseTo(expectedNdcg, 3);
    expect(m.recallAtInject).toBeCloseTo(2 / 3, 3);
  });

  it('should use exact nearest-rank p95 and p50 formula without off-by-one error', () => {
    // 20 cases with latencies 1..20 -> p50 = ceil(10)-1 = idx 9 (10ms), p95 = ceil(19)-1 = idx 18 (19ms, NOT 20ms!)
    const cases20 = Array.from({ length: 20 }, (_, i) => makeCase({ id: `lat-${i + 1}` }));
    const results20: Record<string, CaseResult> = {};
    for (let i = 0; i < 20; i++) {
      results20[`lat-${i + 1}`] = makeResult({ id: `lat-${i + 1}`, latencyMs: 20 - i });
    }
    const m20 = calculateSuiteMetrics('factual', cases20, results20);
    expect(m20.p50LatencyMs).toBe(10);
    expect(m20.p95LatencyMs).toBe(19);

    // 100 cases with latencies 1..100 -> p50 = 50, p95 = 95 (NOT 96!)
    const cases100 = Array.from({ length: 100 }, (_, i) => makeCase({ id: `l100-${i + 1}` }));
    const results100: Record<string, CaseResult> = {};
    for (let i = 0; i < 100; i++) {
      results100[`l100-${i + 1}`] = makeResult({ id: `l100-${i + 1}`, latencyMs: i + 1 });
    }
    const m100 = calculateSuiteMetrics('factual', cases100, results100);
    expect(m100.p50LatencyMs).toBe(50);
    expect(m100.p95LatencyMs).toBe(95);
  });

  it('should filter out unevaluated cases before computing denominators', () => {
    const cases: EvalCase[] = [
      makeCase({ id: 'eval-1', critical: true, expect: { include: ['a'] } }),
      makeCase({ id: 'eval-2', critical: false, expect: { include: [] } }),
      makeCase({ id: 'uneval-3', critical: true, expect: { include: ['b'] } }),
      makeCase({ id: 'uneval-4', critical: false, expect: { include: [] } }),
    ];

    const partialResults: Record<string, CaseResult> = {
      'eval-1': makeResult({
        id: 'eval-1',
        dynamicTokens: 80,
        injectedTexts: ['hit a'],
      }),
      'eval-2': makeResult({
        id: 'eval-2',
        dynamicTokens: 0,
        injectedIds: [],
        injectedTexts: [],
      }),
    };

    const m = calculateSuiteMetrics('factual', cases, partialResults);
    expect(m.totalCases).toBe(2);
    expect(m.passedCases).toBe(2);
    expect(m.recallAtInject).toBe(1.0); // 1/1 evaluated non-empty, NOT 1/2!
    expect(m.emptyPrecision).toBe(1.0); // 1/1 evaluated empty, NOT 1/2!
    expect(m.criticalTotal).toBe(1);
    expect(m.criticalPassed).toBe(1);
    expect(m.avgInjectTokens).toBe(80); // 80/1, NOT 80/2!
  });

  it('should reject vacuous empty-only or zero-case runs in buildEvalReport().mvpPassed', () => {
    // 1. Zero cases -> mvpPassed must be false
    const emptyReport = buildEvalReport([], {});
    expect(emptyReport.mvpPassed).toBe(false);
    expect(emptyReport.mvpGates?.hasCases).toBe(false);
    expect(emptyReport.mvpGates?.hasNonEmptyCases).toBe(false);

    // 2. Empty-threshold-only cases (all include: [] and all pass) -> mvpPassed MUST be false!
    const emptyOnlyCases: EvalCase[] = [
      makeCase({ id: 'e1', expect: { include: [] } }),
      makeCase({ id: 'e2', expect: { include: [] } }),
    ];
    const emptyOnlyResults: Record<string, CaseResult> = {
      e1: makeResult({ id: 'e1', dynamicTokens: 0, injectedIds: [], injectedTexts: [] }),
      e2: makeResult({ id: 'e2', dynamicTokens: 0, injectedIds: [], injectedTexts: [] }),
    };

    const vacuousReport = buildEvalReport(emptyOnlyCases, emptyOnlyResults);
    expect(vacuousReport.overall.emptyPrecision).toBe(1.0);
    expect(vacuousReport.mvpPassed).toBe(false);
    expect(vacuousReport.mvpGates?.hasNonEmptyCases).toBe(false);
  });

  it('should capture exclude violations, failed recall, and evaluate MVP gate correctly', () => {
    const failingResults: Record<string, CaseResult> = {
      c1: makeResult({
        id: 'c1',
        pass: false,
        includePass: false,
        dynamicTokens: 50,
        latencyMs: 15,
        injectedIds: [],
        injectedTexts: [],
      }),
      c2: makeResult({
        id: 'c2',
        pass: false,
        includePass: true,
        excludePass: false,
        dynamicTokens: 120,
        latencyMs: 25,
        injectedIds: ['m2'],
        injectedTexts: ['target forbidden'],
      }),
      c3: makeResult({
        id: 'c3',
        pass: false,
        emptyPass: false,
        dynamicTokens: 30,
        latencyMs: 10,
        injectedIds: ['m3'],
        injectedTexts: ['unexpected'],
      }),
    };

    const failMetrics = calculateSuiteMetrics('factual', dummyCases, failingResults);
    expect(failMetrics.recallAtInject).toBe(0.5);
    expect(failMetrics.excludeViolations).toBe(1);
    expect(failMetrics.emptyPrecision).toBe(0.0);
    expect(failMetrics.criticalPassed).toBe(0);

    const passingResults: Record<string, CaseResult> = {
      c1: makeResult({ id: 'c1', dynamicTokens: 100, latencyMs: 15 }),
      c2: makeResult({ id: 'c2', dynamicTokens: 120, latencyMs: 25 }),
      c3: makeResult({ id: 'c3', dynamicTokens: 0, latencyMs: 10, injectedIds: [], injectedTexts: [] }),
    };
    const passReport = buildEvalReport(dummyCases, passingResults);
    expect(passReport.mvpPassed).toBe(true);
    expect(Object.values(passReport.mvpGates!).every(Boolean)).toBe(true);
  });
});
