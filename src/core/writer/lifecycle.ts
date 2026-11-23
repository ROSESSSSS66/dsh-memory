import { DEFAULTS } from '../../config.js';
import {
  type Db,
  hydrateMemoryRow,
  type MemoryRecord,
  type MemoryRow,
  type MemoryType,
  type OriginKind,
  parseOriginKinds,
  type Scope,
} from '../../types.js';
import { redactSecrets } from '../privacy.js';
import { workspaceId } from '../scope.js';
import { contentHash, extractEntities, ftsText } from '../text.js';
import { estimateTokens } from '../tokens.js';
import { hasUntrustedOrigin, hasUserEvidence } from '../trust.js';
import { computeLocalEmbedding, decodeEmbeddingBlob, encodeEmbeddingBlob } from '../vector.js';
import {
  findActiveSlotOccupant,
  saveVersionSnapshot,
  schedulePrimeVectorCache,
  scheduleRemoveVectorCache,
  scheduleReplaceVectorCache,
  supersedeActiveSlot,
} from './slot-policy.js';
import { firstSentence, truncateExcerpt, truncateToTokens, type WriterLimits } from './validate.js';

const VALID_MEMORY_TYPES = new Set<MemoryType>([
  'episodic',
  'semantic',
  'procedural',
  'belief',
  'preference',
  'goal',
  'failure',
  'meta',
]);

const VALID_SCOPES = new Set<Scope>(['session', 'workspace', 'user', 'global']);

export interface EditMemoryPatch {
  content?: string;
  summary?: string;
  type?: MemoryType;
  scope?: Scope;
  workspaceId?: string | null;
  sessionId?: string | null;
  slot_key?: string | null;
  importance?: number;
}

export interface EditMemoryResult {
  ok: true;
  version: number;
  content_rev: number;
  supersededId?: string;
  memory: MemoryRecord;
}

function loadMemory(db: Db, id: string): MemoryRecord | undefined {
  return hydrateMemoryRow(db.get<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, [id]));
}

function hasPendingRepairProposal(db: Db, memoryId: string): boolean {
  return Boolean(
    db.get(
      `SELECT 1 FROM repair_proposals
       WHERE status = 'candidate'
         AND (
           memory_id = ?
           OR (json_valid(candidate_ids) AND EXISTS (SELECT 1 FROM json_each(candidate_ids) WHERE value = ?))
         )
       LIMIT 1`,
      [memoryId, memoryId]
    )
  );
}

