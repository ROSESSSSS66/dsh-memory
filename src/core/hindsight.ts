import crypto from 'node:crypto';
import {
  hydrateMemoryRow,
  parseOriginKinds,
  type Db,
  type MemoryRecord,
  type MemoryRow,
  type MemoryType,
  type OriginKind,
  type HindsightNetwork,
  type HindsightDisposition,
  type QueryPlan,
} from '../types.js';
import { workspaceId, scopeFilterSQL } from './scope.js';
import { extractEntities } from './text.js';
import {
  redactSecrets,
  isWorkspaceExcluded,
  memoryPrivacyFilterSQL,
} from './privacy.js';
import { upsertCandidate, addRelation, saveVersionSnapshot } from './writer.js';
import {
  hasUntrustedOrigin,
  isUntrustedSourceKind,
  sourceKindToOriginKind,
} from './trust.js';
import { removeCachedRuntimeEmbedding } from './vector.js';

export const DEFAULT_DISPOSITION: HindsightDisposition = {
  skepticism: 0.35,
  literalism: 0.6,
  empathy: 0.7,
};

export const HINDSIGHT_NETWORK_TYPES: Record<HindsightNetwork, MemoryType[]> = {
  world: ['semantic'],
  experience: ['episodic', 'failure'],
  observation: ['procedural'],
  opinion: ['belief', 'preference', 'goal'],
};

export const HINDSIGHT_NETWORK_LABELS: Record<HindsightNetwork, string> = {
  world: 'WORLD (客观事实网络)',
  experience: 'EXPERIENCE (情景与教训网络)',
  observation: 'OBSERVATION (归纳规程网络)',
  opinion: 'OPINION (心智模型与偏好网络)',
};

function clamp01(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function sanitizeDisposition(d?: Partial<HindsightDisposition>): HindsightDisposition {
  return {
    skepticism: clamp01(d?.skepticism, DEFAULT_DISPOSITION.skepticism),
    literalism: clamp01(d?.literalism, DEFAULT_DISPOSITION.literalism),
    empathy: clamp01(d?.empathy, DEFAULT_DISPOSITION.empathy),
  };
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, '\\$&');
}

/**
 * 将底层 MemoryType 映射到 Hindsight 四层认知网络
 * 注意：优先判定 procedural -> observation，确保合成的 procedural 规程模型在所有路径中一致归类为 observation
 */
export function classifyHindsightNetwork(
  type: MemoryType,
  slotKey?: string | null
): HindsightNetwork {
  if (type === 'procedural') {
    return 'observation';
  }
  if (slotKey && slotKey.startsWith('hindsight.obs.')) {
    return 'observation';
  }
  if (slotKey && slotKey.startsWith('hindsight.model.')) {
    return 'opinion';
  }
  switch (type) {
    case 'semantic':
      return 'world';
    case 'episodic':
    case 'failure':
      return 'experience';
    case 'belief':
    case 'preference':
    case 'goal':
      return 'opinion';
    case 'meta':
    default:
      return 'world';
  }
}

/**
 * 解析用户或工具输入的 Hindsight 网络名称
 */
export function parseHindsightNetwork(raw?: string | null): HindsightNetwork | undefined {
  if (!raw) return undefined;
  const norm = raw.toLowerCase().trim();
  if (norm === 'world' || norm === 'fact' || norm === 'facts') return 'world';
  if (norm === 'experience' || norm === 'experiences' || norm === 'episodic') return 'experience';
  if (norm === 'observation' || norm === 'observations' || norm === 'procedural') {
    return 'observation';
  }
  if (
    norm === 'opinion' ||
    norm === 'opinions' ||
    norm === 'belief' ||
    norm === 'mental_model' ||
    norm === 'model'
  ) {
    return 'opinion';
  }
  return undefined;
}

/**
 * 计算 Hindsight 认知网络与查询意图的对齐增益 (用于 fuseCandidates)
 */
export function computeNetworkIntentBonus(
  network: HindsightNetwork,
  intents: QueryPlan['intents']
): number {
  let bonus = 0;
  if (intents.procedural) {
    if (network === 'observation') bonus = Math.max(bonus, 0.016);
    else if (network === 'experience') bonus = Math.max(bonus, 0.008);
  }
  if (intents.causal) {
    if (network === 'experience') bonus = Math.max(bonus, 0.015);
    else if (network === 'opinion') bonus = Math.max(bonus, 0.01);
  }
  if (intents.preference) {
    if (network === 'opinion') bonus = Math.max(bonus, 0.016);
  }
  if (intents.temporal) {
    if (network === 'experience') bonus = Math.max(bonus, 0.014);
    else if (network === 'world') bonus = Math.max(bonus, 0.006);
  }
  return bonus;
}

export interface EvidenceMetrics {
  distinctSessions: number;
  hasUserProof: boolean;
  hasActiveContradiction: boolean;
  derivedSourceCount: number;
}

function deriveBaseConfidencePrior(
  memory: Pick<MemoryRecord, 'source_kind' | 'approved_by' | 'origin_kinds'>,
  hasUserProof: boolean
): number {
  if (hasUntrustedOrigin(memory)) {
    return 0.45;
  }
  if (memory.approved_by === 'user' || (memory.source_kind === 'user' && hasUserProof)) {
    return 0.8;
  }
  if (hasUserProof) {
    return 0.65;
  }
  if (memory.source_kind === 'system' || memory.source_kind === 'rule') {
    return 0.58;
  }
  return 0.5;
}

/**
 * Hindsight Opinion / Observation 无状态幂等目标置信度校准算子
 * 锚定固定来源先验 (basePrior)，结合多会话独立证据、正负向在线效用反馈、矛盾张力与认知倾向计算目标置信度；
 * 多次重复调用不发生加性漂移，彻底消除趋近 0.99 或坍缩至 0.10 的反馈失控。
 */
