import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  recallVector,
  runAllChannels,
  expandGraphNeighbors,
  selectLexicalMatchTokens,
  type LexicalFastPath,
} from '../../src/retrieval/channels.js';
import { upsertCandidate, addRelation } from '../../src/core/writer.js';

describe('Retrieval Channels (channels.ts)', () => {
  let db: Db;
  const ws1 = workspaceId('workspace-alpha');
  const ws2 = workspaceId('workspace-beta');
  const session1 = 'sess_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
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

  it('recallLexical should preserve tail keywords & numbers on long 70+ char CJK queries and exclude prompt fillers', () => {
    const target = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '测试环境后端网关实际监听端口号固定为 7890',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const targetId = (target as any).id;

    const longQuery =
      '前面有一大段关于研发团队协作规范、日常评审流程、文档维护机制、灰度发布审批与测试环境准备工作的详细背景说明，最后请问我们后端网关监听的端口号是不是 7890？';
    const plan = buildQueryPlan({ userText: longQuery, now: fixedNow });
    const matchTokens = selectLexicalMatchTokens(plan, 32);
    expect(matchTokens.length).toBeLessThanOrEqual(32);
    expect(matchTokens).toContain('"7890"');
    expect(matchTokens).toContain('"端口"');
    expect(matchTokens).not.toContain('"请问"');

    const hits = recallLexical(db, plan, { workspaceId: ws1, sessionId: session1 });
    expect(hits.some((h) => h.id === targetId)).toBe(true);
  });

  it('recallLexical AND-probe populates shared.rows for recallTyped reuse without redundant CTE', () => {
    db.transaction(() => {
      for (let i = 1; i <= 30; i++) {
        upsertCandidate(
          db,
          {
            type: i <= 5 ? 'procedural' : 'semantic',
            content: `Redis 集群超时排查步骤第 ${i} 条：检查连接池心跳`,
            scope: 'workspace',
            workspaceId: ws1,
            source_kind: 'user',
            confidence: 0.9,
            origin_kinds: ['user'],
            sources: [{ session_id: session1, seq: i, kind: 'user' }],
            actor: 'user',
          },
          fixedNow + i
        );
      }
    });

    const plan = buildQueryPlan({ userText: '怎么修复 Redis 超时', now: fixedNow });
    const shared: LexicalFastPath = {};
    const lexHits = recallLexical(db, plan, { workspaceId: ws1, sessionId: session1 }, shared);
    expect(lexHits.length).toBeGreaterThanOrEqual(25);
    expect(shared.rows).toBeDefined();
    expect(shared.rows!.length).toBeGreaterThanOrEqual(25);

    const typedHits = recallTyped(db, plan, { workspaceId: ws1, sessionId: session1 }, shared);
    expect(typedHits.length).toBeGreaterThanOrEqual(1);
    for (const hit of typedHits) {
      const row = db.get<{ type: string }>('SELECT type FROM memories WHERE id = ?', [hit.id]);
      expect(['procedural', 'failure', 'episodic']).toContain(row?.type);
    }
  });

  it('recallEntity should weight explicit plan.entities strictly above contextEntities with deterministic tie-breakers', () => {
    const rPrimary = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '核心认证配置文件 auth-guard.ts',
        scope: 'workspace',
        workspaceId: ws1,
        entities: ['auth-guard.ts'],
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      fixedNow
    );
    const rContextOnly = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '通用工具执行日志 bash 与 read_file',
        scope: 'workspace',
        workspaceId: ws1,
        entities: ['bash', 'read_file'],
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      fixedNow + 100
    );
    const primaryId = (rPrimary as any).id;
    const contextId = (rContextOnly as any).id;
    // Even if context-only memory has higher utility, 1 explicit entity (weight 3) beats 2 context entities (weight 2)
    db.run('UPDATE memories SET utility = 0.99 WHERE id = ?', [contextId]);
    db.run('UPDATE memories SET utility = 0.5 WHERE id = ?', [primaryId]);

    const plan = buildQueryPlan({
      userText: '查看 auth-guard.ts 配置',
      recentToolNames: ['bash', 'read_file'],
      now: fixedNow,
    });
    const hits = recallEntity(db, plan, { workspaceId: ws1, sessionId: session1 });
    expect(hits.length).toBe(2);
    expect(hits[0].id).toBe(primaryId);
    expect(hits[1].id).toBe(contextId);
  });

  it('recallTemporal temporalBrowse should NOT match 2-year-old timeless facts via valid_from <= to AND valid_to IS NULL', () => {
    const twoYearsAgo = fixedNow - 730 * 86400000;
    const yesterday = fixedNow - 86400000;

    const oldFact = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '两年前确定的永恒项目编码规范',
        scope: 'workspace',
        workspaceId: ws1,
        valid_from: twoYearsAgo,
        valid_to: null,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 1, kind: 'user' }],
        actor: 'user',
      },
      twoYearsAgo
    );
    const yesterdayEvt = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '昨天上线了新版日志采集器',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: session1, seq: 2, kind: 'user' }],
        actor: 'user',
      },
      yesterday
    );

    const browsePlan = buildQueryPlan({ userText: '昨天发生了什么', now: fixedNow });
    expect(browsePlan.temporalBrowse).toBe(true);
    const hits = recallTemporal(db, browsePlan, { workspaceId: ws1, sessionId: session1 });
    const ids = hits.map((h) => h.id);
    expect(ids).toContain((yesterdayEvt as any).id);
    expect(ids).not.toContain((oldFact as any).id);
  });

  it('recallVector eliminates Top-400 blind spot via full WorkspaceVectorIndex scan', () => {
    let lowUtilTargetId = '';
    db.transaction(() => {
      // Insert 450 high-utility unrelated filler memories
      for (let i = 1; i <= 450; i++) {
        const res = upsertCandidate(
          db,
          {
            type: 'semantic',
            content: `前端样式主题色板记录第 ${i} 条：玻璃拟态圆角与阴影参数配置`,
            scope: 'workspace',
            workspaceId: ws1,
            source_kind: 'user',
            confidence: 0.9,
            origin_kinds: ['user'],
            sources: [{ session_id: session1, seq: i, kind: 'user' }],
            actor: 'user',
          },
          fixedNow + i
        );
        db.run('UPDATE memories SET utility = 0.95 WHERE id = ?', [(res as any).id]);
      }

      // Insert 1 low-utility target memory (would be rank #451 under old Top-400 SQL scan!)
      const target = upsertCandidate(
        db,
        {
          type: 'procedural',
          content: '排查 eBPF 内核探针 kprobe_attach 权限不足时需开启 CAP_BPF 能力',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: session1, seq: 999, kind: 'user' }],
          actor: 'user',
        },
        fixedNow - 100000
      );
      lowUtilTargetId = (target as any).id;
      db.run('UPDATE memories SET utility = 0.1 WHERE id = ?', [lowUtilTargetId]);
    });

    const plan = buildQueryPlan({
      userText: 'eBPF 内核探针 kprobe_attach CAP_BPF',
      now: fixedNow,
    });
    const hits = recallVector(db, plan, { workspaceId: ws1, sessionId: session1 });
    expect(hits.some((h) => h.id === lowUtilTargetId)).toBe(true);
    expect(hits[0].id).toBe(lowUtilTargetId);
  });

  it('expandGraphNeighbors prevents hub entities from starving rare bridge entities and keeps seed-to-seed symmetry', () => {
    let seedA = '';
    let seedB = '';
    let rareNeighbor = '';
    db.transaction(() => {
      const rA = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '核心模块 Alpha 使用 common-hub.ts 与 rare-vault.ts',
          scope: 'workspace',
          workspaceId: ws1,
          entities: ['common-hub.ts', 'rare-vault.ts'],
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: session1, seq: 1, kind: 'user' }],
          actor: 'user',
        },
        fixedNow
      );
      seedA = (rA as any).id;

      const rB = upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '配套模块 Beta 负责密钥轮换调度',
          scope: 'workspace',
          workspaceId: ws1,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: session1, seq: 2, kind: 'user' }],
          actor: 'user',
        },
        fixedNow + 1
      );
      seedB = (rB as any).id;

      // 15 hub memories sharing common-hub.ts (fan = 16 > 10)
      for (let i = 1; i <= 15; i++) {
        upsertCandidate(
          db,
          {
            type: 'semantic',
            content: `高频通用记录 ${i} 提及 common-hub.ts`,
            scope: 'workspace',
            workspaceId: ws1,
            entities: ['common-hub.ts'],
            source_kind: 'user',
            confidence: 0.85,
            origin_kinds: ['user'],
            sources: [{ session_id: session1, seq: 10 + i, kind: 'user' }],
            actor: 'user',
          },
          fixedNow + 10 + i
        );
      }

      // 1 rare entity neighbor sharing rare-vault.ts (fan = 2 <= 10)
      const rRare = upsertCandidate(
        db,
        {
          type: 'failure',
          content: 'rare-vault.ts 密钥文件权限必须为 0600 否则启动失败',
          scope: 'workspace',
          workspaceId: ws1,
          entities: ['rare-vault.ts'],
          source_kind: 'user',
          confidence: 0.95,
          origin_kinds: ['user'],
          sources: [{ session_id: session1, seq: 99, kind: 'user' }],
          actor: 'user',
        },
        fixedNow + 100
      );
      rareNeighbor = (rRare as any).id;

      db.run('DELETE FROM memory_relations');
      // Single directional 'related' edge between seedA and seedB
      addRelation(db, seedA, seedB, 'related', fixedNow + 200);
    });

    const neighbors = expandGraphNeighbors(db, [seedA, seedB], { workspaceId: ws1, sessionId: session1 }, 12);
    // 1. Seed-to-seed symmetry: both seedA->seedB and seedB->seedA emitted
    expect(neighbors.some((n) => n.seedId === seedA && n.neighborId === seedB)).toBe(true);
    expect(neighbors.some((n) => n.seedId === seedB && n.neighborId === seedA)).toBe(true);
    // 2. Rare entity bridge MUST NOT be starved by 15 hub-entity rows
    const rareHit = neighbors.find((n) => n.neighborId === rareNeighbor);
    expect(rareHit).toBeDefined();
    expect(rareHit?.bridgeEntity).toBe('rare-vault.ts');
  });
});