function rebuildFtsAndEntities(
  db: Db,
  id: string,
  rowid: number,
  content: string,
  summary: string
): void {
  db.run(`DELETE FROM memory_fts WHERE rowid = ?`, [rowid]);
  db.run(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`, [
    rowid,
    ftsText(content + ' ' + summary),
  ]);

  db.run(`DELETE FROM memory_entities WHERE memory_id = ?`, [id]);
  const entities = extractEntities(`${summary} ${content}`);
  for (const ent of entities) {
    const normEnt = ent.toLowerCase().replace(/\\/g, '/').trim();
    if (normEnt) {
      db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [
        id,
        normEnt,
      ]);
    }
  }
}

/**
 * 批准候选记忆
 */
export function approveCandidate(
  db: Db,
  id: string,
  approvedBy: string = 'user',
  now: number = Date.now()
):
  | { action: 'approved'; id: string }
  | { action: 'superseded'; id: string; oldId: string }
  | { action: 'rejected'; reason: string } {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) {
      return { action: 'rejected', reason: 'not_found' };
    }
    if (memory.status !== 'candidate') {
      return { action: 'rejected', reason: `invalid_status_${memory.status}` };
    }
    const isTrustedApprover = approvedBy === 'user' || approvedBy === 'system';
    if (!isTrustedApprover && !hasUserEvidence(db, memory)) {
      return { action: 'rejected', reason: 'user_evidence_required' };
    }
    // 核心块会被自动置顶并常驻系统提示词，自动审批方不得凭一段用户引用写入或替换
    if (!isTrustedApprover && memory.slot_key?.startsWith('core:')) {
      return { action: 'rejected', reason: 'core_block_requires_user_approval' };
    }

    // 检查是否有未决的 repair_proposals（原记忆或候选记忆均不能单独批准）
    if (hasPendingRepairProposal(db, id)) {
      return { action: 'rejected', reason: 'pending_repair_proposals' };
    }

    const isCoreBlock = Boolean(memory.slot_key?.startsWith('core:'));
    let supersededId: string | undefined;

    if (memory.slot_key) {
      const supRes = supersedeActiveSlot(db, {
        scope: memory.scope,
        workspaceId: memory.workspace_id ?? null,
        sessionId: memory.session_id ?? null,
        slotKey: memory.slot_key,
        newOwnerId: memory.id,
        excludeId: id,
        actor: approvedBy,
        now,
        reason: 'supersede',
        rejectIfPinned: !isTrustedApprover,
      });
      if (!supRes.ok) {
        return { action: 'rejected', reason: supRes.reason };
      }
      supersededId = supRes.supersededId;
    }

    db.run(
      `UPDATE memories
       SET status = 'active',
           approved_at = ?,
           approved_by = ?,
           pinned = CASE WHEN ? THEN 1 ELSE pinned END,
           importance = CASE WHEN ? THEN 10 ELSE importance END,
           utility = CASE WHEN ? THEN 1.0 ELSE utility END,
           updated_at = ?
       WHERE id = ?`,
      [now, approvedBy, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, now, id]
    );

    if (supersededId) {
      return { action: 'superseded', id: memory.id, oldId: supersededId };
    }
    return { action: 'approved', id };
  });
}

/**
 * 修改记忆正文
 */
export function editContent(
  db: Db,
  id: string,
  newContent: string,
  newSummary?: string,
  actor: string = 'user',
  now: number = Date.now(),
  cfg?: WriterLimits
): { ok: boolean; version: number; content_rev: number } {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) throw new Error('memory_not_found');
    if (memory.status === 'frozen') throw new Error('memory_is_frozen');

    const rawContent = (newContent || '').trim();
    if (!rawContent) throw new Error('empty_content');

    const privCheck = redactSecrets(rawContent);
    if (privCheck.hasSensitive) throw new Error('sensitive_content_detected');

    const maxContentTokens = cfg?.maxContentTokens ?? DEFAULTS.maxContentTokens;
    const maxSummaryTokens = cfg?.maxSummaryTokens ?? DEFAULTS.maxSummaryTokens;

    const contentTokens = estimateTokens(rawContent);
    if (contentTokens > maxContentTokens) throw new Error('content_exceeds_max_tokens');

    let rawSummary = (newSummary || '').trim();
    if (!rawSummary) {
      rawSummary = firstSentence(rawContent);
    }

    if (redactSecrets(rawSummary).hasSensitive) throw new Error('sensitive_content_detected');
    if (estimateTokens(rawSummary) > maxSummaryTokens) {
      rawSummary = truncateToTokens(rawSummary, maxSummaryTokens);
    }

    saveVersionSnapshot(db, memory, 'edit', actor, now);

    const nextVersion = memory.version + 1;
    const nextContentRev = memory.content_rev + 1;
    const newHash = contentHash(memory.type, rawContent);
    const updatedVec = computeLocalEmbedding(
      `${rawSummary}\n${rawContent}${memory.slot_key ? `\n${memory.slot_key}` : ''}`
    );

    db.run(
      `UPDATE memories
       SET content = ?,
           summary = ?,
           token_cost = ?,
           summary_cost = ?,
           hash = ?,
           version = ?,
           content_rev = ?,
           embedding = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        rawContent,
        rawSummary,
        contentTokens,
        estimateTokens(rawSummary),
        newHash,
        nextVersion,
        nextContentRev,
        encodeEmbeddingBlob(updatedVec),
        now,
        id,
      ]
    );
    scheduleReplaceVectorCache(db, id, newHash, updatedVec);
    rebuildFtsAndEntities(db, id, memory.rowid_!, rawContent, rawSummary);

    return { ok: true, version: nextVersion, content_rev: nextContentRev };
  });
}

/**
 * 原子编辑记忆正文与元数据（供 Web / Service 层统一调用）：
 * 强制 frozen 守卫、禁止将非核心记忆改为 core:* 槽位、支持显式 workspaceId 迁移、
 * 通过 supersedeActiveSlot 解决槽位冲突，并在事务提交后更新向量缓存。
 */
