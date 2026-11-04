import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { buildQueryPlan } from '../../src/retrieval/query.js';
import { recall } from '../../src/retrieval/recall.js';
import { upsertCandidate, editContent } from '../../src/core/writer.js';
import { budgetTokens } from '../../src/core/tokens.js';
import { get } from '../../src/core/store.js';

describe('Recall System Integration (recall.ts)', () => {
  let db: Db;
  const wsId = workspaceId('dsh-memory-test-workspace');
  const sessId = 'sess_recall_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
  });

  describe('验收项 2: 构造 200 条记忆，查询 "PostgreSQL 连接超时怎么办"，相关记录排进前 3', () => {
    it('should rank the relevant PostgreSQL timeout memory in top 3 among 200 memories', () => {
      // 1. 插入 199 条干扰记忆
      const topics = ['React 组件', 'Vue 响应式原理', 'Docker 镜像构建', 'Git 分支变基', 'CSS Flex 布局', 'Nginx 负载均衡', 'Redis 缓存击穿', 'Node.js 事件循环'];
      db.transaction(() => {
        for (let i = 1; i <= 199; i++) {
          const topic = topics[i % topics.length];
          upsertCandidate(
            db,
            {
              type: 'semantic',
              content: `关于 ${topic} 的详细笔记第 ${i} 篇，介绍常见技术细节与配置方式。`,
              scope: 'workspace',
              workspaceId: wsId,
              source_kind: 'user',
              confidence: 0.8,
              origin_kinds: ['user'],
              sources: [{ session_id: sessId, seq: i, kind: 'user' }],
              actor: 'user',
            },
            fixedNow - i * 1000
          );
        }

        // 2. 插入 1 条目标记忆
        upsertCandidate(
          db,
          {
            type: 'procedural',
            content: 'PostgreSQL 连接超时排查指南：先把 pool timeout 调到 180s，再检查网络代理和 pg_hba.conf 配置',
            summary: 'PostgreSQL 连接超时解决步骤',
            scope: 'workspace',
            workspaceId: wsId,
            source_kind: 'user',
            confidence: 0.95,
            origin_kinds: ['user'],
            sources: [{ session_id: sessId, seq: 200, kind: 'user' }],
            entities: ['postgresql'],
            actor: 'user',
          },
          fixedNow
        );
      });

      const plan = buildQueryPlan({
        userText: 'PostgreSQL 连接超时怎么办',
        now: fixedNow,
      });

      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 3200,
        now: fixedNow,
      });

      expect(res.items.length).toBeGreaterThan(0);
      // 检查目标记录在前 3 项中
      const top3Contents = res.items.slice(0, 3).map((it) => it.memory.content);
      const matched = top3Contents.some((c) => c.includes('PostgreSQL 连接超时排查指南'));
      expect(matched).toBe(true);
      // 检查渲染块不为空
      expect(res.block).toContain('PostgreSQL');
    });
  });

  describe('验收项 3: budget=300 时完整渲染 budgetTokens <= 300；稳定 600、候选策略 dynamic 3200 / maxItems 12 时总量 <= 3200', () => {
    it('budget=300 时完整渲染 budgetTokens <= 300', () => {
      // 插入 5 条中文较长的记忆
      db.transaction(() => {
        for (let i = 1; i <= 5; i++) {
          upsertCandidate(
            db,
            {
              type: 'semantic',
              content: `步骤 ${i}：在项目工程中严格规范 TypeScript 类型定义，禁止隐式 any 出现，并配置全面的 eslint 规则。`,
              summary: `步骤 ${i} 规范摘要`,
              scope: 'workspace',
              workspaceId: wsId,
              source_kind: 'user',
              confidence: 0.9,
              origin_kinds: ['user'],
              sources: [{ session_id: sessId, seq: i, kind: 'user' }],
              actor: 'user',
            },
            fixedNow + i
          );
        }
      });

      const plan = buildQueryPlan({ userText: 'TypeScript 类型定义规范', now: fixedNow });
      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 300,
        now: fixedNow,
      });

      if (res.items.length > 0) {
        const tokens = budgetTokens(res.block);
        expect(tokens).toBeLessThanOrEqual(300);
      }
    });

    it('稳定 600、候选策略 dynamic 3200 / maxItems 12 时总量 <= 3200', () => {
      db.transaction(() => {
        for (let i = 1; i <= 20; i++) {
          upsertCandidate(
            db,
            {
              type: 'procedural',
              content: `高可用集群部署步骤 ${i}：详细参数调优包括系统内核缓冲区设置、文件描述符限制、网络 keepalive 以及持久化日志归档。`,
              summary: `集群步骤 ${i} 摘要`,
              scope: 'workspace',
              workspaceId: wsId,
              source_kind: 'user',
              confidence: 0.9,
              origin_kinds: ['user'],
              sources: [{ session_id: sessId, seq: i, kind: 'user' }],
              actor: 'user',
            },
            fixedNow + i
          );
        }
      });

      const stableTokens = 600;
      const hardBudgetTokens = 3200;
      const dynamicBudget = hardBudgetTokens - stableTokens; // 2600

      const plan = buildQueryPlan({ userText: '高可用集群部署步骤', now: fixedNow });
      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: dynamicBudget,
        strategy: {
          ...buildQueryPlan({ userText: '' }) as any,
          maxItems: 12,
          dynamicBudgetTokens: 3200,
          rrfK: 60,
          channelWeights: { lexical: 1, entity: 1.2, typed: 0.8, temporal: 0.8, preference: 0.6, vector: 1 },
          scoreWeights: { relevance: 0.3, confidence: 0.2, utility: 0.2, freshness: 0.1, consistency: 0.1, specificity: 0.1 },
          minRelevance: 0.15,
        },
        now: fixedNow,
      });

      const dynamicTokens = budgetTokens(res.block);
      expect(dynamicTokens).toBeLessThanOrEqual(dynamicBudget);
      expect(stableTokens + dynamicTokens).toBeLessThanOrEqual(hardBudgetTokens);
      expect(res.items.length).toBeLessThanOrEqual(12);
    });
  });

  describe('验收项 4: 同 session 连续 recall 传入已提交 id@contentRev，第二次不返回旧版；正文修改后可返回新版', () => {
    it('should deduplicate already injected revisions and permit new revisions', () => {
      const insertRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '项目数据库为 PostgreSQL 16',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      expect(insertRes.action).toBe('inserted');
      const memId = (insertRes as any).id;

      const plan = buildQueryPlan({ userText: '数据库是什么', now: fixedNow });

      // 第一次 recall：未注入任何记忆
      const firstRecall = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        alreadyInjected: new Set(),
        now: fixedNow,
      });
      expect(firstRecall.items.some((it) => it.memory.id === memId)).toBe(true);

      // 第二次 recall：传入已注入的 id@contentRev (m_xxx@1)
      const alreadyInjected = new Set([`${memId}@1`]);
      const secondRecall = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        alreadyInjected,
        now: fixedNow,
      });
      // 第二次不再返回旧版
      expect(secondRecall.items.some((it) => it.memory.id === memId)).toBe(false);

      // 编辑正文 -> content_rev 递增为 2
      const editRes = editContent(db, memId, '项目数据库为 PostgreSQL 17 新版', undefined, 'user', fixedNow + 1000);
      expect(editRes.ok).toBe(true);
      expect(editRes.content_rev).toBe(2);

      // 第三次 recall：依然持有旧版的 alreadyInjected (m_xxx@1)
      const thirdRecall = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        alreadyInjected,
        now: fixedNow + 2000,
      });
      // 允许返回新版本！
      expect(thirdRecall.items.some((it) => it.memory.id === memId)).toBe(true);
      const returned = thirdRecall.items.find((it) => it.memory.id === memId);
      expect(returned?.memory.content_rev).toBe(2);
      expect(returned?.memory.content).toContain('PostgreSQL 17');
    });
  });

  describe('验收项 5: 历史与硬门槛综合判定', () => {
    it('“昨天做了什么”可以浏览昨天记录，superseded 记录标为 (history)', () => {
      const yesterday = fixedNow - 86400000;

      // 昨天完成的 active 记录
      const activeRes = upsertCandidate(
        db,
        {
          type: 'episodic',
          content: '昨天下午完成了数据库备份脚本编写',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        yesterday
      );
      const activeId = (activeRes as any).id;

      // 昨天被废弃的 superseded 记录
      const supRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '旧版数据表字段结构定义',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.85,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 2, kind: 'user' }],
          actor: 'user',
        },
        yesterday
      );
      const supId = (supRes as any).id;
      db.run(`UPDATE memories SET status = 'superseded' WHERE id = ?`, [supId]);

      const plan = buildQueryPlan({ userText: '昨天做了什么', now: fixedNow });
      expect(plan.temporalBrowse).toBe(true);

      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        now: fixedNow,
      });

      expect(res.items.some((it) => it.memory.id === activeId)).toBe(true);
      expect(res.items.some((it) => it.memory.id === supId)).toBe(true);

      // 检查 superseded 记录在渲染块中必须带有 (history) 标记，不得伪装成当前事实
      expect(res.block).toContain('(history)');
    });

    it('普通非 temporalBrowse 查询不得返回 superseded 记录', () => {
      const supRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '旧版数据表字段结构定义',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.85,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      const supId = (supRes as any).id;
      db.run(`UPDATE memories SET status = 'superseded' WHERE id = ?`, [supId]);

      const plan = buildQueryPlan({ userText: '数据表字段结构定义', now: fixedNow });
      expect(plan.temporalBrowse).toBe(false);

      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        now: fixedNow,
      });

      expect(res.items.some((it) => it.memory.id === supId)).toBe(false);
    });
  });

  describe('验收项 7: 性能测试 (1 万条记忆，100 次 recall 的 p95 < 50ms)', () => {
    it('10,000 memories, 100 recalls p95 < 50ms', () => {
      // 批量插入 1 万条记忆
      db.transaction(() => {
        for (let i = 1; i <= 10000; i++) {
          const mod = i % 20;
          const content = `系统指标记录第 ${i} 条：服务器节点 ${mod} 的内存占用率为 ${30 + (i % 50)}%，CPU 负载正常。`;
          upsertCandidate(
            db,
            {
              type: 'semantic',
              content,
              scope: 'workspace',
              workspaceId: wsId,
              source_kind: 'user',
              confidence: 0.85,
              origin_kinds: ['user'],
              sources: [{ session_id: sessId, seq: i, kind: 'user' }],
              actor: 'user',
            },
            fixedNow - i * 100
          );
        }
      });

      // 预热 5 次
      const plan = buildQueryPlan({ userText: '服务器节点 3 的内存占用率', now: fixedNow });
      for (let i = 0; i < 5; i++) {
        recall(db, plan, {
          workspaceId: wsId,
          sessionId: sessId,
          budget: 1000,
          now: fixedNow,
        });
      }

      // 执行 100 次测试并记录耗时
      const latencies: number[] = [];
      for (let i = 0; i < 100; i++) {
        const queryPlan = buildQueryPlan({
          userText: `服务器节点 ${i % 20} 的内存占用率`,
          now: fixedNow,
        });
        const tStart = performance.now();
        recall(db, queryPlan, {
          workspaceId: wsId,
          sessionId: sessId,
          budget: 1000,
          now: fixedNow,
        });
        const elapsed = performance.now() - tStart;
        latencies.push(elapsed);
      }

      latencies.sort((a, b) => a - b);
      const p95Index = Math.floor(latencies.length * 0.95);
      const p95Latency = latencies[p95Index];

      console.log(`[Recall Performance Benchmark] 10,000 memories, 100 queries: p50 = ${latencies[50].toFixed(2)}ms, p95 = ${p95Latency.toFixed(2)}ms, max = ${latencies[latencies.length - 1].toFixed(2)}ms`);

      expect(p95Latency).toBeLessThan(50);
    });
  });

  describe('验收项 8: 异常状态过滤与歧义短码', () => {
    it('meta / candidate / archived 状态绝不注入', () => {
      // 插入一条 candidate 状态
      const candRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '这是一条未审批的候选记忆',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'rule',
          confidence: 0.4,
          origin_kinds: ['tool'],
          sources: [{ session_id: sessId, seq: 1, kind: 'tool' }],
          actor: 'rule',
        },
        fixedNow
      );
      const candId = (candRes as any).id;

      // 插入一条 meta
      const metaRes = upsertCandidate(
        db,
        {
          type: 'meta',
          content: '这是系统内部元数据记录',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 2, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      const metaId = (metaRes as any).id;

      // 插入一条 active 然后改为 archived
      const archRes = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '这是一条已归档的过期记忆',
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: sessId, seq: 3, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      const archId = (archRes as any).id;
      db.run(`UPDATE memories SET status = 'archived' WHERE id = ?`, [archId]);

      const plan = buildQueryPlan({ userText: '记忆记录', now: fixedNow });
      const res = recall(db, plan, {
        workspaceId: wsId,
        sessionId: sessId,
        budget: 1000,
        now: fixedNow,
      });

      const returnedIds = res.items.map((it) => it.memory.id);
      expect(returnedIds).not.toContain(candId);
      expect(returnedIds).not.toContain(metaId);
      expect(returnedIds).not.toContain(archId);
    });

    it('歧义短码不任选，调用 store.get 时必须报错并列出候选 (验收项 8)', () => {
      // 人工向数据库插入两条拥有相同前缀的短码记录
      db.run(`INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES (
        'm_ambi111111111111', 'semantic', 'active', '歧义测试记录 1', '摘要 1', 'workspace', ?,
        '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 30, 15, 'hash1', 1, 1, 0, 1000, 1000
      )`, [wsId]);

      db.run(`INSERT INTO memories (
        id, type, status, content, summary, scope, workspace_id, origin_kinds, source_kind,
        confidence, utility, use_count, success_count, fail_count, token_cost,
        summary_cost, hash, version, content_rev, pinned, created_at, updated_at
      ) VALUES (
        'm_ambi222222222222', 'semantic', 'active', '歧义测试记录 2', '摘要 2', 'workspace', ?,
        '["user"]', 'user', 0.9, 0.8, 1, 0, 0, 30, 15, 'hash2', 1, 1, 0, 1000, 1000
      )`, [wsId]);

      // 用歧义短码 m_ambi 查询
      expect(() => {
        get(db, 'm_ambi', { workspaceId: wsId });
      }).toThrow(/Ambiguous short id/);
    });
  });
});
