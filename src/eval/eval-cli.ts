import { generateDataset } from './gen-dataset.js';
import { runEvalSuite } from './runner.js';
import type { SuiteMetrics, EvalReport } from './types.js';

function formatMetricsTable(report: EvalReport): string {
  const rows: SuiteMetrics[] = [
    report.overall,
    ...Object.values(report.suites),
  ];

  const headers = [
    'Suite',
    'Total',
    'Passed',
    'Recall@Inj',
    'ExclViol',
    'EmptyPrec',
    'CritPass',
    'AvgTokens',
    'MaxTokens',
    'p95 (ms)',
  ];

  const lines: string[] = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);

  for (const r of rows) {
    const rowData = [
      r.suite.padEnd(10),
      String(r.totalCases).padStart(5),
      String(r.passedCases).padStart(6),
      `${(r.recallAtInject * 100).toFixed(1)}%`.padStart(10),
      String(r.excludeViolations).padStart(8),
      `${(r.emptyPrecision * 100).toFixed(1)}%`.padStart(9),
      `${r.criticalPassed}/${r.criticalTotal}`.padStart(8),
      String(r.avgInjectTokens).padStart(9),
      String(r.maxBudgetTokens).padStart(9),
      `${r.p95LatencyMs.toFixed(1)}ms`.padStart(8),
    ];
    lines.push(`| ${rowData.join(' | ')} |`);
  }

  return lines.join('\n');
}

export async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  const suiteFilter = args.find(a => !a.startsWith('-'))?.toLowerCase();

  console.log('===============================================================');
  console.log('            DSH Memory Evaluation Benchmark Suite              ');
  console.log('===============================================================');

  const allCases = generateDataset();
  const casesToRun = suiteFilter
    ? allCases.filter(c => c.suite.toLowerCase() === suiteFilter)
    : allCases;

  if (casesToRun.length === 0) {
    console.error(`Error: No test cases found matching suite '${suiteFilter}'.`);
    console.log(`Available suites: factual, temporal, procedural, implicit`);
    return 1;
  }

  console.log(`Loaded ${casesToRun.length} evaluation cases${suiteFilter ? ` (filter: ${suiteFilter})` : ''}... Running benchmark...`);
  const startTime = Date.now();
  const report = runEvalSuite(casesToRun);
  const durationMs = Date.now() - startTime;

  console.log('\n--- Results Summary ---\n');
  console.log(formatMetricsTable(report));
  console.log(`\nExecution time: ${(durationMs / 1000).toFixed(2)}s`);

  if (!suiteFilter) {
    console.log('\n--- MVP Gate Verification (§8.3) ---');
    console.log(`- Recall @ Inject (>= 0.70):   ${(report.overall.recallAtInject * 100).toFixed(1)}% [${report.overall.recallAtInject >= 0.7 ? 'OK' : 'FAIL'}]`);
    console.log(`- Exclude Violations (== 0):    ${report.overall.excludeViolations} [${report.overall.excludeViolations === 0 ? 'OK' : 'FAIL'}]`);
    console.log(`- Empty Precision (>= 0.80):    ${(report.overall.emptyPrecision * 100).toFixed(1)}% [${report.overall.emptyPrecision >= 0.8 ? 'OK' : 'FAIL'}]`);
    console.log(`- Avg Dynamic Tokens (<= 1600): ${report.overall.avgInjectTokens} [${report.overall.avgInjectTokens <= 1600 ? 'OK' : 'FAIL'}]`);
    console.log(`- Max Budget Tokens (<= 3200):  ${report.overall.maxBudgetTokens} [${report.overall.maxBudgetTokens <= 3200 ? 'OK' : 'FAIL'}]`);
    console.log(`- p95 Latency (<= 50ms):        ${report.overall.p95LatencyMs.toFixed(1)}ms [${report.overall.p95LatencyMs <= 50 ? 'OK' : 'FAIL'}]`);
    console.log(`- Critical Passed (100%):       ${report.overall.criticalPassed}/${report.overall.criticalTotal} [${report.overall.criticalPassed === report.overall.criticalTotal ? 'OK' : 'FAIL'}]`);

    console.log('\n===============================================================');
    if (report.mvpPassed) {
      console.log(' [PASS] ALL MVP EVALUATION THRESHOLDS MET SUCCESSFULLY!');
      console.log('===============================================================');
      return 0;
    } else {
      console.error(' [FAIL] MVP THRESHOLDS NOT MET. Please review regressions.');
      console.log('===============================================================');
      return 1;
    }
  } else {
    const passed = report.overall.passedCases === report.overall.totalCases;
    console.log(`\nSuite '${suiteFilter}' result: ${report.overall.passedCases}/${report.overall.totalCases} passed.`);
    return passed ? 0 : 1;
  }
}

// Auto-run if executed as script
if (process.argv[1] && (process.argv[1].endsWith('eval-cli.ts') || process.argv[1].endsWith('eval-cli.js'))) {
  runCli().then(code => {
    if (code !== 0) {
      process.exit(code);
    }
  });
}
