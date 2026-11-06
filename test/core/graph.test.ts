import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { upsertCandidate, mergeMemories, addRelation } from '../../src/core/writer.js';
import { getGraphData, getSubgraph, renderMermaidGraph } from '../../src/core/store.js';
import { workspaceId } from '../../src/core/scope.js';
import { buildQueryPlan } from '../../src/retrieval/query.js';
import { recall } from '../../src/retrieval/recall.js';

describe('Knowledge Graph & Topology Visualization (汲取自 qwert702/dsh-memory 与 omdsh-dev/dsh-mnemon)', () => {
  let db: Db;
  const now = Date.now();

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('should generate graph nodes and relation links accurately', () => {
    // 写入三条有关联的记忆
    const resA = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: 'Docker 镜像打包使用 alpine 基础镜像，减小体积',
        summary: 'Docker 基础镜像选型',
        scope: 'workspace',
        workspaceId: 'ws_graph',
        source_kind: 'user',
        confidence: 0.9,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );

    const resB = upsertCandidate(
      db,
      {
        type: 'semantic',
        content: '生产环境改用 debian-slim 替代 alpine 解决 musl libc 兼容问题',
        summary: 'Docker 生产镜像变更为 debian-slim',
        scope: 'workspace',
        workspaceId: 'ws_graph',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 1000
    );

    const idA = (resA as any).id;
    const idB = (resB as any).id;

    // 执行显式合并 (B supersedes A)
    mergeMemories(db, idA, idB, 'docker_runtime_fix', 'user', now + 2000);

    const graph = getGraphData(db, { workspaceId: 'ws_graph', limit: 20 });
    expect(graph.stats.totalNodes).toBeGreaterThanOrEqual(2);
    expect(graph.stats.totalLinks).toBeGreaterThanOrEqual(1);

    const memNodes = graph.nodes.filter((n) => n.type === 'memory');
    expect(memNodes.length).toBeGreaterThanOrEqual(1);

    const supersedesLink = graph.links.find((l) => l.rel === 'supersedes');
    expect(supersedesLink).toBeDefined();
    expect(supersedesLink?.source).toBe(idB);
    expect(supersedesLink?.target).toBe(idA);

    // 验证渲染出的 Mermaid 文本格式
    const mermaid = renderMermaidGraph(graph, 15);
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('supersedes');
  });

  it('extracts K-Hop ego-network subgraph and applies GraphRAG 1-hop associative recall + synergy boost', () => {
    const resSeed = upsertCandidate(
      db,
      {
        type: 'procedural',
        content: '网关鉴权中间件位于 src/auth/jwt.ts，默认使用 RS256 公钥校验签名',
        summary: '网关 JWT 鉴权中间件路径与算法',
        scope: 'workspace',
        workspaceId: 'ws_graph',
        source_kind: 'user',
        confidence: 0.95,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 1, kind: 'user' }],
        actor: 'user',
      },
      now
    );
    const seedId = (resSeed as any).id;

    const resNeighbor = upsertCandidate(
      db,
      {
        type: 'failure',
        content: '更新 RS256 密钥轮换时若未同步刷新 Redis JWKS 缓存会导致 401 鉴权失败',
        summary: 'RS256 密钥轮换需刷新 JWKS 缓存',
        scope: 'workspace',
        workspaceId: 'ws_graph',
        source_kind: 'user',
        confidence: 0.92,
        origin_kinds: ['user'],
        sources: [{ session_id: 's1', seq: 2, kind: 'user' }],
        actor: 'user',
      },
      now + 100
    );
    const neighborId = (resNeighbor as any).id;

    addRelation(db, seedId, neighborId, 'related', now + 200);

    // 1. Test K-hop ego-network extraction (getSubgraph)
    const sub = getSubgraph(db, seedId.slice(0, 8), { workspaceId: 'ws_graph', hops: 1 });
    expect(sub).not.toBeNull();
    expect(sub!.nodes.some((n) => n.id === seedId)).toBe(true);
    expect(sub!.nodes.some((n) => n.id === neighborId)).toBe(true);
    expect(sub!.links.some((l) => l.rel === 'related')).toBe(true);

    // 2. Test GraphRAG 1-hop associative recall & relational synergy boost
    const plan = buildQueryPlan({
      userText: 'src/auth/jwt.ts 网关鉴权 RS256 签名怎么配置？',
    });
    const recRes = recall(db, plan, {
      workspaceId: workspaceId('ws_graph'),
      sessionId: 's1',
      now: now + 500,
    });
    const recalledIds = recRes.items.map((it) => it.memory.id);
    expect(recalledIds).toContain(seedId);
    expect(recalledIds).toContain(neighborId);
    // Both linked memories should be tagged with the 'graph' channel in matchedChannels
    expect(recRes.matchedChannels?.[seedId] || []).toContain('graph');
    expect(recRes.matchedChannels?.[neighborId] || []).toContain('graph');
  });
});
