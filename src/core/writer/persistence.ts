import {
  hydrateMemoryRow,
  parseOriginKinds,
  type CandidateInput,
  type Db,
  type MemoryRow,
  type OriginKind,
  type Scope,
  type UpsertResult,
} from '../../types.js';
import { ftsText, extractEntities } from '../text.js';
import { computeLocalEmbedding, decodeEmbeddingBlob, encodeEmbeddingBlob } from '../vector.js';
import {
  generateId,
  truncateExcerpt,
  validateAndPrepareCandidate,
  type SanitizedSourceInput,
  type WriterLimits,
} from './validate.js';
import {
  addRelation,
  findActiveSlotOccupant,
  findExistingConflictCandidate,
  mergeIntoConflictCandidate,
  saveVersionSnapshot,
  schedulePrimeVectorCache,
  supersedeActiveSlot,
} from './slot-policy.js';
import { weaveRelatedMemoryIds } from './weave.js';

export { addRelation, saveVersionSnapshot } from './slot-policy.js';

export interface InsertRecordParams {
  c: CandidateInput;
  id: string;
  status: 'active' | 'candidate' | 'superseded';
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
  content: string;
  summary: string;
  token_cost: number;
  summary_cost: number;
  hash: string;
  slot_key: string | null;
  confidence: number;
  origin_kinds: OriginKind[];
  approved_at: number | null;
  approved_by: string | null;
  sources: SanitizedSourceInput[];
  now: number;
  embeddingVec?: Float32Array;
  invalidated_at?: number | null;
}

