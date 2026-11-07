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
    const summaryTokens = estimateTokens(rawSummary);
    if (summaryTokens > DEFAULTS.maxSummaryTokens) {
      rawSummary = rawSummary.slice(0, 100);
    }

    if (!c.sources || !Array.isArray(c.sources) || c.sources.length === 0) {
      return { action: 'rejected', reason: 'sources_required' };
    }

    const { scope, workspace_id, session_id } = resolveScopeAndOwners(c);
    const originKinds = deriveOriginKinds(c);

    // 1. 计算可信状态
    let isExplicitUser = false;
    if (c.source_kind === 'user' && c.actor === 'user') {
      isExplicitUser = true;
    }

    let initialStatus: 'active' | 'candidate' = 'candidate';
    let approved_at: number | null = null;
    let approved_by: string | null = null;

    if (isExplicitUser) {
      initialStatus = 'active';
      approved_at = now;
      approved_by = 'user';
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
      `SELECT * FROM memories WHERE type = ? AND scope = ? AND COALESCE(workspace_id, '') = ? AND COALESCE(session_id, '') = ? AND COALESCE(slot_key, '') = ? AND hash = ?`,
      [c.type, scope, workspace_id || '', session_id || '', slotKey || '', hash]
    );

    if (existingSame) {
      let isReplay = true;
      for (const s of c.sources) {
        const srcRow = db.get(
          `SELECT 1 FROM memory_sources WHERE memory_id = ? AND content_rev = ? AND session_id = ? AND seq = ?`,
          [existingSame.id, existingSame.content_rev, s.session_id, s.seq]
        );
        if (!srcRow) {
          isReplay = false;
          db.run(
            `INSERT OR IGNORE INTO memory_sources(memory_id, content_rev, session_id, seq, kind, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [existingSame.id, existingSame.content_rev, s.session_id, s.seq, s.kind, s.excerpt || null, now]
          );
        }
      }

      // 同一证据再次重放，confidence/use_count 不变
      if (isReplay) {
        return { action: 'merged', id: existingSame.id };
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
         AND type != 'meta'
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       ORDER BY (CASE WHEN type = ? THEN 0 ELSE 1 END) ASC, utility DESC, updated_at DESC
       LIMIT 24`,
      [scope, workspace_id || '', c.type]
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
    status: 'active' | 'candidate';
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

    // 检查是否有未决的 repair_proposals (原记忆或候选记忆均不能单独批准)
    const pendingRepair = db.get(
      `SELECT 1 FROM repair_proposals WHERE (memory_id = ? OR candidate_ids LIKE ?) AND status = 'candidate'`,
      [id, `%"${id}"%`]
    );
    if (pendingRepair) {
      return { action: 'rejected', reason: 'pending_repair_proposals' };
    }

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
          `UPDATE memories SET status = 'active', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
          [now, approvedBy, now, id]
        );
        return { action: 'superseded', id: memory.id, oldId: existingSlot.id };
      }
    }

    db.run(
      `UPDATE memories SET status = 'active', approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?`,
      [now, approvedBy, now, id]
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
    db.run(`UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`, [now, id]);
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

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(`UPDATE memories SET status = 'frozen', updated_at = ? WHERE id = ?`, [now, id]);
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

    saveVersionSnapshot(db, memory, 'status', actor, now);
    db.run(`UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?`, [now, id]);
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

    const boostConf = actor === 'user' ? 0.2 : 0.1;
    const newConfidence = Math.min(1.0, memory.confidence + boostConf);
    const newUtility = Math.min(1.0, memory.utility + 0.15);
    const newStatus = memory.status === 'candidate' ? 'active' : memory.status;
    const approvedAt = memory.status === 'candidate' ? now : memory.approved_at;
    const approvedBy = memory.status === 'candidate' ? actor : memory.approved_by;

    db.run(
      `UPDATE memories
       SET confidence = ?,
           utility = ?,
           status = ?,
           approved_at = ?,
           approved_by = ?,
           success_count = success_count + 1,
           updated_at = ?
       WHERE id = ?`,
      [newConfidence, newUtility, newStatus, approvedAt, approvedBy, now, id]
    );

    const updated = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
    return {
      success: true,
      memory: updated,
      message: `Memory '${id}' confirmed (confidence: ${newConfidence.toFixed(2)}, utility: ${newUtility.toFixed(2)})`,
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

    // 保存快照
    saveVersionSnapshot(db, source, 'merge_source', actor, now);
    saveVersionSnapshot(db, target, 'merge_target', actor, now);

    // 1. 将 source 的 sources 转移/追加到 target
    const srcSources = db.all<{ session_id: string; seq: number; kind: string; excerpt?: string | null }>(
      `SELECT session_id, seq, kind, excerpt FROM memory_sources WHERE memory_id = ?`,
      [sourceId]
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

    // 5. 强化 target 的效用与成功计数
    const newUtility = Math.min(1.0, target.utility + 0.1);
    const newConfidence = Math.min(1.0, Math.max(target.confidence, source.confidence) + 0.05);
    db.run(
      `UPDATE memories
       SET utility = ?,
           confidence = ?,
           success_count = success_count + 1,
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

    saveVersionSnapshot(db, memory, 'restore', actor, now);
    db.run(`UPDATE memories SET status = 'active', valid_to = NULL, updated_at = ? WHERE id = ?`, [now, id]);
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
    if (!mem) return false;
    saveVersionSnapshot(db, mem, reason, actor, now);
    db.run(
      `UPDATE memories
       SET status = 'archived',
           valid_to = ?,
           invalidated_at = ?,
           updated_at = ?
       WHERE id = ?`,
      [now, now, now, id]
    );
    return true;
  });
}

