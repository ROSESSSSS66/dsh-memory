import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../src/core/db.js';
import type { Db, MemoryRecord } from '../src/types.js';
import { workspaceId } from '../src/core/scope.js';
import { upsertCandidate } from '../src/core/writer.js';
import { setCoreMemory } from '../src/core/core-memory.js';
import {
  classifyHindsightNetwork,
  computeEvidenceCalibratedConfidence,
  runHindsightReflect,
  traceHindsightEvolution,
} from '../src/core/hindsight.js';
import {
  classifyVikingCategory,
  resolveVikingUri,
  buildTieredMemoryView,
  browseVikingDirectory,
  findInVikingTree,
  getVikingEvolutionDiff,
  exportVikingContextTree,
  importVikingContextTree,
  syncAutonomousVikingTree,
} from '../src/core/viking.js';
import { autoHealMemoryHealth } from '../src/core/health.js';
import { exportMemoryBank, importMemoryBank } from '../src/core/markdown.js';
import { runRules } from '../src/ingest/rules.js';
import { distillSession } from '../src/evolution/extractor.js';
import { DEFAULTS } from '../src/config.js';
import { expandGraphNeighbors } from '../src/retrieval/channels.js';
import { govern } from '../src/retrieval/governor.js';
import { render } from '../src/retrieval/render.js';
import { budgetTokens } from '../src/core/tokens.js';
import { MemoryTools } from '../src/dsh/tools.js';
import { MemoryCommands } from '../src/dsh/commands.js';

