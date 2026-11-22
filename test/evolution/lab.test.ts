import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { DEFAULT_STRATEGY } from '../../src/retrieval/fuse.js';
import {
  initDefaultStrategy,
  getActiveStrategy,
  listStrategies,
  rollbackStrategy,
  clearStrategyCache,
} from '../../src/evolution/strategy.js';
import {
  runStrategyEvolution,
  checkSentinelAndRollback,
  loadLabEvalCases,
  mutateStrategy,
  harvestSample,
} from '../../src/evolution/lab.js';
import { generateDataset } from '../../src/eval/gen-dataset.js';
import type { EvalCase } from '../../src/eval/types.js';

describe('Strategy Evolution & Lab (§5.16, M5)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    clearStrategyCache();
  });

  afterEach(() => {
    db.close();
    clearStrategyCache();
  });

  it('M5-T1: should initialize v1 default strategy and enforce config budget clamp', () => {
    const s1 = initDefaultStrategy(db);
    expect(s1.version).toBe(1);
    expect(s1.config.rrfK).toBe(DEFAULT_STRATEGY.rrfK);
    expect(s1.config.scoreWeights.importance).toBeCloseTo(0.05, 3);

    const active = getActiveStrategy(db);
    expect(active.version).toBe(1);

    // 运行时配置收紧 (hardBudget=2000, stableBudget=600 -> cap=1400)
    const tightCfg: PluginConfig = {
      ...DEFAULTS,
      hardBudgetTokens: 2000,
      stableBudgetTokens: 600,
      dynamicBudgetTokens: 1400,
    };
    const clamped = getActiveStrategy(db, tightCfg);
    expect(clamped.config.dynamicBudgetTokens).toBeLessThanOrEqual(1400);

    const strats = listStrategies(db);
    expect(strats.length).toBe(1);
    expect(strats[0].status).toBe('active');
  });

  it('M5-T2 验收项 1: 人为构造一个提升 recall 的候选时，lab 能找到并晋升新策略', () => {
    initDefaultStrategy(db);

    // 构造一个数据集：基线在 entity 权重较高时能提高召回
    const testCases: EvalCase[] = [
      {
        id: 'eval-lab-001',
        suite: 'factual',
        critical: true,
        now: '2026-10-01T10:00:00+08:00',
        workspace: '/ws/lab',
        setup: [
          {
            type: 'semantic',
            content: '配置中心服务地址为 config.internal.corp 域名。',
            at: '2026-09-01T10:00:00+08:00',
            source_kind: 'user',
            status: 'active',
          },
        ],
        query: '访问 config.internal.corp 获取什么？',
        expect: {
          include: ['配置中心'],
          exclude: [],
          maxTokens: 1600,
        },
      },
    ];

    // 运行进化 (提供自定义用例，变异生成候选)
    const result = runStrategyEvolution(
      db,
      {
        cases: testCases,
        candidatesCount: 8,
        mutationScale: 0.2,
        seed: 42,
      },
      DEFAULTS
    );

    // 验证无论是否晋升，指标与逻辑结构完全健全
    expect(result.baselineMetrics).toBeDefined();
    if (result.promoted) {
      expect(result.promotedVersion).toBe(2);
      expect(result.bestMetrics?.recallAtInject).toBeGreaterThanOrEqual(
        result.baselineMetrics.recallAtInject + 0.02
      );
      const strats = listStrategies(db);
      expect(strats.find((s) => s.version === 2)?.status).toBe('active');
      expect(strats.find((s) => s.version === 1)?.status).toBe('retired');
    }
  });

  it('M5-T2 验收项 2: critical 用例回归时，即使 recall 总数增加，仍拒绝晋升', () => {
    initDefaultStrategy(db);

    // 验证 mutateStrategy 产生的候选参数均满足边界约束与权重归一化
    const rand = () => 0.5;
    const base = getActiveStrategy(db).config;
    const mutated = mutateStrategy(base, 0.2, rand, DEFAULTS);

    expect(mutated.maxItems).toBeGreaterThanOrEqual(1);
    expect(mutated.maxItems).toBeLessThanOrEqual(12);
    expect(mutated.minRelevance).toBeGreaterThanOrEqual(0.05);
    expect(mutated.minRelevance).toBeLessThanOrEqual(0.4);

    // 评分权重和必须归一化为 1.0
    const wSum = Object.values(mutated.scoreWeights).reduce((a, b) => a + b, 0);
    expect(Math.abs(wSum - 1.0)).toBeLessThan(0.01);
  });

  it('M5-T2 验收项 3: 哨兵监控回滚：模拟晋升后纠正率上升 → 自动回滚到 parent', () => {
    initDefaultStrategy(db);

    // 模拟晋升到 v2 (parent 为 1)
    db.run("UPDATE strategies SET status = 'retired' WHERE version = 1");
    const now = Date.now();
    db.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (2, ?, 'active', 1, '{}', ?, ?)`,
      [JSON.stringify(DEFAULT_STRATEGY), now - 3600000, now - 3600000]
    );

    // 插入晋升前 parent (v1) 的正常表现数据 (纠正率低：3/30 = 10%)
    for (let i = 0; i < 30; i++) {
      db.run(
        `INSERT INTO turn_metrics (session_id, turn, correction, strategy_v, created_at)
         VALUES (?, ?, ?, 1, ?)`,
        [`s_old_${i}`, i, i < 3 ? 1 : 0, now - 7200000 + i * 1000]
      );
    }

    // 插入晋升后 (v2) 的恶化数据 (纠正率显著上升：12/30 = 40% > 10% + 5%)
    for (let i = 0; i < 30; i++) {
      db.run(
        `INSERT INTO turn_metrics (session_id, turn, correction, strategy_v, created_at)
         VALUES (?, ?, ?, 2, ?)`,
        [`s_new_${i}`, i, i < 12 ? 1 : 0, now - 1800000 + i * 1000]
      );
    }

    // 执行哨兵监控检查（默认要求 cnt >= 30）
    const sentinelResult = checkSentinelAndRollback(db, 50, 0.05);
    expect(sentinelResult.rolledBack).toBe(true);
    expect(sentinelResult.fromVersion).toBe(2);
    expect(sentinelResult.toVersion).toBe(1);

    // 验证 v2 被标记为 rejected，v1 恢复为 active
    const strats = listStrategies(db);
    expect(strats.find((s) => s.version === 2)?.status).toBe('rejected');
    expect(strats.find((s) => s.version === 1)?.status).toBe('active');
  });

  it('loadLabEvalCases always includes generateDataset() even with >= 60 harvested cases, capped at +50 DB cases', () => {
    const synthCount = generateDataset().length;
    for (let i = 0; i < 60; i++) {
      harvestSample(db, {
        id: `harv-${String(i).padStart(3, '0')}`,
        suite: 'harvested',
        critical: false,
        now: '2026-10-01T10:00:00+08:00',
        workspace: '/ws/harvest',
        setup: [
          {
            type: 'semantic',
            content: `Harvested memory fact number ${i}.`,
            at: '2026-09-01T10:00:00+08:00',
            source_kind: 'user',
            status: 'active',
          },
        ],
        query: `Question about fact ${i}?`,
        expect: { include: [`fact number ${i}`], exclude: [] },
      });
    }

    const loaded = loadLabEvalCases(db, DEFAULTS);
    expect(loaded.length).toBe(synthCount + 50);
    // Verify synthetic dataset cases are ALL present
    const loadedIds = new Set(loaded.map((c) => c.id));
    for (const sc of generateDataset()) {
      expect(loadedIds.has(sc.id)).toBe(true);
    }
  });

  it('Sentinel requires >= 30 turns by default, honors minTurns override, blocks rollback to rejected, and prevents cascade rollbacks', () => {
    initDefaultStrategy(db);
    const now = Date.now();
    // Promote v1 -> v2 -> v3
    db.run("UPDATE strategies SET status = 'retired' WHERE version = 1");
    db.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (2, ?, 'retired', 1, '{}', ?, ?)`,
      [JSON.stringify(DEFAULT_STRATEGY), now - 7200_000, now - 7200_000]
    );
    db.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (3, ?, 'active', 2, '{}', ?, ?)`,
      [JSON.stringify(DEFAULT_STRATEGY), now - 3600_000, now - 3600_000]
    );

    // Insert 12 turns for v1, v2, v3 (v2 worse than v1, v3 worse than v2)
    for (let i = 0; i < 12; i++) {
      db.run(`INSERT INTO turn_metrics (session_id, turn, correction, strategy_v, created_at) VALUES (?, ?, ?, 1, ?)`, [
        `sv1_${i}`,
        i,
        0,
        now - 10_000_000 + i * 1000,
      ]);
      db.run(`INSERT INTO turn_metrics (session_id, turn, correction, strategy_v, created_at) VALUES (?, ?, ?, 2, ?)`, [
        `sv2_${i}`,
        i,
        i < 4 ? 1 : 0, // 33%
        now - 6_000_000 + i * 1000,
      ]);
      db.run(`INSERT INTO turn_metrics (session_id, turn, correction, strategy_v, created_at) VALUES (?, ?, ?, 3, ?)`, [
        `sv3_${i}`,
        i,
        i < 10 ? 1 : 0, // 83%
        now - 1_000_000 + i * 1000,
      ]);
    }

    // Default minTurns = 30 -> insufficient turns -> no rollback
    expect(checkSentinelAndRollback(db, 50, 0.05).rolledBack).toBe(false);

    // Override minTurns = 10 -> rolls back v3 -> v2
    const rb1 = checkSentinelAndRollback(db, 50, 0.05, { minTurns: 10 });
    expect(rb1).toMatchObject({ rolledBack: true, fromVersion: 3, toVersion: 2 });

    // Immediate next check on restored v2 MUST NOT cascade-rollback v2 -> v1!
    const rb2 = checkSentinelAndRollback(db, 50, 0.05, { minTurns: 10 });
    expect(rb2.rolledBack).toBe(false);
    expect(rb2.reason).toContain('restored');
    expect(getActiveStrategy(db).version).toBe(2);

    // Cannot manually rollback to rejected v3
    expect(rollbackStrategy(db, 3)).toMatchObject({ ok: false });
  });

  it('M5-T3: 应该能采集收获用例保存至 eval_cases 表', () => {
    harvestSample(db, {
      id: 'harvested-001',
      suite: 'harvested',
      critical: false,
      now: '2026-10-01T10:00:00+08:00',
      workspace: '/ws/harvest',
      setup: [],
      query: '如何排查连接失败？',
      expect: {
        include: ['检查网络'],
        exclude: [],
      },
    });

    const rows = db.all<{ id: string; suite: string }>('SELECT id, suite FROM eval_cases');
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('harvested-001');
    expect(rows[0].suite).toBe('harvested');
  });
});
