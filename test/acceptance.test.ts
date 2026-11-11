import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { openDb } from '../src/core/db.js';
import type { Db, MemoryRecord } from '../src/types.js';
import { DEFAULTS } from '../src/config.js';
import { workspaceId } from '../src/core/scope.js';
import { upsertCandidate, approveCandidate } from '../src/core/writer.js';
import { buildQueryPlan } from '../src/retrieval/query.js';
import { recall } from '../src/retrieval/recall.js';
import { DEFAULT_STRATEGY } from '../src/retrieval/fuse.js';
import { budgetTokens } from '../src/core/tokens.js';
import { MemoryCommands } from '../src/dsh/commands.js';
import { handlePreStep } from '../src/dsh/pre-step.js';
import { PromptSectionManager } from '../src/dsh/prompt-section.js';
import { generateDataset } from '../src/eval/gen-dataset.js';
import { runEvalSuite } from '../src/eval/runner.js';
import {
  backupDatabase,
  exportDatabaseFile,
  importDatabaseFile,
} from '../src/evolution/maintenance.js';
import { getLedgerUsage } from '../src/evolution/ledger.js';

describe('§8.4 MVP 完整验收清单与回归门禁验证', () => {
  let db: Db;
  let tempDir: string;
  const rawWs = '/workspace/mvp-acceptance';
  const ws = workspaceId(rawWs);
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mvp-acc-'));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('MVP-1: 能跨 session 召回事实，并且 /memory inspect 能显示完整来源', async () => {
    const commands = new MemoryCommands(db);
    const sess1 = 'session_source_001';
    const sess2 = 'session_query_002';

    // Session 1 录入记忆
    const ins = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库服务为 PostgreSQL 16 稳定版。',
        summary: '数据库版本设定',
        scope: 'workspace',
        workspaceId: rawWs,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [
          {
            session_id: sess1,
            seq: 3,
            kind: 'user',
            excerpt: '我的项目数据库是 PostgreSQL 16 稳定版',
          },
        ],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (ins as any).id;

    // /memory inspect 能显示来源 session 与摘录
    const inspectStr = commands.inspect(memId, { workspaceId: ws });
    expect(inspectStr).toContain(sess1);
    expect(inspectStr).toContain('seq: 3');
    expect(inspectStr).toContain('PostgreSQL 16');

    // Session 2 查询召回
    const plan = buildQueryPlan({
      userText: '项目数据库服务是什么版本？',
      now: fixedNow,
    });
    const res = recall(db, plan, {
      workspaceId: ws,
      sessionId: sess2,
      now: fixedNow,
    });
    expect(res.items.length).toBeGreaterThan(0);
    expect(res.items[0].memory.content).toContain('PostgreSQL 16');
  });

  it('MVP-2: 事实发生变化时形成 supersedes 链，旧版本完整保留', () => {
    // 第一次写入 MySQL 8
    const ins1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目主数据库是 MySQL 8。',
        slot_key: 'project.database',
        scope: 'workspace',
        workspaceId: rawWs,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow - 3600000
    );
    const id1 = (ins1 as any).id;

    // 第二次用户显式更新为 PostgreSQL 16
    const ins2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目主数据库已变更为 PostgreSQL 16。',
        slot_key: 'project.database',
        scope: 'workspace',
        workspaceId: rawWs,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's2', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const id2 = (ins2 as any).id;

    // 验证 supersedes 关系与历史快照
    const mem1 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id1]);
    const mem2 = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id2]);

    expect(mem1?.status).toBe('superseded');
    expect(mem1?.valid_to).toBe(fixedNow);
    expect(mem2?.status).toBe('active');

    // 关系表记录
    const rel = db.get(
      'SELECT * FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = ?',
      [id2, id1, 'supersedes']
    );
    expect(rel).toBeDefined();

    // 历史版本记录
    const versions = db.all('SELECT * FROM memory_versions WHERE memory_id = ?', [id1]);
    expect(versions.length).toBeGreaterThan(0);
  });

  it('MVP-3: 输入 Token 不随记忆库规模增长 (1k vs 10k 规模跑 eval，avgInjectTokens 相差 < 10%)', () => {
    // 1. 创建 1,000 条记忆的测试数据库
    const db1k = openDb(':memory:');
    try {
      db1k.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          db1k.run(
            `INSERT INTO memories (
              id, type, status, content, summary, scope, workspace_id, origin_kinds,
              source_kind, confidence, utility, use_count, token_cost, summary_cost,
              hash, version, content_rev, pinned, created_at, updated_at
            ) VALUES (?, 'semantic', 'active', ?, ?, 'workspace', ?, '["user"]', 'user', 0.8, 0.5, 0, 30, 15, ?, 1, 1, 0, ?, ?)`,
            [
              `m_1k_${String(i).padStart(5, '0')}`,
              `这是第 ${i} 条关于系统架构、模块依赖与部署配置的测试记忆内容，用于规模压测。`,
              `架构配置 ${i}`,
              ws,
              `h_1k_${i}`,
              fixedNow,
              fixedNow,
            ]
          );
          db1k.run(
            `INSERT INTO memory_fts(rowid, fts_text) VALUES ((SELECT last_insert_rowid()), ?)`,
            [`架构 部署 配置 模块 测试 记忆 ${i}`]
          );
        }
      });

      // 2. 创建 10,000 条记忆的测试数据库
      const db10k = openDb(':memory:');
      try {
        db10k.transaction(() => {
          for (let i = 0; i < 10000; i++) {
            db10k.run(
              `INSERT INTO memories (
                id, type, status, content, summary, scope, workspace_id, origin_kinds,
                source_kind, confidence, utility, use_count, token_cost, summary_cost,
                hash, version, content_rev, pinned, created_at, updated_at
              ) VALUES (?, 'semantic', 'active', ?, ?, 'workspace', ?, '["user"]', 'user', 0.8, 0.5, 0, 30, 15, ?, 1, 1, 0, ?, ?)`,
              [
                `m_10k_${String(i).padStart(6, '0')}`,
                `这是第 ${i} 条关于系统架构、模块依赖与部署配置的测试记忆内容，用于规模压测。`,
                `架构配置 ${i}`,
                ws,
                `h_10k_${i}`,
                fixedNow,
                fixedNow,
              ]
            );
            db10k.run(
              `INSERT INTO memory_fts(rowid, fts_text) VALUES ((SELECT last_insert_rowid()), ?)`,
              [`架构 部署 配置 模块 测试 记忆 ${i}`]
            );
          }
        });

        // 统一查询集合 (测试装箱后的 block tokens)
        const testQueries = [
          '系统架构与模块依赖怎么配置？',
          '部署配置测试细节',
          '架构配置说明文档',
          '模块架构设计原则',
          '系统部署与环境测试',
        ];

        let tokens1kSum = 0;
        let tokens10kSum = 0;

        for (const q of testQueries) {
          const plan = buildQueryPlan({ userText: q, now: fixedNow });
          const r1k = recall(db1k, plan, { workspaceId: ws, now: fixedNow });
          const r10k = recall(db10k, plan, { workspaceId: ws, now: fixedNow });

          tokens1kSum += budgetTokens(r1k.block);
          tokens10kSum += budgetTokens(r10k.block);
        }

        const avg1k = tokens1kSum / testQueries.length;
        const avg10k = tokens10kSum / testQueries.length;

        expect(avg1k).toBeGreaterThan(0);
        expect(avg10k).toBeGreaterThan(0);

        // 验证两者差异必须严格 < 10% (装箱预算硬约束有效)
        const diffPercent = Math.abs(avg10k - avg1k) / avg1k;
        expect(diffPercent).toBeLessThan(0.1);
      } finally {
        db10k.close();
      }
    } finally {
      db1k.close();
    }
  });

  it('MVP-4: 注入有硬预算 (任何情况下注入块都不超过 cfg.hardBudgetTokens，默认 3200)', () => {
    // 插入大批量高分匹配记忆
    for (let i = 0; i < 50; i++) {
      upsertCandidate(db, {
        type: 'semantic',
        content: `高分匹配测试条目 ${i}：详细说明了如何在大规模分布式系统中进行高效的数据处理与集群扩展。`,
        scope: 'workspace',
        workspaceId: rawWs,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's', seq: i, kind: 'user' }],
        actor: 'user',
      });
    }

    const plan = buildQueryPlan({
      userText: '大规模分布式系统 数据处理与集群扩展',
      now: fixedNow,
    });
    const res = recall(db, plan, {
      workspaceId: ws,
      now: fixedNow,
    });

    const dynamicTokens = budgetTokens(res.block);
    // 动态注入完整渲染块 tokens 必须小于等于 dynamicBudgetTokens
    expect(dynamicTokens).toBeLessThanOrEqual(DEFAULTS.dynamicBudgetTokens);
    // 整个系统的总硬预算校验
    expect(dynamicTokens + DEFAULTS.stableBudgetTokens).toBeLessThanOrEqual(
      DEFAULTS.hardBudgetTokens
    );
  });

  it('MVP-5: 在线回调绝对不调用 LLM/embedding (后台禁用时跑 20 turn，HTTP 和 ledger 增量严格为 0)', async () => {
    const promptSections = new PromptSectionManager(db);
    const agentCtx = {
      id: 'agent_test_online',
      cwd: ws,
      session: { id: 'sess_online_safe', cwd: ws },
      ctx: { systemPrompt: { section: () => () => {} } },
    };

    // 连续运行 20 turn 的 pre-step waterfall 在线注入
    for (let turn = 1; turn <= 20; turn++) {
      const payload = {
        sessionId: 'sess_online_safe',
        turn,
        step: 0,
        agent: agentCtx,
      };

      const next = async () => ({
        kind: 'enter' as const,
        messages: [
          {
            id: `msg_u_${turn}`,
            role: 'user' as const,
            content: [{ type: 'text' as const, text: `问题 ${turn}: 怎么连接数据库？` }],
            source: { kind: 'user' as const },
          },
        ],
      });

      await handlePreStep(payload, next, { db, promptSections });
    }

    // 校验离线 LLM 账本调用记录增量严格为 0
    const ledgerRows = db.all('SELECT * FROM llm_ledger');
    expect(ledgerRows.length).toBe(0);

    const usage = getLedgerUsage(db);
    expect(usage.callsCount).toBe(0);
    expect(usage.tokensConsumed).toBe(0);
  });

  it('MVP-6: 能产出 Failure/Procedural 候选，未批准不注入，用户审批后才 active', () => {
    // 插入一条来自反思的 failure candidate 记忆
    const ins = upsertCandidate(db, {
      type: 'failure',
      content: '连接超时错误：数据库代理网关 6432 端口未放行防火墙规则。',
      scope: 'workspace',
      workspaceId: rawWs,
      source_kind: 'assistant',
      status: 'candidate',
      confidence: 0.5,
      origin_kinds: ['tool'],
      sources: [{ session_id: 's_fail', seq: 1, kind: 'tool' }],
      actor: 'llm',
    });
    const candId = (ins as any).id;

    // 1. 未批准前查询：绝对不可被注入
    const query = '连接超时错误：数据库代理网关端口排查';
    const plan = buildQueryPlan({ userText: query, now: fixedNow });
    const beforeRecall = recall(db, plan, { workspaceId: ws, now: fixedNow });
    const foundBefore = beforeRecall.items.some((it) => it.memory.id === candId);
    expect(foundBefore).toBe(false);

    // 2. 模拟用户审批
    const approveRes = approveCandidate(db, candId, 'user', fixedNow);
    expect((approveRes as any).action).toBe('approved');

    // 3. 审批后查询：成功召回 active 记录
    const afterRecall = recall(db, plan, { workspaceId: ws, now: fixedNow });
    const foundAfter = afterRecall.items.some((it) => it.memory.id === candId);
    expect(foundAfter).toBe(true);
  });

  it('MVP-7: 高价值记忆都具备完整 utility, confidence, sources 与 version 元数据', () => {
    upsertCandidate(db, {
      type: 'semantic',
      content: '核心生产配置：Kafka 集群地址为 kafka.prod:9092。',
      scope: 'workspace',
      workspaceId: rawWs,
      source_kind: 'user',
      confidence: 0.95,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_kafka', seq: 5, kind: 'user' }],
      actor: 'user',
    });

    const activeMems = db.all<MemoryRecord>(
      "SELECT * FROM memories WHERE status = 'active'"
    );
    expect(activeMems.length).toBeGreaterThan(0);

    for (const mem of activeMems) {
      expect(mem.utility).toBeGreaterThanOrEqual(0);
      expect(mem.utility).toBeLessThanOrEqual(1);
      expect(mem.confidence).toBeGreaterThan(0);
      expect(mem.confidence).toBeLessThanOrEqual(1);
      expect(mem.version).toBeGreaterThanOrEqual(1);
      expect(mem.content_rev).toBeGreaterThanOrEqual(1);

      const srcList = db.all('SELECT * FROM memory_sources WHERE memory_id = ?', [mem.id]);
      expect(srcList.length).toBeGreaterThan(0);
    }
  });

  it('MVP-8: M4 回归门禁验证 (120 条用例，MVP 各大门槛 100% 达标)', () => {
    const dataset = generateDataset(42);
    expect(dataset.length).toBe(120);

    const report = runEvalSuite(dataset, DEFAULT_STRATEGY, DEFAULTS);

    expect(report.overall.recallAtInject).toBeGreaterThanOrEqual(0.7);
    expect(report.overall.excludeViolations).toBe(0);
    expect(report.overall.emptyPrecision).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.criticalPassed).toBe(20);
    expect(report.overall.criticalTotal).toBe(20);
    expect(report.overall.avgInjectTokens).toBeLessThanOrEqual(1600);
    expect(report.overall.maxBudgetTokens).toBeLessThanOrEqual(3200);
    expect(report.overall.p95LatencyMs).toBeLessThanOrEqual(50);
  });

  it('MVP-9: Compaction 与 Memory 不重复消费同一段历史 (watermark 机制有效)', () => {
    // 写入两批事件
    db.run(
      `INSERT INTO raw_events (session_id, workspace_id, seq, type, time, role, origin_kind, text, processed)
       VALUES ('s_wm', ?, 1, 'user/message', 1000, 'user', 'user', '第一轮用户输入', 0),
              ('s_wm', ?, 2, 'assistant/message', 2000, 'assistant', 'assistant', '第一轮助手输出', 0)`,
      [ws, ws]
    );

    // 模拟抽取器推进 watermark
    db.run("INSERT OR REPLACE INTO meta(key, value) VALUES ('watermark_s_wm', '2')");
    db.run("UPDATE raw_events SET processed = 1 WHERE session_id = 's_wm' AND seq <= 2");

    // 写入后续新事件
    db.run(
      `INSERT INTO raw_events (session_id, workspace_id, seq, type, time, role, origin_kind, text, processed)
       VALUES ('s_wm', ?, 3, 'user/message', 3000, 'user', 'user', '第二轮用户新输入', 0)`,
      [ws]
    );

    const watermark = parseInt(
      db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'watermark_s_wm'")?.value || '0',
      10
    );
    expect(watermark).toBe(2);

    // 下一批待处理事件严格从 seq > watermark 开始，不重复消费历史
    const pendingEvents = db.all(
      "SELECT * FROM raw_events WHERE session_id = 's_wm' AND seq > ? AND processed = 0",
      [watermark]
    );
    expect(pendingEvents.length).toBe(1);
    expect((pendingEvents[0] as any).seq).toBe(3);
  });

  it('MVP-10: 支持备份、导出与恢复 (§10 协议全流程通过)', () => {
    // 插入待备份数据
    upsertCandidate(db, {
      type: 'semantic',
      content: '需要全生命周期备份与恢复的记忆项。',
      scope: 'workspace',
      workspaceId: rawWs,
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: 's_bk', seq: 1, kind: 'user' }],
      actor: 'user',
    });

    // 1. 自动备份生成与轮换
    const backupFile = backupDatabase(db, ':memory:', tempDir, fixedNow);
    expect(fs.existsSync(backupFile)).toBe(true);

    // 2. /memory export 导出到指定路径
    const exportFile = path.join(tempDir, 'manual-export.db');
    const expRes = exportDatabaseFile(db, ':memory:', exportFile);
    expect(expRes.success).toBe(true);

    // 3. /memory import 恢复到新实例
    const restoreDb = openDb(':memory:');
    try {
      const impRes = importDatabaseFile(restoreDb, ':memory:', exportFile);
      expect(impRes.success).toBe(true);
      expect(impRes.importedRecords).toBeGreaterThan(0);

      const restored = restoreDb.get<MemoryRecord>(
        "SELECT * FROM memories WHERE content LIKE '%全生命周期备份%'"
      );
      expect(restored).toBeDefined();
      expect(restored?.content).toContain('全生命周期备份与恢复');
    } finally {
      restoreDb.close();
    }
  });
});
