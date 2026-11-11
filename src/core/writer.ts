import crypto from 'node:crypto';
import type {
  Db,
  CandidateInput,
  UpsertResult,
  MemoryRecord,
  Scope,
  OriginKind,
} from '../types.js';
import { DEFAULTS } from '../config.js';
import {
  normalize,
  segment,
  ftsText,
  tokenSet,
  jaccard,
  contentHash,
  extractEntities,
} from './text.js';
import { estimateTokens } from './tokens.js';
import { workspaceId } from './scope.js';
import { redactSecrets } from './privacy.js';
import { hasUserEvidence } from './trust.js';
import {
  computeLocalEmbedding,
  cosineSimilarity,
  encodeEmbeddingBlob,
  getOrComputeEmbedding,
  primeRuntimeVectorCache,
  removeCachedRuntimeEmbedding,
} from './vector.js';

function generateId(): string {
  const chars = '0123456789abcdefghjkmnpqrstvwxyz';
  let id = 'm_';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function resolveScopeAndOwners(c: CandidateInput): {
  scope: Scope;
  workspace_id: string | null;
  session_id: string | null;
} {
  let scope: Scope = c.scope || DEFAULTS.defaultScope;
  if (!c.scope) {
    if (c.type === 'preference') scope = 'user';
    else if (c.type === 'meta') scope = 'global';
    else scope = 'workspace';
  }

  let workspace_id: string | null = null;
  let session_id: string | null = null;

  if (scope === 'workspace') {
    workspace_id = c.workspaceId ? workspaceId(c.workspaceId) : workspaceId(process.cwd());
  } else if (scope === 'session') {
    workspace_id = c.workspaceId ? workspaceId(c.workspaceId) : workspaceId(process.cwd());
    session_id = c.sessionId || 'default_session';
  }

  return { scope, workspace_id, session_id };
}

function deriveOriginKinds(c: CandidateInput): OriginKind[] {
  const originSet = new Set<OriginKind>();
  if (Array.isArray(c.origin_kinds)) {
    for (const ok of c.origin_kinds) originSet.add(ok);
  }
  if (Array.isArray(c.sources)) {
    for (const s of c.sources) {
      if (s.kind === 'user' || s.kind === 'user_msg') originSet.add('user');
      else if (s.kind === 'tool' || s.kind === 'tool_result') originSet.add('tool');
      else if (s.kind === 'assistant' || s.kind === 'assistant_msg') originSet.add('assistant');
      else if (s.kind === 'web') originSet.add('web');
      else if (s.kind === 'system') originSet.add('system');
    }
  }
  if (c.source_kind === 'web') originSet.add('web');
  if (c.source_kind === 'tool') originSet.add('tool');

  return Array.from(originSet);
}

export function upsertCandidate(db: Db, c: CandidateInput, now: number = Date.now()): UpsertResult {
  return db.transaction(() => {
    // 0. 校验、隐私与 owner
    const rawContent = (c.content || '').trim();
    if (!rawContent) {
      return { action: 'rejected', reason: 'empty_content' };
    }

    // 隐私扫描
    const privCheck = redactSecrets(rawContent);
    if (privCheck.hasSensitive) {
      return { action: 'rejected', reason: 'sensitive_content_detected' };
    }

    const contentTokens = estimateTokens(rawContent);
    if (contentTokens > DEFAULTS.maxContentTokens) {
      return { action: 'rejected', reason: 'content_exceeds_max_tokens' };
    }

    let rawSummary = (c.summary || '').trim();
    if (!rawSummary) {
      // 生成首句
      const match = rawContent.match(/^[^。！？\n.!?]+[。！？\n.!?]?/);
      rawSummary = match ? match[0].trim() : rawContent.slice(0, 80);
    }
    if (redactSecrets(rawSummary).hasSensitive) {
      return { action: 'rejected', reason: 'sensitive_content_detected' };
    }
    const summaryTokens = estimateTokens(rawSummary);
    if (summaryTokens > DEFAULTS.maxSummaryTokens) {
      rawSummary = rawSummary.slice(0, 100);
    }

    if (!c.sources || !Array.isArray(c.sources) || c.sources.length === 0) {
      return { action: 'rejected', reason: 'sources_required' };
    }
    if (c.sources.some((s) => s.excerpt && redactSecrets(s.excerpt).hasSensitive)) {
      return { action: 'rejected', reason: 'sensitive_content_detected' };
    }
    if (false) {
      return { action: 'rejected', reason: 'sources_required' };
    }

    const { scope, workspace_id, session_id } = resolveScopeAndOwners(c);
    const originKinds = deriveOriginKinds(c);

    // 1. 计算可信状态
    let isExplicitUser = false;
    if (
      (c.source_kind === 'user' && c.actor === 'user') ||
      (c.status === 'active' && (c.actor === 'user' || c.actor === 'system'))
    ) {
      isExplicitUser = true;
    }

    let initialStatus: 'active' | 'candidate' = 'candidate';
    let approved_at: number | null = null;
    let approved_by: string | null = null;

    if (isExplicitUser) {
      initialStatus = 'active';
      approved_at = now;
      approved_by = c.actor || 'user';
    }

    let confidence = typeof c.confidence === 'number' && Number.isFinite(c.confidence) ? c.confidence : 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    if (c.actor === 'llm') {
      confidence *= 0.8;
    }
    if (originKinds.includes('tool') || originKinds.includes('web') || c.source_kind === 'web' || c.source_kind === 'tool') {
      confidence = Math.min(confidence, 0.5);
      initialStatus = 'candidate';
    }

    const hash = contentHash(c.type, rawContent);
    const slotKey = c.slot_key || null;

    // 2. 先检查槽位 (slot_key)
    if (slotKey) {
      const existingSlot = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen')`,
        [scope, workspace_id || '', session_id || '', slotKey]
      );

      if (existingSlot) {
        if (existingSlot.hash !== hash) {
          // 旧记录是 frozen
          if (existingSlot.status === 'frozen') {
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
              summary_cost: estimateTokens(rawSummary),
              hash,
              slot_key: slotKey,
              confidence,
              origin_kinds: originKinds,
              approved_at: null,
              approved_by: null,
              now,
            });
            addRelation(db, candId, existingSlot.id, 'contradicts', now);
            return { action: 'conflict_pending', id: candId, withId: existingSlot.id };
          }

          // 新输入为 candidate
          if (initialStatus === 'candidate') {
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
              summary_cost: estimateTokens(rawSummary),
              hash,
              slot_key: slotKey,
              confidence,
              origin_kinds: originKinds,
              approved_at: null,
              approved_by: null,
              now,
            });
            addRelation(db, candId, existingSlot.id, 'contradicts', now);
            return { action: 'conflict_pending', id: candId, withId: existingSlot.id };
          }

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
              summary_cost: estimateTokens(rawSummary),
              hash,
              slot_key: slotKey,
              confidence,
              origin_kinds: originKinds,
              approved_at: now,
              approved_by: 'user',
              now,
            });
            addRelation(db, existingSlot.id, histId, 'supersedes', now);
            return { action: 'superseded', id: existingSlot.id, oldId: histId };
          }
          // 显式用户新值 -> supersede 旧值并激活新值
          saveVersionSnapshot(db, existingSlot, 'supersede', c.actor, now);
          db.run(
            `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
            [now, now, existingSlot.id]
          );

          const newId = generateId();
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
            summary_cost: estimateTokens(rawSummary),
            hash,
            slot_key: slotKey,
            confidence,
            origin_kinds: originKinds,
            approved_at: now,
            approved_by: 'user',
            now,
          });

          addRelation(db, newId, existingSlot.id, 'supersedes', now);
          return { action: 'superseded', id: newId, oldId: existingSlot.id };
        }
      }
    }

    // 3. 精确去重 (Merge)
    const existingSame = db.get<MemoryRecord>(
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

    if (existingSame) {
      const isInactive =
        existingSame.status === 'superseded' ||
        existingSame.status === 'archived' ||
        existingSame.status === 'rejected';
      const hasMissingSource = c.sources.some(
        (s) =>
          !db.get(
            `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ? AND session_id = ? AND seq = ?`,
            [existingSame.id, existingSame.content_rev, s.session_id, s.seq]
          )
      );
      const isReplay = !hasMissingSource;

      // 若旧记录已处于 superseded / archived / rejected 状态，用户显式确认时必须重新激活 (避免 A->B->A 状态死锁)
      if (isInactive && (isExplicitUser || initialStatus === 'active')) {
        for (const s of c.sources) {
          db.run(
            `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existingSame.id, existingSame.content_rev, s.session_id, s.seq, s.kind, s.excerpt || null, now]
          );
        }
        db.run(
          `UPDATE memories
           SET status = 'active',
               valid_to = NULL,
               invalidated_at = NULL,
               confidence = ?,
               approved_at = ?,
               approved_by = ?,
               version = version + 1,
               updated_at = ?
           WHERE id = ?`,
          [confidence, now, isExplicitUser ? 'user' : c.actor || 'user', now, existingSame.id]
        );
        return { action: 'merged', id: existingSame.id };
      }

      // 同一证据再次重放，confidence/use_count/archived 状态保持不变
      if (isReplay) {
        return { action: 'merged', id: existingSame.id };
      }

      if (isInactive) {
        // 非显式用户的新证据再次命中已归档/取代/拒绝记录：递增 content_rev 隔离旧证据并清除旧审批与置顶标记
        const nextContentRev = existingSame.content_rev + 1;
        saveVersionSnapshot(db, existingSame, 'resurrect_candidate', c.actor || 'system', now);
        for (const s of c.sources) {
          db.run(
            `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existingSame.id, nextContentRev, s.session_id, s.seq, s.kind, s.excerpt || null, now]
          );
        }
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
               confidence = ?,
               updated_at = ?
           WHERE id = ?`,
          [nextContentRev, confidence, now, existingSame.id]
        );
        return { action: 'merged', id: existingSame.id };
      }

      for (const s of c.sources) {
        db.run(
          `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [existingSame.id, existingSame.content_rev, s.session_id, s.seq, s.kind, s.excerpt || null, now]
        );
      }

      // 用户确认且之前是 candidate，则激活
      if (isExplicitUser && existingSame.status === 'candidate') {
        db.run(
          `UPDATE memories SET status = 'active', approved_at = ?, approved_by = 'user', updated_at = ? WHERE id = ?`,
          [now, now, existingSame.id]
        );
      } else if (existingSame.status === 'candidate') {
        // 未批准记录使用 noisy-or 聚合独立证据
        let newConf = 1 - (1 - existingSame.confidence) * (1 - confidence);
        if (originKinds.includes('tool') || originKinds.includes('web')) {
          newConf = Math.min(newConf, 0.5);
        }
        db.run(
          `UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`,
          [newConf, now, existingSame.id]
        );
      }

      return { action: 'merged', id: existingSame.id };
    }

    // 4. A-Mem (NeurIPS 2025) Zettelkasten 动态关联织网：结合 128D 本地向量余弦 + 实体共现 + 词汇 Jaccard 建立 related 双链
    const candidatesInScope = db.all<{
      id: string;
      type: string;
      summary: string;
      content: string;
      slot_key: string | null;
      hash: string;
      embedding: Uint8Array | Buffer | null;
    }>(
      `SELECT id, type, summary, content, slot_key, hash, embedding
       FROM memories
       WHERE scope = ?
         AND COALESCE(workspace_id, '') = ?
         AND status IN ('active', 'candidate', 'frozen')
         AND COALESCE(session_id, '') = ?
         AND type != 'meta'
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       ORDER BY (CASE WHEN type = ? THEN 0 ELSE 1 END) ASC, utility DESC, updated_at DESC
       LIMIT 24`,
      [scope, workspace_id || '', session_id || '', c.type]
    );

    const newTokens = tokenSet(rawContent);
    const newVec = computeLocalEmbedding(`${rawSummary}\n${rawContent}${slotKey ? `\n${slotKey}` : ''}`);
    const newEntList = (
      c.entities && c.entities.length > 0
        ? c.entities
        : extractEntities(`${rawSummary} ${rawContent}`)
    ).map((e) => e.toLowerCase().replace(/\\/g, '/').trim());
    const newEntSet = new Set(newEntList);

    const scoredRelations: Array<{ id: string; affinity: number }> = [];
    for (const cand of candidatesInScope) {
      if (cand.hash === hash) continue;
      if (slotKey && cand.slot_key && cand.slot_key === slotKey) continue;

      const jaccardSim = jaccard(newTokens, tokenSet(cand.content));
      const candVec = getOrComputeEmbedding(cand);
      const vecSim = candVec ? Math.max(0, cosineSimilarity(newVec, candVec)) : 0;

      let sharedEnts = 0;
      if (newEntSet.size > 0) {
        const candEnts = extractEntities(`${cand.summary} ${cand.content}`).map((e) =>
          e.toLowerCase().replace(/\\/g, '/').trim()
        );
        for (const ce of candEnts) {
          if (newEntSet.has(ce)) sharedEnts++;
        }
      }

      const entBonus = Math.min(1, sharedEnts / 2);
      const affinity = 0.45 * vecSim + 0.35 * jaccardSim + 0.2 * entBonus;

      if (
        jaccardSim >= DEFAULTS.dupJaccard ||
        affinity >= 0.48 ||
        (sharedEnts >= 2 && vecSim >= 0.42)
      ) {
        scoredRelations.push({ id: cand.id, affinity: Math.max(jaccardSim, affinity) });
      }
    }

    scoredRelations.sort((a, b) => b.affinity - a.affinity);
    const relatedIds = scoredRelations.slice(0, 3).map((r) => r.id);

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
      summary_cost: estimateTokens(rawSummary),
      hash,
      slot_key: slotKey,
      confidence,
      origin_kinds: originKinds,
      approved_at,
      approved_by,
      now,
      embeddingVec: newVec,
    });

    for (const relId of relatedIds) {
      addRelation(db, newId, relId, 'related', now);
    }

    return { action: 'inserted', id: newId };
  });
}

function insertNewRecord(
  db: Db,
  params: {
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
    now: number;
    embeddingVec?: Float32Array;
  }
): string {
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
    now,
    embeddingVec,
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
      null, // invalidated_at
      embeddingBlob,
    ]
  );

  primeRuntimeVectorCache(id, hash, vec);

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
      db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [id, normEnt]);
    }
  }

  // 证据 sources
  for (const s of c.sources) {
    db.run(
      `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, 1, s.session_id, s.seq, s.kind, s.excerpt || null, now]
    );
  }

  return id;
}

