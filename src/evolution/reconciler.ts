import {
  hydrateMemoryRow,
  type Db,
  type CandidateInput,
  type MemoryRecord,
  type MemoryRow,
  type ReconcileDecision,
  type Scope,
  type UpsertResult,
} from '../types.js';
import { tokenSet, jaccard, contentHash, extractEntities, segment } from '../core/text.js';
import { scopeFilterSQL, workspaceId as resolveWorkspaceId } from '../core/scope.js';
import { upsertCandidate, saveVersionSnapshot, addRelation, invalidateMemory } from '../core/writer.js';
import { resolveFixedSlot } from '../ingest/rules.js';
import {
  computeLocalEmbedding,
  cosineSimilarity,
  getOrComputeEmbedding,
  removeCachedRuntimeEmbedding,
} from '../core/vector.js';
import { hasUntrustedOrigin, isUntrustedSourceKind } from '../core/trust.js';
import { sameMemoryOwner } from './review-snapshot.js';

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
  /切换(?:为|到|至)/i,
  /调整(?:为|到|至)/i,
  /改(?:用|为|成)/i,
  /换(?:为|用|成)/i,
  /upgraded? (?:to|into)/i,
  /migrated? (?:to|into)/i,
  /switched? (?:to|from)/i,
  /replaced? (?:with|by)/i,
];

function matchesExplicitTransitionSource(candidateText: string, oldContentLower: string): boolean {
  const zhFrom = candidateText.match(
    /从\s*([^\s,，。；;]{2,30}(?:\s+[a-z0-9._-]{1,12})?)\s*(?:改|换|迁|切换|升级|替换)/i
  );
  if (zhFrom) {
    const src = zhFrom[1].trim().toLowerCase();
    if (src.length >= 3 && oldContentLower.includes(src)) return true;
  }
  const enFrom = candidateText.match(
    /\b(?:migrated?|switched?|upgraded?|moved?|replaced?)\s+(?:from\s+)?([a-z0-9_./-]{3,30}(?:\s+[0-9]+(?:\.[0-9]+)*)?)\s+(?:to|into|with|by)\b/i
  );
  if (enFrom) {
    const src = enFrom[1].trim().toLowerCase();
    if (src.length >= 3 && oldContentLower.includes(src)) return true;
  }
  return false;
}

class ReconcileSavepointAbort extends Error {
  constructor(public readonly result: UpsertResult) {
    super('reconcile_savepoint_abort');
  }
}

function resolveCandidateOwner(candidate: CandidateInput): {
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
} {
  const scope: Scope = candidate.scope || (candidate.type === 'preference' ? 'user' : 'workspace');
  let workspace_id: string | null = null;
  let session_id: string | null = null;
  if (scope === 'workspace') {
    workspace_id = candidate.workspaceId ? resolveWorkspaceId(candidate.workspaceId) : null;
  } else if (scope === 'session') {
    workspace_id = candidate.workspaceId ? resolveWorkspaceId(candidate.workspaceId) : null;
    session_id = candidate.sessionId || null;
  }
  return { scope, workspace_id, session_id };
}

function buildSafeFtsOrQuery(text: string): string | null {
  const tokens = Array.from(new Set(segment(text)))
    .filter((t) => t.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  const escaped = tokens
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length >= 2)
    .map((t) => `"${t}"`);
  return escaped.length > 0 ? escaped.join(' OR ') : null;
}

/**
 * 结合实体倒排、FTS5 全文索引与近期记录召回待调和候选记忆，避免盲扫 LIMIT 40 漏掉旧记忆。
 */
