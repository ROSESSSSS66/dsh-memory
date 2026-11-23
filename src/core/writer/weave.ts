import { DEFAULTS } from '../../config.js';
import type { Db, MemoryType, Scope } from '../../types.js';
import { extractEntities, jaccard, tokenSet } from '../text.js';
import { computeLocalEmbedding, cosineSimilarity, getOrComputeEmbedding } from '../vector.js';
import type { WriterLimits } from './validate.js';

interface WeaveCandidateRow {
  id: string;
  type: string;
  summary: string;
  content: string;
  slot_key: string | null;
  hash: string;
  embedding: Uint8Array | Buffer | null;
}

export interface WeaveInput {
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
  type: MemoryType;
  rawContent: string;
  rawSummary: string;
  slotKey: string | null;
  hash: string;
  entities?: string[];
}

export interface WeaveResult {
  relatedIds: string[];
  newVec: Float32Array;
}

/**
 * A-Mem (NeurIPS 2025) Zettelkasten 动态关联织网：
 * - 利用 ix_mem_weave(scope, workspace_id, status, utility DESC, updated_at DESC) 走索引查询，消除 COALESCE 全表扫描
 * - 批量从 memory_entities 加载候选实体，避免在 BEGIN IMMEDIATE 事务内重复执行 24 次正则抽取
 */
export function weaveRelatedMemoryIds(db: Db, input: WeaveInput, cfg?: WriterLimits): WeaveResult {
  const { scope, workspace_id, session_id, type, rawContent, rawSummary, slotKey, hash } = input;
  const dupJaccard = cfg?.dupJaccard ?? DEFAULTS.dupJaccard;

  const whereParts: string[] = ['scope = ?'];
  const params: unknown[] = [scope];

  if (workspace_id !== null) {
    whereParts.push('workspace_id = ?');
    params.push(workspace_id);
  } else {
    whereParts.push('workspace_id IS NULL');
  }

  whereParts.push("status IN ('active', 'candidate', 'frozen')");

  if (session_id !== null) {
    whereParts.push('session_id = ?');
    params.push(session_id);
  } else {
    whereParts.push('session_id IS NULL');
  }

  whereParts.push("type != 'meta'");
  whereParts.push("(slot_key IS NULL OR slot_key < 'core:' OR slot_key >= 'core;')");

  params.push(type);

  const candidatesInScope = db.all<WeaveCandidateRow>(
    `SELECT id, type, summary, content, slot_key, hash, embedding
     FROM memories
     WHERE ${whereParts.join(' AND ')}
     ORDER BY (CASE WHEN type = ? THEN 0 ELSE 1 END) ASC, utility DESC, updated_at DESC
     LIMIT 24`,
    params
  );

  const newTokens = tokenSet(rawContent);
  const newVec = computeLocalEmbedding(
    `${rawSummary}\n${rawContent}${slotKey ? `\n${slotKey}` : ''}`
  );

  if (candidatesInScope.length === 0) {
    return { relatedIds: [], newVec };
  }

  const newEntList = (
    input.entities && input.entities.length > 0
      ? input.entities
      : extractEntities(`${rawSummary} ${rawContent}`)
  )
    .map((e) => e.toLowerCase().replace(/\\/g, '/').trim())
    .filter(Boolean);
  const newEntSet = new Set(newEntList);

  // 批量查询候选记忆在 memory_entities 中的已抽取实体，避免循环内重复跑正则
  const candEntMap = new Map<string, Set<string>>();
  if (newEntSet.size > 0) {
    const placeholders = candidatesInScope.map(() => '?').join(', ');
    const entRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      candidatesInScope.map((r) => r.id)
    );
    for (const row of entRows) {
      let set = candEntMap.get(row.memory_id);
      if (!set) {
        set = new Set<string>();
        candEntMap.set(row.memory_id, set);
      }
      set.add(row.entity);
    }
  }

  const scoredRelations: Array<{ id: string; affinity: number }> = [];
  for (const cand of candidatesInScope) {
    if (cand.hash === hash) continue;
    if (slotKey && cand.slot_key && cand.slot_key === slotKey) continue;

    const jaccardSim = jaccard(newTokens, tokenSet(cand.content));
    const candVec = getOrComputeEmbedding(cand, db);
    const vecSim = candVec ? Math.max(0, cosineSimilarity(newVec, candVec)) : 0;

    let sharedEnts = 0;
    if (newEntSet.size > 0) {
      const candEnts = candEntMap.get(cand.id);
      if (candEnts) {
        for (const ce of candEnts) {
          if (newEntSet.has(ce)) sharedEnts++;
        }
      }
    }

    const entBonus = Math.min(1, sharedEnts / 2);
    const affinity = 0.45 * vecSim + 0.35 * jaccardSim + 0.2 * entBonus;

    if (jaccardSim >= dupJaccard || affinity >= 0.48 || (sharedEnts >= 2 && vecSim >= 0.42)) {
      scoredRelations.push({ id: cand.id, affinity: Math.max(jaccardSim, affinity) });
    }
  }

  scoredRelations.sort((a, b) => b.affinity - a.affinity || a.id.localeCompare(b.id));
  const relatedIds = scoredRelations.slice(0, 3).map((r) => r.id);

  return { relatedIds, newVec };
}
