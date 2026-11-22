import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import {
  DEFAULT_DISPOSITION,
  classifyHindsightNetwork,
  parseHindsightNetwork,
  computeNetworkIntentBonus,
  computeEvidenceCalibratedConfidence,
  normalizeTopicSlug,
  runHindsightReflect,
  formatHindsightReflectReport,
  traceHindsightEvolution,
} from '../../src/core/hindsight.js';
import { upsertCandidate, editContent, pin, forget, addRelation } from '../../src/core/writer.js';
import { get } from '../../src/core/store.js';
import { workspaceId } from '../../src/core/scope.js';

describe('Hindsight 4-Network Cognitive Reflection & Evolution (src/core/hindsight.ts)', () => {
  let db: Db;
  const ws = workspaceId('/synthetic/ws/hindsight-unit');
  const wsOther = workspaceId('/synthetic/ws/hindsight-other');
  const wsExcluded = workspaceId('/synthetic/ws/hindsight-excluded');
  const baseNow = 1_770_000_000_000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('calibrates confidence idempotently across 10 consecutive runs without drift or updated_at mutation', () => {
    const userMemRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '调度器统一使用单调时钟避免系统时间跳变导致任务错乱',
        slot_key: 'scheduler.clock.mode',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.65,
        origin_kinds: ['user'],
        sources: [
          { session_id: 's1', seq: 1, kind: 'user_msg' },
          { session_id: 's2', seq: 2, kind: 'user_msg' },
        ],
        actor: 'user',
      },
      baseNow
    );
    const userMemId = (userMemRes as { id: string }).id;

    const prefMemRes = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '代码审查反馈优先指出并发竞态与安全边界问题',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.7,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 10
    );
    const prefMemId = (prefMemRes as { id: string }).id;

    // Web-tainted memory forced active to verify <= 0.50 confidence cap under calibration
    const webMemRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '第三方博客声称可以关闭 TLS 证书验证加速内网请求',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'web',
        confidence: 0.5,
        origin_kinds: ['web'],
        sources: [{ session_id: 's1', seq: 4, kind: 'web' }],
        actor: 'llm',
      },
      baseNow + 20
    );
    const webMemId = (webMemRes as { id: string }).id;
    db.run(`UPDATE memories SET status = 'active', confidence = 0.75 WHERE id = ?`, [webMemId]);

    const beforeUpdatedAt = new Map<string, number>([
      [userMemId, get(db, userMemId)!.updated_at],
      [prefMemId, get(db, prefMemId)!.updated_at],
      [webMemId, get(db, webMemId)!.updated_at],
    ]);

    // First calibration run
    const first = runHindsightReflect(db, {
      workspaceId: ws,
      autoSynthesize: false,
      now: baseNow + 1000,
    });
    expect(first.calibratedMemories.length).toBeGreaterThanOrEqual(2);

    const afterRun1 = new Map<string, { confidence: number; updated_at: number }>([
      [userMemId, { confidence: get(db, userMemId)!.confidence, updated_at: get(db, userMemId)!.updated_at }],
      [prefMemId, { confidence: get(db, prefMemId)!.confidence, updated_at: get(db, prefMemId)!.updated_at }],
      [webMemId, { confidence: get(db, webMemId)!.confidence, updated_at: get(db, webMemId)!.updated_at }],
    ]);

    // Untrusted web memory MUST be capped <= 0.50; updated_at MUST NEVER be mutated
    expect(afterRun1.get(webMemId)!.confidence).toBeLessThanOrEqual(0.5);
    for (const [id, origUpdatedAt] of beforeUpdatedAt.entries()) {
      expect(afterRun1.get(id)!.updated_at).toBe(origUpdatedAt);
    }

    // 10 consecutive runs -> zero calibration drift and zero updated_at mutations
    for (let run = 1; run <= 10; run++) {
      const report = runHindsightReflect(db, {
        workspaceId: ws,
        autoSynthesize: false,
        now: baseNow + (run + 1) * 60_000,
      });
      expect(report.calibratedMemories).toHaveLength(0);
      for (const [id, expected] of afterRun1.entries()) {
        const cur = get(db, id)!;
        expect(cur.confidence).toBe(expected.confidence);
        expect(cur.updated_at).toBe(expected.updated_at);
      }
    }

    // Direct stateless computeEvidenceCalibratedConfidence idempotency check
    const targetRec = get(db, userMemId)!;
    const direct1 = computeEvidenceCalibratedConfidence(
      targetRec,
      { distinctSessions: 2, hasUserProof: true, hasActiveContradiction: false, derivedSourceCount: 0 },
      DEFAULT_DISPOSITION
    );
    const direct2 = computeEvidenceCalibratedConfidence(
      { ...targetRec, confidence: direct1 },
      { distinctSessions: 2, hasUserProof: true, hasActiveContradiction: false, derivedSourceCount: 0 },
      DEFAULT_DISPOSITION
    );
    expect(direct2).toBe(direct1);
  });

  it('classifies procedural as observation (even with hindsight.model.* slot) consistently with SQL networkCounts', () => {
    expect(classifyHindsightNetwork('procedural')).toBe('observation');
    expect(classifyHindsightNetwork('procedural', 'hindsight.model.deploy_flow')).toBe('observation');
    expect(classifyHindsightNetwork('belief', 'hindsight.model.arch')).toBe('opinion');
    expect(classifyHindsightNetwork('semantic', 'hindsight.obs.checklist')).toBe('observation');
    expect(classifyHindsightNetwork('semantic')).toBe('world');
    expect(classifyHindsightNetwork('episodic')).toBe('experience');
    expect(classifyHindsightNetwork('failure')).toBe('experience');
    expect(classifyHindsightNetwork('preference')).toBe('opinion');
    expect(classifyHindsightNetwork('goal')).toBe('opinion');

    expect(parseHindsightNetwork('procedural')).toBe('observation');
    expect(parseHindsightNetwork('mental_model')).toBe('opinion');
    expect(parseHindsightNetwork('facts')).toBe('world');
    expect(parseHindsightNetwork('episodic')).toBe('experience');
    expect(parseHindsightNetwork('unknown_net')).toBeUndefined();

    expect(
      computeNetworkIntentBonus('observation', {
        procedural: true,
        causal: false,
        preference: false,
        temporal: false,
      })
    ).toBeGreaterThan(0);

    // Verify SQL GROUP BY networkCounts matches classifyHindsightNetwork for procedural + hindsight.model.*
    upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '发布前先运行 typecheck 与全量单元测试再构建镜像',
        slot_key: 'hindsight.model.release_gate',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow
    );
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '认证服务监听 8443 TLS 端口',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 1
    );
    upsertCandidate(
      db,
      {
        type: 'failure',
        content: '未设置 WAL checkpoint 导致 SQLite 日志体积膨胀',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 2
    );
    upsertCandidate(
      db,
      {
        type: 'belief',
        content: '拆分小而聚焦的路由模块更有利于安全审计',
        slot_key: 'hindsight.model.web_arch',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 4, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 3
    );

    const report = runHindsightReflect(db, {
      workspaceId: ws,
      autoSynthesize: false,
      now: baseNow + 100,
    });
    expect(report.networkCounts).toEqual({
      world: 1,
      experience: 1,
      observation: 1,
      opinion: 1,
    });
  });

  it('normalizes ASCII and CJK topic anchors into strict ASCII slugs keeping hindsight.model.<slug> <= 48 chars', () => {
    expect(normalizeTopicSlug('')).toBe('');
    expect(normalizeTopicSlug('a')).toBe('');

    const samples = [
      'src/pay/gateway.ts',
      'Redis-Cluster.v7',
      '支付网关配置',
      '数据库连接池调优与故障转移策略规范超长标题',
      'gateway/核心模块/v2',
      'a'.repeat(80),
    ];

    for (const raw of samples) {
      const slug = normalizeTopicSlug(raw);
      expect(slug.length).toBeGreaterThanOrEqual(2);
      expect(slug.length).toBeLessThanOrEqual(32);
      expect(slug).toMatch(/^[a-z0-9_-]+$/);

      const fullSlot = `hindsight.model.${slug}`;
      expect(fullSlot.length).toBeLessThanOrEqual(48);
      expect(fullSlot).toMatch(/^[a-z0-9.:_-]+$/);
    }

    // Distinct CJK topics produce distinct deterministic hashes
    const cjk1 = normalizeTopicSlug('支付网关幂等校验');
    const cjk2 = normalizeTopicSlug('订单系统状态机');
    expect(cjk1).toBe(normalizeTopicSlug('支付网关幂等校验'));
    expect(cjk1).not.toBe(cjk2);
  });

  it('refreshes synthesized models on source edit, invalidates them when sources are archived, and protects pinned models', () => {
    const m1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存集群 redis.sentinel 采用三节点哨兵模式管理主从切换',
        slot_key: 'redis.sentinel.topology',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow
    );
    const m2 = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '在 redis.sentinel 切换期间未启用连接重试会导致短暂写失败',
        slot_key: 'redis.sentinel.failover_pitfall',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 10
    );
    const id1 = (m1 as { id: string }).id;
    const id2 = (m2 as { id: string }).id;

    // 1. Synthesize model
    const r1 = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'redis.sentinel',
      minClusterSize: 2,
      now: baseNow + 100,
    });
    expect(r1.synthesizedModels).toHaveLength(1);
    const model1 = r1.synthesizedModels[0];
    expect(model1.slotKey).toBe('hindsight.model.redis_sentinel');
    expect(model1.type).toBe('procedural');
    expect(model1.network).toBe('observation');
    expect(model1.supportingMemoryIds).toContain(id1);
    expect(get(db, model1.id)?.approved_by).not.toBe('user');

    // Report formatter includes model summary
    expect(formatHindsightReflectReport(r1)).toContain(model1.id);

    // 2. Re-run with no source changes -> idempotent (no duplicate synthesis)
    const r2 = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'redis.sentinel',
      minClusterSize: 2,
      now: baseNow + 200,
    });
    expect(r2.synthesizedModels).toHaveLength(0);

    // 3. Supersede source m1 with updated user fact -> old model's derived_from becomes stale -> model refreshed cleanly
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存集群 redis.sentinel 升级为五节点哨兵架构并开启 TLS 加密',
        slot_key: 'redis.sentinel.topology',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 300
    );
    const r3 = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'redis.sentinel',
      minClusterSize: 2,
      now: baseNow + 400,
    });
    expect(r3.synthesizedModels).toHaveLength(1);
    const refreshedModelId = r3.synthesizedModels[0].id;
    expect(get(db, model1.id)?.status).toBe('superseded');
    expect(get(db, refreshedModelId)?.status).toBe('active');
    expect(get(db, refreshedModelId)?.content).toContain('五节点哨兵架构');

    // 4. Archive source m2 -> remaining active sources (1) < minClusterSize (2) -> unpinned active model invalidated/archived
    forget(db, id2, 'user', baseNow + 500);
    runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'redis.sentinel',
      minClusterSize: 2,
      now: baseNow + 600,
    });
    const invalidated = get(db, refreshedModelId)!;
    expect(invalidated.status).toBe('archived');
    expect(invalidated.invalidated_at).not.toBeNull();

    // 5. Pinned model MUST NOT be invalidated when a source is archived
    const p1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '队列集群 kafka.bridge 使用 Snappy 压缩传输批消息',
        slot_key: 'kafka.bridge.codec',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's2', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 700
    );
    const p2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '队列集群 kafka.bridge 分区副本因子固定为 3',
        slot_key: 'kafka.bridge.replication',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's2', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 710
    );
    const rp = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'kafka.bridge',
      minClusterSize: 2,
      now: baseNow + 800,
    });
    expect(rp.synthesizedModels).toHaveLength(1);
    const pinnedModelId = rp.synthesizedModels[0].id;
    pin(db, pinnedModelId, 'user', baseNow + 850);

    forget(db, (p1 as { id: string }).id, 'user', baseNow + 900);
    forget(db, (p2 as { id: string }).id, 'user', baseNow + 910);
    runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'kafka.bridge',
      minClusterSize: 2,
      now: baseNow + 1000,
    });
    expect(get(db, pinnedModelId)?.status).toBe('active');
  });

  it('traceHindsightEvolution keeps only the latest 6 version snapshots in ascending order and enforces scope/excludeWorkspaces isolation', () => {
    const targetRes = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '核心编译配置演进版本 v1',
        summary: '核心编译配置 v1',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow
    );
    const targetId = (targetRes as { id: string }).id;

    // 9 edits -> versions 1..9 stored in memory_versions, current version = 10
    for (let v = 2; v <= 10; v++) {
      editContent(
        db,
        targetId,
        `核心编译配置演进版本 v${v} — 优化构建管线`,
        `核心编译配置 v${v}`,
        'user',
        baseNow + v * 1000
      );
    }

    // Create in-scope vs out-of-scope / other-session / excluded-workspace neighbors
    const visibleSrcId = (
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '同工作区可见证据支撑节点',
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 's1', seq: 20, kind: 'user_msg' }],
          actor: 'user',
        },
        baseNow + 20_000
      ) as { id: string }
    ).id;

    const otherWsId = (
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '其他工作区的敏感关联节点不应泄漏',
          scope: 'workspace',
          workspaceId: wsOther,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_other', seq: 1, kind: 'user_msg' }],
          actor: 'user',
        },
        baseNow + 21_000
      ) as { id: string }
    ).id;

    const otherSessId = (
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '其他会话的私有记忆节点不应泄漏',
          scope: 'session',
          workspaceId: ws,
          sessionId: 'sess_private_2',
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 'sess_private_2', seq: 1, kind: 'user_msg' }],
          actor: 'user',
        },
        baseNow + 22_000
      ) as { id: string }
    ).id;

    const excludedWsId = (
      upsertCandidate(
        db,
        {
          type: 'semantic',
          content: '排除工作区的机密矛盾节点不应泄漏',
          scope: 'workspace',
          workspaceId: wsExcluded,
          source_kind: 'user',
          confidence: 0.9,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_exc', seq: 1, kind: 'user_msg' }],
          actor: 'user',
        },
        baseNow + 23_000
      ) as { id: string }
    ).id;

    // Link target to visible + forbidden neighbors across all relation types
    addRelation(db, targetId, visibleSrcId, 'derived_from', baseNow + 30_000);
    addRelation(db, targetId, otherWsId, 'derived_from', baseNow + 30_001);
    addRelation(db, otherSessId, targetId, 'derived_from', baseNow + 30_002);
    addRelation(db, targetId, excludedWsId, 'contradicts', baseNow + 30_003);
    addRelation(db, targetId, otherWsId, 'supersedes', baseNow + 30_004);

    const targetRecord = get(db, targetId)! as MemoryRecord;
    const trace = traceHindsightEvolution(db, targetRecord, {
      workspaceId: ws,
      sessionId: 'sess_1',
      excludeWorkspaces: [wsExcluded],
    });

    // Latest 6 snapshots [4, 5, 6, 7, 8, 9] in ascending order + current version 10
    const targetTimelineVersions = trace.timeline
      .filter((n) => n.id === targetId)
      .map((n) => n.version);
    expect(targetTimelineVersions).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(trace.timeline[trace.timeline.length - 1].relationToCurrent).toBe('current');

    // Only visibleSrcId appears in derivedSources; forbidden nodes are completely absent
    expect(trace.derivedSources.map((n) => n.id)).toEqual([visibleSrcId]);
    expect(trace.derivedModels).toHaveLength(0);
    expect(trace.contradictions).toHaveLength(0);

    const allReturnedIds = [
      ...trace.timeline.map((n) => n.id),
      ...trace.derivedSources.map((n) => n.id),
      ...trace.derivedModels.map((n) => n.id),
      ...trace.contradictions.map((n) => n.id),
    ];
    expect(allReturnedIds).not.toContain(otherWsId);
    expect(allReturnedIds).not.toContain(otherSessId);
    expect(allReturnedIds).not.toContain(excludedWsId);
  });

  it('respects excludeWorkspaces and never leaks session or user-scope memories into workspace mental models', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '机密仓库 secret_token_flow 使用内部 KMS 签名',
        scope: 'workspace',
        workspaceId: wsExcluded,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_ex', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow
    );

    const excludedReport = runHindsightReflect(db, {
      workspaceId: wsExcluded,
      excludeWorkspaces: [wsExcluded],
      now: baseNow + 100,
    });
    expect(excludedReport.networkCounts).toEqual({
      world: 0,
      experience: 0,
      observation: 0,
      opinion: 0,
    });
    expect(excludedReport.synthesizedModels).toHaveLength(0);

    // Two session/user memories sharing a topic MUST NOT synthesize a workspace mental model
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '临时会话讨论 private_topic_alpha 的个人备忘一',
        scope: 'session',
        workspaceId: ws,
        sessionId: 'sess_alpha',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_alpha', seq: 1, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 200
    );
    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '个人用户级偏好关于 private_topic_alpha 的习惯二',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_alpha', seq: 2, kind: 'user_msg' }],
        actor: 'user',
      },
      baseNow + 210
    );

    const report = runHindsightReflect(db, {
      workspaceId: ws,
      sessionId: 'sess_alpha',
      topic: 'private_topic_alpha',
      minClusterSize: 2,
      now: baseNow + 300,
    });
    expect(report.synthesizedModels).toHaveLength(0);
  });
});
