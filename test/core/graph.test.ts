import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import type { Db } from '../../src/types.js';
import { upsertCandidate, mergeMemories } from '../../src/core/writer.js';
import { getGraphData, renderMermaidGraph } from '../../src/core/store.js';

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
});
