import { DEFAULTS, type PluginConfig } from '../config.js';
import { generateDataset, generateScaleDataset } from './gen-dataset.js';
import { runEvalSuite, runScaleBenchmark } from './runner.js';
import type { EvalReport, MvpGateStatus, SuiteMetrics } from './types.js';

export interface MvpGateLine {
  key: keyof MvpGateStatus;
  label: string;
  value: string;
  ok: boolean;
}

export interface ParsedCliArgs {
  suiteFilter?: string;
  scale: boolean;
  scaleCount: number;
  coldCache: boolean;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  let suiteFilter: string | undefined;
  let scale = false;
  let scaleCount = 10000;
  let coldCache = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--scale') {
      scale = true;
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        scaleCount = Math.max(25, parseInt(next, 10));
        i++;
      }
    } else if (arg.startsWith('--scale=')) {
      scale = true;
      const val = parseInt(arg.slice('--scale='.length), 10);
      if (Number.isInteger(val) && val > 0) {
        scaleCount = Math.max(25, val);
      }
    } else if (arg === '--scale-count') {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        scaleCount = Math.max(25, parseInt(next, 10));
        i++;
      }
    } else if (arg.startsWith('--scale-count=')) {
      const val = parseInt(arg.slice('--scale-count='.length), 10);
      if (Number.isInteger(val) && val > 0) {
        scaleCount = Math.max(25, val);
      }
    } else if (arg === '--cold' || arg === '--cold-cache') {
      coldCache = true;
    } else if (arg === '--suite') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        suiteFilter = next.toLowerCase();
        i++;
      }
    } else if (arg.startsWith('--suite=')) {
      const val = arg.slice('--suite='.length).trim();
      if (val) suiteFilter = val.toLowerCase();
    } else if (!arg.startsWith('-') && !suiteFilter) {
      suiteFilter = arg.toLowerCase();
    }
  }

  return { suiteFilter, scale, scaleCount, coldCache };
}

export function formatMetricsTable(report: EvalReport): string {
  const rows: SuiteMetrics[] = [report.overall, ...Object.values(report.suites)];

  const headers = [
    'Suite',
    'Total',
    'Passed',
    'Recall@Inj',
    'Prec@Inj',
    'MRR',
    'NDCG',
    'ExclViol',
    'EmptyPrec',
    'CritPass',
    'AvgTokens',
    'MaxTokens',
    'p50 (ms)',
    'p95 (ms)',
  ];

  const lines: string[] = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  for (const r of rows) {
    const rowData = [
      r.suite.padEnd(18),
      String(r.totalCases).padStart(5),
      String(r.passedCases).padStart(6),
      `${(r.recallAtInject * 100).toFixed(1)}%`.padStart(10),
      `${(r.precisionAtInject * 100).toFixed(1)}%`.padStart(8),
      r.mrr.toFixed(3).padStart(5),
      r.ndcgAtK.toFixed(3).padStart(5),
      String(r.excludeViolations).padStart(8),
      `${(r.emptyPrecision * 100).toFixed(1)}%`.padStart(9),
      `${r.criticalPassed}/${r.criticalTotal}`.padStart(8),
      String(r.avgInjectTokens).padStart(9),
      String(r.maxBudgetTokens).padStart(9),
      `${r.p50LatencyMs.toFixed(1)}ms`.padStart(8),
      `${r.p95LatencyMs.toFixed(1)}ms`.padStart(8),
    ];
    lines.push(`| ${rowData.join(' | ')} |`);
  }

  return lines.join('\n');
}

