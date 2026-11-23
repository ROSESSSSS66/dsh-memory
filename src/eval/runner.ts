import { performance } from 'node:perf_hooks';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { openDb } from '../core/db.js';
import { isWorkspaceExcluded } from '../core/privacy.js';
import { workspaceId } from '../core/scope.js';
import { contentHash, extractEntities, ftsText } from '../core/text.js';
import { budgetTokens, estimateTokens } from '../core/tokens.js';
import {
  clearRuntimeVectorCache,
  computeLocalEmbedding,
  encodeEmbeddingBlob,
  removeCachedRuntimeEmbedding,
} from '../core/vector.js';
import {
  addRelation,
  freeze,
  generateId,
  invalidateMemory,
  pin,
  upsertCandidate,
} from '../core/writer.js';
import { renderStableLayer } from '../dsh/prompt-section.js';
import { DEFAULT_STRATEGY } from '../retrieval/fuse.js';
import { buildQueryPlan } from '../retrieval/query.js';
import { recall } from '../retrieval/recall.js';
import type { StrategyConfig, VikingContextTier } from '../types.js';
import { buildEvalReport } from './metrics.js';
import type {
  CaseResult,
  EvalCase,
  EvalReport,
  ScaleBenchmarkDataset,
  ScaleBenchmarkReport,
} from './types.js';

export interface RunEvalOptions {
  coldCache?: boolean;
}

function extractInjectedTexts(
  dynamicRendered: string,
  items: ReturnType<typeof recall>['items']
): string[] {
  if (items.length === 0) return [];
  const renderedLines = dynamicRendered ? dynamicRendered.split('\n').slice(1, -1) : [];
  if (renderedLines.length === items.length) {
    return renderedLines;
  }
  return items.map((it) => {
    if (it.form === 'summary') {
      if (it.tier === 'L1' && it.overview) return it.overview;
      return it.memory.summary || it.memory.content;
    }
    return it.memory.content;
  });
}

function extractInjectedTiers(items: ReturnType<typeof recall>['items']): VikingContextTier[] {
  return items.map((it) => it.tier ?? (it.form === 'summary' ? 'L0' : 'L2'));
}

/**
 * 运行单个评测用例 (独立内存库，固定 now/workspace，确保 finally 关闭 SQLite 句柄)
 */
