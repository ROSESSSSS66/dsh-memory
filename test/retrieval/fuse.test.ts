import { describe, it, expect } from 'vitest';
import type { MemoryRecord, QueryPlan } from '../../src/types.js';
import { fuseCandidates, DEFAULT_STRATEGY } from '../../src/retrieval/fuse.js';
import { buildQueryPlan } from '../../src/retrieval/query.js';

function createMockMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm_test001002003004',
    type: 'semantic',
    status: 'active',
    content: '项目数据库为 PostgreSQL 16',
    summary: '项目数据库配置',
    slot_key: 'project.database',
    scope: 'workspace',
    workspace_id: 'ws_test',
    session_id: null,
    origin_kinds: ['user'],
    approved_at: 1000,
    approved_by: 'user',
    source_kind: 'user',
    confidence: 0.9,
    utility: 0.8,
    use_count: 5,
    success_count: 5,
    fail_count: 0,
    token_cost: 30,
    summary_cost: 15,
    hash: 'hash123',
    version: 1,
    content_rev: 1,
    pinned: 0,
    valid_from: null,
    valid_to: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('Fusion and Scoring (fuse.ts)', () => {
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  describe('Step 1: Absolute relevance hard gate (验收项 5)', () => {
    it('库中仅一条当天数据库事实，查询“今天天气”→空', () => {
      // 记忆为当天的数据库事实
      const dbMem = createMockMemory({
        id: 'm_db_fact_00000001',
        content: '项目数据库为 PostgreSQL 16',
        created_at: fixedNow,
        updated_at: fixedNow,
      });

      const plan = buildQueryPlan({ userText: '今天天气', now: fixedNow });
      // temporal 通道召回了它（因为时间是今天）
      const channelResults = {
        lexical: [],
        entity: [],
        typed: [],
        temporal: [{ id: dbMem.id, channel: 'temporal' as const, rank: 1 }],
        preference: [],
        vector: [],
      };

      const memoriesMap = new Map([[dbMem.id, dbMem]]);
      const memoryEntitiesMap = new Map([[dbMem.id, new Set(['postgresql'])]]);
      const contradictionsSet = new Set<string>();

      const scored = fuseCandidates(
        plan,
        channelResults,
        memoriesMap,
        memoryEntitiesMap,
        contradictionsSet,
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      // 必须为空！时间命中不能替代硬门槛
      expect(scored).toEqual([]);
    });

    it('改变 RRF 权重不能绕过绝对门槛 (验收项 5)', () => {
      const dbMem = createMockMemory({
        id: 'm_db_fact_00000001',
        content: '项目数据库为 PostgreSQL 16',
        created_at: fixedNow,
      });

      const plan = buildQueryPlan({ userText: '今天天气', now: fixedNow });
      const channelResults = {
        lexical: [],
        entity: [],
        typed: [],
        temporal: [{ id: dbMem.id, channel: 'temporal' as const, rank: 1 }],
        preference: [],
        vector: [],
      };

      // 即使把 temporal 通道权重设为 999999
      const extremeStrategy = {
        ...DEFAULT_STRATEGY,
        channelWeights: {
          ...DEFAULT_STRATEGY.channelWeights,
          temporal: 999999,
        },
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[dbMem.id, dbMem]]),
        new Map(),
        new Set(),
        extremeStrategy,
        undefined,
        fixedNow
      );

      expect(scored).toEqual([]);
    });

    it('仅低覆盖单词命中也为空 (验收项 5)', () => {
      // 查询有 4 个 contentTokens
      const plan: QueryPlan = {
        text: 'PostgreSQL Redis MongoDB MySQL 集群',
        tokens: ['postgresql', 'redis', 'mongodb', 'mysql', '集群'],
        contentTokens: ['postgresql', 'redis', 'mongodb', 'mysql'],
        entities: [],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: false, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      // 记忆仅包含 1 个词 (PostgreSQL)，命中数 1 < 2，且 coverage = 0.25
      const mem = createMockMemory({
        id: 'm_low_coverage_01',
        content: '仅提及了 PostgreSQL 说明',
      });

      const channelResults = {
        lexical: [{ id: mem.id, channel: 'lexical' as const, rank: 1 }],
        entity: [],
        typed: [],
        temporal: [],
        preference: [],
        vector: [],
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[mem.id, mem]]),
        new Map(),
        new Set(),
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      expect(scored).toEqual([]);
    });

    it('当查询仅有 1 个 contentToken 时，单词精确命中可放行', () => {
      const plan: QueryPlan = {
        text: 'PostgreSQL',
        tokens: ['postgresql'],
        contentTokens: ['postgresql'],
        entities: [],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: false, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      const mem = createMockMemory({
        id: 'm_exact_00000001',
        content: '安装 PostgreSQL 16',
      });

      const channelResults = {
        lexical: [{ id: mem.id, channel: 'lexical' as const, rank: 1 }],
        entity: [],
        typed: [],
        temporal: [],
        preference: [],
        vector: [],
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[mem.id, mem]]),
        new Map(),
        new Set(),
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      expect(scored.length).toBe(1);
      expect(scored[0].memory.id).toBe(mem.id);
    });

    it('实体精确命中可以放行硬门槛', () => {
      const plan: QueryPlan = {
        text: '查询特定服务配置',
        tokens: ['特定', '服务', '配置'],
        contentTokens: ['特定', '服务', '配置'],
        entities: ['nginx.conf'],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: false, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      const mem = createMockMemory({
        id: 'm_ent_0000000001',
        content: '修改了代理规则',
      });

      const channelResults = {
        lexical: [],
        entity: [{ id: mem.id, channel: 'entity' as const, rank: 1 }],
        typed: [],
        temporal: [],
        preference: [],
        vector: [],
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[mem.id, mem]]),
        new Map([[mem.id, new Set(['nginx.conf'])]]),
        new Set(),
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      expect(scored.length).toBe(1);
    });
  });

  describe('Step 2 & 3: RRF and scoring formula', () => {
    it('should correctly fuse multi-channel hits and compute comprehensive score', () => {
      const mem1 = createMockMemory({
        id: 'm_multi_00000001',
        content: 'PostgreSQL 数据库连接超时配置',
        confidence: 0.9,
        utility: 0.8,
      });
      const mem2 = createMockMemory({
        id: 'm_single_0000002',
        content: 'PostgreSQL 安装说明',
        confidence: 0.8,
        utility: 0.5,
      });

      const plan: QueryPlan = {
        text: 'PostgreSQL 连接超时',
        tokens: ['postgresql', '连接', '超时'],
        contentTokens: ['postgresql', '连接', '超时'],
        entities: ['postgresql'],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: true, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      // mem1 在 lexical, entity, typed 三个通道命中
      // mem2 仅在 lexical 命中
      const channelResults = {
        lexical: [
          { id: mem1.id, channel: 'lexical' as const, rank: 1 },
          { id: mem2.id, channel: 'lexical' as const, rank: 2 },
        ],
        entity: [{ id: mem1.id, channel: 'entity' as const, rank: 1 }],
        typed: [{ id: mem1.id, channel: 'typed' as const, rank: 1 }],
        temporal: [],
        preference: [],
        vector: [],
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[mem1.id, mem1], [mem2.id, mem2]]),
        new Map([[mem1.id, new Set(['postgresql'])], [mem2.id, new Set(['postgresql'])]]),
        new Set(),
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      expect(scored.length).toBe(2);
      expect(scored[0].memory.id).toBe(mem1.id);
      expect(scored[0].score).toBeGreaterThan(scored[1].score);
      expect(scored[0].relevance).toBe(1.0); // 最高分项归一化为 1.0
      expect(scored[1].relevance).toBeLessThan(1.0);
    });

    it('should reduce consistency to 0.3 when contradiction is present', () => {
      const memNormal = createMockMemory({ id: 'm_norm_00000001', content: 'PostgreSQL 连接超时配置' });
      const memContradict = createMockMemory({ id: 'm_cont_00000002', content: 'PostgreSQL 连接超时配置' });

      const plan: QueryPlan = {
        text: 'PostgreSQL 连接超时',
        tokens: ['postgresql', '连接', '超时'],
        contentTokens: ['postgresql', '连接', '超时'],
        entities: ['postgresql'],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: false, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      const channelResults = {
        lexical: [
          { id: memNormal.id, channel: 'lexical' as const, rank: 1 },
          { id: memContradict.id, channel: 'lexical' as const, rank: 1 },
        ],
        entity: [],
        typed: [],
        temporal: [],
        preference: [],
        vector: [],
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[memNormal.id, memNormal], [memContradict.id, memContradict]]),
        new Map(),
        new Set([memContradict.id]), // memContradict 有 active 矛盾项
        DEFAULT_STRATEGY,
        undefined,
        fixedNow
      );

      const normScore = scored.find((s) => s.memory.id === memNormal.id)!.score;
      const contScore = scored.find((s) => s.memory.id === memContradict.id)!.score;

      // 矛盾项 consistency 为 0.3，其综合评分必须低于正常项 (1.0)
      expect(normScore).toBeGreaterThan(contScore);
    });
  });

  describe('Step 4: Relative rank filtering', () => {
    it('should discard candidates with relevance < minRelevance', () => {
      const memTop = createMockMemory({ id: 'm_top_000000001', content: 'PostgreSQL 连接超时配置' });
      const memTail = createMockMemory({ id: 'm_tail_00000002', content: 'PostgreSQL 连接超时配置' });

      const plan: QueryPlan = {
        text: 'PostgreSQL 连接超时',
        tokens: ['postgresql', '连接', '超时'],
        contentTokens: ['postgresql', '连接', '超时'],
        entities: ['postgresql'],
        contextEntities: [],
        intents: { temporal: false, causal: false, procedural: false, preference: false },
        temporalBrowse: false,
        preferenceBrowse: false,
        now: fixedNow,
      };

      // 构造让 memTail 的 RRF 排名极低
      const channelResults = {
        lexical: [
          { id: memTop.id, channel: 'lexical' as const, rank: 1 },
          { id: memTail.id, channel: 'lexical' as const, rank: 50 },
        ],
        entity: [{ id: memTop.id, channel: 'entity' as const, rank: 1 }],
        typed: [{ id: memTop.id, channel: 'typed' as const, rank: 1 }],
        temporal: [{ id: memTop.id, channel: 'temporal' as const, rank: 1 }],
        preference: [],
        vector: [],
      };

      const customStrategy = {
        ...DEFAULT_STRATEGY,
        minRelevance: 0.3, // 相对门槛设为 0.3
      };

      const scored = fuseCandidates(
        plan,
        channelResults,
        new Map([[memTop.id, memTop], [memTail.id, memTail]]),
        new Map(),
        new Set(),
        customStrategy,
        undefined,
        fixedNow
      );

      // memTail relevance 远低于 0.3，被丢弃
      expect(scored.map((s) => s.memory.id)).toContain(memTop.id);
      expect(scored.map((s) => s.memory.id)).not.toContain(memTail.id);
    });
  });
});
