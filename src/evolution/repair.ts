import { hydrateMemoryRow, type Db, type MemoryRecord, type MemoryRow } from '../types.js';
import { jobFailure, type JobHandlerResult } from '../jobs/types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { sources } from '../core/store.js';
import { upsertCandidate, saveVersionSnapshot } from '../core/writer.js';
import { removeCachedRuntimeEmbedding } from '../core/vector.js';
import { enqueueJob } from '../jobs/scheduler.js';
import { PROMPT_REPAIR, packPromptWithinBudget } from './prompts.js';
import { parseOutput } from './parse.js';
import { callOfflineLLM } from './llm.js';
import type { EvidenceLedger, EvidenceLedgerEntry } from './types.js';
import { memoryWorkspaceIds, canSendMemoriesOffline } from '../core/privacy.js';
import { hasUserEvidence, sourceKindToOriginKind } from '../core/trust.js';
import { resolveWorkspaceCwd } from '../core/scope.js';
import { sameMemoryOwner } from './review-snapshot.js';

export interface RepairProposalRecord {
  id: number;
  jobId: number;
  memoryId: string;
  contentRev: number;
  action: 'revise' | 'split' | 'invalidate';
  candidateIds: string[];
  reason: string;
  status: 'candidate' | 'approved' | 'rejected';
  createdAt: number;
  expiresAt: number;
  approvedAt?: number | null;
  approvedBy?: string | null;
}

class SplitRollbackError extends Error {
  constructor() {
    super('split_insufficient_candidates');
  }
}

function safeParseCandidateIds(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((item) => typeof item === 'string' && item.trim().length > 0)) return null;
    return parsed.map((item) => item.trim());
  } catch {
    return null;
  }
}

/**
 * 检查条件并在合格时将 repair 任务入队 (§5.17)
 * 统一经 enqueueJob 以 repair:<memoryId> 幂等入队，避免 UNIQUE 约束冲突与同记忆并发修复风暴。
 */
export function enqueueRepairJobIfEligible(
  db: Db,
  params: {
    memoryId: string;
    sessionId: string;
    query: string;
    turn: number;
  },
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now()
): boolean {
  // 1. 查询目标记忆
  const mem = hydrateMemoryRow(
    db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [params.memoryId])
  );
  if (!mem) return false;

  // 必须是 active
  if (mem.status !== 'active') {
    return false;
  }

  // 2. 7天冷却时间检查
  const cooldownDays = cfg.repairCooldownDays ?? 7;
  const cooldownMs = cooldownDays * 86400000;
  if (mem.last_repair_at && now - mem.last_repair_at < cooldownMs) {
    return false;
  }

  // 3. 若已有未决修复提案，不重复入队
  const pendingProposal = db.get<{ id: number }>(
    `SELECT id FROM repair_proposals WHERE memory_id = ? AND status = 'candidate' LIMIT 1`,
    [params.memoryId]
  );
  if (pendingProposal) {
    return false;
  }

  // 4. 幂等入队：按 memoryId 稳定去重
  const jobKey = `repair:${params.memoryId}`;
  return enqueueJob(db, {
    kind: 'repair',
    key: jobKey,
    payload: {
      memoryId: params.memoryId,
      sessionId: params.sessionId,
      query: params.query,
      turn: params.turn,
    },
    now,
  });
}

/**
 * 执行 repair 离线学习任务 (§5.17, 附录 B-4)
 */
