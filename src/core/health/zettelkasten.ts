import type { Db } from '../../types.js';
import { workspaceId } from '../scope.js';
import { extractEntities, jaccard, tokenSet } from '../text.js';
import { cosineSimilarity, getOrComputeEmbedding } from '../vector.js';
import { addRelation } from '../writer.js';
import { buildHealthScopeFilter } from './audit.js';

export interface WeaveOptions {
  workspaceId?: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
  maxNewLinks?: number;
  now?: number;
}

export type WeaveResult = number;

function computeSlotKeyAffinity(slotA?: string | null, slotB?: string | null): number {
  if (!slotA || !slotB) return 0;
  const sa = slotA.toLowerCase().trim();
  const sb = slotB.toLowerCase().trim();
  if (!sa || !sb) return 0;
  if (sa === sb) return 0.35;
  const partsA = sa.split('.');
  const partsB = sb.split('.');
  if (
    partsA.length >= 2 &&
    partsB.length >= 2 &&
    partsA[0] === partsB[0] &&
    partsA[1] === partsB[1]
  ) {
    return 0.28;
  }
  if (partsA[0] === partsB[0]) {
    return 0.2;
  }
  return 0;
}

/**
 * 严格判定两条记忆是否允许在 A-Mem Zettelkasten 图中建立双链：
 * - session 作用域：仅允许同 workspace_id 且同非空 session_id 的 session 记忆互连，绝不跨会话或跨作用域泄漏
 * - workspace 作用域：仅允许同 workspace_id 互连，绝不跨工作区连接
 * - user / global 作用域：允许彼此互连；仅在显式开启单工作区桥接 (`allowSharedWorkspaceBridge`) 时允许孤岛桥接至当前工作区节点
 */
export function areScopesCompatibleForWeaving(
  a: { scope: string; workspace_id?: string | null; session_id?: string | null },
  b: { scope: string; workspace_id?: string | null; session_id?: string | null },
  allowSharedWorkspaceBridge: boolean = false
): boolean {
  if (a.scope === 'session' || b.scope === 'session') {
    return (
      a.scope === 'session' &&
      b.scope === 'session' &&
      Boolean(a.session_id) &&
      (a.workspace_id || '') === (b.workspace_id || '') &&
      (a.session_id || '') === (b.session_id || '')
    );
  }
  if (a.scope === 'workspace' && b.scope === 'workspace') {
    return Boolean(a.workspace_id) && a.workspace_id === b.workspace_id;
  }
  if (
    (a.scope === 'global' || a.scope === 'user') &&
    (b.scope === 'global' || b.scope === 'user')
  ) {
    return true;
  }
  if (allowSharedWorkspaceBridge) {
    const aShared = a.scope === 'global' || a.scope === 'user';
    const bShared = b.scope === 'global' || b.scope === 'user';
    return (
      (aShared && b.scope === 'workspace' && Boolean(b.workspace_id)) ||
      (bShared && a.scope === 'workspace' && Boolean(a.workspace_id))
    );
  }
  return false;
}

/**
 * A-Mem (NeurIPS 2025, arXiv:2502.12110) Zettelkasten 自动双链织网引擎
 * 扫描同作用域内的活跃记忆，基于 128D 本地向量余弦 + 实体共现 + 词汇 Jaccard + 槽位命名空间亲和度
 * 为孤岛/弱连通节点自动编织 related 边，并严格执行工作区、会话与隐私隔离边界。
 */
