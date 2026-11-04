import type { EvalCase, CaseResult, SuiteMetrics, EvalReport } from './types.js';

/**
 * 计算一组用例与测试结果的指标
 */
export function calculateSuiteMetrics(
  suiteName: string,
  cases: EvalCase[],
  caseResults: Record<string, CaseResult>
): SuiteMetrics {
  const totalCases = cases.length;
  if (totalCases === 0) {
    return {
      suite: suiteName,
      totalCases: 0,
      passedCases: 0,
      recallAtInject: 0,
      excludeViolations: 0,
      emptyPrecision: 0,
      criticalPassRate: 0,
      criticalTotal: 0,
      criticalPassed: 0,
      avgInjectTokens: 0,
      maxBudgetTokens: 0,
      p95LatencyMs: 0,
    };
  }

  let passedCases = 0;
  let excludeViolations = 0;

  const nonEmptyIncludeCases = cases.filter(c => c.expect.include.length > 0);
  let includePassedCount = 0;
  let totalDynamicTokens = 0;

  const emptyCases = cases.filter(c => c.expect.include.length === 0);
  let emptyPassedCount = 0;

  const criticalCases = cases.filter(c => c.critical);
  let criticalPassedCount = 0;

  let maxBudgetTokens = 0;
  const latencies: number[] = [];

  for (const c of cases) {
    const res = caseResults[c.id];
    if (!res) continue;

    if (res.pass) passedCases++;
    if (!res.excludePass) excludeViolations++;

    if (c.expect.include.length > 0) {
      if (res.includePass) includePassedCount++;
      totalDynamicTokens += res.dynamicTokens;
    } else {
      if (res.emptyPass) emptyPassedCount++;
    }

    if (c.critical && res.pass) {
      criticalPassedCount++;
    }

    const totalBudget = res.stableTokens + res.dynamicTokens;
    if (totalBudget > maxBudgetTokens) {
      maxBudgetTokens = totalBudget;
    }

    latencies.push(res.latencyMs);
  }

  const recallAtInject =
    nonEmptyIncludeCases.length > 0 ? includePassedCount / nonEmptyIncludeCases.length : 1.0;

  const emptyPrecision = emptyCases.length > 0 ? emptyPassedCount / emptyCases.length : 1.0;

  const criticalPassRate =
    criticalCases.length > 0 ? criticalPassedCount / criticalCases.length : 1.0;

  const avgInjectTokens =
    nonEmptyIncludeCases.length > 0 ? Math.round(totalDynamicTokens / nonEmptyIncludeCases.length) : 0;

  latencies.sort((a, b) => a - b);
  const p95Idx = Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95));
  const p95LatencyMs = latencies.length > 0 ? latencies[p95Idx] : 0;

  return {
    suite: suiteName,
    totalCases,
    passedCases,
    recallAtInject: Number(recallAtInject.toFixed(4)),
    excludeViolations,
    emptyPrecision: Number(emptyPrecision.toFixed(4)),
    criticalPassRate: Number(criticalPassRate.toFixed(4)),
    criticalTotal: criticalCases.length,
    criticalPassed: criticalPassedCount,
    avgInjectTokens,
    maxBudgetTokens,
    p95LatencyMs: Number(p95LatencyMs.toFixed(2)),
  };
}

/**
 * 汇总生成完整评测报告并校验 MVP 门槛 (§8.3)
 */
export function buildEvalReport(
  allCases: EvalCase[],
  caseResults: Record<string, CaseResult>,
  strategyVersion?: number
): EvalReport {
  const overall = calculateSuiteMetrics('overall', allCases, caseResults);

  // 按 suite 分组
  const suiteMap = new Map<string, EvalCase[]>();
  for (const c of allCases) {
    if (!suiteMap.has(c.suite)) {
      suiteMap.set(c.suite, []);
    }
    suiteMap.get(c.suite)!.push(c);
  }

  const suites: Record<string, SuiteMetrics> = {};
  for (const [suiteName, cases] of suiteMap.entries()) {
    suites[suiteName] = calculateSuiteMetrics(suiteName, cases, caseResults);
  }

  // MVP 门槛判定：
  // recallAtInject ≥ 0.7, excludeViolations = 0, emptyPrecision ≥ 0.8,
  // avgInjectTokens ≤ 1600, p95 ≤ 50ms, 全部 critical 通过
  const allCriticalPassed = overall.criticalPassed === overall.criticalTotal;
  const allBudgetPass = allCases.every(c => caseResults[c.id]?.budgetPass);
  const allImplicitStablePass = allCases
    .filter(c => c.suite === 'implicit')
    .every(c => caseResults[c.id]?.stablePass);

  const mvpPassed =
    overall.recallAtInject >= 0.7 &&
    overall.excludeViolations === 0 &&
    overall.emptyPrecision >= 0.8 &&
    overall.avgInjectTokens <= 1600 &&
    overall.p95LatencyMs <= 50 &&
    allCriticalPassed &&
    allBudgetPass &&
    allImplicitStablePass;

  return {
    timestamp: Date.now(),
    strategyVersion,
    overall,
    suites,
    caseResults,
    mvpPassed,
  };
}
