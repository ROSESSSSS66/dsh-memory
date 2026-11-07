import type { Db, MemoryRecord } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { tokenSet, jaccard, extractEntities } from '../core/text.js';
import { redactSecrets } from '../core/privacy.js';
import { PROMPT_CONSOLIDATE } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { upsertCandidate } from '../core/writer.js';

import { workspaceId as normalizeWsId } from '../core/scope.js';

export interface SourceSnapshot {
  id: string;
  content_rev: number;
  hash: string;
  content: string;
  summary: string;
  status: string;
  valid_from: number | null;
}

export interface MemoryCluster {
  clusterKey: string;
  workspaceId: string;
  memories: MemoryRecord[];
  snapshots: SourceSnapshot[];
  distinctSuccessfulSessions: string[];
}

/**
 * 在 workspace 内对 active episodic/failure 记忆聚类并计算连通分量
 * 聚类条件：共享 >= 1 个实体 且 Jaccard >= 0.35
 */
export function findConsolidationClusters(
  db: Db,
  workspaceId: string,
  cfg: PluginConfig
): MemoryCluster[] {
  const wsId = normalizeWsId(workspaceId);
  const records = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE scope = 'workspace' AND workspace_id = ?
       AND status = 'active' AND type IN ('episodic', 'failure')
     ORDER BY created_at ASC`,
    [wsId]
  );

  if (records.length < 3) {
    return [];
  }

  // 1. 预提取 tokenSet 与 entities
  const recordTokens = new Map<string, Set<string>>();
  const recordEntities = new Map<string, string[]>();

  for (const m of records) {
    recordTokens.set(m.id, tokenSet(m.content));
    recordEntities.set(m.id, extractEntities(m.content));
  }

  // 2. 建图并寻找连通分量 (BFS)
  const adj = new Map<string, string[]>();
  for (const m of records) {
    adj.set(m.id, []);
  }

  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const m1 = records[i];
      const m2 = records[j];

      // 必须共享至少 1 个实体
      const ent1 = recordEntities.get(m1.id)!;
      const ent2 = recordEntities.get(m2.id)!;
      const sharesEntity = ent1.some(e => ent2.includes(e));
      if (!sharesEntity) continue;

      // Jaccard 相似度必须 >= 0.35
      const t1 = recordTokens.get(m1.id)!;
      const t2 = recordTokens.get(m2.id)!;
      const sim = jaccard(t1, t2);
      if (sim >= 0.35) {
        adj.get(m1.id)!.push(m2.id);
        adj.get(m2.id)!.push(m1.id);
      }
    }
  }

  const visited = new Set<string>();
  const rawClusters: MemoryRecord[][] = [];

  for (const m of records) {
    if (visited.has(m.id)) continue;

    const component: MemoryRecord[] = [];
    const queue: string[] = [m.id];
    visited.add(m.id);

    while (queue.length > 0) {
      const currId = queue.shift()!;
      const currMem = records.find(r => r.id === currId)!;
      component.push(currMem);

      for (const neighborId of adj.get(currId) || []) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    if (component.length >= 3) {
      rawClusters.push(component);
    }
  }

  const result: MemoryCluster[] = [];
  const maxClusters = cfg.consolidateMaxClusters || 5;

  for (const comp of rawClusters) {
    if (result.length >= maxClusters) break;

    // 检查在 injections 中是否存在 >= 3 个不同 session 的 used=1 AND outcome > 0.5 成功证据
    const memIds = comp.map(r => r.id);
    const placeholders = memIds.map(() => '?').join(',');
    const sessionRows = db.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM injections
       WHERE memory_id IN (${placeholders})
         AND used = 1 AND outcome > 0.5`,
      memIds
    );

    const distinctSessions = sessionRows.map(r => r.session_id);

    // 必须满足至少 3 个独立 session
    if (distinctSessions.length < 3) {
      continue;
    }

    // 检查该组记忆是否已全部整合生成过衍生记忆，避免重复整合同一聚类
    const alreadyDerived = db.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT to_id) as cnt
       FROM memory_relations
       WHERE rel = 'derived_from' AND to_id IN (${placeholders})`,
      memIds
    );
    if ((alreadyDerived?.cnt ?? 0) >= memIds.length) {
      continue;
    }

    // 冻结源记录快照
    const snapshots: SourceSnapshot[] = comp.map(r => ({
      id: r.id,
      content_rev: r.content_rev,
      hash: r.hash,
      content: r.content,
      summary: r.summary,
      status: r.status,
      valid_from: r.valid_from ?? null,
    }));

    const sortedIds = [...memIds].sort();
    const clusterKey = `cluster:${wsId}:${sortedIds.join(',')}`;

    result.push({
      clusterKey,
      workspaceId: wsId,
      memories: comp,
      snapshots,
      distinctSuccessfulSessions: distinctSessions,
    });
  }

  return result;
}

/**
 * 校验快照是否依然有效（正文、版本、hash、状态未变化）
 */
export function verifySnapshots(db: Db, snapshots: SourceSnapshot[]): boolean {
  for (const s of snapshots) {
    const cur = db.get<{
      content_rev: number;
      hash: string;
      status: string;
      valid_from: number | null;
    }>('SELECT content_rev, hash, status, valid_from FROM memories WHERE id = ?', [s.id]);

    if (!cur) return false;
    if (
      cur.content_rev !== s.content_rev ||
      cur.hash !== s.hash ||
      cur.status !== s.status ||
      (cur.valid_from ?? null) !== (s.valid_from ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export interface ConsolidateClusterResult {
  success: boolean;
  clusterKey: string;
  candidateId?: string;
  error?: string;
}

/**
 * 整合单组记忆分量为一条程序性记忆 (procedural candidate)
 */
export async function consolidateCluster(
  db: Db,
  cfg: PluginConfig,
  cluster: MemoryCluster,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch; now?: number } = {}
): Promise<ConsolidateClusterResult> {
  const now = options.now ?? Date.now();

  // 1. 发送前校验源记录快照未发生变化
  if (!verifySnapshots(db, cluster.snapshots)) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: 'snapshots_changed_before_send',
    };
  }

  // 2. 组装输入与证据
  const evidenceLedger: EvidenceLedger = new Map();
  let currentSeq = 1;
  const itemBlocks: string[] = [];
  const evidenceLines: string[] = [];

  // 获取各记忆的 sources 实际 excerpt
  for (let i = 0; i < cluster.memories.length; i++) {
    const m = cluster.memories[i];
    itemBlocks.push(
      `--- item ${i + 1} ---