function fetchReconcileCandidates(
  db: Db,
  rawContent: string,
  candEntities: string[],
  wsId: string | null,
  sessId: string | null
): MemoryRecord[] {
  const scopeFilter = scopeFilterSQL(
    {
      workspaceId: wsId || '',
      sessionId: sessId || undefined,
    },
    'm'
  );

  const byId = new Map<string, MemoryRecord>();
  const addRows = (rows: MemoryRow[]) => {
    for (const r of rows) {
      if (!byId.has(r.id)) {
        byId.set(r.id, hydrateMemoryRow(r));
      }
    }
  };

  // 1. 实体倒排精确召回
  if (candEntities.length > 0) {
    const uniqueEnts = Array.from(new Set(candEntities)).slice(0, 12);
    const placeholders = uniqueEnts.map(() => '?').join(',');
    const entityRows = db.all<MemoryRow>(
      `SELECT DISTINCT m.*
       FROM memories m
       JOIN memory_entities e ON e.memory_id = m.id
       WHERE e.entity IN (${placeholders})
         AND ${scopeFilter.sql}
         AND m.status IN ('active', 'frozen')
         AND m.type != 'meta'
       ORDER BY m.updated_at DESC
       LIMIT 30`,
      [...uniqueEnts, ...scopeFilter.params]
    );
    addRows(entityRows);
  }

  // 2. FTS5 全文召回
  const ftsQuery = buildSafeFtsOrQuery(rawContent);
  if (ftsQuery) {
    try {
      const ftsRows = db.all<MemoryRow>(
        `SELECT m.*
         FROM memory_fts f
         JOIN memories m ON m.rowid_ = f.rowid
         WHERE memory_fts MATCH ?
           AND ${scopeFilter.sql}
           AND m.status IN ('active', 'frozen')
           AND m.type != 'meta'
         ORDER BY bm25(memory_fts) ASC
         LIMIT 30`,
        [ftsQuery, ...scopeFilter.params]
      );
      addRows(ftsRows);
    } catch {
      // FTS 查询语法异常时静默回退至近期记录
    }
  }

  // 3. 补充近期活跃记忆（覆盖短文本/无实体场景）
  const recentRows = db.all<MemoryRow>(
    `SELECT m.*
     FROM memories m
     WHERE ${scopeFilter.sql}
       AND m.status IN ('active', 'frozen')
       AND m.type != 'meta'
     ORDER BY m.updated_at DESC
     LIMIT 20`,
    scopeFilter.params
  );
  addRows(recentRows);

  return Array.from(byId.values());
}