export function addRelation(db: Db, from_id: string, to_id: string, rel: string, now: number) {
  db.run(
    `INSERT OR IGNORE INTO memory_relations(from_id, to_id, rel, metadata, created_at) VALUES (?, ?, ?, '{}', ?)`,
    [from_id, to_id, rel, now]
  );
}

export function saveVersionSnapshot(
  db: Db,
  record: MemoryRecord,
  reason: string,
  actor: string,
  now: number
) {
  const { embedding, rowid_, ...snapshotObj } = record;
  db.run(
    `INSERT OR REPLACE INTO memory_versions(memory_id, version, snapshot, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [record.id, record.version, JSON.stringify(snapshotObj), reason, actor, now]
  );
}

/**
 * 批准候选记忆
 */
export function approveCandidate(
  db: Db,
  id: string,
  approvedBy: string = 'user',
  now: number = Date.now()
): { action: 'approved'; id: string } | { action: 'superseded'; id: string; oldId: string } | { action: 'rejected'; reason: string } {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) {
      return { action: 'rejected', reason: 'not_found' };
    }
    if (memory.status !== 'candidate') {
      return { action: 'rejected', reason: `invalid_status_${memory.status}` };
    }
    if (approvedBy !== 'user' && approvedBy !== 'system' && !hasUserEvidence(db, memory)) {
      return { action: 'rejected', reason: 'user_evidence_required' };
    }

    // 检查是否有未决的 repair_proposals (原记忆或候选记忆均不能单独批准)
    const pendingRepair = db.get(
      `SELECT 1 FROM repair_proposals WHERE (memory_id = ? OR candidate_ids LIKE ?) AND status = 'candidate'`,
      [id, `%"${id}"%`]
    );
    if (pendingRepair) {
      return { action: 'rejected', reason: 'pending_repair_proposals' };
    }

    const isCoreBlock = Boolean(memory.slot_key?.startsWith('core:'));

    // 检查槽位冲突
    if (memory.slot_key) {
      const existingSlot = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id != ?`,
        [memory.scope, memory.workspace_id || '', memory.session_id || '', memory.slot_key, id]
      );

      if (existingSlot) {
        if (existingSlot.status === 'frozen') {
          return { action: 'rejected', reason: 'slot_is_frozen' };
        }
        // Supersede 旧记录
        saveVersionSnapshot(db, existingSlot, 'supersede', approvedBy, now);
        db.run(
          `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [now, now, existingSlot.id]
        );
        addRelation(db, memory.id, existingSlot.id, 'supersedes', now);

        db.run(
          `UPDATE memories SET status = 'active', approved_at = ?, approved_by = ?, pinned = CASE WHEN ? THEN 1 ELSE pinned END, importance = CASE WHEN ? THEN 10 ELSE importance END, utility = CASE WHEN ? THEN 1.0 ELSE utility END, updated_at = ? WHERE id = ?`,
          [now, approvedBy, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, now, id]
        );
        return { action: 'superseded', id: memory.id, oldId: existingSlot.id };
      }
    }

    db.run(
      `UPDATE memories SET status = 'active', approved_at = ?, approved_by = ?, pinned = CASE WHEN ? THEN 1 ELSE pinned END, importance = CASE WHEN ? THEN 10 ELSE importance END, utility = CASE WHEN ? THEN 1.0 ELSE utility END, updated_at = ? WHERE id = ?`,
      [now, approvedBy, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, isCoreBlock ? 1 : 0, now, id]
    );
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
  now: number = Date.now()
): { ok: boolean; version: number; content_rev: number } {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) throw new Error('memory_not_found');
    if (memory.status === 'frozen') throw new Error('memory_is_frozen');

    const rawContent = newContent.trim();
    const privCheck = redactSecrets(rawContent);
    if (privCheck.hasSensitive) throw new Error('sensitive_content_detected');

    const contentTokens = estimateTokens(rawContent);
    if (contentTokens > DEFAULTS.maxContentTokens) throw new Error('content_exceeds_max_tokens');

    let rawSummary = (newSummary || '').trim();
    if (!rawSummary) {
      const match = rawContent.match(/^[^。！？\n.!?]+[。！？\n.!?]?/);
      rawSummary = match ? match[0].trim() : rawContent.slice(0, 80);
    }

    if (redactSecrets(rawSummary).hasSensitive) throw new Error('sensitive_content_detected');
    if (estimateTokens(rawSummary) > DEFAULTS.maxSummaryTokens) {
      rawSummary = rawSummary.slice(0, 100);
    }
    saveVersionSnapshot(db, memory, 'edit', actor, now);

    const nextVersion = memory.version + 1;
    const nextContentRev = memory.content_rev + 1;
    const newHash = contentHash(memory.type, rawContent);
    const updatedVec = computeLocalEmbedding(
      `${rawSummary}\n${rawContent}${memory.slot_key ? `\n${memory.slot_key}` : ''}`
    );

    db.run(
      `UPDATE memories SET content = ?, summary = ?, token_cost = ?, summary_cost = ?, hash = ?, version = ?, content_rev = ?, embedding = ?, updated_at = ? WHERE id = ?`,
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
    removeCachedRuntimeEmbedding(id);
    primeRuntimeVectorCache(id, newHash, updatedVec);

    // 重建 FTS
    const rowid = memory.rowid_!;
    db.run(`DELETE FROM memory_fts WHERE rowid = ?`, [rowid]);
    db.run(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`, [
      rowid,
      ftsText(rawContent + ' ' + rawSummary),
    ]);

    // 重建 entities
    db.run(`DELETE FROM memory_entities WHERE memory_id = ?`, [id]);
    const entities = extractEntities(`${rawSummary} ${rawContent}`);
    for (const ent of entities) {
      const normEnt = ent.toLowerCase().replace(/\\/g, '/').trim();
      if (normEnt) {
        db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [id, normEnt]);
      }
    }

    return { ok: true, version: nextVersion, content_rev: nextContentRev };
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
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) throw new Error('memory_not_found');
    if (memory.status === 'frozen') throw new Error('memory_is_frozen');

    const versionRow = db.get<{ snapshot: string }>(
      `SELECT snapshot FROM memory_versions WHERE memory_id = ? AND version = ?`,
      [id, targetVersion]
    );
    if (!versionRow) throw new Error('target_version_not_found');

    const snapshot: MemoryRecord = JSON.parse(versionRow.snapshot);
    const nextSlotKey = snapshot.slot_key !== undefined ? snapshot.slot_key : memory.slot_key;
    if (nextSlotKey && memory.status === 'active') {
      const slotConflict = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id != ?`,
        [memory.scope, memory.workspace_id || '', memory.session_id || '', nextSlotKey, id]
      );
      if (slotConflict) {
        if (slotConflict.status === 'frozen') throw new Error('slot_is_frozen');
        saveVersionSnapshot(db, slotConflict, 'supersede_by_rollback', actor, now);
        db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`, [now, now, slotConflict.id]);
        removeCachedRuntimeEmbedding(slotConflict.id);
      }
    }
    saveVersionSnapshot(db, memory, 'rollback', actor, now);

    const nextVersion = memory.version + 1;
    const nextContentRev = memory.content_rev + 1;
    const rollbackHash = snapshot.hash || contentHash(memory.type, snapshot.content);
    const rollbackVec = computeLocalEmbedding(
      `${snapshot.summary}\n${snapshot.content}${memory.slot_key ? `\n${memory.slot_key}` : ''}`
    );

    db.run(
      `UPDATE memories SET content = ?, summary = ?, token_cost = ?, summary_cost = ?, hash = ?, version = ?, content_rev = ?, embedding = ?, updated_at = ? WHERE id = ?`,
      [
        snapshot.content,
        snapshot.summary,
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
    removeCachedRuntimeEmbedding(id);
    if (nextSlotKey !== memory.slot_key) {
      db.run(`UPDATE memories SET slot_key = ? WHERE id = ?`, [nextSlotKey, id]);
    }
    primeRuntimeVectorCache(id, rollbackHash, rollbackVec);

    // 重建 FTS
    const rowid = memory.rowid_!;
    db.run(`DELETE FROM memory_fts WHERE rowid = ?`, [rowid]);
    db.run(`INSERT INTO memory_fts(rowid, fts_text) VALUES (?, ?)`, [
      rowid,
      ftsText(snapshot.content + ' ' + snapshot.summary),
    ]);

    // 重建 entities
    db.run(`DELETE FROM memory_entities WHERE memory_id = ?`, [id]);
    const entities = extractEntities(`${snapshot.summary} ${snapshot.content}`);
    for (const ent of entities) {
      const normEnt = ent.toLowerCase().replace(/\\/g, '/').trim();
      if (normEnt) {
        db.run(`INSERT OR IGNORE INTO memory_entities(memory_id, entity) VALUES (?, ?)`, [id, normEnt]);
      }
    }

    return { ok: true, version: nextVersion, content_rev: nextContentRev };
  });
}

