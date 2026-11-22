import { createHash } from 'node:crypto';
import { hydrateMemoryRow, type Db, type MemoryRecord, type MemoryRow } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { EvidenceLedger } from './types.js';
import { tokenSet, jaccard, extractEntities } from '../core/text.js';
import { redactSecrets, memoryWorkspaceIds, canSendMemoriesOffline } from '../core/privacy.js';
import { workspaceId as normalizeWsId, resolveWorkspaceCwd } from '../core/scope.js';
import { sourceKindToOriginKind } from '../core/trust.js';
import { PROMPT_CONSOLIDATE, packPromptWithinBudget } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import { upsertCandidate } from '../core/writer.js';

const MAX_CLUSTER_RECORDS = 500;
const MAX_SINGLE_CLUSTER_SIZE = 10;

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
 * 在 workspace 内对 active 且非负效用的 episodic/failure 记忆聚类并计算有界连通分量
 * 聚类条件：utility >= 0.5、共享 >= 1 个实体 且 Jaccard >= 0.35；单聚类上限 10 条防止无界单链。
 */
export function findConsolidationClusters(
  db: Db,
  workspaceId: string,
  cfg: PluginConfig
): MemoryCluster[] {
  const wsId = normalizeWsId(workspaceId);
  // 只聚类最近的 MAX_CLUSTER_RECORDS 条非负效用记录，保证单次计算有界
  const records = db
    .all<MemoryRow>(
      `SELECT * FROM (
         SELECT * FROM memories
         WHERE scope = 'workspace' AND workspace_id = ?
           AND status = 'active'
           AND type IN ('episodic', 'failure')
           AND utility >= 0.5
         ORDER BY created_at DESC
         LIMIT ${MAX_CLUSTER_RECORDS}
       ) ORDER BY created_at ASC`,
      [wsId]
    )
    .map((r) => hydrateMemoryRow(r));

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

  // 2. 建图并寻找有界连通分量 (BFS，单聚类上限 MAX_SINGLE_CLUSTER_SIZE = 10)
  const adj = new Map<string, string[]>();
  const recordById = new Map<string, MemoryRecord>();
  for (const m of records) {
    adj.set(m.id, []);
    recordById.set(m.id, m);
  }

  // 实体倒排索引：只比较共享至少 1 个实体的记录对，避免对全部记录做两两比较
  const entityIndex = new Map<string, number[]>();
  for (let i = 0; i < records.length; i++) {
    for (const entity of new Set(recordEntities.get(records[i].id)!)) {
      const bucket = entityIndex.get(entity);
      if (bucket) bucket.push(i);
      else entityIndex.set(entity, [i]);
    }
  }

  const compared = new Set<number>();
  for (const bucket of entityIndex.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = a + 1; b < bucket.length; b++) {
        const pairKey = bucket[a] * records.length + bucket[b];
        if (compared.has(pairKey)) continue;
        compared.add(pairKey);

        const m1 = records[bucket[a]];
        const m2 = records[bucket[b]];
        // Jaccard 相似度必须 >= 0.35
        const sim = jaccard(recordTokens.get(m1.id)!, recordTokens.get(m2.id)!);
        if (sim >= 0.35) {
          adj.get(m1.id)!.push(m2.id);
          adj.get(m2.id)!.push(m1.id);
        }
      }
    }
  }

  const assigned = new Set<string>();
  const rawClusters: MemoryRecord[][] = [];

  for (const m of records) {
    if (assigned.has(m.id)) continue;

    const component: MemoryRecord[] = [];
    const queue: string[] = [m.id];
    const inQueue = new Set<string>([m.id]);

    while (queue.length > 0 && component.length < MAX_SINGLE_CLUSTER_SIZE) {
      const currId = queue.shift()!;
      if (assigned.has(currId)) continue;
      assigned.add(currId);
      const currMem = recordById.get(currId)!;
      component.push(currMem);

      if (component.length >= MAX_SINGLE_CLUSTER_SIZE) break;

      for (const neighborId of adj.get(currId) || []) {
        if (!assigned.has(neighborId) && !inQueue.has(neighborId)) {
          inQueue.add(neighborId);
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
    const memIds = comp.map((r) => r.id);
    const placeholders = memIds.map(() => '?').join(',');
    const sessionRows = db.all<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM injections
       WHERE memory_id IN (${placeholders})
         AND used = 1 AND outcome > 0.5`,
      memIds
    );

    const distinctSessions = sessionRows.map((r) => r.session_id);

    // 必须满足至少 3 个独立 session
    if (distinctSessions.length < 3) {
      continue;
    }

    // 仅统计存活的非 Hindsight 启发式模型衍生关系，防止 hindsight.model.* 饿死 LLM 规程整合
    const alreadyDerived = db.get<{ cnt: number }>(
      `SELECT COUNT(DISTINCT r.to_id) as cnt
       FROM memory_relations r
       JOIN memories p ON p.id = r.from_id
       WHERE r.rel = 'derived_from'
         AND r.to_id IN (${placeholders})
         AND p.status IN ('active', 'candidate', 'frozen')
         AND COALESCE(p.slot_key, '') NOT LIKE 'hindsight.model.%'`,
      memIds
    );
    if ((alreadyDerived?.cnt ?? 0) >= memIds.length) {
      continue;
    }

    // 冻结源记录快照
    const snapshots: SourceSnapshot[] = comp.map((r) => ({
      id: r.id,
      content_rev: r.content_rev,
      hash: r.hash,
      content: r.content,
      summary: r.summary,
      status: r.status,
      valid_from: r.valid_from ?? null,
    }));

    const sortedIds = [...memIds].sort();
    const idsHash = createHash('sha256').update(sortedIds.join(',')).digest('hex').slice(0, 16);
    const clusterKey = `cluster:${wsId}:${idsHash}`;

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

interface ConsolidateUnit {
  memory: MemoryRecord;
  snapshot: SourceSnapshot;
  renderedItem: string;
  sources: Array<{
    session_id: string;
    seq: number;
    kind: string;
    excerpt: string;
    created_at: number;
  }>;
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
  if (!canSendMemoriesOffline(db, cluster.memories, cfg.excludeWorkspaces)) {
    return { success: false, clusterKey: cluster.clusterKey, error: 'workspace_excluded' };
  }

  // 1. 发送前校验源记录快照未发生变化
  if (!verifySnapshots(db, cluster.snapshots)) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: 'snapshots_changed_before_send',
    };
  }

  // 2. 收集各记忆块及其脱敏证据，按统一输入预算打包
  const units: ConsolidateUnit[] = [];
  for (let i = 0; i < cluster.memories.length; i++) {
    const m = cluster.memories[i];
    const snap = cluster.snapshots[i] ?? {
      id: m.id,
      content_rev: m.content_rev,
      hash: m.hash,
      content: m.content,
      summary: m.summary,
      status: m.status,
      valid_from: m.valid_from ?? null,
    };

    const srcRows = db.all<{
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

    const sanitizedSources = srcRows.map((src) => {
      const rawExcerpt = src.excerpt || m.summary || m.content.slice(0, 80);
      return {
        session_id: src.session_id,
        seq: src.seq,
        kind: src.kind,
        excerpt: redactSecrets(rawExcerpt).text,
        created_at: src.created_at,
      };
    });

    units.push({
      memory: m,
      snapshot: snap,
      renderedItem: `--- item ${i + 1} ---
id: ${m.id}
type: ${m.type}
confidence: ${m.confidence}
utility: ${m.utility}
created: ${new Date(m.created_at).toISOString()}
valid_from: ${m.valid_from ? new Date(m.valid_from).toISOString() : 'none'}
text: ${m.content}`,
      sources: sanitizedSources,
    });
  }

  const verifiedSuccessSummary = `${cluster.distinctSuccessfulSessions.length} independent successful sessions: ${cluster.distinctSuccessfulSessions.slice(0, 5).join(', ')}`;

  const renderUnits = (
    selectedUnits: ConsolidateUnit[],
    ledgerOut?: EvidenceLedger
  ): { renderedItems: string; evidenceTranscript: string } => {
    const itemBlocks: string[] = [];
    const evidenceLines: string[] = [];
    let currentSeq = 1;

    for (const u of selectedUnits) {
      itemBlocks.push(u.renderedItem);
      for (const src of u.sources) {
        const line = `[E#${currentSeq}] (${src.session_id}#${src.seq}) ${src.excerpt}`;
        evidenceLines.push(line);
        if (ledgerOut) {
          ledgerOut.set(currentSeq, {
            seq: currentSeq,
            session_id: src.session_id,
            original_seq: src.seq,
            kind: src.kind,
            redacted_text: src.excerpt,
            rendered_line: line,
            origin_kinds: [sourceKindToOriginKind(src.kind)],
            time: src.created_at,
          });
        }
        currentSeq++;
      }
    }

    return {
      renderedItems: itemBlocks.join('\n\n'),
      evidenceTranscript: evidenceLines.join('\n'),
    };
  };

  const maxInputTokens = cfg.distillMaxInputTokens || 6000;
  const packed = packPromptWithinBudget(
    PROMPT_CONSOLIDATE.system,
    (selectedUnits) => {
      const rendered = renderUnits(selectedUnits);
      return PROMPT_CONSOLIDATE.buildUser({
        cwd: cluster.workspaceId,
        clusterKey: cluster.clusterKey,
        n: selectedUnits.length,
        verifiedSuccessSummary,
        renderedItems: rendered.renderedItems,
        evidenceTranscript: rendered.evidenceTranscript,
      });
    },
    units,
    maxInputTokens,
    250
  );

  const selectedUnits = packed.selected;
  const evidenceLedger: EvidenceLedger = new Map();
  const finalRendered = renderUnits(selectedUnits, evidenceLedger);

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
    n: selectedUnits.length,
    verifiedSuccessSummary,
    renderedItems: finalRendered.renderedItems,
    evidenceTranscript: finalRendered.evidenceTranscript,
  });

  // 使用不含随机 XML nonce 的规范输入计算去重指纹，确保 noop 缓存稳定命中
  const noopKey = `consolidate:noop:${createHash('sha256').update(cluster.clusterKey).digest('hex').slice(0, 32)}`;
  const fingerprint = createHash('sha256')
    .update(
      `${PROMPT_CONSOLIDATE.version}\n${cluster.clusterKey}\n${finalRendered.renderedItems}\n${finalRendered.evidenceTranscript}`
    )
    .digest('hex');
  if (db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [noopKey])?.value === fingerprint) {
    return { success: true, clusterKey: cluster.clusterKey };
  }

  // 3. 调用离线 LLM（通过 resolveWorkspaceCwd 获取真实路径用于脱敏）
  const realCwd = resolveWorkspaceCwd(db, cluster.workspaceId) || '';
  const selectedMemories = selectedUnits.map((u) => u.memory);
  const selectedSnapshots = selectedUnits.map((u) => u.snapshot);

  const llmRes = await callOfflineLLM(
    db,
    {
      jobKind: 'consolidate',
      promptVersion: PROMPT_CONSOLIDATE.version,
      systemPrompt: PROMPT_CONSOLIDATE.system,
      userPrompt,
      maxOutputTokens: PROMPT_CONSOLIDATE.maxOutputTokens,
      cwd: realCwd,
      workspaceId: cluster.workspaceId,
      dataWorkspaceIds: memoryWorkspaceIds(db, selectedMemories),
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
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [noopKey, fingerprint]
    );
    return {
      success: true,
      clusterKey: cluster.clusterKey,
    };
  }

  // 5. 在同一写事务内原子校验源快照并写入 candidate 与 derived_from 关系，消除 TOCTOU 窗口
  let candidateId: string | undefined;
  let snapshotsChanged = false;

  try {
    db.transaction(() => {
      if (!verifySnapshots(db, selectedSnapshots)) {
        snapshotsChanged = true;
        return;
      }

      const candidateItem = parseRes.items[0];
      const upsertRes = upsertCandidate(db, candidateItem, now);
      if (!('id' in upsertRes)) {
        throw new Error(`upsert_failed: ${(upsertRes as any).reason}`);
      }
      candidateId = upsertRes.id;

      // 为每个源记录建立指向 candidate 的 derived_from 关系
      const snapshotMetadata = JSON.stringify({
        sources: selectedSnapshots.map((s) => ({
          memory_id: s.id,
          content_rev: s.content_rev,
          hash: s.hash,
        })),
      });

      for (const s of selectedSnapshots) {
        db.run(
          `INSERT OR IGNORE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
           VALUES (?, ?, 'derived_from', ?, ?)`,
          [candidateId, s.id, snapshotMetadata, now]
        );
      }
    });
  } catch (err: any) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: `transaction_failed: ${err?.message || err}`,
    };
  }

  if (snapshotsChanged) {
    return {
      success: false,
      clusterKey: cluster.clusterKey,
      error: 'snapshots_changed_before_commit',
    };
  }

  return {
    success: true,
    clusterKey: cluster.clusterKey,
    candidateId,
  };
}