/**
 * 启发式检测新记忆候选与现有记忆之间的冲突与演化关系 (汲取自 Mem0 Dynamic Reconciliation)
 * 决断动作为: ADD (全新事实) | UPDATE (事实升级取代) | DELETE (显式作废/推翻) | NOOP (已完全记录的冗余事实)
 * 纯函数原则：绝不原地修改调用方传入的 candidate 对象（包括 candidate.slot_key）。
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

  const owner = resolveCandidateOwner(candidate);
  const { scope, workspace_id: wsId, session_id: sessId } = owner;

  // 1. 若候选包含明确 slot_key 或可通过规范槽位推演命中，优先根据 slot_key 调和（不原地修改 candidate.slot_key）
  const inferredSlot = candidate.slot_key ? null : resolveFixedSlot(rawContent);
  const effectiveSlotKey = candidate.slot_key || inferredSlot?.slotKey || null;

  if (effectiveSlotKey) {
    const existingSlot = hydrateMemoryRow(
      db.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ?
           AND slot_key = ? AND status IN ('active', 'frozen')`,
        [scope, wsId || '', sessId || '', effectiveSlotKey]
      )
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

  // 2. 通过实体倒排 + FTS5 + 近期记忆召回当前作用域内的相关候选记忆
  const candTokens = tokenSet(rawContent);
  const candEntities = extractEntities(rawContent).map((e) => e.toLowerCase());
  const candVec = computeLocalEmbedding(rawContent);

  const candidateMemories =
    options?.existingMemories ?? fetchReconcileCandidates(db, rawContent, candEntities, wsId, sessId);

  let bestDupMatch: MemoryRecord | null = null;
  let maxDupJaccard = 0;
  let maxDupHybridSim = 0;
  let bestDupScore = 0;

  let bestMutableMatch: MemoryRecord | null = null;
  let maxMutJaccard = 0;
  let maxMutHybridSim = 0;
  let bestMutScore = 0;

  const ownerStub = {
    scope,
    workspace_id: wsId,
    session_id: sessId,
  } as MemoryRecord;

  for (const mem of candidateMemories) {
    const memText = mem.content + ' ' + (mem.summary || '');
    const memTokens = tokenSet(memText);
    const jacSim = jaccard(candTokens, memTokens);
    const memVec = getOrComputeEmbedding(mem, db) ?? computeLocalEmbedding(memText);
    const vecSim = cosineSimilarity(candVec, memVec);
    const hybridSim = 0.55 * jacSim + 0.45 * vecSim;
    const combinedScore = Math.max(hybridSim, jacSim);

    if (combinedScore > bestDupScore) {
      bestDupScore = combinedScore;
      bestDupMatch = mem;
      maxDupHybridSim = hybridSim;
      maxDupJaccard = jacSim;
    }

    // 启发式 UPDATE/DELETE 仅允许匹配同归属且未置顶/未冻结的记忆
    if (mem.pinned === 0 && mem.status === 'active' && sameMemoryOwner(mem, ownerStub)) {
      if (combinedScore > bestMutScore) {
        bestMutScore = combinedScore;
        bestMutableMatch = mem;
        maxMutHybridSim = hybridSim;
        maxMutJaccard = jacSim;
      }
    }
  }

  const isNegation = NEGATION_PATTERNS.some((p) => p.test(rawContent));
  const isEvolution = EVOLUTION_PATTERNS.some((p) => p.test(rawContent));

  // A: 极高相似度 (Jaccard >= 0.85 或 Hybrid >= 0.88)
  if (bestDupMatch && (maxDupJaccard >= 0.85 || maxDupHybridSim >= 0.88)) {
    if (isNegation) {
      if (bestDupMatch.pinned === 0 && bestDupMatch.status === 'active' && sameMemoryOwner(bestDupMatch, ownerStub)) {
        return {
          action: 'DELETE',
          targetId: bestDupMatch.id,
          reason: 'near_duplicate_negation',
          confidence: 0.9,
        };
      }
    } else {
      return {
        action: 'NOOP',
        targetId: bestDupMatch.id,
        reason: 'subsumed_by_existing_memory',
        confidence: Math.max(maxDupJaccard, maxDupHybridSim),
      };
    }
  }

  // B: 启发式演化/否定检测：
  // - 常规启发式 UPDATE/DELETE（含共享实体）必须满足最低相似度门槛 (maxJaccard >= 0.30 || maxHybridSim >= 0.40)
  // - 显式指明旧主体迁移的句式（如 "从 Express 4 迁移到 Fastify 5" 且旧记忆包含该主体）允许在话题锚点相似度 >= 0.22/0.30 时触发
  if (bestMutableMatch) {
    const memContentLower = bestMutableMatch.content.toLowerCase();
    const hasSharedEntity =
      candEntities.length > 0 && candEntities.some((ent) => memContentLower.includes(ent));
    const meetsMinSimilarity = maxMutJaccard >= 0.3 || maxMutHybridSim >= 0.4;
    const hasExplicitFromTarget =
      isEvolution &&
      (maxMutJaccard >= 0.22 || maxMutHybridSim >= 0.3) &&
      matchesExplicitTransitionSource(rawContent, memContentLower);

    if (
      maxMutJaccard >= 0.42 ||
      maxMutHybridSim >= 0.48 ||
      ((hasSharedEntity || isEvolution || isNegation) && meetsMinSimilarity) ||
      hasExplicitFromTarget
    ) {
      if (isEvolution) {
        return {
          action: 'UPDATE',
          targetId: bestMutableMatch.id,
          reason: 'semantic_evolution_detected',
          confidence: 0.85,
        };
      }

      if (isNegation) {
        return {
          action: 'DELETE',
          targetId: bestMutableMatch.id,
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
 * 与 upsertCandidate 的 isExplicitUser 判定保持一致：只有这类输入才会直接以 active 落盘。
 * 非可信输入（模型/工具/网页来源，含 sources 内携带 tool/web 污点）不得直接归档或取代现有记忆，
 * 只能以 candidate + contradicts 关系等待审批，防止提示注入通过 reconcile 清除或覆盖用户的有效记忆。
 */
function isTrustedReconcileInput(c: CandidateInput): boolean {
  if (hasUntrustedOrigin({ origin_kinds: c.origin_kinds, source_kind: c.source_kind })) {
    return false;
  }
  if (Array.isArray(c.sources) && c.sources.some((s) => isUntrustedSourceKind(s.kind))) {
    return false;
  }
  return (
    (c.source_kind === 'user' && c.actor === 'user') ||
    (c.status === 'active' && (c.actor === 'user' || c.actor === 'system'))
  );
}

