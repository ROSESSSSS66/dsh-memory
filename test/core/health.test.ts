import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db, MemoryRecord } from '../../src/types.js';
import {
  auditMemoryHealth,
  autoHealMemoryHealth,
  weaveZettelkastenLinks,
  syncAutonomousCoreMemory,
  areScopesCompatibleForWeaving,
  normSlot,
} from '../../src/core/health.js';
import {
  classifyHindsightNetwork,
  computeEvidenceCalibratedConfidence,
  normalizeTopicSlug,
  runHindsightReflect,
  traceHindsightEvolution,
} from '../../src/core/hindsight.js';
import { upsertCandidate, editContent, pin, forget, saveVersionSnapshot } from '../../src/core/writer.js';
import { setCoreMemory } from '../../src/core/core-memory.js';
import { workspaceId } from '../../src/core/scope.js';

describe('Memory Health & Conflict Doctor (src/core/health.ts)', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-health');
  const now = 1762400000000;
  const DAY_MS = 86_400_000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns A+ score on a clean, consistent memory database', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '后端 API 服务监听在 8080 端口',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const report = auditMemoryHealth(db, { workspaceId: ws, now });
    expect(report.score).toBeGreaterThanOrEqual(95);
    expect(report.grade).toBe('A+');
    expect(report.ftsConsistent).toBe(true);
    expect(report.duplicatePairs).toHaveLength(0);
    expect(report.contradictions).toHaveLength(0);
  });

  it('detects near-duplicate / shared slot_key pairs, contradictions, and stale memories (>= 14d & utility < 0.35)', () => {
    const r1 = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '包管理器统一使用 pnpm 进行依赖安装与脚本执行',
        slot_key: 'pkg_manager',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const id1 = (r1 as any).id;

    // Insert a second active memory with normalized equivalent slot_key ('pkg-manager' vs 'pkg_manager') and high lexical overlap
    const r2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目包管理器统一使用 pnpm 进行依赖安装与构建脚本执行',
        slot_key: 'pkg-manager',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const id2 = (r2 as any).id;

    // A low-utility memory that is only 10 days old should NOT be flagged stale (< 14d floor)
    const rYoung = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '最近一次本地联调记录，尚未超过两周观察期',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now - 10 * DAY_MS
    );
    const youngId = (rYoung as any).id;
    db.run(`UPDATE memories SET utility = 0.25 WHERE id = ?`, [youngId]);

    // Add an explicit contradiction relation and lower utility (< 0.35) + age >= 14 days on id2
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [id1, id2, now]
    );
    db.run(`UPDATE memories SET utility = 0.25, created_at = ? WHERE id = ?`, [
      now - 20 * DAY_MS,
      id2,
    ]);

    const report = auditMemoryHealth(db, { workspaceId: ws, now });
    expect(report.duplicatePairs.length).toBeGreaterThanOrEqual(1);
    expect(report.duplicatePairs[0].reason).toBe('same_slot_key');
    expect(report.contradictions).toHaveLength(1);
    expect(report.staleMemories.some((s) => s.id === id2)).toBe(true);
    expect(report.staleMemories.some((s) => s.id === youngId)).toBe(false);
    expect(report.score).toBeLessThan(95);
    expect(report.recommendations.length).toBeGreaterThanOrEqual(2);
  });

  it('autoHealMemoryHealth backfills embeddings, merges duplicate pairs, and resolves eligible non-frozen contradictions', () => {
    const r1 = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '部署脚本统一使用 Docker Compose V2 构建与启动容器',
        slot_key: 'deploy_tool',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const id1 = (r1 as any).id;

    const r2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目部署脚本统一使用 Docker Compose V2 构建与启动服务容器',
        slot_key: 'deploy-tool',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 100
    );
    expect((r2 as any).id).toBeTruthy();

    // Add a third system-approved active memory with an explicit contradiction against user-approved id1
    const r3 = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '旧版临时实验：曾尝试手动裸跑二进制进程而不使用容器',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'system',
        status: 'active',
        confidence: 0.65,
        origin_kinds: ['system'],
        sources: [{ session_id: 's0', seq: 1, kind: 'system' }],
        actor: 'system',
      },
      now - 5000
    );
    const id3 = (r3 as any).id;
    // Simulate a legacy unembedded record so autoHealMemoryHealth exercises embedding backfill alongside inline write embeddings
    db.run(`UPDATE memories SET embedding = NULL WHERE id = ?`, [id3]);
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [id1, id3, now]
    );

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 500 });
    expect(healRes.embeddingsBackfilled).toBeGreaterThanOrEqual(1);
    expect(healRes.duplicatesMerged).toBe(1);
    expect(healRes.contradictionsResolved).toBe(1);
    expect(healRes.afterScore).toBeGreaterThan(healRes.beforeScore);
    expect(healRes.report.duplicatePairs).toHaveLength(0);
    expect(healRes.report.contradictions).toHaveLength(0);
    expect(healRes.report.missingEmbeddingsCount).toBe(0);
    expect(healRes.errors).toEqual([]);
  });

  it('auto-promotes clean user-evidenced candidates while preserving human approval for repair proposals and blocking llm_extract / tainted candidates', () => {
    // 1. Clean assistant candidate backed by pure user_msg evidence -> eligible for promotion
    const cand = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '全自动部署流水线要求在合并主干前通过全部 120 条门禁回归测试',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'assistant',
        status: 'candidate',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_auto', seq: 1, kind: 'user_msg' }],
        actor: 'llm',
      },
      now
    );
    const candId = (cand as any).id;

    // 2. llm_extract candidate (even with user_msg source) -> MUST NOT be auto-promoted
    const llmExtractCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '离线抽取的缓存失效策略建议改为 15 分钟滑动窗口',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'llm_extract',
        status: 'candidate',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_auto', seq: 2, kind: 'user_msg' }],
        actor: 'llm',
      },
      now + 5
    );
    const llmExtractId = (llmExtractCand as any).id;

    // 3. Mixed-taint candidate (user_msg + web source) -> MUST NOT be auto-promoted
    const taintedCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '混合网页与用户上下文的未经审核配置项',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'assistant',
        status: 'candidate',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [
          { session_id: 's_auto', seq: 3, kind: 'user_msg' },
          { session_id: 's_auto', seq: 4, kind: 'web' },
        ],
        actor: 'llm',
      },
      now + 8
    );
    const taintedId = (taintedCand as any).id;

    // 4. Pending repair proposal -> MUST remain pending human approval (repairsApplied === 0)
    const orig = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存集群连接池最大连接数配置为 50。',
        slot_key: 'redis.max_pool',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_auto', seq: 5, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const origId = (orig as any).id;

    const revCand = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存集群连接池最大连接数已扩容配置为 128。',
        slot_key: 'redis.max_pool',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'assistant',
        status: 'candidate',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_auto', seq: 6, kind: 'user' }],
        actor: 'llm',
      },
      now + 10
    );
    const revCandId = (revCand as any).id;

    db.run(
      `INSERT INTO repair_proposals (
        job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at
      ) VALUES (1, ?, 1, 'revise', ?, 'Pool size updated to 128', 'candidate', ?, ?)`,
      [origId, JSON.stringify([revCandId]), now + 20, now + 86400_000]
    );

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 100 });
    expect(healRes.candidatesPromoted).toBe(1);
    expect(healRes.repairsApplied).toBe(0);

    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [candId])?.status
    ).toBe('active');
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [llmExtractId])?.status
    ).toBe('candidate');
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [taintedId])?.status
    ).toBe('candidate');
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [origId])?.status
    ).toBe('active');
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [revCandId])?.status
    ).toBe('candidate');
  });

  it('weaves cross-scope and heterogeneous orphan memories to 0 orphans during autoHealMemoryHealth', () => {
    upsertCandidate(
      db,
      {
        type: 'preference',
        content: '用户偏好直接给出简洁中文结论',
        slot_key: 'user.pref.style',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '当前工程采用 SQLite WAL + FTS5 + 128D 向量检索引擎',
        slot_key: 'project.arch.storage',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '发布前执行 npm run check 与 npm run eval 验证门禁',
        slot_key: 'project.cmd.verify',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 100 });
    expect(healRes.report.orphanMemoriesCount).toBe(0);
    expect(healRes.afterScore).toBe(100);
    expect(healRes.afterGrade).toBe('A+');
  });

  it('preserves slot hierarchy dots in normSlot and requires similarity when raw slot_keys differ', () => {
    expect(normSlot('pkg_manager')).toBe(normSlot('pkg-manager'));
    expect(normSlot('api.v1_0')).not.toBe(normSlot('api.v10'));
    expect(normSlot('api.v1.0')).not.toBe(normSlot('api.v10'));
    expect(normSlot('api.v1.0')).not.toBe(normSlot('api.v1_0'));

    // Unrelated content with variant separator slot_keys must NOT be flagged or merged
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '生产环境数据库连接超时时间设定为三十秒',
        slot_key: 'service_timeout',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '前端主题配色采用深灰背景与高对比度绿色强调色',
        slot_key: 'service-timeout',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const report = auditMemoryHealth(db, { workspaceId: ws, now: now + 20 });
    expect(report.duplicatePairs).toHaveLength(0);
  });

  it('never auto-resolves contradictions between two user-approved memories or across different scopes', () => {
    const u1 = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '服务端日志输出格式优先使用 JSON 结构化日志',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const u2 = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '本地开发环境日志偏好纯文本彩色输出',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.7,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    // Cross-scope contradiction: user preference vs workspace system rule
    const userPref = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '全局默认使用 pnpm 作为包管理工具',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );
    const wsSys = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '某遗留子包暂时仍通过 npm 执行构建脚本',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'system',
        status: 'active',
        confidence: 0.7,
        origin_kinds: ['system'],
        sources: [{ session_id: 's1', seq: 4, kind: 'system' }],
        actor: 'system',
      },
      now + 30
    );

    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [(u1 as any).id, (u2 as any).id, now + 40]
    );
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [(userPref as any).id, (wsSys as any).id, now + 40]
    );

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 100 });
    expect(healRes.contradictionsResolved).toBe(0);
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [(u2 as any).id])?.status
    ).toBe('active');
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [(wsSys as any).id])?.status
    ).toBe('active');
  });

  it('enforces session, workspace, and excludeWorkspaces isolation across audit, weave, core-sync, and autoHeal', () => {
    const secretWs = workspaceId('/test/secret-workspace');

    // Session-scoped memories in two different sessions within ws
    const sessA = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '会话 A 临时调试断点位于 src/auth.ts 第 42 行',
        scope: 'session',
        workspaceId: ws,
        sessionId: 'sess_A',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_A', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const sessB = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '会话 B 临时调试断点位于 src/auth.ts 第 88 行',
        scope: 'session',
        workspaceId: ws,
        sessionId: 'sess_B',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_B', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    // Excluded workspace memory + core hub in foreign workspace
    setCoreMemory(db, 'project', '机密项目核心架构说明', { workspaceId: secretWs, actor: 'user' });
    const secretMem = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '机密工作区内部网关域名为 internal.secret.corp',
        scope: 'workspace',
        workspaceId: secretWs,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_secret', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );
    db.run(`UPDATE memories SET embedding = NULL, utility = 0.85, success_count = 3 WHERE id = ?`, [
      (secretMem as any).id,
    ]);

    // Single orphan in public workspace ws
    const publicMem = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '公开项目文档采用 VitePress 生成静态站点',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_pub', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now + 30
    );

    // 1. Audit without sessionId must NOT leak session memories or excluded workspace
    const auditNoSess = auditMemoryHealth(db, {
      workspaceId: ws,
      excludeWorkspaces: [secretWs],
      now: now + 50,
    });
    expect(auditNoSess.counts.active).toBe(1);

    // 2. Audit with sessionId='sess_A' includes sess_A but NOT sess_B
    const auditSessA = auditMemoryHealth(db, {
      workspaceId: ws,
      sessionId: 'sess_A',
      excludeWorkspaces: [secretWs],
      now: now + 50,
    });
    expect(auditSessA.counts.active).toBe(2);

    // 3. areScopesCompatibleForWeaving strictly isolates sessions & workspaces
    expect(
      areScopesCompatibleForWeaving(
        { scope: 'session', workspace_id: ws, session_id: 'sess_A' },
        { scope: 'session', workspace_id: ws, session_id: 'sess_B' },
        true
      )
    ).toBe(false);
    expect(
      areScopesCompatibleForWeaving(
        { scope: 'session', workspace_id: ws, session_id: 'sess_A' },
        { scope: 'workspace', workspace_id: ws, session_id: null },
        true
      )
    ).toBe(false);

    // 4. weaveZettelkastenLinks must NOT link publicMem to secretWs's core:project (no coreHubRows[0] fallback)
    //    and must NOT link sessA to publicMem or sessB
    const weaved = weaveZettelkastenLinks(db, {
      workspaceId: ws,
      sessionId: 'sess_A',
      excludeWorkspaces: [secretWs],
      now: now + 60,
    });
    expect(weaved).toBe(0);
    const crossLinks = db.all(
      `SELECT * FROM memory_relations WHERE from_id IN (?, ?, ?) OR to_id IN (?, ?, ?)`,
      [
        (publicMem as any).id,
        (sessA as any).id,
        (sessB as any).id,
        (publicMem as any).id,
        (sessA as any).id,
        (sessB as any).id,
      ]
    );
    expect(crossLinks).toHaveLength(0);

    // 5. syncAutonomousCoreMemory skips excluded workspace
    expect(
      syncAutonomousCoreMemory(db, {
        workspaceId: secretWs,
        excludeWorkspaces: [secretWs],
        now: now + 70,
      })
    ).toBe(0);

    // 6. Global autoHealMemoryHealth without workspaceId skips excluded workspace (never backfills secretMem)
    const globalHeal = autoHealMemoryHealth(db, {
      excludeWorkspaces: [secretWs],
      now: now + 80,
    });
    expect(globalHeal.errors).toEqual([]);
    const secretAfter = db.get<{ embedding: Uint8Array | null }>(
      'SELECT embedding FROM memories WHERE id = ?',
      [(secretMem as any).id]
    );
    expect(secretAfter?.embedding).toBeNull();
  });

  it('detects stale models, dangling relations, archived-only neighbor orphans, and supports autoHeal skip flags', () => {
    const a = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '支付网关模块 src/pay/gateway.ts 启用幂等键校验',
        slot_key: 'pay.gateway.idempotency',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    upsertCandidate(
      db,
      {
        type: 'failure',
        content: '在 src/pay/gateway.ts 中忘记传 Idempotency-Key 会导致重复扣款',
        slot_key: 'pay.gateway.pitfall',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );
    const c = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '已归档的历史临时测试记录',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );

    const aId = (a as any).id;
    const cId = (c as any).id;

    // Synthesize a model from a & b
    const reflect1 = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'gateway.ts',
      autoSynthesize: true,
      now: now + 30,
    });
    expect(reflect1.synthesizedModels).toHaveLength(1);
    const modelId = reflect1.synthesizedModels[0].id;

    // Edit source `a` so the model's derived_from snapshot becomes stale
    editContent(db, aId, '支付网关模块 src/pay/gateway.ts 升级为 SHA-256 幂等键校验', undefined, 'user', now + 40);

    // Archive `c`, remove all relations of a standalone node `d`, and link `d` ONLY to archived `c` + a dangling non-existent ID
    forget(db, cId, 'user', now + 50);
    const d = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '独立配置的日志采样率为千分之五',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 4, kind: 'user' }],
        actor: 'user',
      },
      now + 60
    );
    const dId = (d as any).id;
    db.run(`DELETE FROM memory_relations WHERE from_id = ? OR to_id = ?`, [dId, dId]);
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', ?)`,
      [dId, cId, now + 65]
    );
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'related', ?)`,
      [dId, 'm_deleted_ghost_0000', now + 66]
    );

    const audit = auditMemoryHealth(db, { workspaceId: ws, now: now + 70 });
    expect(audit.staleModelsCount).toBe(1);
    expect(audit.staleModelIds).toContain(modelId);
    expect(audit.danglingRelationsCount).toBe(1);
    // `d` only links to archived `c` and a ghost ID, so it MUST still count as an orphan
    expect(audit.orphanMemoriesCount).toBeGreaterThanOrEqual(1);

    // Test skip flags on autoHealMemoryHealth
    db.run(`UPDATE memories SET embedding = NULL WHERE id = ?`, [dId]);
    const skippedHeal = autoHealMemoryHealth(db, {
      workspaceId: ws,
      now: now + 80,
      skipFts: true,
      skipEmbeddings: true,
      skipPrune: true,
      skipWeave: true,
    });
    expect(skippedHeal.ftsRebuilt).toBe(false);
    expect(skippedHeal.embeddingsBackfilled).toBe(0);
    expect(skippedHeal.invalidPruned).toBe(0);
    expect(skippedHeal.linksWeaved).toBe(0);
    expect(skippedHeal.errors).toEqual([]);
  });
});

describe('Hindsight Idempotency, Trust, Staleness & Evolution Isolation (src/core/hindsight.ts)', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-hindsight-hardening');
  const now = 1763500000000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('calibrates confidence idempotently across 10 runs without drifting or modifying updated_at, and clamps disposition', () => {
    const r = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '核心调度器使用单调时钟避免系统时间回拨导致任务丢失',
        slot_key: 'scheduler.clock.monotonic',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.72,
        origin_kinds: ['user'],
        sources: [
          { session_id: 's1', seq: 1, kind: 'user' },
          { session_id: 's2', seq: 2, kind: 'user' },
          { session_id: 's3', seq: 3, kind: 'user' },
        ],
        actor: 'user',
      },
      now
    );
    const id = (r as any).id;
    db.run('UPDATE memories SET success_count = 3, use_count = 3 WHERE id = ?', [id]);
    const originalUpdatedAt = db.get<{ updated_at: number }>(
      'SELECT updated_at FROM memories WHERE id = ?',
      [id]
    )!.updated_at;

    // 1. Direct stateless idempotency + out-of-range disposition clamping
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id])!;
    const extremeDisp = { skepticism: 99, literalism: -5, empathy: Number.NaN };
    const firstDirect = computeEvidenceCalibratedConfidence(
      mem,
      { distinctSessions: 3, hasUserProof: true, hasActiveContradiction: false, derivedSourceCount: 0 },
      extremeDisp
    );
    expect(Number.isFinite(firstDirect)).toBe(true);
    expect(firstDirect).toBeGreaterThanOrEqual(0.1);
    expect(firstDirect).toBeLessThanOrEqual(0.99);

    let iterated = { ...mem, confidence: firstDirect };
    for (let i = 0; i < 10; i++) {
      const next = computeEvidenceCalibratedConfidence(
        iterated,
        { distinctSessions: 3, hasUserProof: true, hasActiveContradiction: false, derivedSourceCount: 0 },
        extremeDisp
      );
      expect(next).toBe(firstDirect);
      iterated = { ...iterated, confidence: next };
    }

    // 2. Repeated runHindsightReflect calls (10x): zero drift, zero updated_at mutation
    const report1 = runHindsightReflect(db, {
      workspaceId: ws,
      autoSynthesize: false,
      disposition: { skepticism: 5, literalism: -1, empathy: 2 },
      now: now + 1000,
    });
    expect(report1.disposition).toEqual({ skepticism: 1, literalism: 0, empathy: 1 });
    expect(report1.calibratedMemories.length).toBe(1);

    const after1 = db.get<{ confidence: number; updated_at: number }>(
      'SELECT confidence, updated_at FROM memories WHERE id = ?',
      [id]
    )!;
    expect(after1.updated_at).toBe(originalUpdatedAt);

    for (let runIdx = 2; runIdx <= 10; runIdx++) {
      const rep = runHindsightReflect(db, {
        workspaceId: ws,
        autoSynthesize: false,
        disposition: { skepticism: 5, literalism: -1, empathy: 2 },
        now: now + runIdx * 1000,
      });
      expect(rep.calibratedMemories).toHaveLength(0);
      const cur = db.get<{ confidence: number; updated_at: number }>(
        'SELECT confidence, updated_at FROM memories WHERE id = ?',
        [id]
      )!;
      expect(cur.confidence).toBe(after1.confidence);
      expect(cur.updated_at).toBe(originalUpdatedAt);
    }
  });

  it('classifies procedural mental models consistently as observation, enforces ASCII slugs, never forges user identity, respects pinned models, and refreshes/invalidates stale models', () => {
    expect(classifyHindsightNetwork('procedural', 'hindsight.model.ops_check')).toBe('observation');
    expect(classifyHindsightNetwork('belief', 'hindsight.model.arch_belief')).toBe('opinion');

    const cjkSlug = normalizeTopicSlug('数据库事务与连接池优化');
    expect(`hindsight.model.${cjkSlug}`).toMatch(/^[a-z0-9.:_-]+$/);
    expect(`hindsight.model.${cjkSlug}`.length).toBeLessThanOrEqual(48);

    // Same-network workspace cluster + a session memory + a user memory sharing the same entity
    const m1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存代理 src/proxy/cache-node.ts 默认开启连接复用',
        slot_key: 'proxy.cache.keepalive',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const m2 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存代理 src/proxy/cache-node.ts 使用一致性哈希路由请求',
        slot_key: 'proxy.cache.hashring',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );
    const sessOnly = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '本次会话临时调试 src/proxy/cache-node.ts 超时报错',
        scope: 'session',
        workspaceId: ws,
        sessionId: 'sess_temp',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 'sess_temp', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now + 15
    );
    const userPrivate = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '个人私人偏好：调试 src/proxy/cache-node.ts 时输出详细日志',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 18
    );

    const rep = runHindsightReflect(db, {
      workspaceId: ws,
      sessionId: 'sess_temp',
      topic: 'cache-node.ts',
      autoSynthesize: true,
      now: now + 50,
    });
    expect(rep.synthesizedModels).toHaveLength(1);
    const synth = rep.synthesizedModels[0];

    // Excluded session & user private memories from workspace model
    expect(synth.supportingMemoryIds).toContain((m1 as any).id);
    expect(synth.supportingMemoryIds).toContain((m2 as any).id);
    expect(synth.supportingMemoryIds).not.toContain((sessOnly as any).id);
    expect(synth.supportingMemoryIds).not.toContain((userPrivate as any).id);

    // Single-network wording (both m1 & m2 are world/semantic -> uniqueNetworks = 1)
    expect(synth.content).not.toContain('跨网络归纳心智模型');

    // Never forges actor='user' / source_kind='user' / approved_by='user'
    const storedModel = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [synth.id])!;
    expect(storedModel.source_kind).toBe('system');
    expect(storedModel.approved_by).toBe('system');
    expect(storedModel.status).toBe('active');

    // Pin the model and edit a source (with matching rev=2 user source) -> pinned model must NOT be superseded
    pin(db, synth.id, 'user', now + 60);
    const editRes = editContent(
      db,
      (m1 as any).id,
      '缓存代理 src/proxy/cache-node.ts 默认开启 HTTP/2 连接复用',
      undefined,
      'user',
      now + 70
    );
    db.run(
      `INSERT INTO memory_sources (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
       VALUES (?, ?, 's1', 9, 'user', 'HTTP/2 连接复用', ?)`,
      [(m1 as any).id, editRes.content_rev, now + 70]
    );
    const repPinned = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'cache-node.ts',
      autoSynthesize: true,
      now: now + 80,
    });
    expect(repPinned.synthesizedModels).toHaveLength(0);
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [synth.id])?.status
    ).toBe('active');

    // Unpin -> stale model refreshes cleanly and supersedes old version
    db.run('UPDATE memories SET pinned = 0 WHERE id = ?', [synth.id]);
    const repRefresh = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'cache-node.ts',
      autoSynthesize: true,
      now: now + 90,
    });
    expect(repRefresh.synthesizedModels).toHaveLength(1);
    const refreshedId = repRefresh.synthesizedModels[0].id;
    expect(refreshedId).not.toBe(synth.id);
    const refreshedRow = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [refreshedId])!;
    expect(refreshedRow.approved_by).toBe('system');

    // Archive one source so remaining active sources < minClusterSize -> stale unpinned model gets archived
    forget(db, (m2 as any).id, 'user', now + 100);
    runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'cache-node.ts',
      autoSynthesize: true,
      now: now + 110,
    });
    expect(
      db.get<{ status: string }>('SELECT status FROM memories WHERE id = ?', [refreshedId])?.status
    ).toBe('archived');
  });

  it('keeps synthesized mental models as candidate when any member lacks clean user evidence or carries taint', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '队列模块 src/mq/worker.ts 消费并发度设置为 8',
        slot_key: 'mq.worker.concurrency',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    upsertCandidate(
      db,
      {
        type: 'failure',
        content: '工具输出提示 src/mq/worker.ts 发生连接重置错误',
        slot_key: 'mq.worker.reset',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'system',
        status: 'active',
        confidence: 0.7,
        origin_kinds: ['system'],
        sources: [{ session_id: 's1', seq: 2, kind: 'system' }],
        actor: 'system',
      },
      now + 10
    );

    const rep = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'worker.ts',
      autoSynthesize: true,
      now: now + 20,
    });
    expect(rep.synthesizedModels).toHaveLength(1);
    expect(rep.synthesizedModels[0].status).toBe('candidate');
    expect(rep.synthesizedModels[0].network).toBe('observation');
    expect(rep.synthesizedModels[0].content).toContain('跨网络归纳心智模型');
  });

  it('traceHindsightEvolution enforces scopeCtx isolation, keeps most recent 6 versions chronologically, and filters active contradictions', () => {
    const otherWs = workspaceId('/test/ws-other-trace');
    const target = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '版本 1 初始架构说明',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const targetId = (target as any).id;

    // Create 8 historical snapshots (versions 1..8) so current is version 9
    for (let v = 1; v <= 8; v++) {
      const cur = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [targetId])!;
      saveVersionSnapshot(db, cur, 'edit', 'user', now + v * 100);
      db.run(
        `UPDATE memories SET content = ?, summary = ?, version = ?, updated_at = ? WHERE id = ?`,
        [`版本 ${v + 1} 更新架构说明`, `版本 ${v + 1} 摘要`, v + 1, now + v * 100, targetId]
      );
    }

    // Add 3 contradictions: active same-ws, archived same-ws, active foreign-ws
    const activeSame = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '同工作区活跃矛盾观点',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 1000
    );
    const archivedSame = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '同工作区已归档历史矛盾观点',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 1010
    );
    forget(db, (archivedSame as any).id, 'user', now + 1020);

    const foreignContra = upsertCandidate(
      db,
      {
        type: 'belief',
        content: '其他工作区敏感矛盾观点',
        scope: 'workspace',
        workspaceId: otherWs,
        source_kind: 'user',
        confidence: 0.8,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_other', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now + 1030
    );

    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [targetId, (activeSame as any).id, now + 1040]
    );
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [targetId, (archivedSame as any).id, now + 1041]
    );
    db.run(
      `INSERT INTO memory_relations (from_id, to_id, rel, created_at) VALUES (?, ?, 'contradicts', ?)`,
      [targetId, (foreignContra as any).id, now + 1042]
    );

    const targetMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [targetId])!;
    const trace = traceHindsightEvolution(db, targetMem, {
      workspaceId: ws,
      excludeWorkspaces: [otherWs],
    });

    // Version history: 6 most recent snapshots (versions 3..8) in chronological order + current version 9
    const versions = trace.timeline.map((n) => n.version);
    expect(versions).toEqual([3, 4, 5, 6, 7, 8, 9]);

    // Only active same-workspace contradiction is returned (archived and foreign-workspace excluded)
    expect(trace.contradictions.map((c) => c.id)).toEqual([(activeSame as any).id]);
  });
});