export function executeRepair(
  db: Db,
  job: { id: number; key: string; payload: string },
  options: { fetchFn?: typeof fetch; signal?: AbortSignal } = {},
  cfg: PluginConfig = DEFAULTS,
  now: number = Date.now()
): Promise<JobHandlerResult> {
  return (async () => {
    let payload: { memoryId: string; sessionId: string; query: string; turn: number };
    try {
      payload = JSON.parse(job.payload);
    } catch {
      return { action: 'failed', nonRetryable: true, error: 'malformed_payload' };
    }

    // 1. 查询目标记忆
    const mem = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [payload.memoryId])
    );
    if (!mem) {
      return { action: 'skipped', nonRetryable: true, reason: 'Target memory not found' };
    }
    if (mem.status !== 'active') {
      return { action: 'skipped', nonRetryable: true, reason: `Target memory status is ${mem.status}` };
    }
    if (!canSendMemoriesOffline(db, [mem], cfg.excludeWorkspaces)) {
      return { action: 'failed', nonRetryable: true, error: 'workspace_excluded' };
    }

    // 2. 在执行期复核冷却时间，避免延迟队列中积压任务绕过冷却期
    const cooldownDays = cfg.repairCooldownDays ?? 7;
    const cooldownMs = cooldownDays * 86400000;
    if (mem.last_repair_at && now - mem.last_repair_at < cooldownMs) {
      return {
        action: 'skipped',
        nonRetryable: true,
        reason: 'Target memory is within repair cooldown',
      };
    }

    // 3. 获取目标记忆绑定的可验证来源证据
    const srcList = sources(db, mem.id, mem.content_rev);
    const validSources = srcList.filter((s) => s.excerpt && s.excerpt.trim().length >= 10);

    if (validSources.length === 0) {
      return {
        action: 'skipped',
        nonRetryable: true,
        reason: 'No verifiable source excerpts found for target memory',
      };
    }

    // 4. 按统一输入预算打包来源证据并构建 request-local evidenceLedger
    const buildRepairPromptAndLedger = (
      selectedSources: typeof validSources,
      ledgerOut?: EvidenceLedger
    ): string => {
      const lines: string[] = [];
      for (let i = 0; i < selectedSources.length; i++) {
        const s = selectedSources[i];
        const seq = i + 1;
        const originKind = sourceKindToOriginKind(s.kind);
        const tag =
          originKind === 'tool'
            ? 'T'
            : originKind === 'assistant'
              ? 'A'
              : 'U';
        const line = `[${tag}#${seq}] ${s.excerpt!}`;
        lines.push(line);
        if (ledgerOut) {
          ledgerOut.set(seq, {
            seq,
            original_seq: s.seq,
            session_id: s.session_id,
            kind: s.kind,
            origin_kinds: [originKind],
            redacted_text: s.excerpt!,
            rendered_line: line,
            time: s.created_at || now,
          });
        }
      }
      return PROMPT_REPAIR.buildUser({
        queryText: payload.query,
        memoryId: mem.id,
        contentRev: mem.content_rev,
        memoryType: mem.type,
        memoryStatus: mem.status,
        sourceKind: mem.source_kind,
        slotKey: mem.slot_key || 'none',
        memoryText: mem.content,
        failureSignal: 'Observed outcome r <= -0.6 after memory expansion',
        evidenceTranscript: lines.join('\n'),
      });
    };

    const maxInputTokens = cfg.distillMaxInputTokens || 6000;
    const packed = packPromptWithinBudget(
      PROMPT_REPAIR.system,
      (sel) => buildRepairPromptAndLedger(sel),
      validSources,
      maxInputTokens,
      250
    );

    if (packed.selected.length === 0) {
      return {
        action: 'skipped',
        nonRetryable: true,
        reason: 'Repair prompt exceeds input token budget',
      };
    }

    const evidenceLedger: EvidenceLedger = new Map<number, EvidenceLedgerEntry>();
    const prompt = buildRepairPromptAndLedger(packed.selected, evidenceLedger);

    // 5. 调用离线 LLM（使用 resolveWorkspaceCwd 获取工作区路径进行脱敏）
    const realCwd = resolveWorkspaceCwd(db, mem.workspace_id || undefined) || '';
    const llmRes = await callOfflineLLM(
      db,
      {
        jobKind: 'repair',
        promptVersion: PROMPT_REPAIR.version,
        systemPrompt: PROMPT_REPAIR.system,
        userPrompt: prompt,
        maxOutputTokens: PROMPT_REPAIR.maxOutputTokens,
        cwd: realCwd,
        workspaceId: mem.workspace_id || '',
        dataWorkspaceIds: [
          ...memoryWorkspaceIds(db, [mem]),
          ...db
            .all<{ workspace_id: string }>(
              'SELECT workspace_id FROM session_workspace_owners WHERE session_id = ?',
              [payload.sessionId]
            )
            .map((r) => r.workspace_id),
        ],
        signal: options.signal,
        fetchFn: options.fetchFn,
      },
      cfg
    );

    // 仅在实际派发 LLM 请求（成功或已写入账本尝试）后才刷新 last_repair_at 冷却时间戳
    if (llmRes.ok || llmRes.ledgerId !== undefined) {
      db.run('UPDATE memories SET last_repair_at = ? WHERE id = ?', [now, mem.id]);
    }

    if (!llmRes.ok) {
      return jobFailure(llmRes.error);
    }

    // 6. 解析与校验 B-4 合同
    const parsed = parseOutput(llmRes.content, {
      taskKind: 'repair',
      evidenceLedger,
      workspaceId: mem.workspace_id || '',
      sessionId: payload.sessionId,
    });

    if (!parsed.success) {
      return {
        action: 'failed',
        nonRetryable: true,
        error: `repair_parse_failed: ${parsed.error}`,
      };
    }

    const action = parsed.action!;
    const reason = parsed.reason || 'offline repair proposal';
    const expiresAt = now + 30 * 86400000; // 提案固定 30 天过期

    // 7. 依据动作落地提案 (原 active 记忆保持完全原样)
    db.transaction(() => {
      if (action === 'keep') {
        // keep: 成功 no-op
        return;
      } else if (action === 'revise') {
        const item = parsed.items[0];
        const res = upsertCandidate(
          db,
          {
            ...item,
            scope: mem.scope,
            workspaceId: mem.workspace_id || undefined,
            sessionId: mem.scope === 'session' ? mem.session_id || undefined : undefined,
            status: 'candidate',
            actor: 'llm',
          },
          now
        );
        if (!('id' in res)) {
          return;
        }
        const candId = res.id;

        // 建立 derived_from 关系
        db.run(
          `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
           VALUES (?, ?, 'derived_from', ?, ?)`,
          [
            candId,
            mem.id,
            JSON.stringify({ sources: [{ memory_id: mem.id, content_rev: mem.content_rev, hash: mem.hash }] }),
            now,
          ]
        );

        // 创建 repair_proposals 记录
        db.run(
          `INSERT INTO repair_proposals (
            job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at
          ) VALUES (?, ?, ?, 'revise', ?, ?, 'candidate', ?, ?)`,
          [job.id, mem.id, mem.content_rev, JSON.stringify([candId]), reason, now, expiresAt]
        );
      } else if (action === 'split') {
        // 嵌套 SAVEPOINT：若拆分的候选不足 2 条成功落盘，原子回滚已插入的部分候选与关系，不留孤儿数据
        try {
          db.transaction(() => {
            const candIds: string[] = [];
            for (const item of parsed.items) {
              const res = upsertCandidate(
                db,
                {
                  ...item,
                  scope: mem.scope,
                  workspaceId: mem.workspace_id || undefined,
                  sessionId: mem.scope === 'session' ? mem.session_id || undefined : undefined,
                  status: 'candidate',
                  actor: 'llm',
                },
                now
              );
              if ('id' in res && !candIds.includes(res.id)) {
                candIds.push(res.id);
                db.run(
                  `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
                   VALUES (?, ?, 'derived_from', ?, ?)`,
                  [
                    res.id,
                    mem.id,
                    JSON.stringify({
                      sources: [{ memory_id: mem.id, content_rev: mem.content_rev, hash: mem.hash }],
                    }),
                    now,
                  ]
                );
              }
            }

            if (candIds.length < 2) {
              throw new SplitRollbackError();
            }

            db.run(
              `INSERT INTO repair_proposals (
                job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at
              ) VALUES (?, ?, ?, 'split', ?, ?, 'candidate', ?, ?)`,
              [job.id, mem.id, mem.content_rev, JSON.stringify(candIds), reason, now, expiresAt]
            );
          });
        } catch (err) {
          if (!(err instanceof SplitRollbackError)) {
            throw err;
          }
        }
      } else if (action === 'invalidate') {
        db.run(
          `INSERT INTO repair_proposals (
            job_id, memory_id, content_rev, action, candidate_ids, reason, status, created_at, expires_at
          ) VALUES (?, ?, ?, 'invalidate', '[]', ?, 'candidate', ?, ?)`,
          [job.id, mem.id, mem.content_rev, reason, now, expiresAt]
        );
      }
    });

    return { action: 'done' };
  })();
}

