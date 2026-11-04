import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { workspaceId } from '../../src/core/scope.js';
import { buildQueryPlan } from '../../src/retrieval/query.js';
import {
  recallLexical,
  recallEntity,
  recallTyped,
  recallTemporal,
  recallPreference,
  runAllChannels,
} from '../../src/retrieval/channels.js';
import { upsertCandidate } from '../../src/core/writer.js';

describe('Retrieval Channels (channels.ts)', () => {
  let db: Db;
  const ws1 = workspaceId('workspace-alpha');
  const ws2 = workspaceId('workspace-beta');
  const session1 = 'sess_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('recallLexical should search via FTS and respect scope and status', () => {
    // 写入一条合法 active 记忆
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库使用 PostgreSQL 16 版本',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    // 写入另一工作区的相同内容
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库使用 PostgreSQL 16 版本',
        scope: 'workspace',
        workspaceId: ws2,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_other', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    const plan = buildQueryPlan({ userText: 'PostgreSQL 数据库', now: fixedNow });
    const results = recallLexical(db, plan, { workspaceId: ws1, sessionId: session1 });

    expect(results.length).toBe(1);
    expect(results[0].channel).toBe('lexical');
    expect(results[0].rank).toBe(1);

    // 检查查询结果是否属于 ws1
    const mem = db.get<{ workspace_id: string }>('SELECT workspace_id FROM memories WHERE id = ?', [results[0].id]);
    expect(mem?.workspace_id).toBe(ws1);
  });

  it('recallEntity should isolate scope even if 30 interference items exist in another workspace (验收项 8)', () => {
    // 1. 在 ws2 (其他工作区) 插入 30 条带有实体 'postgresql' 的干扰记忆
    for (let i = 1; i <= 30; i++) {
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: `干扰记忆 ${i} 关于 PostgreSQL 的记录`,
          scope: 'workspace',
          workspaceId: ws2,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 'sess_interference', seq: i, kind: 'user' }],
          entities: ['postgresql'],
          actor: 'user',
        },
        fixedNow + i
      );
    }

    // 2. 在 ws1 (当前工作区) 插入 1 条目标记忆
    const targetRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '目标项目的核心数据库是 PostgreSQL 生产集群',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        entities: ['postgresql'],
        actor: 'user',
      },
      fixedNow
    );
    expect(targetRes.action).toBe('inserted');
    const targetId = (targetRes as any).id;

    // 3. 在 ws1 环境下执行 entity 召回
    const plan = buildQueryPlan({ userText: 'PostgreSQL 生产环境', now: fixedNow });
    expect(plan.entities).toContain('postgresql');

    const results = recallEntity(db, plan, { workspaceId: ws1, sessionId: session1 });

    // 必须成功召回本 scope 目标，不能被 ws2 的 30 条干扰项挤占
    expect(results.some((r) => r.id === targetId)).toBe(true);
    // 并且结果中绝不包含 ws2 的任何记忆
    for (const r of results) {
      const row = db.get<{ workspace_id: string }>('SELECT workspace_id FROM memories WHERE id = ?', [r.id]);
      expect(row?.workspace_id).toBe(ws1);
    }
  });

  it('recallTyped should only run for procedural or causal and filter types', () => {
    // 插入一条 procedural 和一条 semantic
    upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '修复连接超时：先把 timeout 调大，再重启连接池',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '超时设置默认值为 30s',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );

    // 查询带 "怎么" (procedural)
    const procPlan = buildQueryPlan({ userText: '连接超时怎么解决？', now: fixedNow });
    expect(procPlan.intents.procedural).toBe(true);

    const results = recallTyped(db, procPlan, { workspaceId: ws1, sessionId: session1 });
    expect(results.length).toBe(1);
    const m = db.get<{ type: string }>('SELECT type FROM memories WHERE id = ?', [results[0].id]);
    expect(m?.type).toBe('procedural');

    // 查询不带 procedural 或 causal
    const nonProcPlan = buildQueryPlan({ userText: '数据库基本信息', now: fixedNow });
    const emptyResults = recallTyped(db, nonProcPlan, { workspaceId: ws1, sessionId: session1 });
    expect(emptyResults.length).toBe(0);
  });

  it('recallTemporal should handle time ranges and allow superseded only in temporalBrowse', () => {
    // 设定昨天的某个固定时间 (12:00:00)
    const yesterday = fixedNow - 86400000;

    // 插入一条昨天的 active 记录
    const activeRes = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '昨天下午完成了支付模块重构',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      yesterday
    );
    const activeId = (activeRes as any).id;

    // 插入一条昨天的 superseded 记录
    const supRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '支付通道老版本接口',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      yesterday
    );
    const supId = (supRes as any).id;
    db.run(`UPDATE memories SET status = 'superseded' WHERE id = ?`, [supId]);

    // 1. 普通时间查询 (非 temporalBrowse)
    const normalTimePlan = buildQueryPlan({ userText: '昨天支付接口', now: fixedNow });
    expect(normalTimePlan.temporalBrowse).toBe(false);
    expect(normalTimePlan.timeRange).toBeDefined();

    const normalResults = recallTemporal(db, normalTimePlan, { workspaceId: ws1, sessionId: session1 });
    // 普通查询不包含 superseded
    expect(normalResults.map((r) => r.id)).toContain(activeId);
    expect(normalResults.map((r) => r.id)).not.toContain(supId);

    // 2. 明确历史浏览 (temporalBrowse = true)
    const browsePlan = buildQueryPlan({ userText: '昨天做了什么', now: fixedNow });
    expect(browsePlan.temporalBrowse).toBe(true);

    const browseResults = recallTemporal(db, browsePlan, { workspaceId: ws1, sessionId: session1 });
    // 包含 superseded
    expect(browseResults.map((r) => r.id)).toContain(activeId);
    expect(browseResults.map((r) => r.id)).toContain(supId);
  });

  it('recallPreference should retrieve preference items ordered by utility', () => {
    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '代码风格偏好使用 2 空格缩进',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    db.run(`UPDATE memories SET utility = 0.95 WHERE content LIKE '%2 空格%'`);

    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '代码命名偏好 camelCase',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    db.run(`UPDATE memories SET utility = 0.5 WHERE content LIKE '%camelCase%'`);

    const plan = buildQueryPlan({ userText: '偏好风格是什么？', now: fixedNow });
    const results = recallPreference(db, plan, { workspaceId: ws1, sessionId: session1 });

    expect(results.length).toBe(2);
    // 高 utility 排在前面
    const topMem = db.get<{ content: string }>('SELECT content FROM memories WHERE id = ?', [results[0].id]);
    expect(topMem?.content).toContain('2 空格');
  });

  it('runAllChannels should aggregate candidates across channels within budget', () => {
    const plan = buildQueryPlan({ userText: '如何配置 PostgreSQL 连接超时？', now: fixedNow });
    const all = runAllChannels(db, plan, { workspaceId: ws1, sessionId: session1 });
    expect(all).toHaveProperty('lexical');
    expect(all).toHaveProperty('entity');
    expect(all).toHaveProperty('typed');
    expect(all).toHaveProperty('temporal');
    expect(all).toHaveProperty('preference');
    expect(all).toHaveProperty('vector');
  });
});