export function computeEvidenceCalibratedConfidence(
  memory: MemoryRecord,
  metrics: EvidenceMetrics,
  disposition: HindsightDisposition = DEFAULT_DISPOSITION,
  basePrior?: number
): number {
  const disp = sanitizeDisposition(disposition);
  const untrusted = hasUntrustedOrigin(memory);

  let conf =
    typeof basePrior === 'number' && Number.isFinite(basePrior)
      ? Math.max(0.1, Math.min(0.95, basePrior))
      : deriveBaseConfidencePrior(memory, metrics.hasUserProof);

  // 1. 多源独立会话证据强化 (Noisy-OR 对数增益)
  const extraSessions = Math.max(0, (metrics.distinctSessions || 1) - 1);
  const derivedBonus = Math.min(3, Math.max(0, metrics.derivedSourceCount || 0));
  if (extraSessions > 0 || derivedBonus > 0) {
    const evidenceBoost =
      0.05 * Math.log2(1 + extraSessions + 0.8 * derivedBonus) * (1 - 0.3 * disp.skepticism);
    conf += evidenceBoost;
  }

  // 2. 在线执行正负反馈校准
  const succ = Math.max(0, memory.success_count || 0);
  const fail = Math.max(0, memory.fail_count || 0);
  if (succ + fail > 0) {
    const netSignal = (succ - 1.5 * fail) / (succ + fail + 2);
    conf += 0.1 * netSignal;
  }

  // 3. Disposition: Empathy 对用户验证偏好/目标的正向保护 vs Skepticism 对无用户证据项的衰减
  const network = classifyHindsightNetwork(memory.type, memory.slot_key);
  if (
    network === 'opinion' &&
    (memory.type === 'preference' || memory.type === 'goal') &&
    metrics.hasUserProof
  ) {
    conf += 0.04 * disp.empathy;
  } else if (!metrics.hasUserProof && disp.skepticism > 0.2) {
    conf -= 0.06 * disp.skepticism;
  }

  // 4. Literalism: 拥有明确规范槽位 (slot_key) 的结构化记忆获得确定性加成
  if (memory.slot_key && !memory.slot_key.startsWith('core:')) {
    conf += 0.025 * disp.literalism;
  }

  // 5. 矛盾张力折损
  if (metrics.hasActiveContradiction) {
    conf -= 0.14 * (0.5 + 0.5 * disp.skepticism);
  }

  // 6. 不可信外部来源 (web/tool) 严格封顶 0.50，与 writer.ts 信任边界一致
  const upperBound = untrusted ? 0.5 : 0.99;
  return Number(Math.max(0.1, Math.min(upperBound, conf)).toFixed(4));
}

export interface SynthesizedMentalModel {
  id: string;
  topic: string;
  slotKey: string;
  network: HindsightNetwork;
  type: MemoryType;
  summary: string;
  content: string;
  confidence: number;
  supportingMemoryIds: string[];
  status: 'active' | 'candidate';
}

export interface CalibratedMemoryItem {
  id: string;
  network: HindsightNetwork;
  summary: string;
  oldConfidence: number;
  newConfidence: number;
  distinctSessions: number;
}

export interface HindsightReflectReport {
  workspaceId: string;
  disposition: HindsightDisposition;
  networkCounts: Record<HindsightNetwork, number>;
  calibratedMemories: CalibratedMemoryItem[];
  synthesizedModels: SynthesizedMentalModel[];
  existingModels: Array<{
    id: string;
    type: MemoryType;
    slotKey: string | null;
    summary: string;
    confidence: number;
    utility: number;
    derivedCount: number;
  }>;
}

interface DerivedSourceSnapshot {
  memory_id: string;
  content_rev: number;
  hash: string;
}

function parseDerivedSourcesMeta(metadata: string | null | undefined): DerivedSourceSnapshot[] {
  if (!metadata) return [];
  try {
    const parsed = JSON.parse(metadata);
    if (parsed && Array.isArray(parsed.sources)) {
      return parsed.sources.filter(
        (s: unknown): s is DerivedSourceSnapshot =>
          Boolean(s) &&
          typeof s === 'object' &&
          typeof (s as DerivedSourceSnapshot).memory_id === 'string' &&
          typeof (s as DerivedSourceSnapshot).content_rev === 'number' &&
          typeof (s as DerivedSourceSnapshot).hash === 'string'
      );
    }
  } catch {
    // malformed metadata falls back to empty snapshot
  }
  return [];
}

/**
 * 将主题锚点规范化为严格 ASCII slug ([a-z0-9_-]，长度 <= 32)，
 * 使 `hindsight.model.<slug>` 始终满足 parse.ts 的 `^[a-z0-9.:_-]+$` 且总长 <= 48。
 */
