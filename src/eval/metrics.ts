import { DEFAULTS, type PluginConfig } from '../config.js';
import type { CaseResult, EvalCase, EvalReport, MvpGateStatus, SuiteMetrics } from './types.js';

function percentileNearestRank(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

interface CaseIrMetrics {
  precision: number;
  rr: number;
  ndcg: number;
}

function computeCaseIrMetrics(evalCase: EvalCase, res: CaseResult): CaseIrMetrics {
  const targets =
    evalCase.expect.targetSubstrings && evalCase.expect.targetSubstrings.length > 0
      ? evalCase.expect.targetSubstrings
      : evalCase.expect.include;

  if (targets.length === 0) {
    return { precision: 0, rr: 0, ndcg: 0 };
  }

  // Exact rank-level IR computation when per-item injectedTexts are available
  if (res.injectedTexts !== undefined) {
    const texts = res.injectedTexts;
    const k = texts.length;
    if (k === 0) {
      return { precision: 0, rr: 0, ndcg: 0 };
    }

    let relevantCount = 0;
    let firstRelevantRank = 0;
    let dcg = 0;
    const matchedUniqueTargets = new Set<string>();

    for (let i = 0; i < k; i++) {
      const text = texts[i];
      let matchedAny = false;
      for (const target of targets) {
        if (text.includes(target)) {
          matchedAny = true;
          matchedUniqueTargets.add(target);
        }
      }
      if (matchedAny) {
        relevantCount++;
        if (firstRelevantRank === 0) {
          firstRelevantRank = i + 1;
        }
        dcg += 1 / Math.log2(i + 2);
      }
    }

    const precision = relevantCount / k;
    const rr = firstRelevantRank > 0 ? 1 / firstRelevantRank : 0;

    if (relevantCount === 0) {
      return { precision: 0, rr: 0, ndcg: 0 };
    }

    const missedTargetsCount = Math.max(0, targets.length - matchedUniqueTargets.size);
    const idealRelSlots = Math.min(k, relevantCount + missedTargetsCount);
    let idcg = 0;
    for (let i = 0; i < idealRelSlots; i++) {
      idcg += 1 / Math.log2(i + 2);
    }
    const ndcg = idcg > 0 ? Math.min(1, dcg / idcg) : 0;

    return { precision, rr, ndcg };
  }

  // Backwards-compatible fallback when callers pass legacy CaseResult without injectedTexts
  if (!res.includePass) {
    return { precision: 0, rr: 0, ndcg: 0 };
  }
  const injectedCount = res.injectedIds?.length ?? 0;
  const precision =
    injectedCount > 0 ? Math.min(1, Math.max(1, targets.length) / injectedCount) : 1.0;
  return { precision, rr: 1.0, ndcg: 1.0 };
}

/**
 * 计算一组用例与测试结果的指标（过滤未评测用例，避免分母污染）
 */
export function calculateSuiteMetrics(
  suiteName: string,
  cases: EvalCase[],
  caseResults: Record<string, CaseResult>
): SuiteMetrics {
  const evaluatedCases = cases.filter((c) => caseResults[c.id] !== undefined);
  const totalCases = evaluatedCases.length;

  if (totalCases === 0) {
    return {
      suite: suiteName,
      totalCases: 0,
      passedCases: 0,
      recallAtInject: 0,
      precisionAtInject: 0,
      mrr: 0,
      ndcgAtK: 0,
      excludeViolations: 0,
      emptyPrecision: 0,
      criticalPassRate: 0,
      criticalTotal: 0,
      criticalPassed: 0,
      avgInjectTokens: 0,
      maxBudgetTokens: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
    };
  }

  let passedCases = 0;
  let excludeViolations = 0;

  const nonEmptyIncludeCases = evaluatedCases.filter((c) => c.expect.include.length > 0);
  let includePassedCount = 0;
  let totalDynamicTokens = 0;
  let totalPrecision = 0;
  let totalRr = 0;
  let totalNdcg = 0;

  const emptyCases = evaluatedCases.filter((c) => c.expect.include.length === 0);
  let emptyPassedCount = 0;

  const criticalCases = evaluatedCases.filter((c) => c.critical);
  let criticalPassedCount = 0;

  let maxBudgetTokens = 0;
  const latencies: number[] = [];

  for (const c of evaluatedCases) {
    const res = caseResults[c.id]!;

    if (res.pass) passedCases++;
    if (!res.excludePass) excludeViolations++;

    if (c.expect.include.length > 0) {
      if (res.includePass) includePassedCount++;
      totalDynamicTokens += res.dynamicTokens;

      const ir = computeCaseIrMetrics(c, res);
      totalPrecision += ir.precision;
      totalRr += ir.rr;
      totalNdcg += ir.ndcg;
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

  const nonEmptyCount = nonEmptyIncludeCases.length;
  const recallAtInject = nonEmptyCount > 0 ? includePassedCount / nonEmptyCount : 0;
  const precisionAtInject = nonEmptyCount > 0 ? totalPrecision / nonEmptyCount : 0;
  const mrr = nonEmptyCount > 0 ? totalRr / nonEmptyCount : 0;
  const ndcgAtK = nonEmptyCount > 0 ? totalNdcg / nonEmptyCount : 0;

  const emptyPrecision = emptyCases.length > 0 ? emptyPassedCount / emptyCases.length : 1.0;

  const criticalPassRate =
    criticalCases.length > 0 ? criticalPassedCount / criticalCases.length : 1.0;

  const avgInjectTokens = nonEmptyCount > 0 ? Math.round(totalDynamicTokens / nonEmptyCount) : 0;

  latencies.sort((a, b) => a - b);
  const p50LatencyMs = percentileNearestRank(latencies, 0.5);
  const p95LatencyMs = percentileNearestRank(latencies, 0.95);

  return {
    suite: suiteName,
    totalCases,
    passedCases,
    recallAtInject: Number(recallAtInject.toFixed(4)),
    precisionAtInject: Number(precisionAtInject.toFixed(4)),
    mrr: Number(mrr.toFixed(4)),
    ndcgAtK: Number(ndcgAtK.toFixed(4)),
    excludeViolations,
    emptyPrecision: Number(emptyPrecision.toFixed(4)),
    criticalPassRate: Number(criticalPassRate.toFixed(4)),
    criticalTotal: criticalCases.length,
    criticalPassed: criticalPassedCount,
    avgInjectTokens,
    maxBudgetTokens,
    p50LatencyMs: Number(p50LatencyMs.toFixed(2)),
    p95LatencyMs: Number(p95LatencyMs.toFixed(2)),
  };
}

/** Alias preserving compatibility for callers importing computeSuiteMetrics */
export const computeSuiteMetrics = calculateSuiteMetrics;

/**
 * 汇总生成完整评测报告并校验 MVP 门槛 (§8.3)
 */
export function buildEvalReport(
  allCases: EvalCase[],
  caseResults: Record<string, CaseResult>,
  strategyVersion?: number,
  cfg?: PluginConfig
): EvalReport {
  const overall = calculateSuiteMetrics('overall', allCases, caseResults);

  // 按 suite 分组
  const suiteMap = new Map<string, EvalCase[]>();
  for (const c of allCases) {
    let list = suiteMap.get(c.suite);
    if (!list) {
      list = [];
      suiteMap.set(c.suite, list);
    }
    list.push(c);
  }

  const suites: Record<string, SuiteMetrics> = {};
  for (const [suiteName, cases] of suiteMap.entries()) {
    suites[suiteName] = calculateSuiteMetrics(suiteName, cases, caseResults);
  }

  const evaluatedCases = allCases.filter((c) => caseResults[c.id] !== undefined);
  const nonEmptyIncludeCases = evaluatedCases.filter((c) => c.expect.include.length > 0);
  const maxAvgDynamicTokens = cfg?.dynamicBudgetTokens ?? DEFAULTS.dynamicBudgetTokens;

  // MVP 门槛判定：
  // 非空用例覆盖 > 0，recallAtInject >= 0.7，excludeViolations == 0，emptyPrecision >= 0.8，
  // avgInjectTokens <= maxAvgDynamicTokens，p95 <= 50ms，全部 critical / budget / implicit stable 通过
  const mvpGates: MvpGateStatus = {
    hasCases: overall.totalCases > 0,
    hasNonEmptyCases: nonEmptyIncludeCases.length > 0,
    recallAtInject: overall.recallAtInject >= 0.7,
    excludeViolations: overall.excludeViolations === 0,
    emptyPrecision: overall.emptyPrecision >= 0.8,
    avgInjectTokens: overall.avgInjectTokens <= maxAvgDynamicTokens,
    p95LatencyMs: overall.p95LatencyMs <= 50,
    allCriticalPassed:
      overall.criticalTotal === 0 || overall.criticalPassed === overall.criticalTotal,
    allBudgetPass:
      overall.totalCases > 0 && evaluatedCases.every((c) => Boolean(caseResults[c.id]?.budgetPass)),
    allImplicitStablePass: evaluatedCases
      .filter((c) => c.suite === 'implicit')
      .every((c) => Boolean(caseResults[c.id]?.stablePass)),
  };

  const mvpPassed =
    mvpGates.hasCases &&
    mvpGates.hasNonEmptyCases &&
    mvpGates.recallAtInject &&
    mvpGates.excludeViolations &&
    mvpGates.emptyPrecision &&
    mvpGates.avgInjectTokens &&
    mvpGates.p95LatencyMs &&
    mvpGates.allCriticalPassed &&
    mvpGates.allBudgetPass &&
    mvpGates.allImplicitStablePass;

  return {
    timestamp: Date.now(),
    strategyVersion,
    overall,
    suites,
    caseResults,
    mvpPassed,
    mvpGates,
  };
}
