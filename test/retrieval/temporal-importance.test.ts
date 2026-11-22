import { describe, it, expect } from 'vitest';
import type { MemoryRecord, QueryPlan, StrategyConfig } from '../../src/types.js';
import { fuseCandidates, DEFAULT_STRATEGY } from '../../src/retrieval/fuse.js';

function createMockMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm_test_temp_001',
    type: 'semantic',
    status: 'active',
    content: '测试用事实',
    summary: '测试用摘要',
    slot_key: null,
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
    hash: 'hash_test',
    version: 1,
    content_rev: 1,
    pinned: 0,
    valid_from: null,
    valid_to: null,
    created_at: 1000,
    updated_at: 1000,
    importance: 5,
    ...overrides,
  };
}

describe('Zep Temporal Invalidation & Stanford Importance Scoring (fuse.ts)', () => {
  const fixedNow = new Date('2026-11-04T12:00:00Z').getTime();

  const plan: QueryPlan = {
    text: '数据库连接配置',
    tokens: ['数据库', '连接', '配置'],
    contentTokens: ['数据库', '连接', '配置'],
    entities: [],
    contextEntities: [],
    intents: { temporal: false, causal: false, procedural: false, preference: false },
    temporalBrowse: false,
    preferenceBrowse: false,
    now: fixedNow,
  };

  it('Stanford Importance: Higher importance memories should rank higher when relevance is equal', () => {
    // 两个记忆内容与检索词相同
    const memLowImportance = createMockMemory({
      id: 'm_low_imp',
      content: '数据库连接配置：超时为 5 秒',
      importance: 2, // 闲聊或低价值事实
      confidence: 0.8,
      utility: 0.8,
    });

    const memHighImportance = createMockMemory({
      id: 'm_high_imp',
      content: '数据库连接配置：核心生产集群参数必须启用 SSL',
      importance: 10, // 核心生产关键约束
      confidence: 0.8,
      utility: 0.8,
    });

    const channelResults = {
      lexical: [
        { id: memLowImportance.id, channel: 'lexical' as const, rank: 1 },
        { id: memHighImportance.id, channel: 'lexical' as const, rank: 1 },
      ],
      entity: [],
      typed: [],
      temporal: [],
      preference: [],
      vector: [],
    };

    const strategyWithImportance: StrategyConfig = {
      ...DEFAULT_STRATEGY,
      scoreWeights: {
        ...DEFAULT_STRATEGY.scoreWeights,
        importance: 0.2, // 开启重要度权重
      },
    };

    const scored = fuseCandidates(
      plan,
      channelResults,
      new Map([[memLowImportance.id, memLowImportance], [memHighImportance.id, memHighImportance]]),
      new Map(),
      new Set(),
      strategyWithImportance,
      undefined,
      fixedNow
    );

    expect(scored).toHaveLength(2);
    expect(scored[0].memory.id).toBe(memHighImportance.id);
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('Zep Temporal Validity: excludes expired/invalidated memories in normal queries, and penalizes freshness during temporalBrowse', () => {
    const validMem = createMockMemory({
      id: 'm_valid',
      content: '数据库连接配置：有效配置',
      created_at: fixedNow - 3600000,
      updated_at: fixedNow - 3600000,
    });

    const invalidatedMem = createMockMemory({
      id: 'm_invalidated',
      content: '数据库连接配置：已被废除的旧配置',
      created_at: fixedNow - 3600000,
      updated_at: fixedNow - 3600000,
      invalidated_at: fixedNow - 1000, // 已标记失效
    });

    const expiredMem = createMockMemory({
      id: 'm_expired',
      content: '数据库连接配置：已过期临时规则',
      created_at: fixedNow - 3600000,
      updated_at: fixedNow - 3600000,
      valid_to: fixedNow - 2000, // 已过期
    });

    const channelResults = {
      lexical: [
        { id: validMem.id, channel: 'lexical' as const, rank: 1 },
        { id: invalidatedMem.id, channel: 'lexical' as const, rank: 1 },
        { id: expiredMem.id, channel: 'lexical' as const, rank: 1 },
      ],
      entity: [],
      typed: [],
      temporal: [],
      preference: [],
      vector: [],
    };

    const memMap = new Map([
      [validMem.id, validMem],
      [invalidatedMem.id, invalidatedMem],
      [expiredMem.id, expiredMem],
    ]);

    // 1. 普通非 temporalBrowse 查询：已失效/已过期记忆必须被直接排除
    const scoredNormal = fuseCandidates(
      plan,
      channelResults,
      memMap,
      new Map(),
      new Set(),
      DEFAULT_STRATEGY,
      undefined,
      fixedNow
    );
    expect(scoredNormal).toHaveLength(1);
    expect(scoredNormal[0].memory.id).toBe(validMem.id);

    // 2. temporalBrowse 历史浏览模式下：允许保留历史记录，但失效/过期项的新鲜度受到重罚，仍严格排在有效项之后
    const browsePlan: QueryPlan = {
      ...plan,
      temporalBrowse: true,
      timeRange: { from: fixedNow - 86400000, to: fixedNow },
    };
    const scoredBrowse = fuseCandidates(
      browsePlan,
      channelResults,
      memMap,
      new Map(),
      new Set(),
      DEFAULT_STRATEGY,
      undefined,
      fixedNow
    );

    expect(scoredBrowse).toHaveLength(3);
    expect(scoredBrowse[0].memory.id).toBe(validMem.id);
    expect(scoredBrowse[0].score).toBeGreaterThan(scoredBrowse[1].score);
    expect(scoredBrowse[0].score).toBeGreaterThan(scoredBrowse[2].score);
  });
});
