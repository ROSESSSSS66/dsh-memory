import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { autoBootstrapMemory } from '../../src/core/bootstrap.js';
import { getAllCoreMemories } from '../../src/core/core-memory.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate, addRelation } from '../../src/core/writer.js';
import { weaveZettelkastenLinks, auditMemoryHealth, autoHealMemoryHealth } from '../../src/core/health.js';
import { computeFanAttenuation, expandGraphNeighbors } from '../../src/retrieval/channels.js';
import { computeActRBaseActivation } from '../../src/retrieval/fuse.js';
import { MemoryCommands } from '../../src/dsh/commands.js';
import { MemoryTools } from '../../src/dsh/tools.js';
import { apply } from '../../src/dsh/plugin.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

describe('v0.4.0 Auto-Bootstrap, SYNAPSE Spreading Activation & A-Mem Zettelkasten Linking', () => {
  let db: Db;
  let tmpDir: string;
  const now = 1762400000000;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-test-'));
    vi.mocked(os.homedir).mockReturnValue(tmpDir);

    // Prepare a mock project workspace with package.json, tsconfig.json, src/, and .dsh/memory-bank
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify(
        {
          name: 'demo-agent-app',
          version: '1.2.0',
          description: 'Demo TypeScript agent service',
          type: 'module',
          scripts: {
            build: 'tsup',
            test: 'vitest run',
            check: 'tsc --noEmit && vitest run',
          },
          dependencies: {
            react: '^19.0.0',
          },
          devDependencies: {
            typescript: '^5.7.0',
            vitest: '^2.1.0',
          },
        },
        null,
        2
      ),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{"compilerOptions":{"strict":true}}', 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'src', 'core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'retrieval'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.dsh', 'memory-bank'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.dsh', 'memory-bank', 'systemPatterns.md'),
      `# System Patterns\n> 架构规范\n\n### [SEMANTIC m_boot001] 数据库统一使用 SQLite WAL 模式并开启外键约束\n- **ID**: \`m_boot001\` | **重要度**: \`8/10\` | **置信度**: \`0.95\`\n\n数据库统一使用 SQLite WAL 模式并开启外键约束。\n---\n`,
      'utf8'
    );
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('autoBootstrapMemory initializes Core Memory blocks, workspace facts, Markdown imports, embeddings, and A-Mem links idempotently', () => {
    const res1 = autoBootstrapMemory(db, {
      workspacePath: tmpDir,
      includeBackfill: false,
      now,
    });

    expect(res1.alreadyInitialized).toBe(false);
    expect(res1.strategyInitialized).toBe(true);
    expect(res1.coreBlocksInitialized).toEqual(expect.arrayContaining(['human', 'persona', 'project']));
    expect(res1.workspaceMemoriesSeeded).toBeGreaterThanOrEqual(3);
    expect(res1.markdownMemoriesImported).toBeGreaterThanOrEqual(1);
    expect(res1.embeddingsBackfilled).toBeGreaterThanOrEqual(0);
    const bootHealth = auditMemoryHealth(db, { workspaceId: res1.workspaceId, now });
    expect(bootHealth.missingEmbeddingsCount).toBe(0);
    expect(bootHealth.embeddingsReadyCount).toBeGreaterThan(0);
    expect(res1.linksWeaved).toBeGreaterThanOrEqual(1);

    // Verify Letta Core Memory blocks are populated
    const blocks = getAllCoreMemories(db, { workspaceId: res1.workspaceId });
    const populated = blocks.filter((b) => b.content.trim().length > 0);
    expect(populated.length).toBeGreaterThanOrEqual(3);
    const projectBlock = blocks.find((b) => b.block === 'project');
    expect(projectBlock?.content).toContain('demo-agent-app');

    // Second invocation without force should be a fast no-op
    const res2 = autoBootstrapMemory(db, {
      workspacePath: tmpDir,
      includeBackfill: false,
      now: now + 1000,
    });
    expect(res2.alreadyInitialized).toBe(true);
    expect(res2.coreBlocksInitialized).toHaveLength(0);

    // Force re-bootstrap runs idempotently without duplicating active memories
    const countBeforeForce =
      db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memories WHERE status IN ('active', 'frozen')`)?.c ?? 0;
    const res3 = autoBootstrapMemory(db, {
      workspacePath: tmpDir,
      includeBackfill: false,
      force: true,
      now: now + 2000,
    });
    expect(res3.alreadyInitialized).toBe(false);
    const countAfterForce =
      db.get<{ c: number }>(`SELECT COUNT(*) as c FROM memories WHERE status IN ('active', 'frozen')`)?.c ?? 0;
    expect(countAfterForce).toBe(countBeforeForce);
  });

  it('A-Mem Zettelkasten dynamic linking automatically connects semantically related memories on write and via weaveZettelkastenLinks', () => {
    const ws = workspaceId('ws_amem_test');
    const r1 = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '在 src/core/db.ts 中使用 SQLite FTS5 虚拟表加速中文分词与全文检索',
        summary: 'src/core/db.ts 使用 SQLite FTS5 全文检索',
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

    const r2 = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '修改 src/core/db.ts 的 SQLite FTS5 触发器时若未同步更新 memories_fts 会导致检索漏召回',
        summary: 'src/core/db.ts FTS5 触发器同步注意事项',
        scope: 'workspace',
        workspaceId: ws,
        source_kind: 'user',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 100
    );

    const id1 = (r1 as any).id;
    const id2 = (r2 as any).id;

    // Verify upsertCandidate automatically created an A-Mem 'related' edge
    const relRow = db.get<{ rel: string }>(
      `SELECT rel FROM memory_relations
       WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)`,
      [id1, id2, id2, id1]
    );
    expect(relRow?.rel).toBe('related');

    // Clear relations and verify weaveZettelkastenLinks / autoHealMemoryHealth re-weaves them
    db.run(`DELETE FROM memory_relations`);
    const healthBefore = auditMemoryHealth(db, { workspaceId: ws, now: now + 200 });
    expect(healthBefore.orphanMemoriesCount).toBe(2);

    const weaved = weaveZettelkastenLinks(db, { workspaceId: ws, now: now + 300 });
    expect(weaved).toBeGreaterThanOrEqual(1);

    const healRes = autoHealMemoryHealth(db, { workspaceId: ws, now: now + 400 });
    expect(healRes.report.orphanMemoriesCount).toBe(0);
  });

  it('SYNAPSE Fan Effect attenuates hub node spreading activation and supports 2-hop damped propagation', () => {
    // 1. Verify computeFanAttenuation decreases monotonically as node degree grows
    const fanDeg1 = computeFanAttenuation(1);
    const fanDeg4 = computeFanAttenuation(4);
    const fanDeg20 = computeFanAttenuation(20);
    expect(fanDeg1).toBeCloseTo(1.0, 5);
    expect(fanDeg4).toBeLessThan(fanDeg1);
    expect(fanDeg20).toBeLessThan(fanDeg4);
    expect(fanDeg20).toBeGreaterThanOrEqual(0.25);

    // 2. Verify 2-hop damped propagation in expandGraphNeighbors
    const ws = workspaceId('ws_synapse');
    const rA = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Alpha 节点：网关入口限流阈值设为每秒 500 请求',
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
    const rB = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: 'Beta 节点：熔断降级器触发后自动切换至备用只读副本',
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
    const rC = upsertCandidate(
      db,
      {
        type: 'failure',
        content: 'Gamma 节点：备用只读副本延迟超过 3 秒时需告警通知运维值班',
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

    const idA = (rA as any).id;
    const idB = (rB as any).id;
    const idC = (rC as any).id;

    db.run(`DELETE FROM memory_relations`);
    addRelation(db, idA, idB, 'related', now + 30);
    addRelation(db, idB, idC, 'related', now + 40);

    const neighbors = expandGraphNeighbors(
      db,
      [idA],
      { workspaceId: ws, sessionId: 's1' },
      10
    );
    const hitB = neighbors.find((n) => n.neighborId === idB);
    const hitC = neighbors.find((n) => n.neighborId === idC);

    expect(hitB).toBeDefined();
    expect(hitC).toBeDefined();
    expect(hitB!.hop).toBe(1);
    expect(hitC!.hop).toBe(2);
    expect(hitB!.activationWeight).toBeGreaterThan(hitC!.activationWeight!);
  });

  it('ACT-R spaced-repetition base activation stretches effective half-life for frequently confirmed memories', () => {
    const coldScore = computeActRBaseActivation(30, 30, 0, 0, 1.0);
    const rehearsedScore = computeActRBaseActivation(30, 30, 8, 5, 1.0);

    // Cold memory after 1 half-life is ~0.5
    expect(coldScore).toBeCloseTo(0.5, 2);
    // Frequently used & confirmed memory retains significantly higher activation after 30 days
    expect(rehearsedScore).toBeGreaterThan(coldScore + 0.15);
  });

  it('exposes /memory init CLI command, memory tool init action, and plugin autoBootstrap option', async () => {
    const cmds = new MemoryCommands(db);
    const cliOut = cmds.init({ workspaceId: tmpDir, sessionId: 's1' }, true);
    expect(cliOut).toContain('工作区记忆冷启动初始化完成');
    expect(cliOut).toContain('Letta 常驻核心块');

    const tools = new MemoryTools({ db });
    const toolRes = tools.unified(
      { action: 'init', force: true },
      { workspaceId: tmpDir, sessionId: 's1' }
    );
    expect(toolRes).toContain('[Workspace Memory Bootstrap]');

    // Verify plugin apply() with autoBootstrap: true on a fresh database
    const dbPath = path.join(tmpDir, 'plugin-auto.db');
    let dispose: (() => Promise<void>) | undefined;
    const mockCtx: any = {
      baseDir: tmpDir,
      on: (name: string, handler: () => Promise<void>) => {
        if (name === 'dispose') dispose = handler;
        return () => {};
      },
    };
    await apply(mockCtx, { dbPath, dataDir: tmpDir, autoBootstrap: true });
    try {
      const verifyDb = openDb(dbPath);
      try {
        const cnt =
          verifyDb.get<{ c: number }>(`SELECT COUNT(*) as c FROM memories WHERE status IN ('active', 'frozen')`)?.c ?? 0;
        expect(cnt).toBeGreaterThanOrEqual(3);
      } finally {
        verifyDb.close();
      }
      expect(dispose).toBeTypeOf('function');
    } finally {
      await dispose?.();
    }
  });
});