function resolveGates(report: EvalReport, cfg: PluginConfig): MvpGateStatus {
  if (report.mvpGates) {
    return report.mvpGates;
  }
  const results = Object.values(report.caseResults);
  const maxAvgDynamic = cfg.dynamicBudgetTokens ?? DEFAULTS.dynamicBudgetTokens;
  const hasCases = report.overall.totalCases > 0;
  const hasNonEmptyCases = hasCases && report.overall.recallAtInject > 0;
  const allCriticalPassed =
    report.overall.criticalTotal === 0 ||
    report.overall.criticalPassed === report.overall.criticalTotal;
  const allBudgetPass =
    hasCases && results.length > 0 && results.every((r) => Boolean(r.budgetPass));
  const allImplicitStablePass = results.every((r) => Boolean(r.stablePass));

  return {
    hasCases,
    hasNonEmptyCases,
    recallAtInject: report.overall.recallAtInject >= 0.7,
    excludeViolations: report.overall.excludeViolations === 0,
    emptyPrecision: report.overall.emptyPrecision >= 0.8,
    avgInjectTokens: report.overall.avgInjectTokens <= maxAvgDynamic,
    p95LatencyMs: report.overall.p95LatencyMs <= 50,
    allCriticalPassed,
    allBudgetPass,
    allImplicitStablePass,
  };
}

/**
 * 生成与 buildEvalReport().mvpPassed 1-to-1 严格对齐的 MVP 门槛检查项。
 * 不变量：lines.every(l => l.ok) === report.mvpPassed
 */
export function buildMvpGateLines(report: EvalReport, cfg: PluginConfig = DEFAULTS): MvpGateLine[] {
  const gates = resolveGates(report, cfg);
  const maxAvgDynamic = cfg.dynamicBudgetTokens ?? DEFAULTS.dynamicBudgetTokens;
  const hardBudget = cfg.hardBudgetTokens ?? DEFAULTS.hardBudgetTokens;

  const evaluatedResults = Object.values(report.caseResults);
  const budgetPassedCount = evaluatedResults.filter((r) => r.budgetPass).length;
  const implicitSuite = report.suites['implicit'];
  const implicitTotal = implicitSuite?.totalCases ?? 0;

  return [
    {
      key: 'hasCases',
      label: 'Evaluated Cases (> 0)',
      value: `${report.overall.totalCases}`,
      ok: gates.hasCases,
    },
    {
      key: 'hasNonEmptyCases',
      label: 'Non-Empty Eval Cases (> 0)',
      value: gates.hasNonEmptyCases ? 'present' : 'none',
      ok: gates.hasNonEmptyCases,
    },
    {
      key: 'recallAtInject',
      label: 'Recall @ Inject (>= 70.0%)',
      value: `${(report.overall.recallAtInject * 100).toFixed(1)}%`,
      ok: gates.recallAtInject,
    },
    {
      key: 'excludeViolations',
      label: 'Exclude Violations (== 0)',
      value: `${report.overall.excludeViolations}`,
      ok: gates.excludeViolations,
    },
    {
      key: 'emptyPrecision',
      label: 'Empty Precision (>= 80.0%)',
      value: `${(report.overall.emptyPrecision * 100).toFixed(1)}%`,
      ok: gates.emptyPrecision,
    },
    {
      key: 'avgInjectTokens',
      label: `Avg Dynamic Tokens (<= ${maxAvgDynamic})`,
      value: `${report.overall.avgInjectTokens}`,
      ok: gates.avgInjectTokens,
    },
    {
      key: 'p95LatencyMs',
      label: 'p95 Latency (<= 50.0ms)',
      value: `${report.overall.p95LatencyMs.toFixed(1)}ms`,
      ok: gates.p95LatencyMs,
    },
    {
      key: 'allCriticalPassed',
      label: 'Critical Passed (100%)',
      value: `${report.overall.criticalPassed}/${report.overall.criticalTotal}`,
      ok: gates.allCriticalPassed,
    },
    {
      key: 'allBudgetPass',
      label: `All Budget Constraints Pass (hard <= ${hardBudget})`,
      value: `${budgetPassedCount}/${evaluatedResults.length} (max=${report.overall.maxBudgetTokens})`,
      ok: gates.allBudgetPass,
    },
    {
      key: 'allImplicitStablePass',
      label: 'All Implicit Stable Layer Pass',
      value:
        implicitTotal > 0
          ? `${gates.allImplicitStablePass ? implicitTotal : 'failed'}/${implicitTotal}`
          : 'n/a',
      ok: gates.allImplicitStablePass,
    },
  ];
}

