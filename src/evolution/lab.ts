import type { Db, StrategyConfig, ChannelName } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  getActiveStrategy,
  promoteStrategy,
  rollbackStrategy,
  validateAndClampStrategy,
} from './strategy.js';
import { generateDataset, createSeededRandom } from '../eval/gen-dataset.js';
import { runEvalSuite } from '../eval/runner.js';
import type { EvalCase, SuiteMetrics, EvalReport } from '../eval/types.js';

export interface LabRunOptions {
  seed?: number;
  candidatesCount?: number;
  mutationScale?: number;
  cases?: EvalCase[];
}

export interface LabResult {
  promoted: boolean;
  baselineMetrics: SuiteMetrics;
  bestMetrics?: SuiteMetrics;
  bestCandidate?: StrategyConfig;
  promotedVersion?: number;
  reason?: string;
}

/**
 * 变异生成候选策略
 */
export function mutateStrategy(
  base: StrategyConfig,
  scale: number,
  rand: () => number,
  cfg: PluginConfig = DEFAULTS
): StrategyConfig {
  function mut(val: number, minVal: number, maxVal: number): number {
    const delta = (rand() * 2 - 1) * scale;
    const mutated = val * (1 + delta);
    return Math.max(minVal, Math.min(maxVal, mutated));
  }

  // 1. rrfK 变异
  const rrfK = Math.round(mut(base.rrfK || 60, 20, 100));

  // 2. 通道权重变异
  const channelWeights = { ...base.channelWeights };
  for (const ch of Object.keys(channelWeights) as ChannelName[]) {
    channelWeights[ch] = Number(mut(channelWeights[ch], 0.1, 3.0).toFixed(4));
  }

  // 3. 评分权重变异
  const scoreWeights = { ...base.scoreWeights };
  for (const k of Object.keys(scoreWeights) as (keyof typeof scoreWeights)[]) {
    scoreWeights[k] = Math.max(0.01, mut(scoreWeights[k], 0.01, 1.0));
  }

  // 4. minRelevance 变异
  const minRelevance = Number(mut(base.minRelevance || 0.15, 0.05, 0.4).toFixed(4));

  // 5. dynamicBudgetTokens 变异
  const dynamicCap = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  const minDyn = Math.min(800, dynamicCap);
  const dynamicBudgetTokens = Math.round(
    mut(base.dynamicBudgetTokens || 1600, minDyn, dynamicCap)
  );

  // 6. maxItems 变异
  const maxItems = Math.round(mut(base.maxItems || 6, 1, cfg.maxLabItems || 12));

  const candidate: StrategyConfig = {
    rrfK,
    channelWeights,
    scoreWeights,
    minRelevance,
    dynamicBudgetTokens,
    maxItems,
  };

  return validateAndClampStrategy(candidate, cfg);
}

/**
 * 加载评测用例集 (优先从 eval_cases 表加载，不足时补齐 generateDataset)
 */
export function loadLabEvalCases(db: Db, cfg: PluginConfig = DEFAULTS): EvalCase[] {
  const rows = db.all<{ payload: string }>('SELECT payload FROM eval_cases');
  const dbCases: EvalCase[] = [];

  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.payload) as EvalCase;
      if (parsed.id && parsed.query && parsed.expect) {
        dbCases.push(parsed);
      }
    } catch {}
  }

  if (dbCases.length >= (cfg.labMinEvalCases || 30)) {
    return dbCases;
  }

  // 补齐合成回归集
  const synthCases = generateDataset();
  const existingIds = new Set(dbCases.map((c) => c.id));
  const merged = [...dbCases];
  for (const c of synthCases) {
    if (!existingIds.has(c.id)) {
      merged.push(c);
      existingIds.add(c.id);
    }
  }

  return merged;
}

/**
 * 运行策略实验室进化 (§5.16)
 */
