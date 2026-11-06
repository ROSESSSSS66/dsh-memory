import type { Db, CandidateInput, MemoryRecord, ReconcileDecision, UpsertResult } from '../types.js';
import { tokenSet, jaccard, contentHash, extractEntities } from '../core/text.js';
import { scopeFilterSQL } from '../core/scope.js';
import { upsertCandidate, saveVersionSnapshot, addRelation, invalidateMemory } from '../core/writer.js';

const NEGATION_PATTERNS = [
  /不再使用/i,
  /废弃/i,
  /弃用/i,
  /禁用/i,
  /取消/i,
  /删除了/i,
  /已移除/i,
  /不再支持/i,
  /deprecated/i,
  /no longer (?:use|support|need)/i,
  /disabled/i,
  /removed/i,
  /uninstalled/i,
];

const EVOLUTION_PATTERNS = [
  /升级(?:到|为|至)/i,
  /从.+?(?:改|换|迁)为/i,
  /迁移(?:到|至)/i,
  /更新(?:到|为|至)/i,
  /替换(?:为|成了)/i,
  /upgraded? (?:to|into)/i,
  /migrated? (?:to|into)/i,
  /switched? (?:to|from)/i,
  /replaced? (?:with|by)/i,
];

/**
 * 启发式检测新记忆候选与现有记忆之间的冲突与演化关系 (汲取自 Mem0 Dynamic Reconciliation)
 * 决断动作为: ADD (全新事实) | UPDATE (事实升级取代) | DELETE (显式作废/推翻) | NOOP (已完全记录的冗余事实)
 */
export function reconcileCandidate(
  db: Db,
  candidate: CandidateInput,
  options?: { existingMemories?: MemoryRecord[] }
): ReconcileDecision {
  const rawContent = (candidate.content || '').trim();
  if (!rawContent) {
    return { action: 'NOOP', reason: 'empty_content', confidence: 1.0 };
  }

  const scope = candidate.scope || (candidate.type === 'preference' ? 'user' : 'workspace');
  let wsId: string | null = null;
  let sessId: string | null = null;
  if (scope === 'workspace') {
    wsId = candidate.workspaceId || null;
  } else if (scope === 'session') {
    wsId = candidate.workspaceId || null;
    sessId = candidate.sessionId || null;
  }

  // 1. 若候选包含明确 slot_key，优先根据 slot_key 调和
  if (candidate.slot_key) {
    const existingSlot = db.get<MemoryRecord>(
      `SELECT * FROM memories
       WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ?
         AND slot_key = ? AND status IN ('active', 'frozen')`,
      [scope, wsId || '', sessId || '', candidate.slot_key]
    );

    if (existingSlot) {
      const cHash = contentHash(candidate.type, rawContent);
      if (existingSlot.hash === cHash) {
        return {
          action: 'NOOP',
          targetId: existingSlot.id,
          reason: 'identical_slot_and_content',
          confidence: 1.0,
        };
      }

      // 检查是否含有否定/废除意图
      const isNegation = NEGATION_PATTERNS.some((p) => p.test(rawContent));
      if (isNegation) {
        return {
          action: 'DELETE',
          targetId: existingSlot.id,
          reason: 'slot_negated_or_deprecated',
          confidence: 0.95,
        };
      }

      return {
        action: 'UPDATE',
        targetId: existingSlot.id,
        reason: 'slot_value_evolved',
        confidence: 0.95,
      };
    }
  }

  // 2. 检索当前作用域内的相关候选记忆 (若未传入则自动查库)
  let candidateMemories = options?.existingMemories;
  if (!candidateMemories) {
    const scopeFilter = scopeFilterSQL({
      workspaceId: wsId || '',
      sessionId: sessId || undefined,
    });
    candidateMemories = db.all<MemoryRecord>(
      `SELECT * FROM memories
       WHERE ${scopeFilter.sql}
         AND status IN ('active', 'frozen')
         AND type != 'meta'
       ORDER BY updated_at DESC
       LIMIT 40`,
      scopeFilter.params
    );
  }

  const candTokens = tokenSet(rawContent);
  const candEntities = extractEntities(rawContent).map((e) => e.toLowerCase());

  let bestMatch: MemoryRecord | null = null;
  let maxJaccard = 0;

  for (const mem of candidateMemories) {
    const memTokens = tokenSet(mem.content + ' ' + (mem.summary || ''));
    const sim = jaccard(candTokens, memTokens);
    if (sim > maxJaccard) {
      maxJaccard = sim;
      bestMatch = mem;
    }
  }

  if (bestMatch) {
    // A: 极高相似度 (Jaccard >= 0.85)
    if (maxJaccard >= 0.85) {
      const isNegation = NEGATION_PATTERNS.some((p) => p.test(rawContent));
      if (isNegation) {
        return {
          action: 'DELETE',
          targetId: bestMatch.id,
          reason: 'near_duplicate_negation',
          confidence: 0.9,
        };
      }
      return {
        action: 'NOOP',
        targetId: bestMatch.id,
        reason: 'subsumed_by_existing_memory',
        confidence: maxJaccard,
      };
    }

    // B: 中高相似度 (Jaccard >= 0.45) 或共用核心实体
    const memContentLower = bestMatch.content.toLowerCase();
    const hasSharedEntity = candEntities.length > 0 && candEntities.some((ent) => memContentLower.includes(ent));

    if (maxJaccard >= 0.45 || hasSharedEntity) {
      const isEvolution = EVOLUTION_PATTERNS.some((p) => p.test(rawContent));
      if (isEvolution) {
        return {
          action: 'UPDATE',
          targetId: bestMatch.id,
          reason: 'semantic_evolution_detected',
          confidence: 0.85,
        };
      }

      const isNegation = NEGATION_PATTERNS.some((p) => p.test(rawContent));
      if (isNegation) {
        return {
          action: 'DELETE',
          targetId: bestMatch.id,
          reason: 'semantic_negation_detected',
          confidence: 0.85,
        };
      }
    }
  }

  // 3. 默认判定为全新正交知识
  return {
    action: 'ADD',
    reason: 'novel_knowledge_detected',
    confidence: 0.9,
  };
}