export function editMemory(
  db: Db,
  id: string,
  patch: EditMemoryPatch,
  actor: string = 'user',
  now: number = Date.now(),
  cfg?: WriterLimits
): EditMemoryResult {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) throw new Error('memory_not_found');
    if (memory.status === 'frozen') throw new Error('memory_is_frozen');

    const maxContentTokens = cfg?.maxContentTokens ?? DEFAULTS.maxContentTokens;
    const maxSummaryTokens = cfg?.maxSummaryTokens ?? DEFAULTS.maxSummaryTokens;

    const contentChanged = patch.content !== undefined;
    let nextContent = memory.content;
    let nextTokenCost = memory.token_cost;

    if (contentChanged) {
      nextContent = (patch.content || '').trim();
      if (!nextContent) throw new Error('empty_content');
      if (redactSecrets(nextContent).hasSensitive) throw new Error('sensitive_content_detected');
      nextTokenCost = estimateTokens(nextContent);
      if (nextTokenCost > maxContentTokens) throw new Error('content_exceeds_max_tokens');
    }

    const summaryProvided = patch.summary !== undefined;
    let nextSummary = memory.summary;
    if (summaryProvided) {
      const trimmedSummary = (patch.summary || '').trim();
      nextSummary = trimmedSummary || firstSentence(nextContent);
    } else if (contentChanged) {
      nextSummary = firstSentence(nextContent);
    }

    if (summaryProvided || contentChanged) {
      if (redactSecrets(nextSummary).hasSensitive) throw new Error('sensitive_content_detected');
      if (estimateTokens(nextSummary) > maxSummaryTokens) {
        nextSummary = truncateToTokens(nextSummary, maxSummaryTokens);
      }
    }
    const nextSummaryCost =
      summaryProvided || contentChanged ? estimateTokens(nextSummary) : memory.summary_cost;

    if (patch.type !== undefined && !VALID_MEMORY_TYPES.has(patch.type)) {
      throw new Error('invalid_memory_type');
    }
    const nextType: MemoryType = patch.type ?? memory.type;

    if (patch.scope !== undefined && !VALID_SCOPES.has(patch.scope)) {
      throw new Error('invalid_scope');
    }
    const nextScope: Scope = patch.scope ?? memory.scope;

    let nextWorkspaceId: string | null = null;
    let nextSessionId: string | null = null;
    if (nextScope === 'workspace') {
      if (typeof patch.workspaceId === 'string' && patch.workspaceId.trim()) {
        nextWorkspaceId = workspaceId(patch.workspaceId);
      } else {
        nextWorkspaceId = memory.workspace_id || workspaceId(process.cwd());
      }
      nextSessionId = null;
    } else if (nextScope === 'session') {
      if (typeof patch.workspaceId === 'string' && patch.workspaceId.trim()) {
        nextWorkspaceId = workspaceId(patch.workspaceId);
      } else {
        nextWorkspaceId = memory.workspace_id || workspaceId(process.cwd());
      }
      if (typeof patch.sessionId === 'string' && patch.sessionId.trim()) {
        nextSessionId = patch.sessionId.trim();
      } else {
        nextSessionId = memory.session_id || 'manual_ui_session';
      }
    }

    const nextSlotKey =
      patch.slot_key !== undefined
        ? patch.slot_key
          ? String(patch.slot_key).trim() || null
          : null
        : (memory.slot_key ?? null);

    // 禁止把非核心记忆改成 core:* 槽位，也禁止通过 editMemory 改写核心块槽位名
    const wasCore = Boolean(memory.slot_key?.startsWith('core:'));
    const willBeCore = Boolean(nextSlotKey?.startsWith('core:'));
    if (willBeCore && (!wasCore || nextSlotKey !== memory.slot_key)) {
      throw new Error('cannot_assign_core_slot_key');
    }

    let nextImportance = memory.importance ?? 5;
    if (patch.importance !== undefined) {
      if (typeof patch.importance !== 'number' || !Number.isFinite(patch.importance)) {
        throw new Error('invalid_importance');
      }
      nextImportance = Math.max(1, Math.min(10, Math.round(patch.importance)));
    }

    // 先处理槽位冲突（若冲突槽位为 frozen 会在此处抛错，不留下孤儿快照）
    let supersededId: string | undefined;
    if (nextSlotKey && memory.status === 'active') {
      const supRes = supersedeActiveSlot(db, {
        scope: nextScope,
        workspaceId: nextWorkspaceId,
        sessionId: nextSessionId,
        slotKey: nextSlotKey,
        newOwnerId: id,
        excludeId: id,
        actor,
        now,
        reason: 'supersede_by_edit',
      });
      if (!supRes.ok) {
        throw new Error(supRes.reason);
      }
      supersededId = supRes.supersededId;
    }

    saveVersionSnapshot(db, memory, 'edit', actor, now);

    const nextVersion = memory.version + 1;
    const contentOrSummaryChanged =
      nextContent !== memory.content || nextSummary !== memory.summary;
    const nextContentRev = contentOrSummaryChanged ? memory.content_rev + 1 : memory.content_rev;
    const nextHash = contentHash(nextType, nextContent);
    const needsEmbeddingRefresh =
      contentOrSummaryChanged ||
      nextType !== memory.type ||
      nextSlotKey !== (memory.slot_key ?? null);

    let updatedVec: Float32Array | undefined;
    if (needsEmbeddingRefresh) {
      updatedVec = computeLocalEmbedding(
        `${nextSummary}\n${nextContent}${nextSlotKey ? `\n${nextSlotKey}` : ''}`
      );
      db.run(
        `UPDATE memories
         SET type = ?,
             content = ?,
             summary = ?,
             slot_key = ?,
             scope = ?,
             workspace_id = ?,
             session_id = ?,
             importance = ?,
             token_cost = ?,
             summary_cost = ?,
             hash = ?,
             version = ?,
             content_rev = ?,
             embedding = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          nextType,
          nextContent,
          nextSummary,
          nextSlotKey,
          nextScope,
          nextWorkspaceId,
          nextSessionId,
          nextImportance,
          nextTokenCost,
          nextSummaryCost,
          nextHash,
          nextVersion,
          nextContentRev,
          encodeEmbeddingBlob(updatedVec),
          now,
          id,
        ]
      );
      scheduleReplaceVectorCache(db, id, nextHash, updatedVec);
    } else {
      db.run(
        `UPDATE memories
         SET type = ?,
             content = ?,
             summary = ?,
             slot_key = ?,
             scope = ?,
             workspace_id = ?,
             session_id = ?,
             importance = ?,
             token_cost = ?,
             summary_cost = ?,
             hash = ?,
             version = ?,
             content_rev = ?,
             updated_at = ?
         WHERE id = ?`,
        [
          nextType,
          nextContent,
          nextSummary,
          nextSlotKey,
          nextScope,
          nextWorkspaceId,
          nextSessionId,
          nextImportance,
          nextTokenCost,
          nextSummaryCost,
          nextHash,
          nextVersion,
          nextContentRev,
          now,
          id,
        ]
      );
    }

    if (contentOrSummaryChanged) {
      rebuildFtsAndEntities(db, id, memory.rowid_!, nextContent, nextSummary);
    }

    const updated = loadMemory(db, id)!;
    return {
      ok: true,
      version: nextVersion,
      content_rev: nextContentRev,
      supersededId,
      memory: updated,
    };
  });
}

/**
 * 回滚记忆至指定版本
 */
export function rollback(
  db: Db,
  id: string,
  targetVersion: number,
  actor: string = 'user',
  now: number = Date.now()
): { ok: boolean; version: number; content_rev: number } {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) throw new Error('memory_not_found');
    if (memory.status === 'frozen') throw new Error('memory_is_frozen');

    const versionRow = db.get<{ snapshot: string }>(
      `SELECT snapshot FROM memory_versions WHERE memory_id = ? AND version = ?`,
      [id, targetVersion]
    );
    if (!versionRow) throw new Error('target_version_not_found');

    const snapshot: MemoryRecord = JSON.parse(versionRow.snapshot);
    const nextSlotKey =
      snapshot.slot_key !== undefined ? snapshot.slot_key : (memory.slot_key ?? null);

    if (nextSlotKey && memory.status === 'active') {
      const supRes = supersedeActiveSlot(db, {
        scope: memory.scope,
        workspaceId: memory.workspace_id ?? null,
        sessionId: memory.session_id ?? null,
        slotKey: nextSlotKey,
        newOwnerId: id,
        excludeId: id,
        actor,
        now,
        reason: 'supersede_by_rollback',
      });
      if (!supRes.ok) {
        throw new Error(supRes.reason);
      }
    }

    saveVersionSnapshot(db, memory, 'rollback', actor, now);

    const nextVersion = memory.version + 1;
    const nextContentRev = memory.content_rev + 1;
    const rollbackHash = snapshot.hash || contentHash(memory.type, snapshot.content);
    const rollbackVec = computeLocalEmbedding(
      `${snapshot.summary}\n${snapshot.content}${nextSlotKey ? `\n${nextSlotKey}` : ''}`
    );

    db.run(
      `UPDATE memories
       SET content = ?,
           summary = ?,
           slot_key = ?,
           token_cost = ?,
           summary_cost = ?,
           hash = ?,
           version = ?,
           content_rev = ?,
           embedding = ?,
           updated_at = ?
       WHERE id = ?`,
      [
        snapshot.content,
        snapshot.summary,
        nextSlotKey,
        snapshot.token_cost,
        snapshot.summary_cost,
        rollbackHash,
        nextVersion,
        nextContentRev,
        encodeEmbeddingBlob(rollbackVec),
        now,
        id,
      ]
    );
    scheduleReplaceVectorCache(db, id, rollbackHash, rollbackVec);
    rebuildFtsAndEntities(db, id, memory.rowid_!, snapshot.content, snapshot.summary);

    return { ok: true, version: nextVersion, content_rev: nextContentRev };
  });
}

/**
 * 遗忘记忆（置为 archived，记录保留；拒绝 frozen 记忆，并写入 valid_to 与 invalidated_at）
 */
export function forget(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): boolean {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory || memory.status === 'frozen') return false;

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(
      `UPDATE memories
       SET status = 'archived',
           valid_to = ?,
           invalidated_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, now, now, id]
    );
    scheduleRemoveVectorCache(db, id);
    return true;
  });
}