function insertAsPendingConflict(
  db: Db,
  candidate: CandidateInput,
  targetId: string,
  now: number
): UpsertResult {
  const insertRes = upsertCandidate(db, { ...candidate, status: 'candidate' }, now);
  if ('id' in insertRes && insertRes.id !== targetId) {
    addRelation(db, insertRes.id, targetId, 'contradicts', now);
    return { action: 'conflict_pending', id: insertRes.id, withId: targetId };
  }
  return insertRes;
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
  // 推演规范槽位时使用浅拷贝，绝不原地修改调用方的 candidate
  const rawContent = (candidate.content || '').trim();
  const inferredSlotKey = !candidate.slot_key && rawContent ? resolveFixedSlot(rawContent).slotKey : null;
  const effectiveCandidate: CandidateInput =
    inferredSlotKey && !candidate.slot_key
      ? { ...candidate, slot_key: inferredSlotKey }
      : candidate;

  const owner = resolveCandidateOwner(effectiveCandidate);
  const ownerStub = owner as MemoryRecord;

  return db.transaction(() => {
    const trusted = isTrustedReconcileInput(effectiveCandidate);
    switch (decision.action) {
      case 'NOOP': {
        if (!decision.targetId) {
          return { action: 'rejected', reason: decision.reason || 'noop_without_target' };
        }
        return { action: 'merged', id: decision.targetId };
      }

      case 'DELETE': {
        if (!decision.targetId) {
          return { action: 'rejected', reason: 'delete_target_missing' };
        }
        const target = hydrateMemoryRow(
          db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [decision.targetId])
        );
        if (!target) {
          return { action: 'rejected', reason: 'delete_target_missing' };
        }
        if (target.status === 'frozen') {
          return { action: 'rejected', reason: 'target_is_frozen' };
        }
        if (target.pinned !== 0) {
          return { action: 'rejected', reason: 'target_is_pinned' };
        }
        if (!sameMemoryOwner(target, ownerStub)) {
          return { action: 'rejected', reason: 'owner_mismatch' };
        }
        if (!trusted) {
          return insertAsPendingConflict(db, effectiveCandidate, decision.targetId, now);
        }
        invalidateMemory(db, decision.targetId, decision.reason, effectiveCandidate.actor, now);
        return { action: 'superseded', id: decision.targetId, oldId: decision.targetId };
      }

      case 'UPDATE': {
        if (decision.targetId) {
          const oldMem = hydrateMemoryRow(
            db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [decision.targetId])
          );
          if (oldMem) {
            if (oldMem.status === 'frozen') {
              return { action: 'rejected', reason: 'target_is_frozen' };
            }
            if (oldMem.pinned !== 0) {
              return { action: 'rejected', reason: 'target_is_pinned' };
            }
            if (!sameMemoryOwner(oldMem, ownerStub)) {
              return { action: 'rejected', reason: 'owner_mismatch' };
            }
            if (!trusted) {
              // 非可信输入只会生成 candidate：此时若先取代旧记忆，会让有效知识在候选审批前“消失”
              return insertAsPendingConflict(db, effectiveCandidate, oldMem.id, now);
            }

            // 使用嵌套 SAVEPOINT 事务保证失败时连同版本快照、invalidated_at 与向量缓存回调一起原子回滚
            try {
              return db.transaction((): UpsertResult => {
                saveVersionSnapshot(db, oldMem, 'supersede', effectiveCandidate.actor, now);
                db.run(
                  `UPDATE memories
                   SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
                   WHERE id = ?`,
                  [now, now, now, oldMem.id]
                );
                db.afterCommit(() => removeCachedRuntimeEmbedding(oldMem.id, db));

                const insertRes = upsertCandidate(db, effectiveCandidate, now);
                if ('id' in insertRes) {
                  addRelation(db, insertRes.id, oldMem.id, 'supersedes', now);
                  return { action: 'superseded', id: insertRes.id, oldId: oldMem.id };
                }
                throw new ReconcileSavepointAbort(insertRes);
              });
            } catch (err) {
              if (err instanceof ReconcileSavepointAbort) {
                return err.result;
              }
              throw err;
            }
          }
        }
        return upsertCandidate(db, effectiveCandidate, now);
      }

      case 'ADD':
      default:
        return upsertCandidate(db, effectiveCandidate, now);
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