export function normalizeTopicSlug(raw: string): string {
  const trimmed = (raw || '').trim().toLowerCase().replace(/\\/g, '/');
  if (trimmed.length < 2) return '';

  const ascii = trimmed
    .replace(/[^a-z0-9._/-]+/g, '_')
    .replace(/[/_.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const hasNonAscii = /[^\x00-\x7f]/.test(trimmed);

  if (!hasNonAscii && ascii.length >= 2) {
    return ascii.slice(0, 32).replace(/_+$/, '');
  }

  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 10);
  if (ascii.length >= 2) {
    const prefix = ascii.slice(0, 20).replace(/_+$/, '');
    return prefix ? `${prefix}_${hash}` : `topic_${hash}`;
  }
  return `topic_${hash}`;
}

interface ModelFreshnessCheck {
  fresh: boolean;
  hasInactiveSource: boolean;
  activeSourceCount: number;
  linkedTargetIds: Set<string>;
}

function inspectDerivedModelFreshness(
  db: Db,
  modelId: string
): ModelFreshnessCheck {
  const edges = db.all<{
    to_id: string;
    metadata: string | null;
    target_id: string | null;
    target_status: string | null;
    target_rev: number | null;
    target_hash: string | null;
  }>(
    `SELECT r.to_id, r.metadata,
            t.id AS target_id, t.status AS target_status,
            t.content_rev AS target_rev, t.hash AS target_hash
     FROM memory_relations r
     LEFT JOIN memories t ON t.id = r.to_id
     WHERE r.from_id = ? AND r.rel = 'derived_from'`,
    [modelId]
  );

  const linkedTargetIds = new Set<string>();
  if (edges.length === 0) {
    return { fresh: false, hasInactiveSource: false, activeSourceCount: 0, linkedTargetIds };
  }

  let fresh = true;
  let hasInactiveSource = false;
  let activeSourceCount = 0;

  for (const edge of edges) {
    linkedTargetIds.add(edge.to_id);
    const targetAlive =
      edge.target_id !== null &&
      (edge.target_status === 'active' || edge.target_status === 'frozen');
    if (!targetAlive) {
      fresh = false;
      hasInactiveSource = true;
      continue;
    }
    activeSourceCount++;

    const snapshots = parseDerivedSourcesMeta(edge.metadata);
    const snap = snapshots.find((s) => s.memory_id === edge.to_id);
    if (snap) {
      if (snap.content_rev !== edge.target_rev || snap.hash !== edge.target_hash) {
        fresh = false;
      }
    }
  }

  return { fresh, hasInactiveSource, activeSourceCount, linkedTargetIds };
}

/**
 * Hindsight Reflect 核心引擎：
 * 1. 盘点 World / Experience / Observation / Opinion 四层认知记忆网络（SQL 全量 GROUP BY，不被 LIMIT 截断）
 * 2. 基于多会话证据、执行反馈与认知倾向 (Disposition) 幂等校准置信度（不改写 updated_at）
 * 3. 从同工作区共享实体/槽位的多条记忆中归纳合成心智模型，并自动检测与刷新陈旧派生模型
 */
export function runHindsightReflect(
  db: Db,
  options: {
    workspaceId?: string;
    sessionId?: string;
    excludeWorkspaces?: string[];
    topic?: string;
    disposition?: Partial<HindsightDisposition>;
    autoSynthesize?: boolean;
    minClusterSize?: number;
    persistCalibration?: boolean;
    now?: number;
  } = {}
): HindsightReflectReport {
  const now = options.now ?? Date.now();
  const wsId = workspaceId(options.workspaceId || process.cwd());
  const disposition = sanitizeDisposition(options.disposition);
  const autoSynthesize = options.autoSynthesize !== false;
  const persistCalibration = options.persistCalibration !== false;
  const topicFilter = options.topic?.trim().toLowerCase() || '';
  const minClusterSize = options.minClusterSize ?? (topicFilter ? 2 : 3);
  const excludeWorkspaces = options.excludeWorkspaces;

  const emptyNetworkCounts: Record<HindsightNetwork, number> = {
    world: 0,
    experience: 0,
    observation: 0,
    opinion: 0,
  };

  if (excludeWorkspaces?.length && isWorkspaceExcluded(wsId, excludeWorkspaces)) {
    return {
      workspaceId: wsId,
      disposition,
      networkCounts: emptyNetworkCounts,
      calibratedMemories: [],
      synthesizedModels: [],
      existingModels: [],
    };
  }

  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId });
  const privacy = memoryPrivacyFilterSQL(excludeWorkspaces);
  const baseWhere = `(${scope.sql}) AND (${privacy.sql}) AND status IN ('active', 'frozen') AND type != 'meta' AND COALESCE(slot_key, '') NOT LIKE 'core:%'`;
  const baseParams: unknown[] = [...scope.params, ...privacy.params];

  // 0. SQL 全量 GROUP BY 统计四层网络分布（不受 LIMIT 250 截断）
  const networkCounts: Record<HindsightNetwork, number> = { ...emptyNetworkCounts };
  const groupRows = db.all<{ type: MemoryType; slot_net: string | null; cnt: number }>(
    `SELECT type,
            CASE
              WHEN type = 'procedural' THEN 'observation'
              WHEN slot_key LIKE 'hindsight.obs.%' THEN 'observation'
              WHEN slot_key LIKE 'hindsight.model.%' THEN 'opinion'
              ELSE NULL
            END AS slot_net,
            COUNT(*) AS cnt
     FROM memories
     WHERE ${baseWhere}
     GROUP BY type, slot_net`,
    baseParams
  );
  for (const g of groupRows) {
    const net = (g.slot_net as HindsightNetwork | null) ?? classifyHindsightNetwork(g.type);
    networkCounts[net] += Number(g.cnt || 0);
  }

  // 推送 topicFilter 到 LIMIT 250 之前，并与 ix_mem_vec_rank 对齐 ORDER BY
  let topicSql = '';
  const topicParams: unknown[] = [];
  if (topicFilter) {
    const likePattern = `%${escapeLike(topicFilter)}%`;
    topicSql = `AND (
      LOWER(summary) LIKE ? ESCAPE '\\'
      OR LOWER(content) LIKE ? ESCAPE '\\'
      OR LOWER(COALESCE(slot_key, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM memory_entities me
        WHERE me.memory_id = memories.id
          AND LOWER(me.entity) LIKE ? ESCAPE '\\'
      )
    )`;
    topicParams.push(likePattern, likePattern, likePattern, likePattern);
  }

  const rawRows = db.all<MemoryRow>(
    `SELECT * FROM memories
     WHERE ${baseWhere}
       ${topicSql}
     ORDER BY pinned DESC, utility DESC, updated_at DESC
     LIMIT 250`,
    [...baseParams, ...topicParams]
  );
  const rows: MemoryRecord[] = rawRows.map((row) => hydrateMemoryRow(row));

  if (rows.length === 0) {
    return {
      workspaceId: wsId,
      disposition,
      networkCounts,
      calibratedMemories: [],
      synthesizedModels: [],
      existingModels: [],
    };
  }

  const rowIds = rows.map((r) => r.id);
  const placeholders = rowIds.map(() => '?').join(', ');
  const memById = new Map<string, MemoryRecord>();
  for (const r of rows) {
    memById.set(r.id, r);
  }

  // 单次批量查询当前 content_rev 的来源证据（在写事务外完成，彻底消除 N+1）
  const srcRows = db.all<{
    memory_id: string;
    content_rev: number;
    session_id: string;
    seq: number;
    kind: string;
    excerpt: string | null;
  }>(
    `SELECT memory_id, content_rev, session_id, seq, kind, excerpt
     FROM memory_sources
     WHERE memory_id IN (${placeholders})`,
    rowIds
  );

  const sessionsByMem = new Map<string, Set<string>>();
  const currentRevSourcesByMem = new Map<
    string,
    Array<{ session_id: string; seq: number; kind: string; excerpt: string | null }>
  >();
  const hasUserSrcByMem = new Set<string>();
  const hasTaintedSrcByMem = new Set<string>();

  for (const sr of srcRows) {
    const mem = memById.get(sr.memory_id);
    if (!mem || sr.content_rev !== mem.content_rev) continue;

    let sSet = sessionsByMem.get(sr.memory_id);
    if (!sSet) {
      sSet = new Set();
      sessionsByMem.set(sr.memory_id, sSet);
    }
    if (sr.session_id) sSet.add(sr.session_id);

    let list = currentRevSourcesByMem.get(sr.memory_id);
    if (!list) {
      list = [];
      currentRevSourcesByMem.set(sr.memory_id, list);
    }
    list.push({
      session_id: sr.session_id,
      seq: sr.seq,
      kind: sr.kind,
      excerpt: sr.excerpt,
    });

    const normKind = (sr.kind || '').toLowerCase().trim();
    if (normKind === 'user' || normKind === 'user_msg') {
      hasUserSrcByMem.add(sr.memory_id);
    } else if (isUntrustedSourceKind(normKind)) {
      hasTaintedSrcByMem.add(sr.memory_id);
    }
  }

  const hasCleanUserEvidence = (mem: MemoryRecord): boolean => {
    if (hasUntrustedOrigin(mem)) return false;
    if (hasTaintedSrcByMem.has(mem.id)) return false;
    return hasUserSrcByMem.has(mem.id);
  };

  // 批量查询关系 (derived_from & contradicts)，仅将 active/frozen 父节点计入有效覆盖
  const outgoingDerivedRows = db.all<{
    from_id: string;
    to_id: string;
    target_status: string | null;
  }>(
    `SELECT r.from_id, r.to_id, t.status AS target_status
     FROM memory_relations r
     LEFT JOIN memories t ON t.id = r.to_id
     WHERE r.rel = 'derived_from'
       AND r.from_id IN (${placeholders})`,
    rowIds
  );

  const derivedTargetsByFrom = new Map<string, Set<string>>();
  for (const rel of outgoingDerivedRows) {
    if (rel.target_status !== 'active' && rel.target_status !== 'frozen') continue;
    let tSet = derivedTargetsByFrom.get(rel.from_id);
    if (!tSet) {
      tSet = new Set();
      derivedTargetsByFrom.set(rel.from_id, tSet);
    }
    tSet.add(rel.to_id);
  }

  // 仅 JOIN active/frozen 父节点，并校验 metadata 快照判断父模型是否仍然新鲜；
  // 若父模型已被用户 pinned=1 或 frozen，则视为受保护的既有覆盖，禁止其他别名槽位重复合成影子模型
  const incomingDerivedRows = db.all<{
    from_id: string;
    to_id: string;
    metadata: string | null;
    parent_pinned: number;
    parent_status: string;
  }>(
    `SELECT r.from_id, r.to_id, r.metadata, p.pinned AS parent_pinned, p.status AS parent_status
     FROM memory_relations r
     JOIN memories p ON p.id = r.from_id
     WHERE r.rel = 'derived_from'
       AND p.status IN ('active', 'frozen')
       AND r.to_id IN (${placeholders})`,
    rowIds
  );

  const freshParentToTargets = new Map<string, Set<string>>();
  const staleParentsSeen = new Set<string>();
  const parentFreshCache = new Map<string, ModelFreshnessCheck>();

  for (const rel of incomingDerivedRows) {
    const isProtectedParent = rel.parent_pinned === 1 || rel.parent_status === 'frozen';
    if (!isProtectedParent) {
      let check = parentFreshCache.get(rel.from_id);
      if (!check) {
        check = inspectDerivedModelFreshness(db, rel.from_id);
        parentFreshCache.set(rel.from_id, check);
      }
      if (!check.fresh) {
        staleParentsSeen.add(rel.from_id);
        continue;
      }
      const targetMem = memById.get(rel.to_id);
      if (targetMem) {
        const snaps = parseDerivedSourcesMeta(rel.metadata);
        const snap = snaps.find((s) => s.memory_id === targetMem.id);
        if (snap && (snap.content_rev !== targetMem.content_rev || snap.hash !== targetMem.hash)) {
          staleParentsSeen.add(rel.from_id);
          continue;
        }
      }
    }
    let covered = freshParentToTargets.get(rel.from_id);
    if (!covered) {
      covered = new Set();
      freshParentToTargets.set(rel.from_id, covered);
    }
    covered.add(rel.to_id);
  }
  for (const staleId of staleParentsSeen) {
    freshParentToTargets.delete(staleId);
  }

  // 批量查询活跃矛盾边 (仅计入双方均为 active/frozen 的矛盾)
  const contraRows = db.all<{ from_id: string; to_id: string }>(
    `SELECT r.from_id, r.to_id
     FROM memory_relations r
     JOIN memories m1 ON m1.id = r.from_id
     JOIN memories m2 ON m2.id = r.to_id
     WHERE r.rel = 'contradicts'
       AND m1.status IN ('active', 'frozen')
       AND m2.status IN ('active', 'frozen')
       AND (r.from_id IN (${placeholders}) OR r.to_id IN (${placeholders}))`,
    [...rowIds, ...rowIds]
  );
  const contradictedIds = new Set<string>();
  for (const rel of contraRows) {
    contradictedIds.add(rel.from_id);
    contradictedIds.add(rel.to_id);
  }

  // 1. 幂等证据密度置信度校准（基于证据签名跳过无变化记录，绝不改写 updated_at）
  const calMetaKey = `hs_cal:${wsId}`;
  const calCache: Record<string, string> = {};
  try {
    const metaRow = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [calMetaKey]);
    if (metaRow?.value) {
      const parsed = JSON.parse(metaRow.value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') calCache[k] = v;
        }
      }
    }
  } catch {
    // 忽略损坏缓存，按当前证据重建
  }

  const calibratedMemories: CalibratedMemoryItem[] = [];
  const pendingConfUpdates: Array<{ id: string; newConf: number }> = [];
  let calCacheDirty = false;

  for (const r of rows) {
    if (r.status === 'frozen') continue;
    const net = classifyHindsightNetwork(r.type, r.slot_key);
    const distinctSessions = sessionsByMem.get(r.id)?.size || 1;
    const derivedSourceCount = derivedTargetsByFrom.get(r.id)?.size || 0;
    const userProof = hasCleanUserEvidence(r);
    const hasActiveContradiction = contradictedIds.has(r.id);
    const succ = Math.max(0, r.success_count || 0);
    const fail = Math.max(0, r.fail_count || 0);

    const calSig = `${r.content_rev}:${distinctSessions}:${succ}:${fail}:${derivedSourceCount}:${userProof ? 1 : 0}:${hasActiveContradiction ? 1 : 0}:${disposition.skepticism}:${disposition.literalism}:${disposition.empathy}`;
    if (calCache[r.id] === calSig) {
      continue;
    }

    const newConf = computeEvidenceCalibratedConfidence(
      r,
      {
        distinctSessions,
        hasUserProof: userProof,
        hasActiveContradiction,
        derivedSourceCount,
      },
      disposition
    );

    calCache[r.id] = calSig;
    calCacheDirty = true;

    if (Math.abs(newConf - r.confidence) >= 0.025) {
      pendingConfUpdates.push({ id: r.id, newConf });
      calibratedMemories.push({
        id: r.id,
        network: net,
        summary: r.summary || r.content.slice(0, 60),
        oldConfidence: Number(r.confidence.toFixed(2)),
        newConfidence: Number(newConf.toFixed(2)),
        distinctSessions,
      });
      r.confidence = newConf;
    }
  }

  if (persistCalibration && (pendingConfUpdates.length > 0 || calCacheDirty)) {
    // 控制 meta 缓存体积上限
    const cacheKeys = Object.keys(calCache);
    if (cacheKeys.length > 1000) {
      const keepSet = new Set(rowIds);
      for (const k of cacheKeys) {
        if (!keepSet.has(k)) delete calCache[k];
      }
    }
    db.transaction(() => {
      for (const upd of pendingConfUpdates) {
        // 严格仅更新 confidence，不触碰 updated_at 以保护 ACT-R 新鲜度、healthFingerprint 与 review-snapshot
        db.run(`UPDATE memories SET confidence = ? WHERE id = ?`, [upd.newConf, upd.id]);
      }
      db.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [calMetaKey, JSON.stringify(calCache)]
      );
    });
  }

  // 2. 盘点已有心智模型 / 归纳规程
  const existingModels = rows
    .filter((r) => {
      const net = classifyHindsightNetwork(r.type, r.slot_key);
      return (
        net === 'opinion' ||
        net === 'observation' ||
        (derivedTargetsByFrom.get(r.id)?.size ?? 0) > 0
      );
    })
    .filter((r) => {
      if (!topicFilter) return true;
      const hay = `${r.summary} ${r.content} ${r.slot_key || ''}`.toLowerCase();
      return hay.includes(topicFilter);
    })
    .slice(0, 12)
    .map((r) => ({
      id: r.id,
      type: r.type,
      slotKey: r.slot_key ?? null,
      summary: r.summary || r.content.slice(0, 70),
      confidence: Number(r.confidence.toFixed(2)),
      utility: Number(r.utility.toFixed(2)),
      derivedCount: derivedTargetsByFrom.get(r.id)?.size ?? 0,
    }));

  // 3. 实体/主题聚类归纳合成心智模型 (World + Experience -> Observation / Opinion Mental Model)
  const synthesizedModels: SynthesizedMentalModel[] = [];
  const refreshedSlotKeys = new Set<string>();

  if (autoSynthesize) {
    const entRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
      rowIds
    );
    const entitiesByMem = new Map<string, string[]>();
    for (const er of entRows) {
      const list = entitiesByMem.get(er.memory_id) || [];
      list.push(er.entity.toLowerCase().trim());
      entitiesByMem.set(er.memory_id, list);
    }

    // 仅从 workspace / global 记忆中归纳 workspace 心智模型，严禁将 session 临时记忆或 user 私人记忆泄漏进 workspace 模型
    const topicBuckets = new Map<string, { label: string; memories: MemoryRecord[] }>();

    for (const r of rows) {
      if (r.scope === 'session' || r.scope === 'user') continue;
      if (r.slot_key?.startsWith('hindsight.model.') || r.slot_key?.startsWith('hindsight.obs.')) {
        continue;
      }

      const anchors: string[] = [];
      if (r.slot_key && r.slot_key.includes('.')) {
        const parts = r.slot_key.split('.');
        const prefix = parts.slice(0, Math.min(2, parts.length)).join('.');
        anchors.push(prefix);
      }
      const memEnts = entitiesByMem.get(r.id) || extractEntities(`${r.summary} ${r.content}`, 4);
      for (const ent of memEnts.slice(0, 3)) {
        const cleanEnt = ent.toLowerCase().trim();
        if (cleanEnt.length >= 2) anchors.push(cleanEnt);
      }

      for (const anchor of new Set(anchors)) {
        const slug = normalizeTopicSlug(anchor);
        if (!slug || slug.length < 2) continue;
        let bucket = topicBuckets.get(slug);
        if (!bucket) {
          bucket = { label: anchor, memories: [] };
          topicBuckets.set(slug, bucket);
        }
        if (!bucket.memories.some((m) => m.id === r.id)) {
          bucket.memories.push(r);
        }
      }
    }

    // 优先选择跨网络且规模 >= minClusterSize 的聚类
    const candidateBuckets = Array.from(topicBuckets.entries())
      .filter(([, b]) => b.memories.length >= minClusterSize)
      .sort((a, b) => {
        const netsA = new Set(
          a[1].memories.map((m) => classifyHindsightNetwork(m.type, m.slot_key))
        ).size;
        const netsB = new Set(
          b[1].memories.map((m) => classifyHindsightNetwork(m.type, m.slot_key))
        ).size;
        if (netsB !== netsA) return netsB - netsA;
        return b[1].memories.length - a[1].memories.length;
      });

    const isClusterCoveredByFreshParent = (members: MemoryRecord[]): boolean => {
      for (const coveredSet of freshParentToTargets.values()) {
        if (members.every((m) => coveredSet.has(m.id))) {
          return true;
        }
      }
      return false;
    };

    for (const [slug, bucket] of candidateBuckets) {
      if (synthesizedModels.length >= 3) break;
      const modelSlotKey = `hindsight.model.${slug}`;
      const topMembers = bucket.memories.slice(0, 4);

      const rawExistingSlot = db.get<MemoryRow>(
        `SELECT * FROM memories
         WHERE scope = 'workspace' AND COALESCE(workspace_id, '') = ?
           AND slot_key = ? AND status IN ('active', 'candidate', 'frozen')
         ORDER BY CASE status WHEN 'frozen' THEN 0 WHEN 'active' THEN 1 ELSE 2 END ASC, updated_at DESC
         LIMIT 1`,
        [wsId, modelSlotKey]
      );
      const existingSlotModel = hydrateMemoryRow(rawExistingSlot);

      // 尊重 pinned=1 或 frozen 的既有心智模型，禁止覆盖或取代
      if (existingSlotModel && (existingSlotModel.pinned === 1 || existingSlotModel.status === 'frozen')) {
        continue;
      }

      if (existingSlotModel) {
        const check = inspectDerivedModelFreshness(db, existingSlotModel.id);
        const coversAllTop = topMembers.every((m) => check.linkedTargetIds.has(m.id));
        if (check.fresh && coversAllTop) {
          continue;
        }
      } else if (isClusterCoveredByFreshParent(topMembers)) {
        continue;
      }

      const hasFailureOrProc = topMembers.some(
        (m) => m.type === 'failure' || m.type === 'procedural'
      );
      const synthType: MemoryType = hasFailureOrProc ? 'procedural' : 'belief';
      const synthNet: HindsightNetwork = classifyHindsightNetwork(synthType, modelSlotKey);

      const uniqueNetworks = new Set(
        topMembers.map((m) => classifyHindsightNetwork(m.type, m.slot_key))
      ).size;

      const clauses = topMembers.map((m) => {
        const tag = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
        const text = redactSecrets((m.summary || m.content).trim()).text.replace(/\s+/g, ' ');
        return `[${tag}] ${text.slice(0, 95)}`;
      });

      const summary = `[Hindsight 心智模型] ${bucket.label} 综合认知与操作准则`.slice(0, 75);
      const singleNetLabel = classifyHindsightNetwork(
        topMembers[0].type,
        topMembers[0].slot_key
      ).toUpperCase();
      const content =
        uniqueNetworks >= 2
          ? `针对「${bucket.label}」的跨网络归纳心智模型（融合 ${topMembers.length} 条事实与经验）：${clauses.join('；')}。`.slice(
              0,
              380
            )
          : `针对「${bucket.label}」的 ${singleNetLabel} 网络归纳心智模型（融合 ${topMembers.length} 条同网络记忆）：${clauses.join('；')}。`.slice(
              0,
              380
            );

      // 复用已批量加载的 current_rev 来源证据，合并全部成员 origin_kinds 与污点标记，严禁伪造 user 身份
      const collectedSources: Array<{
        session_id: string;
        seq: number;
        kind: string;
        excerpt?: string;
      }> = [];
      const unionOrigins = new Set<OriginKind>(['system']);
      let allCleanUserVerified = true;

      for (const m of topMembers) {
        if (!hasCleanUserEvidence(m)) {
          allCleanUserVerified = false;
        }
        for (const ok of parseOriginKinds(m.origin_kinds)) {
          unionOrigins.add(ok);
        }
        if (m.source_kind === 'web') unionOrigins.add('web');
        if (m.source_kind === 'tool') unionOrigins.add('tool');

        const mSrcs = currentRevSourcesByMem.get(m.id) || [];
        if (mSrcs.length === 0) {
          allCleanUserVerified = false;
        }
        for (const s of mSrcs) {
          unionOrigins.add(sourceKindToOriginKind(s.kind));
          if (isUntrustedSourceKind(s.kind)) {
            allCleanUserVerified = false;
          }
        }
        if (mSrcs.length > 0) {
          const first = mSrcs[0];
          collectedSources.push({
            session_id: first.session_id,
            seq: first.seq,
            kind: first.kind,
            excerpt: first.excerpt || m.summary.slice(0, 80),
          });
        }
      }

      if (unionOrigins.has('web') || unionOrigins.has('tool')) {
        allCleanUserVerified = false;
      }

      if (collectedSources.length === 0) {
        collectedSources.push({
          session_id: options.sessionId || 'hindsight_reflect',
          seq: 0,
          kind: 'system',
          excerpt: summary,
        });
        allCleanUserVerified = false;
      }

      const avgConf =
        topMembers.reduce((acc, m) => acc + m.confidence, 0) / Math.max(1, topMembers.length);
      const modelConf = Number(
        Math.min(allCleanUserVerified ? 0.95 : 0.5, avgConf * 0.95 + 0.05).toFixed(2)
      );

      // 若旧槽位上存在陈旧 candidate 模型，先归档它避免堆积
      if (existingSlotModel && existingSlotModel.status === 'candidate') {
        db.transaction(() => {
          saveVersionSnapshot(db, existingSlotModel, 'hindsight_stale_refresh', 'system', now);
          db.run(
            `UPDATE memories SET status = 'superseded', valid_to = ?, version = version + 1, updated_at = ? WHERE id = ?`,
            [now, now, existingSlotModel.id]
          );
          db.afterCommit(() => removeCachedRuntimeEmbedding(existingSlotModel.id, db));
        });
      }

      const upsertRes = upsertCandidate(
        db,
        {
          type: synthType,
          content,
          summary,
          slot_key: modelSlotKey,
          scope: 'workspace',
          workspaceId: wsId,
          source_kind: 'system',
          origin_kinds: Array.from(unionOrigins),
          confidence: modelConf,
          importance: 8,
          status: allCleanUserVerified ? 'active' : 'candidate',
          sources: collectedSources.slice(0, 4),
          actor: 'system',
        },
        now
      );

      if ('id' in upsertRes) {
        refreshedSlotKeys.add(modelSlotKey);
        const snapshotMeta = JSON.stringify({
          sources: topMembers.map((m) => ({
            memory_id: m.id,
            content_rev: m.content_rev,
            hash: m.hash,
          })),
        });
        const memberIds = topMembers.map((m) => m.id).filter((id) => id !== upsertRes.id);

        db.transaction(() => {
          // 防御性确保机器合成模型永不伪造 approved_by = 'user'
          db.run(
            `UPDATE memories SET approved_by = 'system' WHERE id = ? AND approved_by = 'user'`,
            [upsertRes.id]
          );

          if (memberIds.length > 0) {
            const keepPh = memberIds.map(() => '?').join(', ');
            db.run(
              `DELETE FROM memory_relations
               WHERE from_id = ? AND rel = 'derived_from' AND to_id NOT IN (${keepPh})`,
              [upsertRes.id, ...memberIds]
            );
          }

          for (const m of topMembers) {
            if (m.id === upsertRes.id) continue;
            db.run(
              `INSERT INTO memory_relations (from_id, to_id, rel, metadata, created_at)
               VALUES (?, ?, 'derived_from', ?, ?)
               ON CONFLICT(from_id, to_id, rel) DO UPDATE SET
                 metadata = excluded.metadata,
                 created_at = excluded.created_at`,
              [upsertRes.id, m.id, snapshotMeta, now]
            );
            addRelation(db, upsertRes.id, m.id, 'related', now);
          }
        });

        freshParentToTargets.set(upsertRes.id, new Set(memberIds));

        const stored = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [upsertRes.id]);
        synthesizedModels.push({
          id: upsertRes.id,
          topic: bucket.label,
          slotKey: modelSlotKey,
          network: synthNet,
          type: synthType,
          summary,
          content,
          confidence: stored?.confidence ?? modelConf,
          supportingMemoryIds: topMembers.map((m) => m.id),
          status: (stored?.status as 'active' | 'candidate') || 'candidate',
        });
      }
    }

    // 4. 失效清理：若已有未置顶/未冻结的 hindsight.model.* 派生源已被归档/取代且剩余活跃源不足 minClusterSize，将其归档失效
    for (const r of rows) {
      if (r.pinned === 1 || r.status === 'frozen') continue;
      if (!r.slot_key?.startsWith('hindsight.model.') && !r.slot_key?.startsWith('hindsight.obs.')) {
        continue;
      }
      if (r.slot_key && refreshedSlotKeys.has(r.slot_key)) continue;

      const check = inspectDerivedModelFreshness(db, r.id);
      if (check.hasInactiveSource && check.activeSourceCount < minClusterSize) {
        db.transaction(() => {
          saveVersionSnapshot(db, r, 'hindsight_source_invalidated', 'system', now);
          db.run(
            `UPDATE memories
             SET status = 'archived', valid_to = ?, invalidated_at = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND status = 'active' AND pinned = 0`,
            [now, now, now, r.id]
          );
          db.afterCommit(() => removeCachedRuntimeEmbedding(r.id, db));
        });
      }
    }
  }

  return {
    workspaceId: wsId,
    disposition,
    networkCounts,
    calibratedMemories,
    synthesizedModels,
    existingModels,
  };
}