export function runCase(
  testCase: EvalCase,
  strategy?: StrategyConfig,
  cfg: PluginConfig = DEFAULTS,
  options?: RunEvalOptions
): CaseResult {
  const memDb = openDb(':memory:');
  const fixedNow = new Date(testCase.now).getTime();
  const wsId = workspaceId(testCase.workspace);
  const caseSessionId = testCase.sessionId || 'eval_session';

  const effectiveCfg: PluginConfig = {
    ...cfg,
    ...(testCase.excludeWorkspaces?.length
      ? {
          excludeWorkspaces: Array.from(
            new Set([...(cfg.excludeWorkspaces || []), ...testCase.excludeWorkspaces])
          ),
        }
      : {}),
    ...(testCase.dynamicBudgetTokens !== undefined
      ? { dynamicBudgetTokens: testCase.dynamicBudgetTokens }
      : {}),
    ...(testCase.maxItems !== undefined ? { maxItems: testCase.maxItems } : {}),
  };

  const effectiveStrategy: StrategyConfig | undefined =
    strategy || testCase.maxItems !== undefined
      ? {
          ...(strategy || DEFAULT_STRATEGY),
          ...(testCase.maxItems !== undefined ? { maxItems: testCase.maxItems } : {}),
        }
      : undefined;

  try {
    // 1. 设置记忆前置环境 (setup)
    const setupIds: Array<string | undefined> = [];

    for (let idx = 0; idx < testCase.setup.length; idx++) {
      const item = testCase.setup[idx];
      const atTime = item.at ? new Date(item.at).getTime() : fixedNow;
      const itemScope = item.scope ?? 'workspace';
      const itemWsId =
        itemScope === 'workspace' || itemScope === 'session'
          ? workspaceId(item.workspaceId || testCase.workspace)
          : undefined;
      const itemSessionId =
        itemScope === 'session' ? item.sessionId || caseSessionId : item.sessionId;
      const itemConfidence = item.confidence ?? 1.0;

      const res = upsertCandidate(
        memDb,
        {
          type: item.type,
          content: item.content,
          summary: item.summary,
          slot_key: item.slot_key,
          scope: itemScope,
          workspaceId: itemWsId,
          sessionId: itemSessionId,
          source_kind: item.source_kind || 'user',
          confidence: itemConfidence,
          origin_kinds: ['user'],
          sources: [
            {
              session_id: itemSessionId || 'eval_setup_session',
              seq: idx + 1,
              kind: 'user',
            },
          ],
          entities: item.entities,
          valid_from: item.valid_from ?? null,
          valid_to: item.valid_to ?? null,
          importance: item.importance,
          actor: 'user',
          status: item.status === 'candidate' ? 'candidate' : 'active',
        },
        atTime
      );

      if ('id' in res) {
        setupIds.push(res.id);

        if (item.pinned) {
          pin(memDb, res.id, 'user', atTime);
        } else if (item.pinned === 0) {
          memDb.run('UPDATE memories SET pinned = 0 WHERE id = ?', [res.id]);
        }

        if (item.frozen || item.status === 'frozen') {
          freeze(memDb, res.id, 'user', atTime);
        }

        if (item.invalidated_at !== undefined) {
          if (item.status === undefined || item.status === 'archived') {
            invalidateMemory(memDb, res.id, 'eval_invalidated', 'user', item.invalidated_at);
            if (item.valid_to !== undefined) {
              memDb.run('UPDATE memories SET valid_to = ? WHERE id = ?', [item.valid_to, res.id]);
            }
          } else {
            memDb.run('UPDATE memories SET invalidated_at = ? WHERE id = ?', [
              item.invalidated_at,
              res.id,
            ]);
          }
        }

        if (
          item.status &&
          item.status !== 'active' &&
          item.status !== 'frozen' &&
          !(item.invalidated_at !== undefined && item.status === 'archived')
        ) {
          memDb.run('UPDATE memories SET status = ? WHERE id = ?', [item.status, res.id]);
          if (
            item.status === 'archived' ||
            item.status === 'rejected' ||
            item.status === 'superseded'
          ) {
            removeCachedRuntimeEmbedding(res.id, memDb);
          }
        }

        if (item.utility !== undefined) {
          memDb.run('UPDATE memories SET utility = ? WHERE id = ?', [item.utility, res.id]);
        }
      } else {
        setupIds.push(undefined);
      }
    }

    // 1.5 设置图谱关系 (relations)
    const allRelations = [
      ...(testCase.relations || []),
      ...testCase.setup.flatMap((item) => item.relations || []),
    ];
    for (const rel of allRelations) {
      const fromId = setupIds[rel.fromIdx];
      const toId = setupIds[rel.toIdx];
      if (fromId && toId && fromId !== toId) {
        addRelation(memDb, fromId, toId, rel.rel, fixedNow);
      }
    }

    // 冷缓存模式：计时前清空运行时向量缓存
    if (options?.coldCache) {
      clearRuntimeVectorCache(memDb);
    }

    // 2. 渲染稳定层 (严格尊重 excludeWorkspaces 隐私边界，与 pre-step.ts 一致)
    const wsExcluded = isWorkspaceExcluded(testCase.workspace, effectiveCfg.excludeWorkspaces);
    const stable = wsExcluded
      ? { text: '', visibleRefs: new Set<string>(), stableTokens: 0, estimatedTokens: 0 }
      : renderStableLayer(memDb, { workspaceId: wsId, sessionId: caseSessionId }, effectiveCfg);

    const stableRendered = stable.text;
    const stableTokens = budgetTokens(stableRendered);

    let stablePass = true;
    if (testCase.expect.expectStable && testCase.expect.expectStable.length > 0) {
      stablePass = testCase.expect.expectStable.every((sub) => stableRendered.includes(sub));
    }

    // 3. 构建查询计划并执行动态召回（计时完整包含 buildQueryPlan + recall）
    const remainingHardBudget = Math.max(0, effectiveCfg.hardBudgetTokens - stableTokens);
    const dynamicBudget =
      effectiveCfg.dynamicBudgetTokens === 0
        ? 0
        : Math.min(
            testCase.dynamicBudgetTokens ??
              effectiveStrategy?.dynamicBudgetTokens ??
              effectiveCfg.dynamicBudgetTokens ??
              1600,
            remainingHardBudget
          );

    const startPerf = performance.now();
    const plan = buildQueryPlan({
      userText: testCase.query,
      now: fixedNow,
      cfg: effectiveCfg,
    });

    const recallResult = wsExcluded
      ? { items: [], block: '', latencyMs: 0 }
      : recall(memDb, plan, {
          workspaceId: wsId,
          sessionId: caseSessionId,
          budget: dynamicBudget,
          alreadyInjected: stable.visibleRefs,
          strategy: effectiveStrategy,
          now: fixedNow,
          cfg: effectiveCfg,
        });
    const latencyMs = performance.now() - startPerf;

    const dynamicRendered = recallResult.block;
    const dynamicTokens = budgetTokens(dynamicRendered);

    // 4. 判定评测指标
    // 4.1 include & empty
    let includePass = true;
    let emptyPass = true;
    if (testCase.expect.include.length === 0) {
      includePass = true;
      emptyPass = recallResult.items.length === 0;
    } else {
      includePass = testCase.expect.include.every((sub) => dynamicRendered.includes(sub));
      emptyPass = true;
    }

    // 4.2 exclude
    let excludePass = true;
    if (testCase.expect.exclude && testCase.expect.exclude.length > 0) {
      excludePass = !testCase.expect.exclude.some((sub) => dynamicRendered.includes(sub));
    }

    // 4.3 预算约束（stableTokens 与 dynamicTokens 同口径为统一 budgetTokens）
    const maxAllowedDynamic =
      testCase.expect.maxTokens !== undefined
        ? Math.min(testCase.expect.maxTokens, dynamicBudget)
        : dynamicBudget;
    const dynamicBudgetPass = dynamicTokens <= maxAllowedDynamic;
    const hardBudgetPass = stableTokens + dynamicTokens <= effectiveCfg.hardBudgetTokens;
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
      injectedIds: recallResult.items.map((it) => it.memory.id),
      injectedTexts: extractInjectedTexts(dynamicRendered, recallResult.items),
      injectedTiers: extractInjectedTiers(recallResult.items),
    };
  } finally {
    clearRuntimeVectorCache(memDb);
    memDb.close();
  }
}