export function formatMvpGateSection(report: EvalReport, cfg: PluginConfig = DEFAULTS): string {
  const gateLines = buildMvpGateLines(report, cfg);
  return [
    '--- MVP Gate Verification (§8.3) ---',
    ...gateLines.map((g) => `- ${g.label.padEnd(48)} ${g.value} [${g.ok ? 'OK' : 'FAIL'}]`),
  ].join('\n');
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  cfg: PluginConfig = DEFAULTS
): Promise<number> {
  const parsed = parseCliArgs(argv);

  console.log('=============================================================================');
  console.log('                DSH Memory Evaluation v2 Benchmark Suite                     ');
  console.log('=============================================================================');

  if (parsed.scale) {
    console.log(
      `Generating scale benchmark dataset (${parsed.scaleCount} memories${parsed.coldCache ? ', coldCache' : ''})...`
    );
    const dataset = generateScaleDataset(parsed.scaleCount);
    const startTime = Date.now();
    const scaleRes = runScaleBenchmark(dataset, undefined, cfg, {
      coldCache: parsed.coldCache,
    });
    const durationMs = Date.now() - startTime;

    console.log(
      `\nIndexed ${scaleRes.memoryCount} memories in ${(scaleRes.setupMs / 1000).toFixed(2)}s`
    );
    console.log('\n--- Scale Benchmark Summary ---\n');
    console.log(formatMetricsTable(scaleRes.report));
    console.log(`\nTotal execution time: ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`\n${formatMvpGateSection(scaleRes.report, cfg)}`);

    return scaleRes.report.mvpPassed ? 0 : 1;
  }

  const allCases = generateDataset();
  const availableSuites = Array.from(new Set(allCases.map((c) => c.suite)));
  const casesToRun = parsed.suiteFilter
    ? allCases.filter((c) => c.suite.toLowerCase() === parsed.suiteFilter)
    : allCases;

  if (casesToRun.length === 0) {
    console.error(`Error: No test cases found matching suite '${parsed.suiteFilter}'.`);
    console.log(`Available suites: ${availableSuites.join(', ')}`);
    return 1;
  }

  console.log(
    `Loaded ${casesToRun.length} evaluation cases${parsed.suiteFilter ? ` (filter: ${parsed.suiteFilter})` : ''}${parsed.coldCache ? ' [coldCache]' : ''}... Running benchmark...`
  );
  const startTime = Date.now();
  const report = runEvalSuite(casesToRun, undefined, cfg, undefined, {
    coldCache: parsed.coldCache,
  });
  const durationMs = Date.now() - startTime;

  console.log('\n--- Results Summary ---\n');
  console.log(formatMetricsTable(report));
  console.log(`\nExecution time: ${(durationMs / 1000).toFixed(2)}s`);

  if (!parsed.suiteFilter) {
    console.log(`\n${formatMvpGateSection(report, cfg)}`);

    console.log('\n=============================================================================');
    if (report.mvpPassed) {
      console.log(' [PASS] ALL MVP EVALUATION THRESHOLDS MET SUCCESSFULLY!');
      console.log('=============================================================================');
      return 0;
    } else {
      console.error(' [FAIL] MVP THRESHOLDS NOT MET. Please review regressions.');
      console.log('=============================================================================');
      return 1;
    }
  } else {
    const passed = report.overall.passedCases === report.overall.totalCases;
    console.log(
      `\nSuite '${parsed.suiteFilter}' result: ${report.overall.passedCases}/${report.overall.totalCases} passed.`
    );
    return passed ? 0 : 1;
  }
}

// Auto-run if executed as script
if (
  process.argv[1] &&
  (process.argv[1].endsWith('eval-cli.ts') || process.argv[1].endsWith('eval-cli.js'))
) {
  runCli().then((code) => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