export function weaveZettelkastenLinks(db: Db, options: WeaveOptions | string = {}): WeaveResult {
  const opts: WeaveOptions = typeof options === 'string' ? { workspaceId: options } : options;
  const now = opts.now ?? Date.now();
  const maxNewLinks = opts.maxNewLinks ?? 60;
  const wsFilter = opts.workspaceId ? workspaceId(opts.workspaceId) : undefined;
  const filterOpts = {
    workspaceId: wsFilter,
    sessionId: opts.sessionId,
    excludeWorkspaces: opts.excludeWorkspaces,
  };
  const scopeFilter = buildHealthScopeFilter(filterOpts);

  const activeRows = db.all<{
    id: string;
    scope: string;
    workspace_id: string | null;
    session_id: string | null;
    type: string;
    summary: string;
    content: string;
    slot_key: string | null;
    hash: string;
    embedding: Uint8Array | Buffer | null;
  }>(
    `SELECT id, scope, workspace_id, session_id, type, summary, content, slot_key, hash, embedding
     FROM memories
     WHERE status IN ('active', 'frozen')
       AND type != 'meta'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       AND (${scopeFilter.sql})
     ORDER BY utility DESC, confidence DESC, updated_at DESC
     LIMIT 250`,
    scopeFilter.params
  );

  if (activeRows.length === 0) return 0;

  const existingPairs = new Set<string>();
  const connectedIds = new Set<string>();
  const activeIdsJson = JSON.stringify(activeRows.map((r) => r.id));

  // 加载既有边：existingPairs 覆盖所有历史边防重复插入，connectedIds 仅计入活跃邻居且同处于可见作用域的边
  const relRows = db.all<{
    from_id: string;
    to_id: string;
    from_status: string | null;
    to_status: string | null;
  }>(
    `SELECT r.from_id, r.to_id, m1.status AS from_status, m2.status AS to_status
     FROM memory_relations r
     LEFT JOIN memories m1 ON m1.id = r.from_id
     LEFT JOIN memories m2 ON m2.id = r.to_id
     WHERE r.rel IN ('related', 'derived_from', 'supersedes')
       AND (r.from_id IN (SELECT value FROM json_each(?)) OR r.to_id IN (SELECT value FROM json_each(?)))`,
    [activeIdsJson, activeIdsJson]
  );

  // 预查询可见活跃边集合以确保 connectedIds 与 auditMemoryHealth 判定一致
  const filterM1 = buildHealthScopeFilter(filterOpts, 'm1');
  const filterM2 = buildHealthScopeFilter(filterOpts, 'm2');
  const liveVisibleRels = db.all<{ from_id: string; to_id: string }>(
    `SELECT r.from_id, r.to_id
     FROM memory_relations r
     JOIN memories m1 ON m1.id = r.from_id
     JOIN memories m2 ON m2.id = r.to_id
     WHERE r.rel IN ('related', 'derived_from', 'supersedes')
       AND m1.status IN ('active', 'frozen')
       AND m2.status IN ('active', 'frozen')
       AND m1.id != m2.id
       AND (${filterM1.sql})
       AND (${filterM2.sql})
       AND (r.from_id IN (SELECT value FROM json_each(?)) OR r.to_id IN (SELECT value FROM json_each(?)))`,
    [...filterM1.params, ...filterM2.params, activeIdsJson, activeIdsJson]
  );

  for (const r of relRows) {
    existingPairs.add(`${r.from_id}->${r.to_id}`);
    existingPairs.add(`${r.to_id}->${r.from_id}`);
  }
  for (const r of liveVisibleRels) {
    connectedIds.add(r.from_id);
    connectedIds.add(r.to_id);
  }

  const tokenCache = new Map<string, Set<string>>();
  const entCache = new Map<string, Set<string>>();
  const vecCache = new Map<string, Float32Array | null>();

  for (const r of activeRows) {
    tokenCache.set(r.id, tokenSet(`${r.summary} ${r.content}`));
    entCache.set(
      r.id,
      new Set(
        extractEntities(`${r.summary} ${r.content}`, 12).map((e) =>
          e.toLowerCase().replace(/\\/g, '/').trim()
        )
      )
    );
    vecCache.set(r.id, getOrComputeEmbedding(r, db));
  }

  // Merge indexed entities from memory_entities table
  const placeholders = activeRows.map(() => '?').join(', ');
  const dbEntRows = db.all<{ memory_id: string; entity: string }>(
    `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
    activeRows.map((r) => r.id)
  );
  for (const row of dbEntRows) {
    const s = entCache.get(row.memory_id);
    if (s && row.entity) {
      s.add(row.entity.toLowerCase().replace(/\\/g, '/').trim());
    }
  }

  const computePairAffinity = (
    a: (typeof activeRows)[0],
    b: (typeof activeRows)[0]
  ): {
    affinity: number;
    jaccardSim: number;
    vecSim: number;
    sharedEnts: number;
    slotBonus: number;
  } => {
    const setA = tokenCache.get(a.id)!;
    const setB = tokenCache.get(b.id)!;
    const jaccardSim = jaccard(setA, setB);

    const vecA = vecCache.get(a.id);
    const vecB = vecCache.get(b.id);
    const vecSim = vecA && vecB ? Math.max(0, cosineSimilarity(vecA, vecB)) : 0;

    const entA = entCache.get(a.id)!;
    const entB = entCache.get(b.id)!;
    let sharedEnts = 0;
    for (const e of entA) {
      if (entB.has(e)) sharedEnts++;
    }

    const entBonus = Math.min(1, sharedEnts / 2);
    const slotBonus = computeSlotKeyAffinity(a.slot_key, b.slot_key);
    const typeBonus = a.type === b.type ? 0.05 : 0;
    const affinity = 0.45 * vecSim + 0.3 * jaccardSim + 0.15 * entBonus + slotBonus + typeBonus;

    return { affinity, jaccardSim, vecSim, sharedEnts, slotBonus };
  };

  const candidateEdges: Array<{ fromId: string; toId: string; affinity: number }> = [];

  for (let i = 0; i < activeRows.length; i++) {
    const a = activeRows[i];
    for (let j = i + 1; j < activeRows.length; j++) {
      const b = activeRows[j];
      if (!areScopesCompatibleForWeaving(a, b)) continue;
      if (existingPairs.has(`${a.id}->${b.id}`)) continue;

      const { affinity, jaccardSim, vecSim, sharedEnts, slotBonus } = computePairAffinity(a, b);
      // Avoid linking pairs that are near-identical duplicates (>= 0.65) which should be merged instead
      if (jaccardSim >= 0.65) continue;

      if (
        affinity >= 0.26 ||
        (sharedEnts >= 1 && vecSim >= 0.22) ||
        jaccardSim >= 0.18 ||
        slotBonus >= 0.2
      ) {
        candidateEdges.push({ fromId: a.id, toId: b.id, affinity });
      }
    }
  }

  candidateEdges.sort((a, b) => b.affinity - a.affinity);

  let weaved = 0;
  const degreeAdded = new Map<string, number>();

  // 仅加载符合当前作用域与隐私过滤的 Core Memory 锚点，严禁跨工作区挂载
  const coreHubRows = db.all<{
    id: string;
    slot_key: string | null;
    scope: string;
    workspace_id: string | null;
  }>(
    `SELECT id, slot_key, scope, workspace_id
     FROM memories
     WHERE status IN ('active', 'frozen')
       AND slot_key LIKE 'core:%'
       AND (${scopeFilter.sql})`,
    scopeFilter.params
  );

  db.transaction(() => {
    // Phase 1: 高亲和度多边双链织网
    for (const edge of candidateEdges) {
      if (weaved >= maxNewLinks) break;
      const degA = degreeAdded.get(edge.fromId) || 0;
      const degB = degreeAdded.get(edge.toId) || 0;
      if (degA >= 3 || degB >= 3) continue;

      addRelation(db, edge.fromId, edge.toId, 'related', now);
      existingPairs.add(`${edge.fromId}->${edge.toId}`);
      existingPairs.add(`${edge.toId}->${edge.fromId}`);
      connectedIds.add(edge.fromId);
      connectedIds.add(edge.toId);
      degreeAdded.set(edge.fromId, degA + 1);
      degreeAdded.set(edge.toId, degB + 1);
      weaved++;
    }

    // Phase 2: 孤岛节点最近邻与核心锚点桥接 (Nearest-Neighbor & Core-Hub Orphan Bridging)
    for (const orphan of activeRows) {
      if (weaved >= maxNewLinks) break;
      if (connectedIds.has(orphan.id)) continue;

      let bestPeerId: string | null = null;
      let bestScore = -1;

      // Phase 2a: 优先在兼容作用域/同工作区的活跃记忆中寻找最高亲和度邻居
      for (const peer of activeRows) {
        if (peer.id === orphan.id) continue;
        if (existingPairs.has(`${orphan.id}->${peer.id}`)) continue;
        if (!areScopesCompatibleForWeaving(orphan, peer)) continue;

        const { affinity, jaccardSim } = computePairAffinity(orphan, peer);
        if (jaccardSim >= 0.65) continue;
        const sameWsBonus =
          orphan.workspace_id && orphan.workspace_id === peer.workspace_id ? 0.12 : 0;
        const score = affinity + sameWsBonus;
        if (score > bestScore) {
          bestScore = score;
          bestPeerId = peer.id;
        }
      }

      // Phase 2b: 若无同作用域邻居，尝试挂载至工作区兼容的 Core Memory 锚点（session 绝不挂载；删除不安全的 coreHubRows[0] 兜底）
      if (!bestPeerId && orphan.scope !== 'session' && coreHubRows.length > 0) {
        const compatibleHubs = coreHubRows.filter(
          (c) =>
            c.id !== orphan.id &&
            !existingPairs.has(`${orphan.id}->${c.id}`) &&
            (!c.workspace_id || c.workspace_id === orphan.workspace_id)
        );
        const preferredSlot =
          orphan.scope === 'user' || orphan.type === 'preference'
            ? 'core:human'
            : orphan.type === 'procedural' || orphan.type === 'belief'
              ? 'core:persona'
              : 'core:project';
        const matchedCore =
          compatibleHubs.find((c) => c.slot_key === preferredSlot) ||
          compatibleHubs.find((c) => c.slot_key === 'core:human' || c.slot_key === 'core:persona');
        if (matchedCore) {
          bestPeerId = matchedCore.id;
        }
      }

      // Phase 2c: 兜底桥接仍严格执行 areScopesCompatibleForWeaving（绝不放松 session/跨工作区边界）
      if (!bestPeerId && activeRows.length >= 2) {
        const allowSingleWsSharedBridge = Boolean(wsFilter);
        for (const peer of activeRows) {
          if (peer.id === orphan.id) continue;
          if (existingPairs.has(`${orphan.id}->${peer.id}`)) continue;
          if (!areScopesCompatibleForWeaving(orphan, peer, allowSingleWsSharedBridge)) continue;

          const { affinity } = computePairAffinity(orphan, peer);
          if (affinity > bestScore) {
            bestScore = affinity;
            bestPeerId = peer.id;
          }
        }
      }

      if (bestPeerId) {
        addRelation(db, orphan.id, bestPeerId, 'related', now);
        existingPairs.add(`${orphan.id}->${bestPeerId}`);
        existingPairs.add(`${bestPeerId}->${orphan.id}`);
        connectedIds.add(orphan.id);
        connectedIds.add(bestPeerId);
        weaved++;
      }
    }
  });

  return weaved;
}