export function insertNewRecord(db: Db, params: InsertRecordParams): string {
  const {
    c,
    id,
    status,
    scope,
    workspace_id,
    session_id,
    content,
    summary,
    token_cost,
    summary_cost,
    hash,
    slot_key,
    confidence,
    origin_kinds,
    approved_at,
    approved_by,
    sources,
    now,
    embeddingVec,
    invalidated_at = null,
  } = params;

  const vec =
    embeddingVec ??
    computeLocalEmbedding(`${summary}\n${content}${slot_key ? `\n${slot_key}` : ''}`);
  const embeddingBlob = encodeEmbeddingBlob(vec);

  const res = db.run(
    `INSERT INTO memories (
      id, type, status, content, summary, slot_key, scope, workspace_id, session_id,
      origin_kinds, approved_at, approved_by, source_kind, confidence, utility,
      use_count, success_count, fail_count, token_cost, summary_cost, hash,
      version, content_rev, pinned, valid_from, valid_to, created_at, updated_at,
      importance, invalidated_at, embedding
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      c.type,
      status,
      content,
      summary,
      slot_key,
      scope,
      workspace_id,
      session_id,
      JSON.stringify(origin_kinds),
      approved_at,
      approved_by,
      c.source_kind,
      confidence,
      0.5, // utility
      0, // use_count
      0, // success_count
      0, // fail_count
      token_cost,
      summary_cost,
      hash,
      1, // version
      1, // content_rev
      0, // pinned
      c.valid_from || null,
      c.valid_to || null,
      now,
      now,
      Math.max(1, Math.min(10, c.importance || 5)),
      invalidated_at,
      embeddingBlob,
    ]
  );

  if (status !== 'superseded') {
    schedulePrimeVectorCache(db, id, hash, vec);
  }

  const rowid = Number(res.lastInsertRowid);

  // FTS
  const fts = ftsText(content + ' ' + summary);
  db.run(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`, [rowid, fts]);

  // 实体
  const entities =
    c.entities && c.entities.length > 0 ? c.entities : extractEntities(`${summary} ${content}`);
  for (const ent of entities) {
    const normEnt = ent.toLowerCase().replace(/\\/g, '/').trim();
    if (normEnt) {
      db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [
        id,
        normEnt,
      ]);
    }
  }

  // 证据 sources
  for (const s of sources) {
    db.run(
      `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 1, s.session_id, s.seq, s.kind, truncateExcerpt(s.excerpt), now]
    );
  }

  return id;
}

export function upsertCandidate(
  db: Db,
  c: CandidateInput,
  now: number = Date.now(),
  cfg?: WriterLimits
): UpsertResult {
  return db.transaction(() => {
    // 0 & 1. 校验、隐私、owner 与污点隔离后的可信状态计算
    const prepRes = validateAndPrepareCandidate(c, now, cfg);
    if (!prepRes.ok) {
      return { action: 'rejected', reason: prepRes.reason };
    }
    const prepared = prepRes.data;
    const {
      rawContent,
      rawSummary,
      contentTokens,
      summaryTokens,
      scope,
      workspace_id,
      session_id,
      originKinds,
      isExplicitUser,
      isTainted,
      initialStatus,
      approved_at,
      approved_by,
      confidence,
      hash,
      slotKey,
      sanitizedSources,
    } = prepared;

    // 2. 先检查槽位 (slot_key)
    if (slotKey) {
      const existingSlot = findActiveSlotOccupant(db, scope, workspace_id, session_id, slotKey);

      if (existingSlot && existingSlot.hash !== hash) {
        // 旧记录是 frozen 或新输入为 candidate -> 冲突挂起（同 hash 候选幂等合并，避免无限重复插入）
        if (existingSlot.status === 'frozen' || initialStatus === 'candidate') {
          const existingCand = findExistingConflictCandidate(db, prepared);
          if (existingCand) {
            const mergedCandId = mergeIntoConflictCandidate(
              db,
              existingCand,
              existingSlot.id,
              prepared,
              now
            );
            return { action: 'conflict_pending', id: mergedCandId, withId: existingSlot.id };
          }

          const candId = insertNewRecord(db, {
            c,
            id: generateId(),
            status: 'candidate',
            scope,
            workspace_id,
            session_id,
            content: rawContent,
            summary: rawSummary,
            token_cost: contentTokens,
            summary_cost: summaryTokens,
            hash,
            slot_key: slotKey,
            confidence,
            origin_kinds: originKinds,
            approved_at: null,
            approved_by: null,
            sources: sanitizedSources,
            now,
          });
          addRelation(db, candId, existingSlot.id, 'contradicts', now);
          return { action: 'conflict_pending', id: candId, withId: existingSlot.id };
        }

        // 回溯历史版本（valid_from 早于当前现行版本）
        if (c.valid_from && existingSlot.valid_from && c.valid_from < existingSlot.valid_from) {
          const histId = generateId();
          insertNewRecord(db, {
            c: { ...c, valid_to: existingSlot.valid_from },
            id: histId,
            status: 'superseded',
            scope,
            workspace_id,
            session_id,
            content: rawContent,
            summary: rawSummary,
            token_cost: contentTokens,
            summary_cost: summaryTokens,
            hash,
            slot_key: slotKey,
            confidence,
            origin_kinds: originKinds,
            approved_at: now,
            approved_by: approved_by ?? (c.actor || 'user'),
            sources: sanitizedSources,
            now,
            invalidated_at: existingSlot.valid_from,
          });
          addRelation(db, existingSlot.id, histId, 'supersedes', now);
          return { action: 'superseded', id: existingSlot.id, oldId: histId };
        }

        // 显式用户/系统新值 -> 统一 supersede 旧值并激活新值
        const newId = generateId();
        const actorName = c.actor || 'user';
        const supRes = supersedeActiveSlot(db, {
          scope,
          workspaceId: workspace_id,
          sessionId: session_id,
          slotKey,
          newOwnerId: newId,
          actor: actorName,
          now,
          reason: 'supersede',
        });
        if (!supRes.ok) {
          const candId = insertNewRecord(db, {
            c,
            id: newId,
            status: 'candidate',
            scope,
            workspace_id,
            session_id,
            content: rawContent,
            summary: rawSummary,
            token_cost: contentTokens,
            summary_cost: summaryTokens,
            hash,
            slot_key: slotKey,
            confidence,
            origin_kinds: originKinds,
            approved_at: null,
            approved_by: null,
            sources: sanitizedSources,
            now,
          });
          addRelation(db, candId, supRes.occupant.id, 'contradicts', now);
          return { action: 'conflict_pending', id: candId, withId: supRes.occupant.id };
        }

        insertNewRecord(db, {
          c,
          id: newId,
          status: 'active',
          scope,
          workspace_id,
          session_id,
          content: rawContent,
          summary: rawSummary,
          token_cost: contentTokens,
          summary_cost: summaryTokens,
          hash,
          slot_key: slotKey,
          confidence,
          origin_kinds: originKinds,
          approved_at: now,
          approved_by: approved_by ?? actorName,
          sources: sanitizedSources,
          now,
        });

        return { action: 'superseded', id: newId, oldId: existingSlot.id };
      }
    }

    // 3. 精确去重 (Merge)
    const existingSameRaw = db.get<MemoryRow>(
      `SELECT * FROM memories
       WHERE type = ?
         AND scope = ?
         AND COALESCE(workspace_id, '') = ?
         AND COALESCE(session_id, '') = ?
         AND COALESCE(slot_key, '') = ?
         AND hash = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'frozen' THEN 1 WHEN 'candidate' THEN 2 ELSE 3 END ASC, updated_at DESC
       LIMIT 1`,
      [c.type, scope, workspace_id || '', session_id || '', slotKey || '', hash]
    );
    const existingSame = hydrateMemoryRow(existingSameRaw);

    if (existingSame) {
      const existingOrigins = parseOriginKinds(existingSame.origin_kinds);
      const mergedOriginKinds = Array.from(
        new Set<OriginKind>([...existingOrigins, ...originKinds])
      );
      const mergedTainted =
        mergedOriginKinds.includes('tool') ||
        mergedOriginKinds.includes('web') ||
        existingSame.source_kind === 'web' ||
        existingSame.source_kind === 'tool' ||
        isTainted;

      const isInactive =
        existingSame.status === 'superseded' ||
        existingSame.status === 'archived' ||
        existingSame.status === 'rejected';
      const hasMissingSource = sanitizedSources.some(
        (s) =>
          !db.get(
            `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ? AND session_id = ? AND seq = ?`,
            [existingSame.id, existingSame.content_rev, s.session_id, s.seq]
          )
      );
      const isReplay = !hasMissingSource;
      const approver = c.actor || 'user';

      // 若旧记录已处于 superseded / archived / rejected 状态，显式用户/系统确认时重新激活 (避免 A->B->A 状态死锁)
      if (isInactive && (isExplicitUser || initialStatus === 'active')) {
        saveVersionSnapshot(db, existingSame, 'reactivate', approver, now);
        for (const s of sanitizedSources) {
          db.run(
            `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existingSame.id, existingSame.content_rev, s.session_id, s.seq, s.kind, s.excerpt, now]
          );
        }
        const reactivatedConf = mergedTainted ? Math.min(confidence, 0.5) : confidence;
        db.run(
          `UPDATE memories
           SET status = 'active',
               valid_to = NULL,
               invalidated_at = NULL,
               confidence = ?,
               origin_kinds = ?,
               approved_at = ?,
               approved_by = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?`,
          [
            reactivatedConf,
            JSON.stringify(mergedOriginKinds),
            now,
            approver,
            now,
            existingSame.id,
          ]
        );
        const existingVec = decodeEmbeddingBlob(existingSame.embedding);
        if (existingVec) {
          schedulePrimeVectorCache(db, existingSame.id, existingSame.hash, existingVec);
        }
        return { action: 'merged', id: existingSame.id };
      }

      // 同一证据再次重放，confidence/use_count/archived 状态保持不变（仅当候选新增污点来源时收紧污点）
      if (isReplay) {
        if (
          existingSame.status === 'candidate' &&
          mergedOriginKinds.length !== existingOrigins.length
        ) {
          const clampedConf = mergedTainted
            ? Math.min(existingSame.confidence, 0.5)
            : existingSame.confidence;
          db.run(
            `UPDATE memories SET origin_kinds = ?, confidence = ? WHERE id = ?`,
            [JSON.stringify(mergedOriginKinds), clampedConf, existingSame.id]
          );
        }
        return { action: 'merged', id: existingSame.id };
      }

      if (isInactive) {
        // 非显式用户的新证据再次命中已归档/取代/拒绝记录：递增 content_rev 隔离旧证据并清除旧审批与置顶标记
        const nextContentRev = existingSame.content_rev + 1;
        saveVersionSnapshot(db, existingSame, 'resurrect_candidate', c.actor || 'system', now);
        for (const s of sanitizedSources) {
          db.run(
            `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existingSame.id, nextContentRev, s.session_id, s.seq, s.kind, s.excerpt, now]
          );
        }
        const resurrectedConf = mergedTainted ? Math.min(confidence, 0.5) : confidence;
        db.run(
          `UPDATE memories
           SET status = 'candidate',
               content_rev = ?,
               version = version + 1,
               approved_at = NULL,
               approved_by = NULL,
               pinned = 0,
               valid_to = NULL,
               invalidated_at = NULL,
               origin_kinds = ?,
               confidence = ?,
               updated_at = ?
           WHERE id = ?`,
          [
            nextContentRev,
            JSON.stringify(mergedOriginKinds),
            resurrectedConf,
            now,
            existingSame.id,
          ]
        );
        return { action: 'merged', id: existingSame.id };
      }

      for (const s of sanitizedSources) {
        db.run(
          `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [existingSame.id, existingSame.content_rev, s.session_id, s.seq, s.kind, s.excerpt, now]
        );
      }

      // 显式用户/系统确认且之前是 candidate，则快照并晋升激活
      if (isExplicitUser && existingSame.status === 'candidate') {
        saveVersionSnapshot(db, existingSame, 'approve', approver, now);
        const promotedConf = mergedTainted
          ? Math.min(existingSame.confidence, 0.5)
          : Math.max(existingSame.confidence, confidence);
        db.run(
          `UPDATE memories
           SET status = 'active',
               approved_at = ?,
               approved_by = ?,
               confidence = ?,
               origin_kinds = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?`,
          [
            now,
            approver,
            promotedConf,
            JSON.stringify(mergedOriginKinds),
            now,
            existingSame.id,
          ]
        );
      } else if (existingSame.status === 'candidate') {
        // 未批准记录使用 noisy-or 聚合独立证据，并在任一已合并来源含 web/tool 污点时强制封顶 0.5
        let newConf = 1 - (1 - existingSame.confidence) * (1 - confidence);
        if (mergedTainted) {
          newConf = Math.min(newConf, 0.5);
        }
        db.run(
          `UPDATE memories
           SET confidence = ?,
               origin_kinds = ?,
               updated_at = ?
           WHERE id = ?`,
          [newConf, JSON.stringify(mergedOriginKinds), now, existingSame.id]
        );
      } else if (existingSame.status === 'active' && !isTainted) {
        if (mergedOriginKinds.length !== existingOrigins.length) {
          db.run(`UPDATE memories SET origin_kinds = ?, updated_at = ? WHERE id = ?`, [
            JSON.stringify(mergedOriginKinds),
            now,
            existingSame.id,
          ]);
        }
      }

      return { action: 'merged', id: existingSame.id };
    }

    // 4. A-Mem (NeurIPS 2025) Zettelkasten 动态关联织网
    const { relatedIds, newVec } = weaveRelatedMemoryIds(
      db,
      {
        scope,
        workspace_id,
        session_id,
        type: c.type,
        rawContent,
        rawSummary,
        slotKey,
        hash,
        entities: c.entities,
      },
      cfg
    );

    // 5. 插入新记录
    const newId = generateId();
    insertNewRecord(db, {
      c,
      id: newId,
      status: initialStatus,
      scope,
      workspace_id,
      session_id,
      content: rawContent,
      summary: rawSummary,
      token_cost: contentTokens,
      summary_cost: summaryTokens,
      hash,
      slot_key: slotKey,
      confidence,
      origin_kinds: originKinds,
      approved_at,
      approved_by,
      sources: sanitizedSources,
      now,
      embeddingVec: newVec,
    });

    for (const relId of relatedIds) {
      addRelation(db, newId, relId, 'related', now);
    }

    return { action: 'inserted', id: newId };
  });
}