/**
 * 遗忘记忆 (置为 archived，记录保留)
 */
export function forget(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return false;

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(`UPDATE memories SET status = 'archived', version = version + 1, updated_at = ? WHERE id = ?`, [now, id]);
    removeCachedRuntimeEmbedding(id);
    return true;
  });
}

/**
 * 冻结记忆
 */
export function freeze(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return false;

    if (memory.slot_key && memory.status !== 'active' && memory.status !== 'frozen') {
      const slotConflict = db.get<MemoryRecord>(
        `SELECT * FROM memories
         WHERE scope = ?
           AND IFNULL(workspace_id, '') = IFNULL(?, '')
           AND IFNULL(session_id, '') = IFNULL(?, '')
           AND slot_key = ?
           AND status IN ('active', 'frozen')
           AND id != ?`,
        [memory.scope, memory.workspace_id, memory.session_id, memory.slot_key, id]
      );
      if (slotConflict) {
        if (slotConflict.status === 'frozen') return false;
        saveVersionSnapshot(db, slotConflict, 'supersede_by_freeze', actor, now);
        db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`, [
          now,
          now,
          slotConflict.id,
        ]);
        removeCachedRuntimeEmbedding(slotConflict.id);
      }
    }

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(`UPDATE memories SET status = 'frozen', version = version + 1, updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * 解冻记忆
 */
export function unfreeze(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return false;

    if (memory.slot_key && memory.status !== 'active' && memory.status !== 'frozen') {
      const slotConflict = db.get<MemoryRecord>(
        `SELECT * FROM memories
         WHERE scope = ?
           AND IFNULL(workspace_id, '') = IFNULL(?, '')
           AND IFNULL(session_id, '') = IFNULL(?, '')
           AND slot_key = ?
           AND status IN ('active', 'frozen')
           AND id != ?`,
        [memory.scope, memory.workspace_id, memory.session_id, memory.slot_key, id]
      );
      if (slotConflict) {
        if (slotConflict.status === 'frozen') return false;
        saveVersionSnapshot(db, slotConflict, 'supersede_by_unfreeze', actor, now);
        db.run(`UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`, [
          now,
          now,
          slotConflict.id,
        ]);
        removeCachedRuntimeEmbedding(slotConflict.id);
      }
    }

    saveVersionSnapshot(db, memory, 'status', actor, now);
    if (memory.status !== 'frozen' && memory.status !== 'active') return false;
    if (memory.status === 'active') return true;
    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(`UPDATE memories SET status = 'active', version = version + 1, updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * 置顶记忆
 */
export function pin(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return false;

    db.run(`UPDATE memories SET pinned = 1, updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * 取消置顶
 */
export function unpin(db: Db, id: string, actor: string = 'user', now: number = Date.now()): boolean {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return false;

    db.run(`UPDATE memories SET pinned = 0, updated_at = ? WHERE id = ?`, [now, id]);
    return true;
  });
}

/**
 * 效用与使用计数更新
 */
export function applyUtility(
  db: Db,
  id: string,
  utility: number,
  deltaSuccess: number = 0,
  deltaFail: number = 0,
  now: number = Date.now()
): void {
  db.run(
    `UPDATE memories SET utility = ?, success_count = success_count + ?, fail_count = fail_count + ?, use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`,
    [utility, deltaSuccess, deltaFail, now, now, id]
  );
}

/**
 * 确认记忆：提升可信度与效用，支持将 candidate 激活
 */
export function confirmMemory(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): { success: boolean; memory?: MemoryRecord; message: string } {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return { success: false, message: `Memory '${id}' not found` };
    if (memory.status === 'archived' || memory.status === 'rejected') {
      return { success: false, message: `Memory '${id}' is ${memory.status}` };
    }

    saveVersionSnapshot(db, memory, 'confirm', actor, now);

    // 信任边界：仅用户/系统可无条件激活候选；模型(llm/assistant)只能激活带有用户证据的候选。
    // 否则模型可先 memory_note 再 memory_confirm 自我批准，或将网页/工具输出中的提示注入“洗白”为常驻记忆。
    const trustedActor = actor === 'user' || actor === 'system';
    const canActivate = trustedActor || hasUserEvidence(db, memory);
    const promote = memory.status === 'candidate' && canActivate;

    const boostConf = actor === 'user' ? 0.2 : 0.1;
    let newConfidence = Math.min(1.0, memory.confidence + boostConf);
    if (memory.status === 'candidate' && !canActivate) {
      newConfidence = Math.min(newConfidence, 0.7);
    }
    const newUtility = Math.min(1.0, memory.utility + 0.15);
    let newStatus = promote ? 'active' : memory.status;
    let approvedAt = promote ? now : memory.approved_at;
    let approvedBy = promote ? actor : memory.approved_by;

    if (promote && memory.slot_key) {
      const existingSlot = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id != ?`,
        [memory.scope, memory.workspace_id || '', memory.session_id || '', memory.slot_key, id]
      );
      if (existingSlot) {
        if (existingSlot.status === 'frozen') {
          return {
            success: false,
            message: `Slot '${memory.slot_key}' is currently locked by frozen memory '${existingSlot.id}'`,
          };
        }
        saveVersionSnapshot(db, existingSlot, 'supersede', actor, now);
        db.run(
          `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [now, now, existingSlot.id]
        );
        removeCachedRuntimeEmbedding(existingSlot.id);
        addRelation(db, memory.id, existingSlot.id, 'supersedes', now);
      }
    }

    db.run(
      `UPDATE memories
       SET confidence = ?,
           utility = ?,
           status = ?,
           approved_at = ?,
           approved_by = ?,
           success_count = success_count + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [newConfidence, newUtility, newStatus, approvedAt, approvedBy, now, id]
    );

    const updated = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    const pendingNote =
      memory.status === 'candidate' && !promote ? '; remains candidate pending user approval (no user-origin evidence)' : '';
    return {
      success: true,
      memory: updated,
      message: `Memory '${id}' confirmed (confidence: ${newConfidence.toFixed(2)}, utility: ${newUtility.toFixed(2)})${pendingNote}`,
    };
  });
}

/**
 * 显式合并记忆：将 sourceId 合并进 targetId，转移证据与实体，并将 sourceId 置为 superseded
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
    const source = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [sourceId]);
    const target = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [targetId]);
    if (!source) return { success: false, message: `Source memory '${sourceId}' not found` };
    if (!target) return { success: false, message: `Target memory '${targetId}' not found` };
    if (target.status === 'archived' || target.status === 'rejected' || target.status === 'superseded') {
      return { success: false, message: `Target memory '${targetId}' is ${target.status}; cannot merge into it` };
    }
    if (source.status === 'superseded' || source.status === 'archived' || source.status === 'rejected') {
      return { success: false, message: `Source memory '${sourceId}' is already ${source.status}` };
    }
    // 用户锁定（frozen）或置顶（pinned）的记忆只能由用户本人合并，防止模型/自动流程覆盖
    if (actor !== 'user' && (source.status === 'frozen' || source.pinned)) {
      return { success: false, message: `Source memory '${sourceId}' is ${source.status === 'frozen' ? 'frozen' : 'pinned'} by user; only the user can merge it` };
    }
    if (actor !== 'user') {
      if (target.status === 'frozen' || target.pinned) {
        return { success: false, message: 'Only the user can merge into a protected target' };
      }
      if (source.scope !== target.scope || source.workspace_id !== target.workspace_id || source.session_id !== target.session_id) {
        return { success: false, message: 'Automatic merge requires matching ownership' };
      }
      if ((source.status === 'active' && target.status === 'candidate') ||
          (target.status === 'candidate' && source.hash !== target.hash)) {
        return { success: false, message: 'A model proposal cannot inherit approval evidence through merge' };
      }
    }

    // 保存快照
    saveVersionSnapshot(db, source, 'merge_source', actor, now);
    saveVersionSnapshot(db, target, 'merge_target', actor, now);

    // 1. 将 source 的 sources 转移/追加到 target
    const srcSources = db.all<{ session_id: string; seq: number; kind: string; excerpt?: string | null }>(
      `SELECT session_id, seq, kind, excerpt FROM memory_sources WHERE memory_id = ? AND content_rev = ?`,
      [sourceId, source.content_rev]
    );
    for (const s of srcSources) {
      db.run(
        `INSERT OR IGNORE INTO memory_sources (memory_id, content_rev, session_id, seq, kind, excerpt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [targetId, target.content_rev, s.session_id, s.seq, s.kind, s.excerpt || null, now]
      );
    }

    // 2. 将 source 的 entities 转移到 target
    const srcEntities = db.all<{ entity: string }>(
      `SELECT entity FROM memory_entities WHERE memory_id = ?`,
      [sourceId]
    );
    for (const e of srcEntities) {
      db.run(`INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)`, [targetId, e.entity]);
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
       SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
      [now, now, sourceId]
    );
    removeCachedRuntimeEmbedding(sourceId);

    // 5. 强化 target 的效用与成功计数
    const newUtility = Math.min(1.0, target.utility + 0.1);
    const newConfidence = Math.min(1.0, Math.max(target.confidence, source.confidence) + 0.05);
    db.run(
      `UPDATE memories
       SET utility = ?,
           confidence = ?,
           success_count = success_count + 1,
           version = version + 1,
           updated_at = ?
       WHERE id = ?`,
      [newUtility, newConfidence, now, targetId]
    );

    return {
      success: true,
      message: `Successfully merged '${sourceId}' into '${targetId}' (superseded '${sourceId}')`,
    };
  });
}