/**
 * 冻结记忆（仅允许冻结 active 记忆；已 frozen 幂等返回 true，拒绝 candidate/archived/rejected/superseded）
 */
export function freeze(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): boolean {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return false;
    if (memory.status === 'frozen') return true;
    if (memory.status !== 'active') return false;

    if (memory.slot_key) {
      const supRes = supersedeActiveSlot(db, {
        scope: memory.scope,
        workspaceId: memory.workspace_id ?? null,
        sessionId: memory.session_id ?? null,
        slotKey: memory.slot_key,
        newOwnerId: memory.id,
        excludeId: id,
        actor,
        now,
        reason: 'supersede_by_freeze',
      });
      if (!supRes.ok) return false;
    }

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(
      `UPDATE memories SET status = 'frozen', version = version + 1, updated_at = ? WHERE id = ?`,
      [now, id]
    );
    return true;
  });
}

/**
 * 解冻记忆
 */
export function unfreeze(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): boolean {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return false;
    // 仅 frozen 记录可解冻。对 superseded/archived 记录调用时必须在任何写入之前返回。
    if (memory.status !== 'frozen') return memory.status === 'active';
    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(
      `UPDATE memories SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?`,
      [now, id]
    );
    return true;
  });
}

/**
 * 置顶记忆（仅允许 active / frozen 状态，记录快照并递增版本）
 */
