import type {
  Db,
  MemoryRecord,
  MemoryType,
  HindsightNetwork,
  HindsightDisposition,
  QueryPlan,
} from '../types.js';
import { workspaceId, scopeFilterSQL } from './scope.js';
import { extractEntities } from './text.js';
import { redactSecrets } from './privacy.js';
import { upsertCandidate, addRelation } from './writer.js';
import { hasUserEvidence } from './trust.js';

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

/**
 * 将底层 MemoryType 映射到 Hindsight 四层认知网络
 */
export function classifyHindsightNetwork(
  type: MemoryType,
  slotKey?: string | null
): HindsightNetwork {
  if (slotKey && slotKey.startsWith('hindsight.model.')) {
    return 'opinion';
  }
  switch (type) {
    case 'semantic':
      return 'world';
    case 'episodic':
    case 'failure':
      return 'experience';
    case 'procedural':
      return 'observation';
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

/**
 * Hindsight Opinion / Observation 证据密度与 Disposition 调制置信度演化算子
 * 结合多会话独立证据、正负向在线效用反馈、矛盾张力与认知倾向 (skepticism / literalism / empathy) 动态校准置信度
 */
export function computeEvidenceCalibratedConfidence(
  memory: MemoryRecord,
  metrics: EvidenceMetrics,
  disposition: HindsightDisposition = DEFAULT_DISPOSITION
): number {
  let conf = memory.confidence;

  // 1. 多源独立会话证据强化 (Noisy-OR 对数增益)
  const extraSessions = Math.max(0, metrics.distinctSessions - 1);
  const derivedBonus = Math.min(3, metrics.derivedSourceCount);
  if (extraSessions > 0 || derivedBonus > 0) {
    const evidenceBoost =
      0.04 * Math.log2(1 + extraSessions + 0.8 * derivedBonus) * (1 - 0.3 * disposition.skepticism);
    conf += evidenceBoost;
  }

  // 2. 在线执行正负反馈校准
  const succ = Math.max(0, memory.success_count || 0);
  const fail = Math.max(0, memory.fail_count || 0);
  if (succ + fail > 0) {
    const netSignal = (succ - 1.5 * fail) / (succ + fail + 2);
    conf += 0.08 * netSignal;
  }

  // 3. Disposition: Empathy 对用户验证偏好/目标的正向保护 vs Skepticism 对无用户证据项的衰减
  const network = classifyHindsightNetwork(memory.type, memory.slot_key);
  if (network === 'opinion' && memory.type === 'preference' && metrics.hasUserProof) {
    conf += 0.03 * disposition.empathy;
  } else if (!metrics.hasUserProof && disposition.skepticism > 0.2) {
    conf -= 0.04 * disposition.skepticism;
  }

  // 4. Literalism: 拥有明确规范槽位 (slot_key) 的结构化记忆获得确定性加成
  if (memory.slot_key && !memory.slot_key.startsWith('core:')) {
    conf += 0.02 * disposition.literalism;
  }

  // 5. 矛盾张力折损
  if (metrics.hasActiveContradiction) {
    conf -= 0.12 * (0.5 + 0.5 * disposition.skepticism);
  }

  return Number(Math.max(0.1, Math.min(0.99, conf)).toFixed(4));
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

function normalizeTopicSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9\u4e00-\u9fa5._/-]+/g, '_')
    .replace(/[/_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
}

/**
 * Hindsight Reflect 核心引擎：
 * 1. 盘点 World / Experience / Observation / Opinion 四层认知记忆网络
 * 2. 基于多会话证据、执行反馈与认知倾向 (Disposition) 校准 Opinion 与 Observation 置信度
 * 3. 从共享实体或同命名空间槽位的多条 World + Experience 记忆中归纳合成心智模型 (Mental Models / Observations)
 */
export function runHindsightReflect(
  db: Db,
  options: {
    workspaceId?: string;
    sessionId?: string;
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
  const disposition: HindsightDisposition = {
    skepticism: options.disposition?.skepticism ?? DEFAULT_DISPOSITION.skepticism,
    literalism: options.disposition?.literalism ?? DEFAULT_DISPOSITION.literalism,
    empathy: options.disposition?.empathy ?? DEFAULT_DISPOSITION.empathy,
  };
  const autoSynthesize = options.autoSynthesize !== false;
  const persistCalibration = options.persistCalibration !== false;
  const topicFilter = options.topic?.trim().toLowerCase() || '';
  const minClusterSize = options.minClusterSize ?? (topicFilter ? 2 : 3);

  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId });
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
       AND type != 'meta'
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
     ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
     LIMIT 250`,
    scope.params
  );

  const networkCounts: Record<HindsightNetwork, number> = {
    world: 0,
    experience: 0,
    observation: 0,
    opinion: 0,
  };

  for (const r of rows) {
    const net = classifyHindsightNetwork(r.type, r.slot_key);
    networkCounts[net]++;
  }

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

  // 批量查询来源会话数
  const srcRows = db.all<{ memory_id: string; session_id: string; kind: string }>(
    `SELECT memory_id, session_id, kind FROM memory_sources WHERE memory_id IN (${placeholders})`,
    rowIds
  );
  const sessionsByMem = new Map<string, Set<string>>();
  for (const sr of srcRows) {
    let set = sessionsByMem.get(sr.memory_id);
    if (!set) {
      set = new Set();
      sessionsByMem.set(sr.memory_id, set);
    }
    if (sr.session_id) set.add(sr.session_id);
  }

  // 批量查询关系 (derived_from & contradicts)
  const relRows = db.all<{ from_id: string; to_id: string; rel: string }>(
    `SELECT from_id, to_id, rel FROM memory_relations
     WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`,
    [...rowIds, ...rowIds]
  );
  const derivedTargetsByFrom = new Map<string, Set<string>>();
  const derivedParentsByTo = new Map<string, Set<string>>();
  const activeIdSet = new Set(rowIds);
  const contradictedIds = new Set<string>();

  for (const rel of relRows) {
    if (rel.rel === 'derived_from') {
      let tSet = derivedTargetsByFrom.get(rel.from_id);
      if (!tSet) {
        tSet = new Set();
        derivedTargetsByFrom.set(rel.from_id, tSet);
      }
      tSet.add(rel.to_id);

      let pSet = derivedParentsByTo.get(rel.to_id);
      if (!pSet) {
        pSet = new Set();
        derivedParentsByTo.set(rel.to_id, pSet);
      }
      pSet.add(rel.from_id);
    } else if (
      rel.rel === 'contradicts' &&
      activeIdSet.has(rel.from_id) &&
      activeIdSet.has(rel.to_id)
    ) {
      contradictedIds.add(rel.from_id);
      contradictedIds.add(rel.to_id);
    }
  }

  // 1. 证据密度置信度校准
  const calibratedMemories: CalibratedMemoryItem[] = [];
  db.transaction(() => {
    for (const r of rows) {
      if (r.status === 'frozen') continue;
      const net = classifyHindsightNetwork(r.type, r.slot_key);
      const distinctSessions = sessionsByMem.get(r.id)?.size || 1;
      const derivedSourceCount = derivedTargetsByFrom.get(r.id)?.size || 0;
      const userProof = hasUserEvidence(db, r);
      const hasActiveContradiction = contradictedIds.has(r.id);

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

      if (Math.abs(newConf - r.confidence) >= 0.025) {
        if (persistCalibration) {
          db.run(`UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?`, [
            newConf,
            now,
            r.id,
          ]);
        }
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
  });

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

  // 3. 跨网络实体/主题聚类归纳合成心智模型 (World + Experience -> Observation / Opinion Mental Model)
  const synthesizedModels: SynthesizedMentalModel[] = [];
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

    // 按主题锚点 (slot 命名空间前缀 或 核心实体) 聚合记忆
    const topicBuckets = new Map<string, { label: string; memories: MemoryRecord[] }>();

    for (const r of rows) {
      if (r.slot_key?.startsWith('hindsight.model.')) continue;
      if (topicFilter) {
        const hay = `${r.summary} ${r.content} ${r.slot_key || ''}`.toLowerCase();
        const memEnts = entitiesByMem.get(r.id) || [];
        if (!hay.includes(topicFilter) && !memEnts.some((e) => e.includes(topicFilter))) {
          continue;
        }
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

    // 优先选择跨网络 (例如同时包含 World 事实与 Experience 教训/事件) 且规模 >= minClusterSize 的聚类
    const candidateBuckets = Array.from(topicBuckets.entries())
      .filter(([, b]) => b.memories.length >= minClusterSize)
      .sort((a, b) => {
        const netsA = new Set(a[1].memories.map((m) => classifyHindsightNetwork(m.type, m.slot_key))).size;
        const netsB = new Set(b[1].memories.map((m) => classifyHindsightNetwork(m.type, m.slot_key))).size;
        if (netsB !== netsA) return netsB - netsA;
        return b[1].memories.length - a[1].memories.length;
      });

    for (const [slug, bucket] of candidateBuckets) {
      if (synthesizedModels.length >= 3) break;
      const modelSlotKey = `hindsight.model.${slug}`;

      // 若该集群绝大多数记忆已被某个现有心智模型 derived_from 覆盖，则跳过重复合成
      const topMembers = bucket.memories.slice(0, 4);
      const alreadyCovered = topMembers.every((m) => (derivedParentsByTo.get(m.id)?.size ?? 0) > 0);
      const existingSlotModel = db.get<MemoryRecord>(
        `SELECT * FROM memories
         WHERE scope = 'workspace' AND COALESCE(workspace_id, '') = ?
           AND slot_key = ? AND status IN ('active', 'candidate', 'frozen')`,
        [wsId, modelSlotKey]
      );
      if (alreadyCovered && existingSlotModel) continue;

      const hasFailureOrProc = topMembers.some(
        (m) => m.type === 'failure' || m.type === 'procedural'
      );
      const synthType: MemoryType = hasFailureOrProc ? 'procedural' : 'belief';
      const synthNet: HindsightNetwork = hasFailureOrProc ? 'observation' : 'opinion';

      const clauses = topMembers.map((m) => {
        const tag = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
        const text = redactSecrets((m.summary || m.content).trim()).text.replace(/\s+/g, ' ');
        return `[${tag}] ${text.slice(0, 95)}`;
      });

      const summary = `[Hindsight 心智模型] ${bucket.label} 综合认知与操作准则`.slice(0, 75);
      const content = `针对「${bucket.label}」的跨网络归纳心智模型（融合 ${topMembers.length} 条事实与经验）：${clauses.join('；')}。`.slice(
        0,
        380
      );

      // 收集真实来源证据以坚守信任边界
      const collectedSources: Array<{
        session_id: string;
        seq: number;
        kind: string;
        excerpt?: string;
      }> = [];
      let allUserVerified = true;
      for (const m of topMembers) {
        if (!hasUserEvidence(db, m)) {
          allUserVerified = false;
        }
        const mSrcs = db.all<{
          session_id: string;
          seq: number;
          kind: string;
          excerpt: string | null;
        }>(
          `SELECT session_id, seq, kind, excerpt FROM memory_sources
           WHERE memory_id = ? AND content_rev = ? LIMIT 1`,
          [m.id, m.content_rev]
        );
        for (const s of mSrcs) {
          collectedSources.push({
            session_id: s.session_id,
            seq: s.seq,
            kind: s.kind,
            excerpt: s.excerpt || m.summary.slice(0, 80),
          });
        }
      }

      if (collectedSources.length === 0) {
        collectedSources.push({
          session_id: options.sessionId || 'hindsight_reflect',
          seq: 0,
          kind: 'assistant',
          excerpt: summary,
        });
        allUserVerified = false;
      }

      const avgConf =
        topMembers.reduce((acc, m) => acc + m.confidence, 0) / Math.max(1, topMembers.length);
      const modelConf = Number(Math.min(0.95, avgConf * 0.95 + 0.05).toFixed(2));

      const upsertRes = upsertCandidate(
        db,
        {
          type: synthType,
          content,
          summary,
          slot_key: modelSlotKey,
          scope: 'workspace',
          workspaceId: wsId,
          sessionId: options.sessionId,
          source_kind: allUserVerified ? 'user' : 'llm_extract',
          origin_kinds: [allUserVerified ? 'user' : 'assistant'],
          confidence: modelConf,
          importance: 8,
          status: allUserVerified ? 'active' : 'candidate',
          sources: collectedSources.slice(0, 4),
          actor: allUserVerified ? 'user' : 'llm',
        },
        now
      );

      if ('id' in upsertRes) {
        const snapshotMeta = JSON.stringify({
          sources: topMembers.map((m) => ({
            memory_id: m.id,
            content_rev: m.content_rev,
            hash: m.hash,
          })),
        });
        for (const m of topMembers) {
          if (m.id === upsertRes.id) continue;
          db.run(
            `INSERT OR IGNORE INTO memory_relations (from_id, to_id, rel, metadata, created_at)
             VALUES (?, ?, 'derived_from', ?, ?)`,
            [upsertRes.id, m.id, snapshotMeta, now]
          );
          addRelation(db, upsertRes.id, m.id, 'related', now);
        }

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

/**
 * Hindsight 认知演化时间线与因果溯源链追踪 (`traceHindsightEvolution`)
 * 沿着 supersedes 历史链、memory_versions 版本快照、derived_from 归纳链与 contradicts 矛盾边还原某条信念/事实的完整演化轨迹
 */
export function traceHindsightEvolution(
  db: Db,
  targetMemory: MemoryRecord
): HindsightEvolutionTrace {
  const net = classifyHindsightNetwork(targetMemory.type, targetMemory.slot_key);
  const timeline: HindsightEvolutionNode[] = [];

  // 1. 追溯 supersedes 历史祖先链 (最多向后追溯 6 代)
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
    const oldMem: MemoryRecord | undefined = db.get<MemoryRecord>(
      'SELECT * FROM memories WHERE id = ?',
      [sup.to_id]
    );
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

  // 2. 加入当前节点自身的历史版本快照 (memory_versions)
  const verRows = db.all<{ version: number; snapshot: string; created_at: number }>(
    `SELECT version, snapshot, created_at FROM memory_versions WHERE memory_id = ? ORDER BY version ASC LIMIT 6`,
    [targetMemory.id]
  );
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
    } catch {}
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
  const derivedSourceRows = db.all<MemoryRecord>(
    `SELECT m.* FROM memory_relations r
     JOIN memories m ON m.id = r.to_id
     WHERE r.from_id = ? AND r.rel = 'derived_from'
     ORDER BY m.updated_at DESC LIMIT 8`,
    [targetMemory.id]
  );
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

  const derivedModelRows = db.all<MemoryRecord>(
    `SELECT m.* FROM memory_relations r
     JOIN memories m ON m.id = r.from_id
     WHERE r.to_id = ? AND r.rel = 'derived_from'
     ORDER BY m.updated_at DESC LIMIT 8`,
    [targetMemory.id]
  );
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

  // 5. 矛盾张力节点 (contradicts)
  const contraRows = db.all<MemoryRecord>(
    `SELECT m.* FROM memory_relations r
     JOIN memories m ON (m.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END)
     WHERE (r.from_id = ? OR r.to_id = ?) AND r.rel = 'contradicts'
     ORDER BY m.updated_at DESC LIMIT 6`,
    [targetMemory.id, targetMemory.id, targetMemory.id]
  );
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