/**
 * 恢复归档记忆为 active
 */
export function restoreMemory(
  db: Db,
  id: string,
  actor: string = 'user',
  now: number = Date.now()
): { success: boolean; message: string } {
  return db.transaction(() => {
    const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    if (!memory) return { success: false, message: `Memory '${id}' not found` };

    if (memory.slot_key && memory.status !== 'active' && memory.status !== 'frozen') {
      const existingSlot = db.get<MemoryRecord>(
        `SELECT * FROM memories WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND slot_key = ? AND status IN ('active', 'frozen') AND id != ?`,
        [memory.scope, memory.workspace_id || '', memory.session_id || '', memory.slot_key, id]
      );
      if (existingSlot) {
        if (existingSlot.status === 'frozen') {
          return {
            success: false,
            message: `Slot '${memory.slot_key}' is currently locked by frozen memory '${existingSlot.id}'`,
          };
        }
        saveVersionSnapshot(db, existingSlot, 'supersede', actor, now);
        db.run(
          `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
          [now, now, existingSlot.id]
        );
        removeCachedRuntimeEmbedding(existingSlot.id);
        addRelation(db, memory.id, existingSlot.id, 'supersedes', now);
      }
    }

    saveVersionSnapshot(db, memory, 'restore', actor, now);
    db.run(`UPDATE memories SET status = 'active', valid_to = NULL, version = version + 1, updated_at = ? WHERE id = ?`, [now, id]);
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
    const mem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [id]);
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
    removeCachedRuntimeEmbedding(id);
    return true;
  });
}