/**
 * 格式化 Hindsight Reflect 报告为结构化文本
 */
export function formatHindsightReflectReport(report: HindsightReflectReport): string {
  const lines: string[] = [
    `🧠 [Hindsight 四层认知网络与心智模型反思报告]`,
    `认知网络分布：WORLD(事实)=${report.networkCounts.world} · EXPERIENCE(事件/教训)=${report.networkCounts.experience} · OBSERVATION(规程)=${report.networkCounts.observation} · OPINION(心智模型/偏好)=${report.networkCounts.opinion}`,
    `认知倾向 (Disposition)：skepticism=${report.disposition.skepticism} · literalism=${report.disposition.literalism} · empathy=${report.disposition.empathy}`,
  ];

  if (report.synthesizedModels.length > 0) {
    lines.push(`新归纳心智模型 (${report.synthesizedModels.length}):`);
    for (const m of report.synthesizedModels) {
      lines.push(
        `  • [${m.network.toUpperCase()} ${m.id}] (${m.status}, c=${m.confidence.toFixed(2)}, slot=${m.slotKey}) ${m.content}`
      );
      lines.push(`    ↳ 派生自证据节点: ${m.supportingMemoryIds.join(', ')}`);
    }
  }

  if (report.calibratedMemories.length > 0) {
    lines.push(`证据密度置信度校准 (${report.calibratedMemories.length}):`);
    for (const c of report.calibratedMemories.slice(0, 6)) {
      lines.push(
        `  • [${c.network.toUpperCase()} ${c.id}] ${c.summary}: c=${c.oldConfidence.toFixed(2)} -> ${c.newConfidence.toFixed(2)} (${c.distinctSessions} 会话证据)`
      );
    }
  }

  if (report.existingModels.length > 0 && report.synthesizedModels.length === 0) {
    lines.push(`活跃心智模型与归纳规程 (${report.existingModels.length}):`);
    for (const em of report.existingModels.slice(0, 6)) {
      lines.push(
        `  • [${em.type.toUpperCase()} ${em.id}]${em.slotKey ? ` (${em.slotKey})` : ''} ${em.summary} (c=${em.confidence.toFixed(2)}, u=${em.utility.toFixed(2)}, 派生源=${em.derivedCount})`
      );
    }
  }

  return lines.join('\n');
}

