import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCliArgs,
  formatMetricsTable,
  buildMvpGateLines,
  formatMvpGateSection,
  runCli,
} from '../../src/eval/eval-cli.js';
import { buildEvalReport } from '../../src/eval/metrics.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import type { EvalCase, CaseResult } from '../../src/eval/types.js';

function makeCase(overrides: Partial<EvalCase> & { id: string }): EvalCase {
  return {
    suite: 'factual',
    critical: false,
    now: '2026-10-01T10:00:00Z',
    workspace: '/ws/cli-test',
    setup: [],
    query: `q-${overrides.id}`,
    expect: { include: ['ok'] },
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
    dynamicTokens: 120,
    stableTokens: 40,
    latencyMs: 5,
    injectedIds: ['m1'],
    injectedTexts: ['[FACT m_1] ok'],
    ...overrides,
  };
}

describe('Eval CLI v2 (eval-cli.ts)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should parse suite filter, --scale, --scale-count, and --cold flags', () => {
    expect(parseCliArgs([])).toEqual({
      suiteFilter: undefined,
      scale: false,
      scaleCount: 10000,
      coldCache: false,
    });
    expect(parseCliArgs(['temporal'])).toEqual({
      suiteFilter: 'temporal',
      scale: false,
      scaleCount: 10000,
      coldCache: false,
    });
    expect(parseCliArgs(['--suite', 'English_Mixed', '--cold'])).toEqual({
      suiteFilter: 'english_mixed',
      scale: false,
      scaleCount: 10000,
      coldCache: true,
    });
    expect(parseCliArgs(['--scale=2500', '--cold-cache'])).toEqual({
      suiteFilter: undefined,
      scale: true,
      scaleCount: 2500,
      coldCache: true,
    });
    expect(parseCliArgs(['--scale', '--scale-count', '500'])).toEqual({
      suiteFilter: undefined,
      scale: true,
      scaleCount: 500,
      coldCache: false,
    });
  });

  it('should include Prec@Inj, MRR, NDCG, p50 (ms), and p95 (ms) columns in summary table', () => {
    const cases = [makeCase({ id: 'c1', critical: true })];
    const results = { c1: makeResult({ id: 'c1', latencyMs: 12.3 }) };
    const report = buildEvalReport(cases, results);
    const table = formatMetricsTable(report);

    expect(table).toContain('Prec@Inj');
    expect(table).toContain('MRR');
    expect(table).toContain('NDCG');
    expect(table).toContain('p50 (ms)');
    expect(table).toContain('p95 (ms)');
    expect(table).toContain('12.3ms');
  });

  it('should keep MVP gate lines strictly aligned 1-to-1 with report.mvpPassed across every failure mode', () => {
    const customCfg: PluginConfig = {
      ...DEFAULTS,
      hardBudgetTokens: 2400,
      dynamicBudgetTokens: 1200,
    };

    const scenarios: Array<{
      name: string;
      cases: EvalCase[];
      results: Record<string, CaseResult>;
      expectedMvp: boolean;
      expectedFailKey?: string;
    }> = [
      {
        name: 'all gates passing',
        cases: [
          makeCase({ id: 'p1', suite: 'factual', critical: true }),
          makeCase({ id: 'p2', suite: 'implicit', expect: { include: ['ok'], expectStable: ['pref'] } }),
        ],
        results: {
          p1: makeResult({ id: 'p1' }),
          p2: makeResult({ id: 'p2' }),
        },
        expectedMvp: true,
      },
      {
        name: 'empty-only vacuous run',
        cases: [makeCase({ id: 'e1', expect: { include: [] } })],
        results: {
          e1: makeResult({ id: 'e1', dynamicTokens: 0, injectedIds: [], injectedTexts: [] }),
        },
        expectedMvp: false,
        expectedFailKey: 'hasNonEmptyCases',
      },
      {
        name: 'budget violation only',
        cases: [makeCase({ id: 'b1' })],
        results: {
          b1: makeResult({ id: 'b1', pass: false, budgetPass: false, dynamicTokens: 500 }),
        },
        expectedMvp: false,
        expectedFailKey: 'allBudgetPass',
      },
      {
        name: 'implicit stable layer violation only',
        cases: [
          makeCase({ id: 'i1', suite: 'implicit', expect: { include: ['ok'], expectStable: ['pref'] } }),
        ],
        results: {
          i1: makeResult({ id: 'i1', pass: false, stablePass: false }),
        },
        expectedMvp: false,
        expectedFailKey: 'allImplicitStablePass',
      },
      {
        name: 'p95 latency violation',
        cases: [makeCase({ id: 'l1' })],
        results: {
          l1: makeResult({ id: 'l1', latencyMs: 65 }),
        },
        expectedMvp: false,
        expectedFailKey: 'p95LatencyMs',
      },
      {
        name: 'exclude violation',
        cases: [makeCase({ id: 'x1' })],
        results: {
          x1: makeResult({ id: 'x1', pass: false, excludePass: false }),
        },
        expectedMvp: false,
        expectedFailKey: 'excludeViolations',
      },
    ];

    for (const sc of scenarios) {
      const report = buildEvalReport(sc.cases, sc.results, undefined, customCfg);
      expect(report.mvpPassed, sc.name).toBe(sc.expectedMvp);

      const lines = buildMvpGateLines(report, customCfg);
      expect(lines.every((l) => l.ok), `${sc.name}: lines must match mvpPassed 1:1`).toBe(
        report.mvpPassed
      );

      if (sc.expectedFailKey) {
        const targetLine = lines.find((l) => l.key === sc.expectedFailKey);
        expect(targetLine?.ok, `${sc.name}: ${sc.expectedFailKey} must be FAIL`).toBe(false);
      }

      const section = formatMvpGateSection(report, customCfg);
      expect(section).toContain('hard <= 2400');
      expect(section).not.toContain('<= 3200');
      if (!report.mvpPassed) {
        expect(section).toContain('[FAIL]');
      }
    }
  });

  it('should execute runCli for a filtered suite and reject unknown suite names', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));

    const badCode = await runCli(['--suite', 'unknown_suite_xyz']);
    expect(badCode).toBe(1);
    expect(errs.join('\n')).toContain('unknown_suite_xyz');
    expect(logs.join('\n')).toContain('english_mixed');

    logs.length = 0;
    const okCode = await runCli(['--suite', 'budget_viking']);
    expect(okCode).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('Prec@Inj');
    expect(out).toContain('MRR');
    expect(out).toContain('NDCG');
    expect(out).toContain('p50 (ms)');
  });

  it('should execute runCli full benchmark (all 7 suites) and print aligned MVP gate output', async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => errs.push(a.join(' ')));

    const code = await runCli([]);
    expect(code).toBe(0);
    expect(errs).toHaveLength(0);

    const out = logs.join('\n');
    for (const suite of [
      'overall',
      'factual',
      'temporal',
      'procedural',
      'implicit',
      'english_mixed',
      'isolation_multihop',
      'budget_viking',
    ]) {
      expect(out).toContain(suite);
    }
    expect(out).toContain('ALL MVP EVALUATION THRESHOLDS MET SUCCESSFULLY');
    expect(out).not.toContain('[FAIL]');
  });

  it('should execute runCli --scale mode on demand', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = await runCli(['--scale', '--scale-count', '200']);
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('Indexed 200 memories');
    expect(out).toContain('Scale Benchmark Summary');
    expect(out).toContain('Prec@Inj');
  });
});