export function pin(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return false;
    if (memory.status !== 'active' && memory.status !== 'frozen') return false;
    if (memory.pinned === 1) return true;

    saveVersionSnapshot(db, memory, 'pin', actor, now);
    db.run(`UPDATE memories SET pinned = 1, version = version + 1, updated_at = ? WHERE id = ?`, [
      now,
      id,
    ]);
    return true;
  });
}

/**
 * 取消置顶（记录快照并递增版本）
 */
export function unpin(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): boolean {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return false;
    if (memory.pinned === 0) return true;

    saveVersionSnapshot(db, memory, 'unpin', actor, now);
    db.run(`UPDATE memories SET pinned = 0, version = version + 1, updated_at = ? WHERE id = ?`, [
      now,
      id,
    ]);
    return true;
  });
}

/**
 * 效用与成败计数更新（不再重复递增 use_count，不再覆盖 updated_at 以保护内容新鲜度）
 */
export function applyUtility(
  db: Db,
  id: string,
  utility: number,
  deltaSuccess: number = 0,
  deltaFail: number = 0,
  now: number = Date.now()
): void {
  if (typeof utility !== 'number' || !Number.isFinite(utility)) {
    throw new Error('invalid_utility');
  }
  if (!Number.isInteger(deltaSuccess) || deltaSuccess < 0) {
    throw new Error('invalid_delta_success');
  }
  if (!Number.isInteger(deltaFail) || deltaFail < 0) {
    throw new Error('invalid_delta_fail');
  }

  const clampedUtility = Math.max(0, Math.min(1, utility));
  db.run(
    `UPDATE memories
     SET utility = ?,
         success_count = success_count + ?,
         fail_count = fail_count + ?,
         last_used_at = ?
     WHERE id = ?`,
    [clampedUtility, deltaSuccess, deltaFail, now, id]
  );
}