describe('Hindsight (vectorize-io/hindsight) & OpenViking (volcengine/OpenViking) Optimizations', () => {
  let db: Db;
  const ws = workspaceId('/test/ws-hindsight-viking');
  const now = 1763000000000;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('1. maps memories to OpenViking viking:// virtual URIs and supports L0/L1/L2 directory recursive retrieval', () => {
    setCoreMemory(db, 'project', 'Node 24 + SQLite FTS5 核心记忆架构', { workspaceId: ws });

    const rPref = upsertCandidate(
      db,
      {
        type: 'preference',
        content: '代码提交前必须通过 npm run check 与 npm run eval 评测门禁',
        summary: '提交前必跑 check 与 eval',
        slot_key: 'user.pref.commit_gate',
        scope: 'user',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_vk', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const rSkill = upsertCandidate(
      db,
      {
        type: 'procedural',
        content:
          '排查 SQLite WAL 锁冲突步骤：1) 检查 busy_timeout 是否设为 3000ms；2) 使用 VACUUM INTO 替代直接文件拷贝；3) 确保写操作收敛于单一事务。',
        summary: 'SQLite WAL 锁冲突排查规程',
        slot_key: 'project.db.wal_troubleshooting',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.94,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_vk', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const prefMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      (rPref as any).id,
    ])!;
    const skillMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      (rSkill as any).id,
    ])!;

    expect(classifyVikingCategory(prefMem)).toBe('preferences');
    expect(resolveVikingUri(prefMem)).toBe(
      'viking://user/memories/preferences/user/pref/commit_gate'
    );

    expect(classifyVikingCategory(skillMem)).toBe('skills');
    expect(resolveVikingUri(skillMem)).toBe(
      'viking://workspace/memories/skills/project/db/wal_troubleshooting'
    );

    // L0 / L1 / L2 tiered view verification
    const tiered = buildTieredMemoryView(skillMem);
    expect(tiered.l0Abstract).toContain('SQLite WAL 锁冲突排查规程');
    expect(tiered.l1Overview).toContain('[L1 viking://workspace/memories/skills/');
    expect(tiered.l1Overview).toContain('OBSERVATION');
    expect(tiered.l2Detail).toContain('[L2 viking://workspace/memories/skills/');
    expect(tiered.l2Detail).toContain('VACUUM INTO');

    // Directory Recursive Retrieval at root (L0) and sub-directory (L1)
    const rootTree = browseVikingDirectory(db, { workspaceId: ws, tier: 'L0' });
    expect(rootTree).toContain('viking://agent/core/');
    expect(rootTree).toContain('viking://user/memories/preferences/');
    expect(rootTree).toContain('viking://workspace/memories/skills/');

    const skillsDirL1 = browseVikingDirectory(db, {
      uri: 'viking://workspace/memories/skills',
      workspaceId: ws,
      tier: 'L1',
    });
    expect(skillsDirL1).toContain(skillMem.id);
    expect(skillsDirL1).toContain('VACUUM INTO');

    // Expand by viking:// URI across L0, L1, L2 via MemoryTools and /memory inspect
    const tools = new MemoryTools({ db });
    const expandL1 = tools.expand(
      {
        id: 'viking://workspace/memories/skills/project/db/wal-troubleshooting',
        tier: 'L1',
      },
      { workspaceId: ws, sessionId: 's_vk', turn: 1 }
    );
    expect(expandL1).toContain('[L1 viking://workspace/memories/skills/');

    const expandL2 = tools.expand(
      {
        id: 'viking://workspace/memories/skills/project/db/wal-troubleshooting',
        tier: 'L2',
      },
      { workspaceId: ws, sessionId: 's_vk', turn: 1 }
    );
    expect(expandL2).toContain('排查 SQLite WAL 锁冲突步骤');

    const commands = new MemoryCommands(db);
    const inspectByUri = commands.handleCommand(
      'inspect viking://workspace/memories/skills/project/db/wal-troubleshooting',
      { workspaceId: ws }
    );
    expect(inspectByUri.kind).toBe('success');
    expect(inspectByUri.text).toContain(`ID: ${skillMem.id}`);
    expect(inspectByUri.text).toContain('Network: OBSERVATION');
    expect(inspectByUri.text).toContain('Viking URI: viking://workspace/memories/skills/');
  });

  it('2. progressively packs OpenViking L2 -> L1 -> L0 in Token Governor based on available budget', () => {
    const detailedSteps =
      '微服务灰度发布完整规程：第一步检查 Prometheus 错误率基线低于 0.1%；第二步将 Canary 权重切至 10% 并观察 15 分钟 P99 延迟；第三步执行自动化冒烟回归并全量放通流量；第四步清理旧版本容器镜像。';
    const shortAbstract = '微服务灰度发布四步规程';

    const rMem = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: detailedSteps,
        summary: shortAbstract,
        slot_key: 'ops.canary.release',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_gov', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      (rMem as any).id,
    ])!;

    const l2Tokens = budgetTokens(render([{ memory: mem, form: 'content', tier: 'L2' }]));
    const l0Tokens = budgetTokens(render([{ memory: mem, form: 'summary', tier: 'L0' }]));
    expect(l2Tokens).toBeGreaterThanOrEqual(l0Tokens + 30);

    // Mid-tier budget: smaller than L2 full content, but comfortably larger than L0 abstract
    const midBudget = l2Tokens - 15;
    const packedL1 = govern(
      [{ memory: mem, score: 0.92, relevance: 1.0, fusedRrf: 0.1 }],
      {
        budget: midBudget,
        maxItems: 3,
        alreadyInjected: new Set(),
      }
    );

    expect(packedL1).toHaveLength(1);
    expect(packedL1[0].form).toBe('summary');
    expect(packedL1[0].tier).toBe('L1');
    expect(packedL1[0].overview).toContain('[ops.canary.release]');

    const renderedL1 = render(
      packedL1.map((s) => ({
        memory: s.memory,
        form: s.form,
        tier: s.tier,
        overview: s.overview,
      }))
    );
    const l1Tokens = budgetTokens(renderedL1);
    expect(l2Tokens).toBeGreaterThan(l1Tokens);
    expect(l1Tokens).toBeGreaterThan(l0Tokens);
    expect(renderedL1).toContain('⟨L1 · memory_expand(');
    expect(l1Tokens).toBeLessThanOrEqual(midBudget);

    // Tight budget: only enough for L0 abstract
    const tightBudget = l0Tokens + 6;
    const packedL0 = govern(
      [{ memory: mem, score: 0.92, relevance: 1.0, fusedRrf: 0.1 }],
      {
        budget: tightBudget,
        maxItems: 3,
        alreadyInjected: new Set(),
      }
    );
    expect(packedL0).toHaveLength(1);
    expect(packedL0[0].form).toBe('summary');
    expect(packedL0[0].tier).toBe('L0');
  });

  it('3. traverses Hindsight Bipartite Entity-Bridge Graph (seed -> @entity -> neighbor) even without explicit memory_relations', () => {
    const rSeed = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '支付回调签名校验器位于 src/payment/stripe-webhook.ts，使用 HMAC-SHA256 验证签名头',
        summary: 'stripe-webhook.ts HMAC-SHA256 验签',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_hb', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const rBridgeNeighbor = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '在 src/payment/stripe-webhook.ts 中禁止先使用 express.json() 解析请求体，否则原始字节流改变会导致验签失败',
        summary: 'stripe-webhook.ts 必须保留 raw body 字节流',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.93,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_hb', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const seedId = (rSeed as any).id;
    const neighborId = (rBridgeNeighbor as any).id;

    // Delete any auto-weaved memory_relations to prove Bipartite Entity-Bridge Traversal works purely via memory_entities
    db.run('DELETE FROM memory_relations');

    const neighbors = expandGraphNeighbors(
      db,
      [seedId],
      { workspaceId: ws, sessionId: 's_hb' },
      8
    );

    const hit = neighbors.find((n) => n.neighborId === neighborId);
    expect(hit).toBeDefined();
    expect(hit?.bridgeEntity).toContain('src/payment/stripe-webhook.ts');
    expect(hit?.activationWeight).toBeGreaterThan(0.4);
  });

  it('4. executes Hindsight Reflect loop: 4-network classification, evidence-density confidence calibration, and mental-model synthesis', () => {
    const rWorld = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '鉴权网关模块 src/auth/token-service.ts 采用双 Token (Access 15m + Refresh 7d) 轮换机制',
        summary: 'token-service.ts 双 Token 轮换机制',
        slot_key: 'auth.token_service.arch',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [
          { session_id: 'sess_1', seq: 1, kind: 'user' },
          { session_id: 'sess_2', seq: 3, kind: 'user' },
          { session_id: 'sess_3', seq: 5, kind: 'user' },
        ],
        actor: 'user',
      },
      now
    );

    const rExp = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '并发刷新 src/auth/token-service.ts 的 Refresh Token 时若未加 Redis 分布式短锁，会触发重放吊销误判',
        summary: 'token-service.ts 并发刷新需加短锁防误吊销',
        slot_key: 'auth.token_service.pitfall',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.84,
        origin_kinds: ['user'],
        sources: [
          { session_id: 'sess_2', seq: 8, kind: 'user' },
          { session_id: 'sess_3', seq: 9, kind: 'user' },
        ],
        actor: 'user',
      },
      now + 10
    );

    const worldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      (rWorld as any).id,
    ])!;
    const expMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      (rExp as any).id,
    ])!;

    expect(classifyHindsightNetwork(worldMem.type)).toBe('world');
    expect(classifyHindsightNetwork(expMem.type)).toBe('experience');

    // Simulate positive online utility feedback on worldMem
    db.run('UPDATE memories SET success_count = 4, use_count = 4 WHERE id = ?', [worldMem.id]);
    const refreshedWorld = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [
      worldMem.id,
    ])!;

    const calibrated = computeEvidenceCalibratedConfidence(refreshedWorld, {
      distinctSessions: 3,
      hasUserProof: true,
      hasActiveContradiction: false,
      derivedSourceCount: 0,
    });
    expect(calibrated).toBeGreaterThan(refreshedWorld.confidence);

    // Run Hindsight Reflect to synthesize cross-network Mental Model / Observation
    const report = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'token-service.ts',
      autoSynthesize: true,
      now: now + 100,
    });

    expect(report.networkCounts.world).toBeGreaterThanOrEqual(1);
    expect(report.networkCounts.experience).toBeGreaterThanOrEqual(1);
    expect(report.calibratedMemories.length).toBeGreaterThanOrEqual(1);
    expect(report.synthesizedModels.length).toBeGreaterThanOrEqual(1);

    const model = report.synthesizedModels[0];
    expect(model.supportingMemoryIds).toContain(worldMem.id);
    expect(model.supportingMemoryIds).toContain(expMem.id);
    expect(model.status).toBe('active');

    // Verify derived_from relations were linked in SQLite
    const derivedCnt =
      db.get<{ c: number }>(
        `SELECT COUNT(*) as c FROM memory_relations WHERE from_id = ? AND rel = 'derived_from'`,
        [model.id]
      )?.c || 0;
    expect(derivedCnt).toBe(2);

    // Second run on the same cluster is idempotent (no duplicate mental model created)
    const report2 = runHindsightReflect(db, {
      workspaceId: ws,
      topic: 'token-service.ts',
      autoSynthesize: true,
      now: now + 200,
    });
    expect(report2.synthesizedModels).toHaveLength(0);
  });

  it('5. exports and imports OpenViking L0/L1/L2 directory trees losslessly via CLI commands', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '消息总线采用 NATS JetStream 持久化流处理订单事件',
        summary: 'NATS JetStream 订单事件流',
        slot_key: 'project.messaging.nats',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.94,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_exp', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-openviking-tree-'));
    try {
      const expRes = exportVikingContextTree(db, tmpDir, { workspaceId: ws });
      expect(expRes.totalMemories).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, '.abstract.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, '.overview.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'entities', '.abstract.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'entities', '.overview.md'))).toBe(true);

      const destDb = openDb(':memory:');
      const impRes = importVikingContextTree(destDb, tmpDir, { workspaceId: ws, trusted: true });
      expect(impRes.importedCount).toBe(1);
      expect(impRes.skippedIndexes).toBeGreaterThanOrEqual(4);
      destDb.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('6. integrates network/uriPrefix/tier filtering in memory_search, unified tool actions (tree/reflect), and /memory CLI commands', () => {
    upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Kubernetes 集群 Ingress 控制器采用 Cilium eBPF 替代 kube-proxy',
        summary: 'Cilium eBPF 替代 kube-proxy',
        slot_key: 'k8s.network.cilium',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_cli', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    upsertCandidate(
      db,
      {
        type: 'procedural',
        content:
          '排查 Cilium eBPF 连接追踪丢包时：1) 执行 cilium monitor --type drop 查看丢包原因；2) 检查 bpf-ct-global-tcp-max 水位；3) 校验节点内核版本 >= 5.15。',
        summary: 'Cilium eBPF 丢包排查三步法',
        slot_key: 'k8s.network.cilium_debug',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.94,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_cli', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );

    const tools = new MemoryTools({ db });
    const commands = new MemoryCommands(db);

    // 1. memory_search filtered by Hindsight network='observation' and tier='L1'
    const obsSearch = tools.search(
      {
        query: 'Cilium eBPF 排查',
        network: 'observation',
        uriPrefix: 'viking://workspace/memories/skills',
        tier: 'L1',
      },
      { workspaceId: ws, sessionId: 's_cli', turn: 1 }
    );
    expect(obsSearch).toContain('OBSERVATION');
    expect(obsSearch).toContain('viking://workspace/memories/skills/k8s/network/cilium_debug');
    expect(obsSearch).toContain('cilium monitor --type drop');
    expect(obsSearch).not.toContain('[FACT');

    // 2. Unified tool: action='tree' & action='reflect'
    const treeOut = tools.unified(
      { action: 'tree', uri: 'skills', tier: 'L1' },
      { workspaceId: ws, sessionId: 's_cli', turn: 2 }
    );
    expect(treeOut).toContain('viking://workspace/memories/skills');
    expect(treeOut).toContain('cilium_debug');

    // LLM reflect defaults to read-only (autoSynthesize: false) — returns report without mutating DB
    const countModels = () =>
      db.get<{ c: number }>(
        `SELECT COUNT(*) as c FROM memories WHERE workspace_id = ? AND slot_key LIKE 'hindsight.model.%'`,
        [ws]
      )?.c || 0;
    expect(countModels()).toBe(0);

    const reflectOut = tools.unified(
      { action: 'reflect', topic: 'k8s.network' },
      { workspaceId: ws, sessionId: 's_cli', turn: 3 }
    );
    expect(reflectOut).toContain('[Hindsight 四层认知网络与心智模型反思报告]');
    expect(reflectOut).not.toContain('新归纳心智模型');
    expect(countModels()).toBe(0);

    // 3. Slash commands: user CLI /memory reflect synthesizes the mental model, then /memory tree lists it
    const cmdReflect = commands.handleCommand('reflect k8s.network', { workspaceId: ws });
    expect(cmdReflect.kind).toBe('success');
    expect(cmdReflect.text).toContain('Hindsight 四层认知网络');
    expect(cmdReflect.text).toContain('新归纳心智模型');
    expect(countModels()).toBeGreaterThanOrEqual(1);

    const cmdTree = commands.handleCommand('tree viking://workspace/memories/models --l1', {
      workspaceId: ws,
    });
    expect(cmdTree.kind).toBe('success');
    expect(cmdTree.text).toContain('viking://workspace/memories/models');
  });

  it('7. runs 100% autonomously: autoHeal triggers Hindsight reflection & confidence calibration, auto-syncs Viking tree + memory_diff.json, traces evolution timelines, filters conversational R2 noise, and auto-skips poisoned distill batches', async () => {
    // A. Accumulate 3 cross-network memories around the same service entity (redis-cluster.ts)
    const r1 = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '缓存层组件 src/cache/redis-cluster.ts 使用 6 节点 Redis Cluster 分片拓扑',
        summary: 'redis-cluster.ts 6 节点分片架构',
        slot_key: 'cache.redis.topology',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.85,
        origin_kinds: ['user'],
        sources: [
          { session_id: 's_a1', seq: 1, kind: 'user' },
          { session_id: 's_a2', seq: 2, kind: 'user' },
        ],
        actor: 'user',
      },
      now
    );
    const r2 = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '在 src/cache/redis-cluster.ts 中跨槽位 MGET 会报 CROSSSLOT 错误，必须使用 Hash Tag {tenant}',
        summary: 'redis-cluster.ts 跨槽位需加 Hash Tag',
        slot_key: 'cache.redis.crossslot_pitfall',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.86,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_a2', seq: 3, kind: 'user' }],
        actor: 'user',
      },
      now + 10
    );
    const r3 = upsertCandidate(
      db,
      {
        type: 'episodic',
        content: '压测发现 src/cache/redis-cluster.ts 开启 enableAutoPipelining 后吞吐提升 2.4 倍',
        summary: 'redis-cluster.ts 开启 autoPipelining 提速',
        slot_key: 'cache.redis.benchmark',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.88,
        origin_kinds: ['user'],
        sources: [{ session_id: 's_a3', seq: 4, kind: 'user' }],
        actor: 'user',
      },
      now + 20
    );

    // Without any manual /memory reflect call, autoHealMemoryHealth automatically calibrates confidence & synthesizes a Hindsight Mental Model!
    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 100 });
    expect(healRes.confidenceCalibrated).toBeGreaterThanOrEqual(1);
    expect(healRes.modelsSynthesized).toBeGreaterThanOrEqual(1);

    const modelMem = db.get<MemoryRecord>(
      `SELECT * FROM memories WHERE workspace_id = ? AND slot_key LIKE 'hindsight.model.%'`,
      [ws]
    );
    expect(modelMem).toBeDefined();

    // B. Trace Hindsight Evolution Timeline & Provenance
    const trace = traceHindsightEvolution(db, modelMem!);
    expect(trace.derivedSources.map((s) => s.id)).toEqual(
      expect.arrayContaining([(r1 as any).id, (r2 as any).id, (r3 as any).id])
    );

    // C. Subtree Hybrid Find & Self-Evolving Diff Audit
    const subFind = findInVikingTree(db, {
      uri: 'viking://workspace/memories/cases',
      query: 'CROSSSLOT Hash Tag',
      workspaceId: ws,
      tier: 'L1',
    });
    expect(subFind).toContain((r2 as any).id);
    expect(subFind).toContain('CROSSSLOT');

    const diff = getVikingEvolutionDiff(db, { workspaceId: ws });
    expect(diff.synthesizedModels.length).toBeGreaterThanOrEqual(1);

    // D. Autonomous OpenViking Context Tree Sync writes memory_diff.json, .abstract.md, .overview.md
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auto-viking-'));
    try {
      const syncRes = syncAutonomousVikingTree(db, {
        workspacePath: tmpWs,
        workspaceId: ws,
        forceCreate: true,
      });
      expect(syncRes.synced).toBe(true);
      expect(fs.existsSync(path.join(tmpWs, '.dsh', 'viking-context', 'memory_diff.json'))).toBe(
        true
      );

      // E. Memory Bank export & import preserves workspace-scoped preference without changing scope to user
      upsertCandidate(
        db,
        {
          type: 'preference',
          content: '本工作区单元测试一律使用内存 SQLite',
          summary: '本工作区使用内存 SQLite',
          slot_key: 'project.pref.sqlite_mem',
          scope: 'workspace',
          workspaceId: ws,
          source_kind: 'user',
          confidence: 0.95,
          origin_kinds: ['user'],
          sources: [{ session_id: 's_mb', seq: 1, kind: 'user' }],
          actor: 'user',
        },
        now + 50
      );
      const bankDir = path.join(tmpWs, 'bank');
      exportMemoryBank(db, bankDir, { workspaceId: ws });

      const destDb = openDb(':memory:');
      importMemoryBank(destDb, bankDir, { workspaceId: ws, trusted: true });
      const reimportedPref = destDb.get<MemoryRecord>(
        `SELECT * FROM memories WHERE slot_key = 'project.pref.sqlite_mem'`
      );
      expect(reimportedPref?.scope).toBe('workspace');
      destDb.close();
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }

    // F. R2 ignores conversational non-directive remarks ("I never said that", "以后再说吧")
    const beforeCount = db.get<{ c: number }>('SELECT COUNT(*) as c FROM memories')!.c;
    runRules(db, {
      session_id: 's_r2',
      seq: 1,
      workspace_id: ws,
      type: 'user/message',
      time: now,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: 'I never said that',
      processed: 0,
    });
    runRules(db, {
      session_id: 's_r2',
      seq: 2,
      workspace_id: ws,
      type: 'user/message',
      time: now,
      turn: 1,
      role: 'user',
      origin_kind: 'user',
      is_error: 0,
      text: '以后再说吧',
      processed: 0,
    });
    const afterCount = db.get<{ c: number }>('SELECT COUNT(*) as c FROM memories')!.c;
    expect(afterCount).toBe(beforeCount);

    // G. Poisoned unparseable distill batch fails on attempt 1, then auto-advances on attempt 2 so autonomous pipeline never deadlocks
    db.run(
      `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, text, processed)
       VALUES ('sess_poison', 1, ?, 'user/message', ?, 1, 'user', 'user', 'bad batch event', 0)`,
      [ws, now]
    );
    const badFetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'NOT VALID JSON AT ALL' } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
        { status: 200 }
      );
    const testCfg = {
      ...DEFAULTS,
      privacy: { offlineConsent: true, allowedOfflineEndpoints: ['https://api.deepseek.com'] },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
      },
    };
    const attempt1 = await distillSession(db, testCfg, {
      sessionId: 'sess_poison',
      fetchFn: badFetch,
    });
    expect(attempt1.success).toBe(false);
    expect(
      db.get<{ processed: number }>(
        "SELECT processed FROM raw_events WHERE session_id = 'sess_poison' AND seq = 1"
      )?.processed
    ).toBe(0);

    const attempt2 = await distillSession(db, testCfg, {
      sessionId: 'sess_poison',
      fetchFn: badFetch,
    });
    expect(attempt2.success).toBe(true);
    expect(
      db.get<{ processed: number }>(
        "SELECT processed FROM raw_events WHERE session_id = 'sess_poison' AND seq = 1"
      )?.processed
    ).toBe(2);
  });
});