id: ${m.id}
type: ${m.type}
confidence: ${m.confidence}
utility: ${m.utility}
created: ${new Date(m.created_at).toISOString()}
valid_from: ${m.valid_from ? new Date(m.valid_from).toISOString() : 'none'}
text: ${m.content}`
    );

    const sources = db.all<{
      session_id: string;
      seq: number;
      kind: string;
      excerpt: string | null;
      created_at: number;
    }>(
      `SELECT session_id, seq, kind, excerpt, created_at
       FROM memory_sources
       WHERE memory_id = ? AND content_rev = ?`,
      [m.id, m.content_rev]
    );

    for (const src of sources) {
      const rawExcerpt = src.excerpt || m.summary || m.content.slice(0, 80);
      const excerpt = redactSecrets(rawExcerpt).text;
      const originKind =
        src.kind === 'tool_result' || src.kind === 'tool'
          ? 'tool'
          : src.kind === 'web'
            ? 'web'
            : src.kind === 'assistant_msg' || src.kind === 'assistant'
              ? 'assistant'
              : 'user';
      evidenceLines.push(`[E#${currentSeq}] (${src.session_id}#${src.seq}) ${excerpt}`);
      evidenceLedger.set(currentSeq, {
        seq: currentSeq,
        session_id: src.session_id,
        original_seq: src.seq,
        kind: src.kind,
        redacted_text: excerpt,
        origin_kinds: [originKind],
        time: src.created_at,
      });
      currentSeq++;
    }
  }

  if (evidenceLedger.size === 0) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: 'no_verifiable_evidence_found',
    };
  }

  const userPrompt = PROMPT_CONSOLIDATE.buildUser({
    cwd: cluster.workspaceId,
    clusterKey: cluster.clusterKey,
    n: cluster.memories.length,
    verifiedSuccessSummary: `${cluster.distinctSuccessfulSessions.length} independent successful sessions: ${cluster.distinctSuccessfulSessions.slice(0, 5).join(', ')}`,
    renderedItems: itemBlocks.join('\n\n'),
    evidenceTranscript: evidenceLines.join('\n'),
  });

  // 3. 调用离线 LLM
  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'consolidate',
      promptVersion: PROMPT_CONSOLIDATE.version,
      systemPrompt: PROMPT_CONSOLIDATE.system,
      userPrompt,
      maxOutputTokens: PROMPT_CONSOLIDATE.maxOutputTokens,
      cwd: cluster.workspaceId,
      workspaceId: cluster.workspaceId,
      signal: options.signal,
      fetchFn: options.fetchFn,
    },
    cfg
  );

  if (!llmRes.ok) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: llmRes.error,
    };
  }

  // 4. 解析输出
  const parseRes = parseOutput(llmRes.content, {
    taskKind: 'consolidate',
    evidenceLedger,
    workspaceId: cluster.workspaceId,
  });

  if (!parseRes.success) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: parseRes.error,
    };
  }

  if (parseRes.items.length === 0) {
    return {
      success: true,
      clusterKey: cluster.clusterKey,
    };
  }

  // 5. 提交前再次严格校验快照未发生变化
  if (!verifySnapshots(db, cluster.snapshots)) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: 'snapshots_changed_before_commit',
    };
  }

  // 6. 事务内写入 candidate 与 derived_from 关系
  let candidateId: string | undefined;

  db.transaction(() => {
    const candidateItem = parseRes.items[0];
    const upsertRes = upsertCandidate(db, candidateItem, now);
    if (!('id' in upsertRes)) {
      throw new Error(`upsert_failed: ${(upsertRes as any).reason}`);
    }
    candidateId = upsertRes.id;

    // 为每个源记录建立指向 candidate 的 derived_from 关系
    const snapshotMetadata = JSON.stringify({
      sources: cluster.snapshots.map(s => ({
        memory_id: s.id,
        content_rev: s.content_rev,
        hash: s.hash,
      })),
    });

    for (const s of cluster.snapshots) {
      db.run(
        `INSERT OR IGNORE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
         VALUES (?, ?, 'derived_from', ?, ?)`,
        [candidateId, s.id, snapshotMetadata, now]
      );
    }
  });

  return {
    success: true,
    clusterKey: cluster.clusterKey,
    candidateId,
  };
}