export interface HindsightEvolutionNode {
  id: string;
  version: number;
  status: string;
  network: HindsightNetwork;
  summary: string;
  confidence: number;
  timestamp: number;
  relationToCurrent: 'ancestor' | 'current' | 'derived_source' | 'derived_model' | 'contradiction';
}

export interface HindsightEvolutionTrace {
  targetId: string;
  slotKey: string | null;
  network: HindsightNetwork;
  timeline: HindsightEvolutionNode[];
  derivedSources: HindsightEvolutionNode[];
  derivedModels: HindsightEvolutionNode[];
  contradictions: HindsightEvolutionNode[];
}

export interface HindsightScopeContext {
  workspaceId?: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
}

function buildEvolutionScopeClause(
  scopeCtx?: HindsightScopeContext
): { sql: string; params: unknown[] } {
  if (!scopeCtx) {
    return { sql: '1 = 1', params: [] };
  }
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (scopeCtx.workspaceId) {
    const sf = scopeFilterSQL(
      { workspaceId: workspaceId(scopeCtx.workspaceId), sessionId: scopeCtx.sessionId },
      'memories'
    );
    clauses.push(sf.sql);
    params.push(...sf.params);
  } else if (scopeCtx.sessionId) {
    clauses.push(`(memories.scope != 'session' OR memories.session_id = ?)`);
    params.push(scopeCtx.sessionId.trim());
  }

  if (scopeCtx.excludeWorkspaces?.length) {
    const privacy = memoryPrivacyFilterSQL(scopeCtx.excludeWorkspaces);
    if (privacy.params.length > 0) {
      clauses.push(privacy.sql);
      params.push(...privacy.params);
    }
  }

  return {
    sql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
    params,
  };
}

