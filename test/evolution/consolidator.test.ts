import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS, type PluginConfig } from '../../src/config.js';
import {
  findConsolidationClusters,
  consolidateCluster,
} from '../../src/evolution/consolidator.js';
import { upsertCandidate } from '../../src/core/writer.js';
import type { Db, MemoryRecord } from '../../src/types.js';

describe('Consolidator (M3-T5)', () => {
  let db: Db;
  let cfg: PluginConfig;

  beforeEach(() => {
    db = openDb(':memory:');
    cfg = {
      ...DEFAULTS,
      privacy: {
        offlineConsent: true,
        allowedOfflineEndpoints: ['https://api.deepseek.com'],
      },
      offlineLLM: {
        useDshLlm: false,
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKeyEnv: '',
      },
    };
  });

  function setupSuccessMemory(sessionId: string, title: string): string {
    const res = upsertCandidate(db, {
      type: 'episodic',
      content: `在项目执行 vitest 测试时因 dist/index.js 缺失报错，运行 pnpm build 成功修复了构建：${title}`,
      scope: 'workspace',
      workspaceId: 'ws1',
      source_kind: 'user',
      confidence: 1.0,
      origin_kinds: ['user'],
      sources: [{ session_id: sessionId, seq: 1, kind: 'user', excerpt: 'pnpm build && vitest run' }],
      actor: 'user',
    });
    const id = (res as any).id;
    // 置为 active
    db.run("UPDATE memories SET status = 'active' WHERE id = ?", [id]);
    // 注入成功记录 (used = 1, outcome = 1.0)
    db.run(
      `INSERT INTO injections (session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, outcome, used, created_at)
       VALUES (?, 1, ?, 1, 'dynamic', 1, 50, 'content', 1, 1.0, 1, 1000)`,
      [sessionId, id]
    );
    return id;
  }

  it('consolidates 3 approved episodic successes across 3 sessions into 1 procedural candidate (3个session成功转procedural及3条derived_from)', async () => {
    const id1 = setupSuccessMemory('session_1', '修复 A');
    const id2 = setupSuccessMemory('session_2', '修复 B');
    const id3 = setupSuccessMemory('session_3', '修复 C');

    // 聚类发现
    const clusters = findConsolidationClusters(db, 'ws1', cfg);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memories).toHaveLength(3);
    expect(clusters[0].distinctSuccessfulSessions).toHaveLength(3);

    const fixtureProceduralResponse = {
      items: [
        {
          type: 'procedural',
          text: '本仓库测试报错时，先执行 pnpm build 重新生成 dist/，再执行测试；以测试通过验证修复。',
          slot_key: 'build-before-test',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [
            { seq: 1, quote: 'pnpm build && vitest run' },
            { seq: 2, quote: 'pnpm build && vitest run' },
            { seq: 3, quote: 'pnpm build && vitest run' },
          ],
        },
      ],
    };

    const mockFetch: typeof fetch = async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fixtureProceduralResponse) } }],
          usage: { prompt_tokens: 300, completion_tokens: 100 },
        }),
        { status: 200 }
      );
    };

    const result = await consolidateCluster(db, cfg, clusters[0], {
      fetchFn: mockFetch,
    });

    expect(result.success).toBe(true);
    expect(result.candidateId).toBeDefined();

    // 验证新记忆为 candidate 状态，type 为 procedural
    const candidate = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [result.candidateId!]);
    expect(candidate?.type).toBe('procedural');
    expect(candidate?.status).toBe('candidate');

    // 验证 3 条 derived_from 关系
    const relations = db.all<{ from_id: string; to_id: string; rel: string; metadata: string }>(
      "SELECT * FROM memory_relations WHERE from_id = ? AND rel = 'derived_from'",
      [result.candidateId!]
    );
    expect(relations).toHaveLength(3);
    const toIds = relations.map(r => r.to_id).sort();
    expect(toIds).toEqual([id1, id2, id3].sort());

    const meta = JSON.parse(relations[0].metadata);
    expect(meta.sources).toHaveLength(3);
    expect(meta.sources[0]).toHaveProperty('content_rev');
    expect(meta.sources[0]).toHaveProperty('hash');

    // 验证源记录保持不变 (依然为 active，并未被修改或被 supersede)
    const sources = db.all<MemoryRecord>('SELECT status FROM memories WHERE id IN (?, ?, ?)', [
      id1,
      id2,
      id3,
    ]);
    expect(sources.every(s => s.status === 'active')).toBe(true);
  });

  it('aborts consolidation if any source memory changes before commit (源记录在提交前变化整次响应丢弃)', async () => {
    setupSuccessMemory('s1', '案例 1');
    setupSuccessMemory('s2', '案例 2');
    const id3 = setupSuccessMemory('s3', '案例 3');

    const clusters = findConsolidationClusters(db, 'ws1', cfg);
    expect(clusters).toHaveLength(1);

    const fixtureProceduralResponse = {
      items: [
        {
          type: 'procedural',
          text: '本仓库测试报错时，先执行 pnpm build 重新生成 dist/，再执行测试；以测试通过验证修复。',
          confidence: 0.9,
          scope: 'workspace',
          evidence: [{ seq: 1, quote: 'pnpm build && vitest run' }],
        },
      ],
    };

    // 模拟在 LLM 返回期间，其中一条源记录被修改或冻结
    const mockFetch: typeof fetch = async () => {
      db.run("UPDATE memories SET status = 'frozen', content_rev = 2 WHERE id = ?", [id3]);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(fixtureProceduralResponse) } }],
          usage: { prompt_tokens: 300, completion_tokens: 100 },
        }),
        { status: 200 }
      );
    };

    const result = await consolidateCluster(db, cfg, clusters[0], {
      fetchFn: mockFetch,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('snapshots_changed_before_commit');

    // 确认没有生成新的 candidate
    const count = db.get<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM memories WHERE status = 'candidate'"
    );
    expect(count?.cnt).toBe(0);
  });

  it('rejects consolidation if all 3 successes are from the same session (单session3次成功不满足门槛)', () => {
    // 同一个 session 的 3 次成功
    setupSuccessMemory('single_session', '案例 1');
    setupSuccessMemory('single_session', '案例 2');
    setupSuccessMemory('single_session', '案例 3');

    const clusters = findConsolidationClusters(db, 'ws1', cfg);
    // 不满足 >= 3 个独立 session 的要求，不生成聚类
    expect(clusters).toHaveLength(0);
  });
});