export function runStrategyEvolution(
  db: Db,
  options: LabRunOptions = {},
  cfg: PluginConfig = DEFAULTS
): LabResult {
  const cases = options.cases || loadLabEvalCases(db, cfg);
  const activeStrat = getActiveStrategy(db, cfg);

  // 1. 基线评估 M0
  const m0Report = runEvalSuite(cases, activeStrat.config, cfg, activeStrat.version);
  const m0 = m0Report.overall;

  // 2. 停滞探索检测 (连续 3 次无晋升 → 比例由 0.2 升至 0.4)
  const stagRow = db.get<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'lab.consecutive_stagnations'"
  );
  let consecutiveStags = stagRow ? parseInt(stagRow.value, 10) || 0 : 0;

  let s = options.mutationScale ?? (consecutiveStags >= 3 ? 0.4 : 0.2);
  const candCount = options.candidatesCount ?? cfg.labCandidates ?? 8;
  const seed = options.seed ?? Date.now();
  const rand = createSeededRandom(seed);

  // 3. 生成变异候选并分别评测
  interface CandidateEval {
    config: StrategyConfig;
    report: EvalReport;
  }

  const qualified: CandidateEval[] = [];

  for (let i = 0; i < candCount; i++) {
    const candidateConfig = mutateStrategy(activeStrat.config, s, rand, cfg);
    const candidateReport = runEvalSuite(cases, candidateConfig, cfg);
    const mi = candidateReport.overall;

    // 4. 判定晋升条件 (必须全部满足，见 §5.16)
    // 4.1 recallAtInject 至少提升 0.02
    const recallPassed = mi.recallAtInject >= m0.recallAtInject + 0.02;

    // 4.2 平均注入 Token 不超过基线 1.10 倍
    const tokensPassed = mi.avgInjectTokens <= m0.avgInjectTokens * 1.1;

    // 4.3 关键用例保持性 (基线通过的 critical 用例，候选必须全部保持通过)
    let criticalPreserved = true;
    for (const c of cases) {
      if (c.critical) {
        const m0Pass = m0Report.caseResults[c.id]?.pass;
        const miPass = candidateReport.caseResults[c.id]?.pass;
        if (m0Pass && !miPass) {
          criticalPreserved = false;
          break;
        }
      }
    }

    // 4.4 exclude 违规不增加
    const excludePassed = mi.excludeViolations <= m0.excludeViolations;

    // 4.5 空门槛精度 >= max(M0.emptyPrecision, 0.8)
    const emptyPassed = mi.emptyPrecision >= Math.max(m0.emptyPrecision, 0.8);

    // 4.6 预算硬约束全部通过
    const allBudgetPassed = cases.every((c) => candidateReport.caseResults[c.id]?.budgetPass);
    const allStablePassed = cases
      .filter((c) => c.suite === 'implicit')
      .every((c) => candidateReport.caseResults[c.id]?.stablePass);

    if (
      recallPassed &&
      tokensPassed &&
      criticalPreserved &&
      excludePassed &&
      emptyPassed &&
      allBudgetPassed &&
      allStablePassed
    ) {
      qualified.push({ config: candidateConfig, report: candidateReport });
    }
  }

  // 5. 择优晋升
  if (qualified.length === 0) {
    // 晋升失败，增加停滞计数
    consecutiveStags++;
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('lab.consecutive_stagnations', ?)", [
      consecutiveStags.toString(),
    ]);

    return {
      promoted: false,
      baselineMetrics: m0,
      reason: `None of the ${candCount} candidates satisfied all promotion gates (s=${s}).`,
    };
  }

  // 按 recall 降序、avgTokens 升序排序，取最优候选
  qualified.sort((a, b) => {
    if (b.report.overall.recallAtInject !== a.report.overall.recallAtInject) {
      return b.report.overall.recallAtInject - a.report.overall.recallAtInject;
    }
    return a.report.overall.avgInjectTokens - b.report.overall.avgInjectTokens;
  });

  const best = qualified[0];

  // 查询当前最大版本号
  const maxRow = db.get<{ max_v: number | null }>('SELECT MAX(version) as max_v FROM strategies');
  const nextVersion = (maxRow?.max_v ?? activeStrat.version) + 1;

  // 事务晋升
  promoteStrategy(db, nextVersion, best.config, activeStrat.version, best.report, cfg);

  // 清零停滞计数
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('lab.consecutive_stagnations', '0')");

  return {
    promoted: true,
    baselineMetrics: m0,
    bestMetrics: best.report.overall,
    bestCandidate: best.config,
    promotedVersion: nextVersion,
  };
}

/**
 * 哨兵监控与自动回滚 (§5.16)
 *
 * 比较新策略上线后最近 50 个 turn 与之前的纠正率
 * 若 新纠正率 > 旧纠正率 + 0.05 则自动回滚至 parent
 */
export function checkSentinelAndRollback(
  db: Db,
  windowSize = 50,
  diffThreshold = 0.05
): { rolledBack: boolean; fromVersion?: number; toVersion?: number; reason?: string } {
  const active = db.get<{ version: number; parent: number | null; promoted_at: number | null }>(
    "SELECT version, parent, promoted_at FROM strategies WHERE status = 'active' LIMIT 1"
  );

  if (!active || !active.parent || !active.promoted_at) {
    return { rolledBack: false, reason: 'Active strategy has no parent or promotion timestamp' };
  }

  // 统计晋升后的纠正率 (最多取 windowSize 条)
  const afterRow = db.get<{ avg_corr: number | null; cnt: number }>(
    `SELECT AVG(correction) as avg_corr, COUNT(*) as cnt
     FROM turn_metrics
     WHERE strategy_v = ?
     ORDER BY created_at DESC LIMIT ?`,
    [active.version, windowSize]
  );

  if (!afterRow || afterRow.cnt < 10) {
    return { rolledBack: false, reason: 'Insufficient post-promotion turns to evaluate' };
  }

  // 统计晋升前 (parent 版本) 的纠正率
  const beforeRow = db.get<{ avg_corr: number | null; cnt: number }>(
    `SELECT AVG(correction) as avg_corr, COUNT(*) as cnt
     FROM turn_metrics
     WHERE strategy_v = ?
     ORDER BY created_at DESC LIMIT ?`,
    [active.parent, windowSize]
  );

  if (!beforeRow || beforeRow.cnt < 10) {
    return { rolledBack: false, reason: 'Insufficient pre-promotion turns to evaluate' };
  }

  const postRate = afterRow.avg_corr ?? 0;
  const preRate = beforeRow.avg_corr ?? 0;

  if (postRate > preRate + diffThreshold) {
    const res = rollbackStrategy(db, active.parent);
    if (res.ok) {
      console.warn(
        `[dsh-memory] Sentinel rollback triggered: strategy v${active.version} correction rate (${(postRate * 100).toFixed(1)}%) exceeded parent v${active.parent} (${(preRate * 100).toFixed(1)}%) + ${(diffThreshold * 100).toFixed(1)}%`
      );
      return {
        rolledBack: true,
        fromVersion: active.version,
        toVersion: active.parent,
        reason: `Correction rate increased from ${(preRate * 100).toFixed(1)}% to ${(postRate * 100).toFixed(1)}%`,
      };
    }
  }

  return { rolledBack: false };
}

/**
 * 采集收获用例保存至 eval_cases 表 (§6.6, M5-T3)
 */
export function harvestSample(db: Db, sample: EvalCase): void {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO eval_cases (id, suite, payload, critical, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      sample.id,
      sample.suite,
      JSON.stringify(sample),
      sample.critical ? 1 : 0,
      now,
    ]
  );
}