/**
 * 用户批准修复提案 (/memory approve-repair <proposalId>, §5.17)
 */
export function approveRepairProposal(
  db: Db,
  proposalId: number,
  approvedBy: string = 'user',
  now: number = Date.now()
): { ok: boolean; reason?: string } {
  return db.transaction(() => {
    // 1. 查找提案
    const proposal = db.get<{
      id: number;
      job_id: number;
      memory_id: string;
      content_rev: number;
      action: 'revise' | 'split' | 'invalidate';
      candidate_ids: string;
      status: string;
      expires_at: number;
    }>('SELECT * FROM repair_proposals WHERE id = ?', [proposalId]);

    if (!proposal) {
      return { ok: false, reason: `Proposal #${proposalId} not found` };
    }
    if (proposal.status !== 'candidate') {
      return { ok: false, reason: `Proposal #${proposalId} is already ${proposal.status}` };
    }
    if (proposal.expires_at <= now) {
      return {
        ok: false,
        reason: `Proposal #${proposalId} has expired (expired at ${new Date(proposal.expires_at).toISOString()})`,
      };
    }

    // 2. 校验原记忆状态与 content_rev
    const target = hydrateMemoryRow(
      db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [proposal.memory_id])
    );
    if (!target) {
      return { ok: false, reason: `Target memory ${proposal.memory_id} not found` };
    }
    if (target.status !== 'active') {
      return { ok: false, reason: `Target memory is ${target.status}, must be active` };
    }
    if (target.content_rev !== proposal.content_rev) {
      return {
        ok: false,
        reason: `Target memory content_rev has changed from ${proposal.content_rev} to ${target.content_rev}`,
      };
    }

    const candidateIds = safeParseCandidateIds(proposal.candidate_ids);
    if (!candidateIds) {
      return { ok: false, reason: `Proposal #${proposalId} has malformed candidate_ids` };
    }
    if (new Set(candidateIds).size !== candidateIds.length) {
      return { ok: false, reason: 'Repair candidates must be distinct' };
    }

    const trustedApprover = approvedBy === 'user' || approvedBy === 'system';
    if (!trustedApprover) {
      if (target.pinned) return { ok: false, reason: 'Target memory is pinned' };
      if (proposal.action === 'invalidate' || candidateIds.length === 0) {
        return { ok: false, reason: 'user_approval_required' };
      }
      for (const id of candidateIds) {
        const candidate = hydrateMemoryRow(
          db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id])
        );
        if (!candidate || candidate.source_kind === 'llm_extract' || !hasUserEvidence(db, candidate)) {
          return { ok: false, reason: 'user_evidence_required' };
        }
      }
    }

    // 3. 执行应用
    if (proposal.action === 'revise') {
      if (candidateIds.length !== 1) {
        return { ok: false, reason: 'Revise proposal must have exactly 1 candidate id' };
      }
      const candId = candidateIds[0];
      const candidateMem = hydrateMemoryRow(
        db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [candId])
      );
      if (!candidateMem || candidateMem.status !== 'candidate') {
        return { ok: false, reason: `Candidate ${candId} not found or not in candidate status` };
      }
      if (!sameMemoryOwner(target, candidateMem)) {
        return { ok: false, reason: 'Repair candidates must belong to the target scope' };
      }

      // 检查候选槽位冲突（排除将要被取代的 target.id）
      if (candidateMem.slot_key) {
        const conflictingSlot = hydrateMemoryRow(
          db.get<MemoryRow>(
            `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id NOT IN (?, ?)`,
            [
              candidateMem.scope,
              candidateMem.workspace_id || '',
              candidateMem.session_id || '',
              candidateMem.slot_key,
              target.id,
              candId,
            ]
          )
        );
        if (conflictingSlot) {
          if (conflictingSlot.status === 'frozen') {
            return { ok: false, reason: `Slot '${candidateMem.slot_key}' is frozen` };
          }
          if (conflictingSlot.pinned && !trustedApprover) {
            return { ok: false, reason: `Slot '${candidateMem.slot_key}' is pinned` };
          }
          saveVersionSnapshot(db, conflictingSlot, 'repair_slot_supersede', approvedBy, now);
          db.run(
            `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
            [now, now, now, conflictingSlot.id]
          );
          db.afterCommit(() => removeCachedRuntimeEmbedding(conflictingSlot.id, db));
        }
      }

      // 保存旧版本快照并标记 superseded
      saveVersionSnapshot(db, target, 'repair_revise', approvedBy, now);
      db.run(
        `UPDATE memories
         SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [now, now, now, target.id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(target.id, db));

      // 建立 supersedes 关系
      db.run(
        `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
         VALUES (?, ?, 'supersedes', '{}', ?)`,
        [candId, target.id, now]
      );

      // 激活候选记忆
      db.run(
        `UPDATE memories
         SET status = 'active', approved_at = ?, approved_by = ?, updated_at = ?
         WHERE id = ?`,
        [now, approvedBy, now, candId]
      );
    } else if (proposal.action === 'split') {
      if (candidateIds.length < 2 || candidateIds.length > 3) {
        return { ok: false, reason: 'Split proposal must have 2-3 candidate ids' };
      }

      // 检查子候选间槽位冲突（全部前置校验通过后才写库）
      const seenSlots = new Set<string>();
      const slotConflicts: MemoryRecord[] = [];
      for (const cid of candidateIds) {
        const cMem = hydrateMemoryRow(db.get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [cid]));
        if (!cMem || cMem.status !== 'candidate') {
          return { ok: false, reason: `Candidate ${cid} not found or not in candidate status` };
        }
        if (!sameMemoryOwner(target, cMem)) {
          return { ok: false, reason: 'Repair candidates must belong to the target scope' };
        }
        if (cMem.slot_key) {
          if (seenSlots.has(cMem.slot_key)) {
            return {
              ok: false,
              reason: `Conflicting slot_key '${cMem.slot_key}' among split candidates`,
            };
          }
          seenSlots.add(cMem.slot_key);

          const conflictingSlot = hydrateMemoryRow(
            db.get<MemoryRow>(
              `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id NOT IN (?, ?)`,
              [
                cMem.scope,
                cMem.workspace_id || '',
                cMem.session_id || '',
                cMem.slot_key,
                target.id,
                cid,
              ]
            )
          );
          if (conflictingSlot) {
            if (conflictingSlot.status === 'frozen') {
              return { ok: false, reason: `Slot '${cMem.slot_key}' is frozen` };
            }
            if (conflictingSlot.pinned && !trustedApprover) {
              return { ok: false, reason: `Slot '${cMem.slot_key}' is pinned` };
            }
            slotConflicts.push(conflictingSlot);
          }
        }
      }

      for (const conflictingSlot of slotConflicts) {
        saveVersionSnapshot(db, conflictingSlot, 'repair_slot_supersede', approvedBy, now);
        db.run(
          `UPDATE memories SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [now, now, now, conflictingSlot.id]
        );
        db.afterCommit(() => removeCachedRuntimeEmbedding(conflictingSlot.id, db));
      }

      // 保存快照并将目标置为 superseded
      saveVersionSnapshot(db, target, 'repair_split', approvedBy, now);
      db.run(
        `UPDATE memories
         SET status = 'superseded', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [now, now, now, target.id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(target.id, db));

      // 逐个激活各子候选并建立 supersedes 关系
      for (const cid of candidateIds) {
        db.run(
          `INSERT OR REPLACE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
           VALUES (?, ?, 'supersedes', '{}', ?)`,
          [cid, target.id, now]
        );
        db.run(
          `UPDATE memories
           SET status = 'active', approved_at = ?, approved_by = ?, updated_at = ?
           WHERE id = ?`,
          [now, approvedBy, now, cid]
        );
      }
    } else if (proposal.action === 'invalidate') {
      // invalidate 归档原记录并标记失效时间
      saveVersionSnapshot(db, target, 'repair_invalidate', approvedBy, now);
      db.run(
        `UPDATE memories
         SET status = 'archived', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [now, now, now, target.id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(target.id, db));
    }

    // 4. 更新提案状态为 approved
    db.run(
      `UPDATE repair_proposals
       SET status = 'approved', approved_at = ?, approved_by = ?
       WHERE id = ?`,
      [now, approvedBy, proposal.id]
    );

    return { ok: true };
  });
}

/**
 * 用户拒绝修复提案 (/memory reject-repair <proposalId>, §5.17)
 */
export function rejectRepairProposal(
  db: Db,
  proposalId: number,
  now: number = Date.now()
): { ok: boolean; reason?: string } {
  return db.transaction(() => {
    const proposal = db.get<{
      id: number;
      memory_id: string;
      candidate_ids: string;
      status: string;
    }>('SELECT id, memory_id, candidate_ids, status FROM repair_proposals WHERE id = ?', [proposalId]);

    if (!proposal) {
      return { ok: false, reason: `Proposal #${proposalId} not found` };
    }
    if (proposal.status !== 'candidate') {
      return { ok: false, reason: `Proposal #${proposalId} is already ${proposal.status}` };
    }

    // 将关联的候选置为 rejected 并清理对应的 derived_from 关系
    const candidateIds = safeParseCandidateIds(proposal.candidate_ids) ?? [];
    for (const cid of candidateIds) {
      db.run(
        `UPDATE memories SET status = 'rejected', valid_to = ?, invalidated_at = ?, updated_at = ? WHERE id = ? AND status = 'candidate'`,
        [now, now, now, cid]
      );
      db.run(
        `DELETE FROM memory_relations WHERE from_id = ? AND to_id = ? AND rel = 'derived_from'`,
        [cid, proposal.memory_id]
      );
      db.afterCommit(() => removeCachedRuntimeEmbedding(cid, db));
    }

    // 提案置为 rejected
    db.run("UPDATE repair_proposals SET status = 'rejected' WHERE id = ?", [proposalId]);

    return { ok: true };
  });
}

/**
 * 列出修复提案
 */
export function listRepairProposals(db: Db, status?: string): RepairProposalRecord[] {
  let sql = 'SELECT * FROM repair_proposals';
  const params: any[] = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY id DESC';

  const rows = db.all<{
    id: number;
    job_id: number;
    memory_id: string;
    content_rev: number;
    action: 'revise' | 'split' | 'invalidate';
    candidate_ids: string;
    reason: string;
    status: 'candidate' | 'approved' | 'rejected';
    created_at: number;
    expires_at: number;
    approved_at: number | null;
    approved_by: string | null;
  }>(sql, params);

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    memoryId: r.memory_id,
    contentRev: r.content_rev,
    action: r.action,
    candidateIds: safeParseCandidateIds(r.candidate_ids) ?? [],
    reason: r.reason,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
  }));
}