/** Alias preserving compatibility for callers referring to runEvalCase */
export const runEvalCase = runCase;

/**
 * 运行整组用例并生成评测报告
 */
export function runEvalSuite(
  cases: EvalCase[],
  strategy?: StrategyConfig,
  cfg: PluginConfig = DEFAULTS,
  strategyVersion?: number,
  options?: RunEvalOptions
): EvalReport {
  const caseResults: Record<string, CaseResult> = {};

  for (const c of cases) {
    caseResults[c.id] = runCase(c, strategy, cfg, options);
  }

  return buildEvalReport(cases, caseResults, strategyVersion, cfg);
}

/**
 * 运行大规模语料（默认 10k 记忆）延迟与召回基准测试
 */
export function runScaleBenchmark(
  dataset: ScaleBenchmarkDataset,
  strategy?: StrategyConfig,
  cfg: PluginConfig = DEFAULTS,
  options?: RunEvalOptions
): ScaleBenchmarkReport {
  const memDb = openDb(':memory:');
  const fixedNow = new Date(dataset.now).getTime();
  const wsId = workspaceId(dataset.workspace);
  const caseSessionId = 'scale_eval_session';

  try {
    const setupStart = performance.now();
    memDb.transaction(() => {
      const insertMem = memDb.prepare(
        `INSERT INTO memories (
          id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
          origin_kinds, approved_at, approved_by, source_kind, confidence, utility,
          use_count, success_count, fail_count, token_cost, summary_cost, hash,
          version, content_rev, pinned, valid_from, valid_to, created_at, updated_at,
          importance, invalidated_at, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertFts = memDb.prepare(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`);
      const insertEnt = memDb.prepare(
        `INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`
      );
      const insertSrc = memDb.prepare(
        `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      const originsJson = JSON.stringify(['user']);

      for (let i = 0; i < dataset.memories.length; i++) {
        const item = dataset.memories[i];
        const id = generateId();
        const atTime = item.at ? new Date(item.at).getTime() : fixedNow;
        const scope = item.scope ?? 'workspace';
        const itemWs =
          scope === 'workspace' || scope === 'session'
            ? workspaceId(item.workspaceId || dataset.workspace)
            : null;
        const itemSess = scope === 'session' ? item.sessionId || caseSessionId : null;
        const summary = (item.summary || item.content).slice(0, 120);
        const tokenCost = estimateTokens(item.content);
        const summaryCost = estimateTokens(summary);
        const hash = contentHash(item.type, item.content);
        const vec = computeLocalEmbedding(
          `${summary}\n${item.content}${item.slot_key ? `\n${item.slot_key}` : ''}`
        );
        const res = insertMem.run(
          id,
          item.type,
          item.status || 'active',
          item.content,
          summary,
          item.slot_key ?? null,
          scope,
          itemWs,
          itemSess,
          originsJson,
          atTime,
          'user',
          item.source_kind || 'user',
          item.confidence ?? 0.9,
          item.utility ?? 0.5,
          0,
          0,
          0,
          tokenCost,
          summaryCost,
          hash,
          1,
          1,
          item.pinned ? 1 : 0,
          item.valid_from ?? null,
          item.valid_to ?? null,
          atTime,
          atTime,
          item.importance ?? 5,
          item.invalidated_at ?? null,
          encodeEmbeddingBlob(vec)
        );
        const rowid = Number(res.lastInsertRowid);
        insertFts.run(rowid, ftsText(`${item.content} ${summary}`));

        const ents =
          item.entities && item.entities.length > 0
            ? item.entities
            : extractEntities(`${summary} ${item.content}`);
        for (const ent of ents) {
          const norm = ent.toLowerCase().replace(/\\/g, '/').trim();
          if (norm) insertEnt.run(id, norm);
        }
        insertSrc.run(id, 1, 'scale_setup', i + 1, 'user', null, atTime);
      }
    });
    const setupMs = Number((performance.now() - setupStart).toFixed(2));

    if (options?.coldCache) {
      clearRuntimeVectorCache(memDb);
    }

    const stable = renderStableLayer(memDb, { workspaceId: wsId, sessionId: caseSessionId }, cfg);
    const stableTokens = budgetTokens(stable.text);
    const dynamicBudget =
      cfg.dynamicBudgetTokens === 0
        ? 0
        : Math.min(
            strategy?.dynamicBudgetTokens ?? cfg.dynamicBudgetTokens ?? 1600,
            Math.max(0, cfg.hardBudgetTokens - stableTokens)
          );

    const syntheticCases: EvalCase[] = [];
    const caseResults: Record<string, CaseResult> = {};

    for (const q of dataset.queries) {
      if (options?.coldCache) {
        clearRuntimeVectorCache(memDb);
      }

      const startPerf = performance.now();
      const plan = buildQueryPlan({ userText: q.query, now: fixedNow, cfg });
      const recallResult = recall(memDb, plan, {
        workspaceId: wsId,
        sessionId: caseSessionId,
        budget: dynamicBudget,
        alreadyInjected: stable.visibleRefs,
        strategy,
        now: fixedNow,
        cfg,
      });
      const latencyMs = performance.now() - startPerf;

      const dynamicRendered = recallResult.block;
      const dynamicTokens = budgetTokens(dynamicRendered);

      const includePass =
        q.expect.include.length === 0
          ? true
          : q.expect.include.every((sub) => dynamicRendered.includes(sub));
      const emptyPass = q.expect.include.length === 0 ? recallResult.items.length === 0 : true;
      const excludePass =
        q.expect.exclude && q.expect.exclude.length > 0
          ? !q.expect.exclude.some((sub) => dynamicRendered.includes(sub))
          : true;
      const maxAllowed =
        q.expect.maxTokens !== undefined
          ? Math.min(q.expect.maxTokens, dynamicBudget)
          : dynamicBudget;
      const budgetPass =
        dynamicTokens <= maxAllowed && stableTokens + dynamicTokens <= cfg.hardBudgetTokens;

      const pass =
        includePass && excludePass && budgetPass && (q.expect.include.length > 0 || emptyPass);

      syntheticCases.push({
        id: q.id,
        suite: 'scale',
        critical: Boolean(q.critical),
        now: dataset.now,
        workspace: dataset.workspace,
        setup: [],
        query: q.query,
        expect: q.expect,
      });

      caseResults[q.id] = {
        id: q.id,
        pass,
        includePass,
        excludePass,
        stablePass: true,
        budgetPass,
        emptyPass,
        dynamicTokens,
        stableTokens,
        latencyMs,
        injectedIds: recallResult.items.map((it) => it.memory.id),
        injectedTexts: extractInjectedTexts(dynamicRendered, recallResult.items),
        injectedTiers: extractInjectedTiers(recallResult.items),
      };
    }

    const report = buildEvalReport(syntheticCases, caseResults, undefined, cfg);
    return {
      memoryCount: dataset.memories.length,
      setupMs,
      report,
    };
  } finally {
    clearRuntimeVectorCache(memDb);
    memDb.close();
  }
}
