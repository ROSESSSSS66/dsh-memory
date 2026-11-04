import { describe, it, expect } from 'vitest';
import { calculateSuiteMetrics, buildEvalReport } from '../../src/eval/metrics.js';
import type { EvalCase, CaseResult } from '../../src/eval/types.js';

describe('Evaluation Metrics (§8.3)', () => {
  const dummyCases: EvalCase[] = [
    {
      id: 'c1',
      suite: 'factual',
      critical: true,
      now: '2026-10-01T10:00:00Z',
      workspace: '/ws/test',
      setup: [],
      query: 'q1',
      expect: { include: ['target'], exclude: [] },
    },
    {
      id: 'c2',
      suite: 'factual',
      critical: false,
      now: '2026-10-01T10:00:00Z',
      workspace: '/ws/test',
      setup: [],
      query: 'q2',
      expect: { include: ['target'], exclude: ['forbidden'] },
    },
    {
      id: 'c3',
      suite: 'factual',
      critical: true,
      now: '2026-10-01T10:00:00Z',
      workspace: '/ws/test',
      setup: [],
      query: 'q3',
      expect: { include: [], exclude: [] }, // empty threshold test
    },
  ];

  it('should accurately calculate suite metrics for perfect pass', () => {
    const results: Record<string, CaseResult> = {
      c1: {
        id: 'c1',
        pass: true,
        includePass: true,
        excludePass: true,
        stablePass: true,
        budgetPass: true,
        emptyPass: true,
        dynamicTokens: 100,
        stableTokens: 50,
        latencyMs: 15,
        injectedIds: ['m1'],
      },
      c2: {
        id: 'c2',
        pass: true,
        includePass: true,
        excludePass: true,
        stablePass: true,
        budgetPass: true,
        emptyPass: true,
        dynamicTokens: 120,
        stableTokens: 50,
        latencyMs: 25,
        injectedIds: ['m2'],
      },
      c3: {
        id: 'c3',
        pass: true,
        includePass: true,
        excludePass: true,
        stablePass: true,
        budgetPass: true,
        emptyPass: true,
        dynamicTokens: 0,
        stableTokens: 50,
        latencyMs: 10,
        injectedIds: [],
      },
    };

    const metrics = calculateSuiteMetrics('factual', dummyCases, results);
    expect(metrics.totalCases).toBe(3);
    expect(metrics.passedCases).toBe(3);
    expect(metrics.recallAtInject).toBe(1.0);
    expect(metrics.excludeViolations).toBe(0);
    expect(metrics.emptyPrecision).toBe(1.0);
    expect(metrics.criticalTotal).toBe(2);
    expect(metrics.criticalPassed).toBe(2);
    expect(metrics.criticalPassRate).toBe(1.0);
    expect(metrics.avgInjectTokens).toBe(110); // (100 + 120) / 2
    expect(metrics.maxBudgetTokens).toBe(170); // 120 + 50
  });

  it('should capture exclude violations and failed recall', () => {
    const results: Record<string, CaseResult> = {
      c1: {
        id: 'c1',
        pass: false,
        includePass: false,
        excludePass: true,
        stablePass: true,
        budgetPass: true,
        emptyPass: true,
        dynamicTokens: 50,
        stableTokens: 50,
        latencyMs: 15,
        injectedIds: [],
      },
      c2: {
        id: 'c2',
        pass: false,
        includePass: true,
        excludePass: false, // violation!
        stablePass: true,
        budgetPass: true,
        emptyPass: true,
        dynamicTokens: 120,
        stableTokens: 50,
        latencyMs: 25,
        injectedIds: ['m2'],
      },
      c3: {
        id: 'c3',
        pass: false,
        includePass: true,
        excludePass: true,
        stablePass: true,
        budgetPass: true,
        emptyPass: false, // failed empty threshold!
        dynamicTokens: 30,
        stableTokens: 50,
        latencyMs: 10,
        injectedIds: ['m3'],
      },
    };

    const metrics = calculateSuiteMetrics('factual', dummyCases, results);
    expect(metrics.recallAtInject).toBe(0.5); // 1 / 2
    expect(metrics.excludeViolations).toBe(1);
    expect(metrics.emptyPrecision).toBe(0.0); // 0 / 1
    expect(metrics.criticalPassed).toBe(0);
  });

  it('should evaluate MVP gate correctly in buildEvalReport', () => {
    const passingResults: Record<string, CaseResult> = {
      c1: { id: 'c1', pass: true, includePass: true, excludePass: true, stablePass: true, budgetPass: true, emptyPass: true, dynamicTokens: 100, stableTokens: 50, latencyMs: 15, injectedIds: ['m1'] },
      c2: { id: 'c2', pass: true, includePass: true, excludePass: true, stablePass: true, budgetPass: true, emptyPass: true, dynamicTokens: 120, stableTokens: 50, latencyMs: 25, injectedIds: ['m2'] },
      c3: { id: 'c3', pass: true, includePass: true, excludePass: true, stablePass: true, budgetPass: true, emptyPass: true, dynamicTokens: 0, stableTokens: 50, latencyMs: 10, injectedIds: [] },
    };

    const report = buildEvalReport(dummyCases, passingResults);
    expect(report.mvpPassed).toBe(true);
  });
});
