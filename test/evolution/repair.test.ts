import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { CandidateInput, Db, MemoryRecord } from '../../src/types.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import { workspaceId } from '../../src/core/scope.js';
import { upsertCandidate, approveCandidate } from '../../src/core/writer.js';
import {
  enqueueRepairJobIfEligible,
  executeRepair,
  approveRepairProposal,
  rejectRepairProposal,
  listRepairProposals,
} from '../../src/evolution/repair.js';

describe('Query-Triggered Memory Repair (§5.17, M6)', () => {
  let db: Db;
  const ws1 = workspaceId('test-ws-repair');
  const sess1 = 'session_repair_001';
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  const testCfg: PluginConfig = {
    ...DEFAULTS,
    privacy: {
      offlineConsent: true,
      allowedOfflineEndpoints: ['https://api.deepseek.com'],
    },
    offlineLLM: {
      useDshLlm: false,
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'TEST_KEY',
    },
  };

  beforeEach(() => {
    db = openDb(':memory:');
    process.env.TEST_KEY = 'mock_key_123';
  });

  afterEach(() => {
    db.close();
    delete process.env.TEST_KEY;
  });

  function createMockFetch(responseJson: any): typeof fetch {
    return (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify(responseJson),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
          },
        }),
      } as any;
    }) as any;
  }

  function seed(content: string, extra: Partial<CandidateInput> = {}): string {
    const result = upsertCandidate(db, {
      type: 'semantic', content, scope: 'workspace', workspaceId: ws1,
      source_kind: 'user', actor: 'user', origin_kinds: ['user'], confidence: 0.9,
      sources: [{ session_id: sess1, seq: 1, kind: 'user', excerpt: content }],
      ...extra,
    }, fixedNow);
    if (!('id' in result)) throw new Error(JSON.stringify(result));
    return result.id;
  }

  function propose(target: string, action: string, candidates: string[]): number {
    db.run(`INSERT INTO repair_proposals
      (job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at)
      VALUES (1, ?, 1, ?, ?, 'test', 'candidate', ?, ?)`,
    [target, action, JSON.stringify(candidates), fixedNow, fixedNow + 86400_000]);
    return db.get<{ id: number }>('SELECT MAX(id) AS id FROM repair_proposals')!.id;
  }

  it.each(['frozen-slot', 'duplicate-slot', 'missing-candidate'] as const)(
    'does not partially apply a split when a later candidate has a %s',
    problem => {
      const target = seed('The original deployment and database configuration.');
      seed('Existing database configuration.', { slot_key: 'project.database' });
      const first = seed('Proposed database configuration.', { actor: 'llm', slot_key: 'project.database' });
      const second = seed('Proposed release configuration.', {
        actor: 'llm', slot_key: problem === 'duplicate-slot' ? 'project.database' : 'project.release',
      });
      if (problem === 'frozen-slot') {
        const frozen = seed('Frozen release configuration.', { slot_key: 'project.release' });
        db.run("UPDATE memories SET status = 'frozen' WHERE id = ?", [frozen]);
      } else if (problem === 'missing-candidate') {
        db.run("UPDATE memories SET status = 'rejected' WHERE id = ?", [second]);
      }
      const proposal = propose(target, 'split', [first, second]);
      const before = db.all('SELECT * FROM memories ORDER BY id');
      const versions = db.all('SELECT * FROM memory_versions ORDER BY memory_id, version');
      expect(approveRepairProposal(db, proposal, 'user', fixedNow)).toMatchObject({ ok: false });
      expect(db.all('SELECT * FROM memories ORDER BY id')).toEqual(before);
      expect(db.all('SELECT * FROM memory_versions ORDER BY memory_id, version')).toEqual(versions);
      expect(db.get('SELECT status FROM repair_proposals WHERE id = ?', [proposal])?.status).toBe('candidate');
    }
  );

  it.each(['revise', 'split'])('autonomous %s cannot replace a pinned slot occupant', action => {
    const target = seed('The original deployment configuration.');
    const pinned = seed('User-pinned database configuration.', { slot_key: 'project.database' });
    db.run('UPDATE memories SET pinned = 1 WHERE id = ?', [pinned]);
    const candidates = [seed('Proposed database configuration.', { actor: 'llm', slot_key: 'project.database' })];
    if (action === 'split') candidates.push(seed('Proposed release policy.', { actor: 'llm' }));
    const proposal = propose(target, action, candidates);
    const before = db.all('SELECT * FROM memories ORDER BY id');
    expect(approveRepairProposal(db, proposal, 'autonomous-doctor', fixedNow)).toMatchObject({ ok: false });
    expect(db.all('SELECT * FROM memories ORDER BY id')).toEqual(before);
  });

  it.each(['revise', 'split'])('refuses %s candidates belonging to another workspace', action => {
    const target = seed('The original deployment configuration.');
    const candidates = [seed('A private configuration in another project.', {
      actor: 'llm', workspaceId: workspaceId('/other/repair'),
    })];
    if (action === 'split') candidates.push(seed('Another release policy.', { actor: 'llm' }));
    const proposal = propose(target, action, candidates);
    const before = db.all('SELECT * FROM memories ORDER BY id');
    expect(approveRepairProposal(db, proposal, 'user', fixedNow)).toMatchObject({ ok: false });
    expect(db.all('SELECT * FROM memories ORDER BY id')).toEqual(before);
  });

  it('applies every part of a valid split including an occupied slot', () => {
    const target = seed('The original deployment configuration.');
    const occupant = seed('Existing database configuration.', { slot_key: 'project.database' });
    const first = seed('New database configuration.', { actor: 'llm', slot_key: 'project.database' });
    const second = seed('New release policy.', { actor: 'llm', slot_key: 'project.release' });
    const proposal = propose(target, 'split', [first, second]);
    expect(approveRepairProposal(db, proposal, 'user', fixedNow)).toEqual({ ok: true });
    for (const id of [target, occupant]) {
      expect(db.get('SELECT status FROM memories WHERE id = ?', [id])?.status).toBe('superseded');
      expect(db.get('SELECT memory_id FROM memory_versions WHERE memory_id = ?', [id])).toBeDefined();
    }
    for (const id of [first, second]) {
      expect(db.get('SELECT status FROM memories WHERE id = ?', [id])?.status).toBe('active');
    }
    expect(db.get('SELECT status FROM repair_proposals WHERE id = ?', [proposal])?.status).toBe('approved');
  });

  it('M6: enqueueRepairJobIfEligible 应检查状态、7天冷却和排队去重', () => {
    // 写入活跃记忆
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '项目数据库连接超时需要增加超时时间至 60 秒。',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user', excerpt: '超时需要增加超时时间至 60 秒。' }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    // 1. 正常入队
    const enq1 = enqueueRepairJobIfEligible(
      db,
      { memoryId: memId, sessionId: sess1, query: '连接超时怎么处理？', turn: 1 },
      DEFAULTS,
      fixedNow
    );
    expect(enq1).toBe(true);

    // 2. 重复入队应被去重
    const enqDup = enqueueRepairJobIfEligible(
      db,
      { memoryId: memId, sessionId: sess1, query: '连接超时怎么处理？', turn: 1 },
      DEFAULTS,
      fixedNow
    );
    expect(enqDup).toBe(false);

    // 3. 7天冷却检查：模拟 3 天前刚派发过 repair
    db.run('UPDATE memories SET last_repair_at = ? WHERE id = ?', [fixedNow - 3 * 86400000, memId]);
    db.run("DELETE FROM jobs WHERE kind = 'repair'");

    const enqCool = enqueueRepairJobIfEligible(
      db,
      { memoryId: memId, sessionId: sess1, query: '连接超时怎么处理？', turn: 2 },
      DEFAULTS,
      fixedNow
    );
    expect(enqCool).toBe(false);

    // 4. frozen 状态记忆绝不自动修复
    db.run("UPDATE memories SET status = 'frozen', last_repair_at = NULL WHERE id = ?", [memId]);
    const enqFrozen = enqueueRepairJobIfEligible(
      db,
      { memoryId: memId, sessionId: sess1, query: '连接超时怎么处理？', turn: 3 },
      DEFAULTS,
      fixedNow
    );
    expect(enqFrozen).toBe(false);
  });

  it('M6: executeRepair 处理 keep 动作 (items=[]，成功 no-op)', async () => {
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '团队生产环境强制使用 PostgreSQL 16 数据库。',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 5, kind: 'user', excerpt: '生产环境强制使用 PostgreSQL 16 数据库。' }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    const mockFetch = createMockFetch({
      action: 'keep',
      reason: 'Memory is accurate and consistent with verifiable evidence.',
      items: [],
    });

    const jobRes = await executeRepair(
      db,
      { id: 101, key: 'rep_1', payload: JSON.stringify({ memoryId: memId, sessionId: sess1, query: 'q', turn: 1 }) },
      { fetchFn: mockFetch },
      testCfg,
      fixedNow
    );

    expect(jobRes.action).toBe('done');
    const proposals = listRepairProposals(db);
    expect(proposals.length).toBe(0);

    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(mem?.status).toBe('active');
    expect(mem?.last_repair_at).toBe(fixedNow);
  });

  it('M6: executeRepair 处理 revise 动作并经 approve-repair 落地', async () => {
    const quote = '生产环境强制使用 PostgreSQL 16 数据库。';
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: `团队生产环境强制使用 PostgreSQL 16 数据库。`,
        slot_key: 'project.db',
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 5, kind: 'user', excerpt: quote }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    // 模型返回 revise 提案
    const mockFetch = createMockFetch({
      action: 'revise',
      reason: 'Port and pool details should be refined.',
      items: [
        {
          type: 'semantic',
          text: '团队生产环境强制使用 PostgreSQL 16 数据库并配置连接池。',
          slot_key: 'project.db',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote }],
        },
      ],
    });

    const jobRes = await executeRepair(
      db,
      { id: 102, key: 'rep_2', payload: JSON.stringify({ memoryId: memId, sessionId: sess1, query: '连接串', turn: 1 }) },
      { fetchFn: mockFetch },
      testCfg,
      fixedNow
    );

    expect(jobRes.action).toBe('done');

    // 验证原记忆保持 active，并未被直接篡改
    const origMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(origMem?.status).toBe('active');

    // 验证生成了 repair_proposals 记录
    const proposals = listRepairProposals(db, 'candidate');
    expect(proposals.length).toBe(1);
    const prop = proposals[0];
    expect(prop.action).toBe('revise');
    expect(prop.memoryId).toBe(memId);
    expect(prop.candidateIds.length).toBe(1);

    const candId = prop.candidateIds[0];
    const candidateMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [candId]);
    expect(candidateMem?.status).toBe('candidate');

    // 门禁测试：普通 approveCandidate 必须拒绝直接批准挂着 repair proposal 的候选
    const directApprove = approveCandidate(db, candId, 'user', fixedNow);
    expect(directApprove.action).toBe('rejected');

    // 用户通过 approveRepairProposal 显式批准
    const approveRes = approveRepairProposal(db, prop.id, 'user', fixedNow);
    expect(approveRes.ok).toBe(true);

    // 验证原记忆被 supersede，新候选被激活
    const supersededMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(supersededMem?.status).toBe('superseded');

    const activatedMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [candId]);
    expect(activatedMem?.status).toBe('active');

    const propAfter = db.get<{ status: string }>('SELECT status FROM repair_proposals WHERE id = ?', [prop.id]);
    expect(propAfter?.status).toBe('approved');
  });

  it('M6: executeRepair 处理 split 动作并经 approve-repair 落地', async () => {
    const quote = '生产环境强制使用 PostgreSQL 16 数据库。';
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: `团队生产环境强制使用 PostgreSQL 16 数据库。`,
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user', excerpt: quote }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    // 模型返回 split 提案 (拆分成 2 条)
    const mockFetch = createMockFetch({
      action: 'split',
      reason: 'Split into primary database and pool configuration.',
      items: [
        {
          type: 'semantic',
          text: '团队生产环境使用 PostgreSQL 16 数据库。',
          slot_key: 'project.db.type',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote }],
        },
        {
          type: 'semantic',
          text: '团队数据库连接池配置强制要求在生产环境启用。',
          slot_key: 'project.db.pool',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote }],
        },
      ],
    });

    const jobRes = await executeRepair(
      db,
      { id: 103, key: 'rep_3', payload: JSON.stringify({ memoryId: memId, sessionId: sess1, query: 'q', turn: 1 }) },
      { fetchFn: mockFetch },
      testCfg,
      fixedNow
    );
    expect(jobRes.action).toBe('done');

    const proposals = listRepairProposals(db, 'candidate');
    expect(proposals.length).toBe(1);
    const prop = proposals[0];
    expect(prop.action).toBe('split');
    expect(prop.candidateIds.length).toBe(2);

    // 批准拆分提案
    const approveRes = approveRepairProposal(db, prop.id, 'user', fixedNow);
    expect(approveRes.ok).toBe(true);

    const origMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(origMem?.status).toBe('superseded');

    for (const cid of prop.candidateIds) {
      const cm = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [cid]);
      expect(cm?.status).toBe('active');
    }
  });

  it('M6: executeRepair 处理 invalidate 动作并经 reject-repair 拒绝', async () => {
    const quote = '生产环境强制使用 PostgreSQL 16 数据库。';
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: `团队生产环境强制使用 PostgreSQL 16 数据库。`,
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user', excerpt: quote }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    // 模型返回 invalidate 提案
    const mockFetch = createMockFetch({
      action: 'invalidate',
      reason: 'This fact is entirely obsolete and contradicted.',
      items: [],
    });

    const jobRes = await executeRepair(
      db,
      { id: 104, key: 'rep_4', payload: JSON.stringify({ memoryId: memId, sessionId: sess1, query: 'q', turn: 1 }) },
      { fetchFn: mockFetch },
      testCfg,
      fixedNow
    );
    expect(jobRes.action).toBe('done');

    const proposals = listRepairProposals(db, 'candidate');
    expect(proposals.length).toBe(1);
    const prop = proposals[0];
    expect(prop.action).toBe('invalidate');

    // 用户拒绝该废弃提案
    const rejectRes = rejectRepairProposal(db, prop.id);
    expect(rejectRes.ok).toBe(true);

    // 原记忆依旧保持 active，未被归档
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [memId]);
    expect(mem?.status).toBe('active');
  });

  it('M6: 若原记忆正文发生修订或已过期，approveRepairProposal 应拒绝', async () => {
    const quote = '生产环境强制使用 PostgreSQL 16 数据库。';
    const res = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: `团队生产环境强制使用 PostgreSQL 16 数据库。`,
        scope: 'workspace',
        workspaceId: ws1,
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: sess1, seq: 1, kind: 'user', excerpt: quote }],
        actor: 'user',
      },
      fixedNow
    );
    const memId = (res as any).id;

    // 手动插入一个 content_rev = 1 的提案
    db.run(
      `INSERT INTO repair_proposals (
        job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at
      ) VALUES (999, ?, 1, 'invalidate', '[]', 'test', 'candidate', ?, ?)`,
      [memId, fixedNow, fixedNow + 30 * 86400000]
    );

    // 模拟原记忆正文修订 (content_rev 递增为 2)
    db.run('UPDATE memories SET content_rev = 2 WHERE id = ?', [memId]);

    const approveRevMismatch = approveRepairProposal(db, 1, 'user', fixedNow);
    expect(approveRevMismatch.ok).toBe(false);
    expect(approveRevMismatch.reason).toContain('content_rev has changed');

    // 模拟提案过期
    db.run('UPDATE memories SET content_rev = 1 WHERE id = ?', [memId]);
    db.run('UPDATE repair_proposals SET expires_at = ? WHERE id = 1', [fixedNow - 1000]);

    const approveExpired = approveRepairProposal(db, 1, 'user', fixedNow);
    expect(approveExpired.ok).toBe(false);
    expect(approveExpired.reason).toContain('expired');
  });
});
