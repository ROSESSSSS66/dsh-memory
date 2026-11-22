import type { Db, StrategyConfig, ChannelName } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import {
  SENTINEL_RESTORED_VERSION_KEY,
  getActiveStrategy,
  promoteStrategy,
  rollbackStrategy,
  validateAndClampStrategy,
} from './strategy.js';
import { redactSecrets } from '../core/privacy.js';
import { generateDataset, createSeededRandom } from '../eval/gen-dataset.js';
import { runEvalSuite } from '../eval/runner.js';
import type { EvalCase, SuiteMetrics, EvalReport } from '../eval/types.js';

const MAX_DB_EVAL_CASES = 50;
const DEFAULT_SENTINEL_MIN_TURNS = 30;

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

export interface SentinelOptions {
  minTurns?: number;
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
    scoreWeights[k] = Math.max(0.01, mut(scoreWeights[k] ?? 0.2, 0.01, 1.0));
  }

  // 4. minRelevance 变异
  const minRelevance = Number(mut(base.minRelevance || 0.15, 0.05, 0.4).toFixed(4));

  // 5. dynamicBudgetTokens 变异
  const dynamicCap = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  const minDyn = Math.min(800, dynamicCap);
  const dynamicBudgetTokens =
    cfg.dynamicBudgetTokens === 0 || base.dynamicBudgetTokens === 0
      ? 0
      : Math.round(mut(base.dynamicBudgetTokens ?? 1600, minDyn, dynamicCap));

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
 * 加载评测用例集：
 * 始终包含完整的合成回归基准集 generateDataset()，并追加最多 50 条最新的数据库持久化 eval_cases，
 * 绝不因收获用例增长而丢弃核心基准回归集。
 */
export function loadLabEvalCases(db: Db, _cfg: PluginConfig = DEFAULTS): EvalCase[] {
  const synthCases = generateDataset();
  const merged: EvalCase[] = [...synthCases];
  const existingIds = new Set<string>(synthCases.map((c) => c.id));

  const rows = db.all<{ payload: string }>(
    'SELECT payload FROM eval_cases ORDER BY created_at DESC, id DESC LIMIT ?',
    [MAX_DB_EVAL_CASES]
  );

  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.payload) as EvalCase;
      if (
        parsed.id &&
        !existingIds.has(parsed.id) &&
        parsed.query &&
        parsed.expect &&
        Array.isArray(parsed.setup) &&
        (parsed.setup.length > 0 || (parsed.expect.include?.length ?? 0) === 0)
      ) {
        merged.push(parsed);
        existingIds.add(parsed.id);
      }
    } catch {}
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

  const s = options.mutationScale ?? (consecutiveStags >= 3 ? 0.4 : 0.2);
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

    // 4. 判定晋升条件 (必须全部满足，见 §5.16 + 高饱和区 Pareto 效率晋升门)
    const recallPassed =
      mi.recallAtInject >= m0.recallAtInject + 0.02 ||
      (m0.recallAtInject >= 0.985 &&
        mi.recallAtInject >= m0.recallAtInject &&
        mi.avgInjectTokens <= m0.avgInjectTokens * 0.95);

    const tokensPassed = mi.avgInjectTokens <= m0.avgInjectTokens * 1.1;

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

    const excludePassed = mi.excludeViolations <= m0.excludeViolations;
    const emptyPassed = mi.emptyPrecision >= Math.max(m0.emptyPrecision, 0.8);
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
 * 比较新策略上线后最近 windowSize 个 turn（默认要求前后均至少 30 个 turn）与 parent 的纠正率。
 * 拒绝回滚到 rejected 策略，且对已通过回滚恢复的策略不再触发连锁回滚。
 */
export function checkSentinelAndRollback(
  db: Db,
  windowSize = 50,
  diffThreshold = 0.05,
  options?: SentinelOptions
): { rolledBack: boolean; fromVersion?: number; toVersion?: number; reason?: string } {
  const minTurns = Math.max(1, options?.minTurns ?? DEFAULT_SENTINEL_MIN_TURNS);

  const active = db.get<{ version: number; parent: number | null; promoted_at: number | null }>(
    "SELECT version, parent, promoted_at FROM strategies WHERE status = 'active' LIMIT 1"
  );

  if (!active || !active.parent || !active.promoted_at) {
    return { rolledBack: false, reason: 'Active strategy has no parent or promotion timestamp' };
  }

  // 防止对已经通过回滚恢复的策略触发连锁回滚
  const restoredRow = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    SENTINEL_RESTORED_VERSION_KEY,
  ]);
  if (restoredRow?.value === String(active.version)) {
    return {
      rolledBack: false,
      reason: `Active strategy v${active.version} was already restored via rollback`,
    };
  }

  // 校验父策略状态，禁止回滚至已 rejected 的策略
  const parentRow = db.get<{ version: number; status: string }>(
    'SELECT version, status FROM strategies WHERE version = ?',
    [active.parent]
  );
  if (!parentRow || parentRow.status === 'rejected') {
    return {
      rolledBack: false,
      reason: `Parent strategy v${active.parent} is unavailable or rejected`,
    };
  }

  // 统计晋升后的纠正率 (最多取最近 windowSize 条)
  const afterRow = db.get<{ avg_corr: number | null; cnt: number }>(
    `SELECT AVG(correction) as avg_corr, COUNT(*) as cnt
     FROM (
       SELECT correction FROM turn_metrics
       WHERE strategy_v = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT ?
     )`,
    [active.version, active.promoted_at, windowSize]
  );

  if (!afterRow || afterRow.cnt < minTurns) {
    return { rolledBack: false, reason: 'Insufficient post-promotion turns to evaluate' };
  }

  // 统计晋升前 (parent 版本) 的纠正率 (最多取最近 windowSize 条)
  const beforeRow = db.get<{ avg_corr: number | null; cnt: number }>(
    `SELECT AVG(correction) as avg_corr, COUNT(*) as cnt
     FROM (
       SELECT correction FROM turn_metrics
       WHERE strategy_v = ?
       ORDER BY created_at DESC LIMIT ?
     )`,
    [active.parent, windowSize]
  );

  if (!beforeRow || beforeRow.cnt < minTurns) {
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
    return { rolledBack: false, reason: res.reason };
  }

  return { rolledBack: false };
}

/**
 * 采集收获用例保存至 eval_cases 表 (§6.6, M5-T3)，持久化前对 query 与 setup 做脱敏纵深防御
 */
export function harvestSample(db: Db, sample: EvalCase): void {
  const now = Date.now();
  const sanitizedSample: EvalCase = {
    ...sample,
    query: redactSecrets(sample.query).text,
    setup: Array.isArray(sample.setup)
      ? sample.setup.map((item) => ({
          ...item,
          content: redactSecrets(item.content).text,
        }))
      : [],
  };

  db.run(
    `INSERT OR IGNORE INTO eval_cases (id, suite, payload, critical, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      sanitizedSample.id,
      sanitizedSample.suite,
      JSON.stringify(sanitizedSample),
      sanitizedSample.critical ? 1 : 0,
      now,
    ]
  );
}