/**
 * 确认记忆：提升可信度与效用，支持将 candidate 激活。
 * 仅允许 candidate / active 状态，所有前置校验完成后才写入快照与变更。
 */
export function confirmMemory(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): { success: boolean; memory?: MemoryRecord; message: string } {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return { success: false, message: `Memory '${id}' not found` };
    if (memory.status !== 'candidate' && memory.status !== 'active') {
      return { success: false, message: `Memory '${id}' is ${memory.status}` };
    }

    // 信任边界：仅用户/系统可无条件激活候选；模型(llm/assistant)只能激活带有干净用户证据的候选。
    const trustedActor = actor === 'user' || actor === 'system';
    const isCoreBlock = Boolean(memory.slot_key?.startsWith('core:'));
    const canActivate = trustedActor || hasUserEvidence(db, memory);
    const promote = memory.status === 'candidate' && canActivate;

    // 所有前置校验必须在 saveVersionSnapshot 之前完成，杜绝失败调用残留孤儿快照
    if (!trustedActor && memory.status === 'candidate' && isCoreBlock) {
      return {
        success: false,
        message: `Core memory block '${memory.slot_key}' requires explicit user approval`,
      };
    }

    if (promote && hasPendingRepairProposal(db, id)) {
      return {
        success: false,
        message: `Memory '${id}' has pending repair proposals and cannot be confirmed directly`,
      };
    }

    if (promote && memory.slot_key) {
      const existingSlot = findActiveSlotOccupant(
        db,
        memory.scope,
        memory.workspace_id ?? null,
        memory.session_id ?? null,
        memory.slot_key,
        id
      );
      if (existingSlot) {
        if (existingSlot.status === 'frozen') {
          return {
            success: false,
            message: `Slot '${memory.slot_key}' is currently locked by frozen memory '${existingSlot.id}'`,
          };
        }
        if (!trustedActor && existingSlot.pinned) {
          return {
            success: false,
            message: `Slot '${memory.slot_key}' is currently pinned by '${existingSlot.id}'`,
          };
        }
      }
    }

    // 所有前置校验均通过，开始执行状态变更
    if (promote && memory.slot_key) {
      const supRes = supersedeActiveSlot(db, {
        scope: memory.scope,
        workspaceId: memory.workspace_id ?? null,
        sessionId: memory.session_id ?? null,
        slotKey: memory.slot_key,
        newOwnerId: memory.id,
        excludeId: id,
        actor,
        now,
        reason: 'supersede',
        rejectIfPinned: !trustedActor,
      });
      if (!supRes.ok) {
        return {
          success: false,
          message:
            supRes.reason === 'slot_is_frozen'
              ? `Slot '${memory.slot_key}' is currently locked by frozen memory '${supRes.occupant.id}'`
              : `Slot '${memory.slot_key}' is currently pinned by '${supRes.occupant.id}'`,
        };
      }
    }

    saveVersionSnapshot(db, memory, 'confirm', actor, now);

    const boostConf = actor === 'user' ? 0.2 : 0.1;
    let newConfidence = Math.min(1.0, memory.confidence + boostConf);
    if (memory.status === 'candidate' && !canActivate) {
      newConfidence = Math.min(newConfidence, 0.7);
    }
    if (!trustedActor) {
      newConfidence = Math.min(newConfidence, Math.max(memory.confidence, 0.85));
    }
    if (memory.status === 'candidate' && !promote && hasUntrustedOrigin(memory)) {
      newConfidence = Math.min(newConfidence, 0.5);
    }

    const promoteCore = promote && isCoreBlock;
    const newUtility = promoteCore
      ? 1.0
      : trustedActor
        ? Math.min(1.0, memory.utility + 0.15)
        : memory.utility;
    const successDelta = trustedActor ? 1 : 0;
    const newStatus = promote ? 'active' : memory.status;
    const approvedAt = promote ? now : (memory.approved_at ?? null);
    const approvedBy = promote ? actor : (memory.approved_by ?? null);

    db.run(
      `UPDATE memories
       SET confidence = ?,
           utility = ?,
           status = ?,
           approved_at = ?,
           approved_by = ?,
           pinned = CASE WHEN ? THEN 1 ELSE pinned END,
           importance = CASE WHEN ? THEN 10 ELSE importance END,
           success_count = success_count + ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [
        newConfidence,
        newUtility,
        newStatus,
        approvedAt,
        approvedBy,
        promoteCore ? 1 : 0,
        promoteCore ? 1 : 0,
        successDelta,
        now,
        id,
      ]
    );

    const updated = loadMemory(db, id);
    const pendingNote =
      memory.status === 'candidate' && !promote
        ? '; remains candidate pending user approval (no user-origin evidence)'
        : '';
    return {
      success: true,
      memory: updated,
      message: `Memory '${id}' confirmed (confidence: ${newConfidence.toFixed(2)}, utility: ${newUtility.toFixed(2)})${pendingNote}`,
    };
  });
}

/**
 * 显式合并记忆：将 sourceId 合并进 targetId，转移证据与实体并合并 origin_kinds 污点，
 * 并将 sourceId 置为 superseded。
 */
export function mergeMemories(
  db: Db,
  sourceId: string,
  targetId: string,
  reason: string = 'deduplication',
  actor: string = 'user',
  now: number = Date.now()
): { success: boolean; message: string } {
  return db.transaction(() => {
    if (sourceId === targetId) {
      return { success: false, message: 'Source and target memories must be different' };
    }
    const source = loadMemory(db, sourceId);
    const target = loadMemory(db, targetId);
    if (!source) return { success: false, message: `Source memory '${sourceId}' not found` };
    if (!target) return { success: false, message: `Target memory '${targetId}' not found` };
    if (
      target.status === 'archived' ||
      target.status === 'rejected' ||
      target.status === 'superseded'
    ) {
      return {
        success: false,
        message: `Target memory '${targetId}' is ${target.status}; cannot merge into it`,
      };
    }
    if (
      source.status === 'superseded' ||
      source.status === 'archived' ||
      source.status === 'rejected'
    ) {
      return {
        success: false,
        message: `Source memory '${sourceId}' is already ${source.status}`,
      };
    }
    // 用户锁定（frozen）或置顶（pinned）的记忆只能由用户本人合并，防止模型/自动流程覆盖
    if (actor !== 'user' && (source.status === 'frozen' || source.pinned)) {
      return {
        success: false,
        message: `Source memory '${sourceId}' is ${source.status === 'frozen' ? 'frozen' : 'pinned'} by user; only the user can merge it`,
      };
    }
    if (actor !== 'user') {
      if (target.status === 'frozen' || target.pinned) {
        return { success: false, message: 'Only the user can merge into a protected target' };
      }
      if (
        source.scope !== target.scope ||
        source.workspace_id !== target.workspace_id ||
        source.session_id !== target.session_id
      ) {
        return { success: false, message: 'Automatic merge requires matching ownership' };
      }
      if (
        (source.status === 'active' && target.status === 'candidate') ||
        (target.status === 'candidate' && source.hash !== target.hash)
      ) {
        return {
          success: false,
          message: 'A model proposal cannot inherit approval evidence through merge',
        };
      }
    }

    // 保存快照
    saveVersionSnapshot(db, source, 'merge_source', actor, now);
    saveVersionSnapshot(db, target, 'merge_target', actor, now);

    // 1. 将 source 的 sources 转移/追加到 target
    const srcSources = db.all<{
      session_id: string;
      seq: number;
      kind: string;
      excerpt?: string | null;
    }>(
      `SELECT session_id, seq, kind, excerpt FROM memory_sources WHERE memory_id = ? AND content_rev = ?`,
      [sourceId, source.content_rev]
    );
    for (const s of srcSources) {
      db.run(
        `INSERT OR IGNORE INTO memory_sources (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [targetId, target.content_rev, s.session_id, s.seq, s.kind, truncateExcerpt(s.excerpt), now]
      );
    }

    // 2. 将 source 的 entities 转移到 target
    const srcEntities = db.all<{ entity: string }>(
      `SELECT entity FROM memory_entities WHERE memory_id = ?`,
      [sourceId]
    );
    for (const e of srcEntities) {
      db.run(`INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)`, [
        targetId,
        e.entity,
      ]);
    }

    // 3. 建立 supersedes 关系: target supersedes source
    db.run(
      `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
       VALUES (?, ?, 'supersedes', ?, ?)`,
      [targetId, sourceId, JSON.stringify({ reason, actor }), now]
    );

    // 4. 将 source 置为 superseded
    db.run(
      `UPDATE memories
       SET status = 'superseded',
           valid_to = ?,
           invalidated_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, now, now, sourceId]
    );
    scheduleRemoveVectorCache(db, sourceId);

    // 5. 合并 origin_kinds 保留污点；按操作者可信度更新效用与置信度
    const mergedOrigins = Array.from(
      new Set<OriginKind>([
        ...parseOriginKinds(target.origin_kinds),
        ...parseOriginKinds(source.origin_kinds),
      ])
    );
    const mergedTainted =
      mergedOrigins.includes('web') ||
      mergedOrigins.includes('tool') ||
      target.source_kind === 'web' ||
      target.source_kind === 'tool' ||
      source.source_kind === 'web' ||
      source.source_kind === 'tool';

    const trustedActor = actor === 'user' || actor === 'system';
    let newUtility = target.utility;
    let newConfidence: number;
    let successDelta = 0;

    if (trustedActor) {
      newUtility = Math.min(1.0, target.utility + 0.1);
      newConfidence = Math.min(1.0, Math.max(target.confidence, source.confidence) + 0.05);
      successDelta = 1;
    } else {
      // 非可信操作者（如 llm）：不提升效用和成功次数，置信度封顶 0.85（不误伤既有更高置信度）
      newConfidence = Math.min(
        Math.max(target.confidence, source.confidence),
        Math.max(target.confidence, 0.85)
      );
    }

    if (target.status === 'candidate' && mergedTainted) {
      newConfidence = Math.min(newConfidence, 0.5);
    }

    db.run(
      `UPDATE memories
       SET utility = ?,
           confidence = ?,
           origin_kinds = ?,
           success_count = success_count + ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [newUtility, newConfidence, JSON.stringify(mergedOrigins), successDelta, now, targetId]
    );

    return {
      success: true,
      message: `Successfully merged '${sourceId}' into '${targetId}' (superseded '${sourceId}')`,
    };
  });
}

