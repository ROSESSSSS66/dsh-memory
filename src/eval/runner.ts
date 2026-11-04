import { performance } from 'node:perf_hooks';
import { openDb } from '../core/db.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { workspaceId } from '../core/scope.js';
import { upsertCandidate } from '../core/writer.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import { render } from '../retrieval/render.js';
import { budgetTokens } from '../core/tokens.js';
import { buildEvalReport } from './metrics.js';
import type { EvalCase, CaseResult, EvalReport } from './types.js';
import type { StrategyConfig, MemoryRecord } from '../types.js';

/**
 * 运行单个评测用例 (独立内存库，固定 now/workspace)
 */
export function runCase(
  testCase: EvalCase,
  strategy?: StrategyConfig,
  cfg: PluginConfig = DEFAULTS
): CaseResult {
  const memDb = openDb(':memory:');
  const fixedNow = new Date(testCase.now).getTime();
  const wsId = workspaceId(testCase.workspace);

  try {
    // 1. 设置记忆前置环境 (setup)
    for (const item of testCase.setup) {
      const atTime = item.at ? new Date(item.at).getTime() : fixedNow;
      const res = upsertCandidate(
        memDb,
        {
          type: item.type,
          content: item.content,
          slot_key: item.slot_key,
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: item.source_kind || 'user',
          confidence: 1.0,
          origin_kinds: ['user'],
          sources: [{ session_id: 'eval_setup_session', seq: 1, kind: 'user' }],
          actor: 'user',
          status: item.status === 'candidate' ? 'candidate' : 'active',
        },
        atTime
      );

      if ('id' in res) {
        if (item.pinned !== undefined) {
          memDb.run('UPDATE memories SET pinned = ? WHERE id = ?', [item.pinned ? 1 : 0, res.id]);
        }
        if (item.status) {
          memDb.run('UPDATE memories SET status = ? WHERE id = ?', [item.status, res.id]);
        }
        if (item.utility !== undefined) {
          memDb.run('UPDATE memories SET utility = ? WHERE id = ?', [item.utility, res.id]);
        }
      }
    }

    // 2. 渲染稳定层
    const stableRecords = memDb.all<MemoryRecord>(
      `SELECT * FROM memories
       WHERE scope = 'workspace' AND workspace_id = ?
         AND pinned = 1 AND status IN ('active', 'frozen')
       ORDER BY id ASC`,
      [wsId]
    );

    const stableRendered = render(stableRecords, {
      layer: 'stable',
      strategyVersion: 1,
    });
    const stableTokens = budgetTokens(stableRendered);

    // 检查稳定层期望
    let stablePass = true;
    if (testCase.expect.expectStable && testCase.expect.expectStable.length > 0) {
      stablePass = testCase.expect.expectStable.every(sub => stableRendered.includes(sub));
    }

    // 3. 构建查询计划并执行动态召回
    const plan = buildQueryPlan({
      userText: testCase.query,
      now: fixedNow,
    });

    const dynamicBudget = strategy?.dynamicBudgetTokens || cfg.dynamicBudgetTokens || 1600;

    const startPerf = performance.now();
    const recallResult = recall(memDb, plan, {
      workspaceId: wsId,
      sessionId: 'eval_session',
      budget: dynamicBudget,
      strategy,
      now: fixedNow,
    });
    const latencyMs = performance.now() - startPerf;

    const dynamicRendered = recallResult.block;
    const dynamicTokens = budgetTokens(dynamicRendered);

    // 4. 判定评测指标
    // 4.1 include
    let includePass = true;
    let emptyPass = true;
    if (testCase.expect.include.length === 0) {
      includePass = true;
      emptyPass = recallResult.items.length === 0;
    } else {
      includePass = testCase.expect.include.every(sub => dynamicRendered.includes(sub));
      emptyPass = true;
    }

    // 4.2 exclude
    let excludePass = true;
    if (testCase.expect.exclude && testCase.expect.exclude.length > 0) {
      excludePass = !testCase.expect.exclude.some(sub => dynamicRendered.includes(sub));
    }

    // 4.3 预算约束
    const maxAllowedTokens = testCase.expect.maxTokens || dynamicBudget;
    const dynamicBudgetPass = dynamicTokens <= maxAllowedTokens;
    const hardBudgetPass = stableTokens + dynamicTokens <= cfg.hardBudgetTokens;
    const budgetPass = dynamicBudgetPass && hardBudgetPass;

    // 综合判定通过
    const pass =
      includePass &&
      excludePass &&
      stablePass &&
      budgetPass &&
      (testCase.expect.include.length > 0 || emptyPass);

    return {
      id: testCase.id,
      pass,
      includePass,
      excludePass,
      stablePass,
      budgetPass,
      emptyPass,
      dynamicTokens,
      stableTokens,
      latencyMs,
      injectedIds: recallResult.items.map(it => it.memory.id),
    };
  } finally {
    memDb.close();
  }
}

/**
 * 运行整组用例并生成评测报告
 */
export function runEvalSuite(
  cases: EvalCase[],
  strategy?: StrategyConfig,
  cfg: PluginConfig = DEFAULTS,
  strategyVersion?: number
): EvalReport {
  const caseResults: Record<string, CaseResult> = {};

  for (const c of cases) {
    caseResults[c.id] = runCase(c, strategy, cfg);
  }

  return buildEvalReport(cases, caseResults, strategyVersion);
}