/**
 * 执行调和决策，原子应用至数据库 (支持 Mem0 四种调和行为)
 */
export function applyReconciliation(
  db: Db,
  candidate: CandidateInput,
  decision: ReconcileDecision,
  now: number = Date.now()
): UpsertResult {
  return db.transaction(() => {
    switch (decision.action) {
      case 'NOOP':
        return { action: 'merged', id: decision.targetId || 'noop_duplicate' };

      case 'DELETE': {
        if (decision.targetId) {
          invalidateMemory(db, decision.targetId, decision.reason, candidate.actor, now);
          return { action: 'superseded', id: decision.targetId, oldId: decision.targetId };
        }
        return { action: 'rejected', reason: 'delete_target_missing' };
      }

      case 'UPDATE': {
        if (decision.targetId) {
          const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [decision.targetId]);
          if (oldMem) {
            // 先将旧记忆归档并标记 superseded
            saveVersionSnapshot(db, oldMem, 'supersede', candidate.actor, now);
            db.run(
              `UPDATE memories
               SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ?
               WHERE id = ?`,
              [now, now, oldMem.id]
            );

            // 插入新记忆
            const insertRes = upsertCandidate(db, candidate, now);
            if ('id' in insertRes) {
              addRelation(db, insertRes.id, oldMem.id, 'supersedes', now);
              return { action: 'superseded', id: insertRes.id, oldId: oldMem.id };
            }
            return insertRes;
          }
        }
        return upsertCandidate(db, candidate, now);
      }

      case 'ADD':
      default:
        return upsertCandidate(db, candidate, now);
    }
  });
}

/**
 * 调和并写入：一步完成冲突/演化检测与智能持久化
 */
export function reconcileAndUpsert(
  db: Db,
  candidate: CandidateInput,
  now: number = Date.now()
): UpsertResult & { decision: ReconcileDecision } {
  const decision = reconcileCandidate(db, candidate);
  const res = applyReconciliation(db, candidate, decision, now);
  return { ...res, decision };
}