/**
 * 恢复已归档或已取代的记忆为 active（仅允许 archived / superseded 状态）
 */
export function restoreMemory(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): { success: boolean; message: string } {
  return db.transaction(() => {
    const memory = loadMemory(db, id);
    if (!memory) return { success: false, message: `Memory '${id}' not found` };
    if (memory.status !== 'archived' && memory.status !== 'superseded') {
      return {
        success: false,
        message: `Memory '${id}' cannot be restored from status '${memory.status}'`,
      };
    }

    if (memory.slot_key) {
      const supRes = supersedeActiveSlot(db, {
        scope: memory.scope,
        workspaceId: memory.workspace_id ?? null,
        sessionId: memory.session_id ?? null,
        slotKey: memory.slot_key,
        newOwnerId: memory.id,
        excludeId: id,
        actor,
        now,
        reason: 'supersede',
      });
      if (!supRes.ok) {
        return {
          success: false,
          message: `Slot '${memory.slot_key}' is currently locked by frozen memory '${supRes.occupant.id}'`,
        };
      }
    }

    saveVersionSnapshot(db, memory, 'restore', actor, now);
    db.run(
      `UPDATE memories
       SET status = 'active',
           valid_to = NULL,
           invalidated_at = NULL,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, id]
    );
    const restoredVec = decodeEmbeddingBlob(memory.embedding);
    if (restoredVec) {
      schedulePrimeVectorCache(db, memory.id, memory.hash, restoredVec);
    }
    return { success: true, message: `Memory '${id}' restored to active status` };
  });
}

/**
 * 标记记忆失效/归档 (Zep 时序失效与 Mem0 DELETE 动作)
 */
export function invalidateMemory(
  db: Db,
  id: string,
  reason: string = 'invalidated',
  actor: string = 'user',
  now: number = Date.now()
): boolean {
  return db.transaction(() => {
    const mem = loadMemory(db, id);
    if (!mem || mem.status === 'frozen') return false;
    saveVersionSnapshot(db, mem, reason, actor, now);
    db.run(
      `UPDATE memories
       SET status = 'archived',
           valid_to = ?,
           invalidated_at = ?,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [now, now, now, id]
    );
    scheduleRemoveVectorCache(db, id);
    return true;
  });
}