/**
 * Hindsight 认知演化时间线与因果溯源链追踪 (`traceHindsightEvolution`)
 * 沿着 supersedes 历史链、memory_versions 版本快照、derived_from 归纳链与 contradicts 活跃矛盾边还原演化轨迹
 */
export function traceHindsightEvolution(
  db: Db,
  targetMemory: MemoryRecord,
  scopeCtx?: HindsightScopeContext
): HindsightEvolutionTrace {
  const net = classifyHindsightNetwork(targetMemory.type, targetMemory.slot_key);
  const timeline: HindsightEvolutionNode[] = [];
  const vis = buildEvolutionScopeClause(scopeCtx);

  // 1. 追溯 supersedes 历史祖先链 (最多向后追溯 6 代，遵守 scope/privacy 隔离)
  const visitedAncestors = new Set<string>([targetMemory.id]);
  let cursorId: string | undefined = targetMemory.id;
  const ancestorRecords: MemoryRecord[] = [];

  for (let depth = 0; depth < 6 && cursorId; depth++) {
    const sup: { to_id: string } | undefined = db.get<{ to_id: string }>(
      `SELECT to_id FROM memory_relations WHERE from_id = ? AND rel = 'supersedes' ORDER BY created_at DESC LIMIT 1`,
      [cursorId]
    );
    if (!sup || visitedAncestors.has(sup.to_id)) break;
    visitedAncestors.add(sup.to_id);
    const oldMemRow: MemoryRow | undefined = db.get<MemoryRow>(
      `SELECT memories.* FROM memories WHERE memories.id = ? AND (${vis.sql})`,
      [sup.to_id, ...vis.params]
    );
    const oldMem: MemoryRecord | undefined = hydrateMemoryRow(oldMemRow);
    if (oldMem) {
      ancestorRecords.unshift(oldMem);
      cursorId = oldMem.id;
    } else {
      break;
    }
  }

  for (const anc of ancestorRecords) {
    timeline.push({
      id: anc.id,
      version: anc.version,
      status: anc.status,
      network: classifyHindsightNetwork(anc.type, anc.slot_key),
      summary: redactSecrets(anc.summary || anc.content.slice(0, 80)).text,
      confidence: Number(anc.confidence.toFixed(2)),
      timestamp: anc.updated_at,
      relationToCurrent: 'ancestor',
    });
  }

  // 2. 加入当前节点自身最近 6 条历史版本快照 (ORDER BY version DESC LIMIT 6 后反转为时间正序)
  const verRows = db
    .all<{ version: number; snapshot: string; created_at: number }>(
      `SELECT version, snapshot, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version DESC LIMIT 6`,
      [targetMemory.id]
    )
    .reverse();

  for (const vr of verRows) {
    try {
      const snap = JSON.parse(vr.snapshot);
      timeline.push({
        id: targetMemory.id,
        version: vr.version,
        status: String(snap.status || 'superseded'),
        network: net,
        summary: redactSecrets(String(snap.summary || snap.content || '').slice(0, 80)).text,
        confidence: Number(Number(snap.confidence ?? 0.5).toFixed(2)),
        timestamp: vr.created_at,
        relationToCurrent: 'ancestor',
      });
    } catch {
      // ignore malformed snapshot
    }
  }

  // 3. 当前现行版本
  timeline.push({
    id: targetMemory.id,
    version: targetMemory.version,
    status: targetMemory.status,
    network: net,
    summary: redactSecrets(targetMemory.summary || targetMemory.content.slice(0, 80)).text,
    confidence: Number(targetMemory.confidence.toFixed(2)),
    timestamp: targetMemory.updated_at,
    relationToCurrent: 'current',
  });

  // 4. 归纳支撑源 (target -> derived_from -> source) 与上层派生模型 (model -> derived_from -> target)
  const derivedSourceRows = db
    .all<MemoryRow>(
      `SELECT memories.* FROM memory_relations r
       JOIN memories ON memories.id = r.to_id
       WHERE r.from_id = ? AND r.rel = 'derived_from'
         AND (${vis.sql})
       ORDER BY memories.updated_at DESC LIMIT 8`,
      [targetMemory.id, ...vis.params]
    )
    .map((r) => hydrateMemoryRow(r));

  const derivedSources: HindsightEvolutionNode[] = derivedSourceRows.map((m) => ({
    id: m.id,
    version: m.version,
    status: m.status,
    network: classifyHindsightNetwork(m.type, m.slot_key),
    summary: redactSecrets(m.summary || m.content.slice(0, 80)).text,
    confidence: Number(m.confidence.toFixed(2)),
    timestamp: m.updated_at,
    relationToCurrent: 'derived_source',
  }));

  const derivedModelRows = db
    .all<MemoryRow>(
      `SELECT memories.* FROM memory_relations r
       JOIN memories ON memories.id = r.from_id
       WHERE r.to_id = ? AND r.rel = 'derived_from'
         AND (${vis.sql})
       ORDER BY memories.updated_at DESC LIMIT 8`,
      [targetMemory.id, ...vis.params]
    )
    .map((r) => hydrateMemoryRow(r));

  const derivedModels: HindsightEvolutionNode[] = derivedModelRows.map((m) => ({
    id: m.id,
    version: m.version,
    status: m.status,
    network: classifyHindsightNetwork(m.type, m.slot_key),
    summary: redactSecrets(m.summary || m.content.slice(0, 80)).text,
    confidence: Number(m.confidence.toFixed(2)),
    timestamp: m.updated_at,
    relationToCurrent: 'derived_model',
  }));

  // 5. 活跃矛盾张力节点 (contradicts，仅包含 active/frozen 记录并遵守 scope/privacy 隔离)
  const contraRows = db
    .all<MemoryRow>(
      `SELECT memories.* FROM memory_relations r
       JOIN memories ON (memories.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END)
       WHERE (r.from_id = ? OR r.to_id = ?)
         AND r.rel = 'contradicts'
         AND memories.status IN ('active', 'frozen')
         AND (${vis.sql})
       ORDER BY memories.updated_at DESC LIMIT 6`,
      [targetMemory.id, targetMemory.id, targetMemory.id, ...vis.params]
    )
    .map((r) => hydrateMemoryRow(r));

  const contradictions: HindsightEvolutionNode[] = contraRows.map((m) => ({
    id: m.id,
    version: m.version,
    status: m.status,
    network: classifyHindsightNetwork(m.type, m.slot_key),
    summary: redactSecrets(m.summary || m.content.slice(0, 80)).text,
    confidence: Number(m.confidence.toFixed(2)),
    timestamp: m.updated_at,
    relationToCurrent: 'contradiction',
  }));

  return {
    targetId: targetMemory.id,
    slotKey: targetMemory.slot_key ?? null,
    network: net,
    timeline,
    derivedSources,
    derivedModels,
    contradictions,
  };
}
