import fs from 'node:fs';
import path from 'node:path';
import type {
  Db,
  MemoryRecord,
  MemoryRow,
  MemorySource,
  MemoryType,
  Scope,
  VikingCategory,
  VikingContextTier,
} from '../types.js';
import { hydrateMemoryRow } from '../types.js';
import { workspaceId, scopeFilterSQL, resolveWorkspaceCwd } from './scope.js';
import { get, sources } from './store.js';
import { redactSecrets, isWorkspaceExcluded } from './privacy.js';
import { extractEntities, segment, tokenSet, isTokenMatch } from './text.js';
import { budgetTokens } from './tokens.js';
import { computeLocalEmbedding, cosineSimilarity, getOrComputeEmbedding } from './vector.js';
import {
  serializeMemoryToMarkdown,
  parseMemoryMarkdown,
  atomicWriteFileSync,
  isPathInsideRoot,
  safeReadTextFileSync,
  safeFilenameId,
} from './markdown.js';
import { upsertCandidate, pin, freeze } from './writer.js';
import { classifyHindsightNetwork } from './hindsight.js';

export const VIKING_CATEGORY_DESCRIPTIONS: Record<VikingCategory, string> = {
  core: 'Letta/OpenViking 常驻核心工作台记忆 (human / persona / project)',
  profile: '用户长期身份画像与基础背景特征',
  preferences: '用户编码风格、交互语言与工程偏好规范',
  entities: '项目架构实体、服务配置、模块拓扑与客观事实 (World)',
  events: '关键历史决策、版本演进里程碑与活跃目标 (Events & Goals)',
  cases: '故障排查案例、报错根因分析与避坑防错指南 (Troubleshooting Cases)',
  skills: '经实战检验的可复用操作规程、构建部署工作流与执行轨迹 (Procedural Skills)',
  models: '跨会话归纳演化的心智模型与架构信念 (Mental Models & Opinions)',
};

const ALL_VIKING_CATEGORIES: VikingCategory[] = [
  'core',
  'profile',
  'preferences',
  'entities',
  'events',
  'cases',
  'skills',
  'models',
];

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

const SQL_IN_CHUNK_SIZE = 400;
const MAX_VIKING_OUTPUT_TOKENS = 1500;
const MAX_VIKING_IMPORT_DEPTH = 6;
const MAX_VIKING_IMPORT_FILES = 500;
const MAX_VIKING_IMPORT_FILE_BYTES = 256 * 1024;

function sanitizePathSegment(seg: string): string {
  return seg
    .toLowerCase()
    .trim()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function canonUri(s: string): string {
  return s.toLowerCase().replace(/[-_]+/g, '-');
}

function normalizePathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/**
 * 将单条记忆映射至 OpenViking 语义目录分类
 */
export function classifyVikingCategory(
  memory: Pick<MemoryRecord, 'type' | 'scope' | 'slot_key'>
): VikingCategory {
  if (memory.slot_key && memory.slot_key.startsWith('core:')) {
    return 'core';
  }
  if (
    memory.scope === 'user' &&
    memory.slot_key &&
    memory.slot_key.startsWith('user.profile')
  ) {
    return 'profile';
  }
  if (memory.slot_key && memory.slot_key.startsWith('hindsight.model.')) {
    return 'models';
  }
  switch (memory.type) {
    case 'preference':
      return 'preferences';
    case 'semantic':
      return 'entities';
    case 'episodic':
    case 'goal':
      return 'events';
    case 'failure':
      return 'cases';
    case 'procedural':
      return 'skills';
    case 'belief':
      return 'models';
    default:
      return 'entities';
  }
}

/**
 * 与 classifyVikingCategory 1:1 等价的 SQL 过滤谓词，用于下推至 SQLite WHERE 避免 LIMIT 300 截断饥饿
 */
function categoryFilterSQL(
  category: VikingCategory,
  tableAlias?: string
): { sql: string; params: unknown[] } {
  const p = tableAlias ? `${tableAlias}.` : '';
  const notCore = `COALESCE(${p}slot_key, '') NOT LIKE 'core:%'`;
  const notModel = `COALESCE(${p}slot_key, '') NOT LIKE 'hindsight.model.%'`;
  const notUserProfile = `NOT (${p}scope = 'user' AND COALESCE(${p}slot_key, '') LIKE 'user.profile%')`;

  switch (category) {
    case 'core':
      return { sql: `(${p}slot_key LIKE 'core:%')`, params: [] };
    case 'profile':
      return {
        sql: `(${p}scope = 'user' AND ${p}slot_key LIKE 'user.profile%' AND ${notCore})`,
        params: [],
      };
    case 'preferences':
      return {
        sql: `(${p}type = 'preference' AND ${notCore} AND ${notModel} AND ${notUserProfile})`,
        params: [],
      };
    case 'entities':
      return {
        sql: `(${p}type = 'semantic' AND ${notCore} AND ${notModel} AND ${notUserProfile})`,
        params: [],
      };
    case 'events':
      return {
        sql: `(${p}type IN ('episodic', 'goal') AND ${notCore} AND ${notModel} AND ${notUserProfile})`,
        params: [],
      };
    case 'cases':
      return {
        sql: `(${p}type = 'failure' AND ${notCore} AND ${notModel} AND ${notUserProfile})`,
        params: [],
      };
    case 'skills':
      return {
        sql: `(${p}type = 'procedural' AND ${notCore} AND ${notModel} AND ${notUserProfile})`,
        params: [],
      };
    case 'models':
      return {
        sql: `((${p}slot_key LIKE 'hindsight.model.%' OR ${p}type = 'belief') AND ${notCore} AND ${notUserProfile})`,
        params: [],
      };
  }
}

/**
 * 批量按字典序加载 memory_entities，确保跨调用 URI 解析 100% 确定性
 */
function loadEntitiesBatch(db: Db, memoryIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const uniqueIds = [...new Set(memoryIds.filter(Boolean))];
  for (let i = 0; i < uniqueIds.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + SQL_IN_CHUNK_SIZE);
    const rows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity
       FROM memory_entities
       WHERE memory_id IN (${chunk.map(() => '?').join(', ')})
       ORDER BY entity ASC`,
      chunk
    );
    for (const r of rows) {
      let list = map.get(r.memory_id);
      if (!list) {
        list = [];
        map.set(r.memory_id, list);
      }
      list.push(r.entity);
    }
  }
  return map;
}

/**
 * 为任意记忆生成确定性的 OpenViking 虚拟文件系统 URI (`viking://...`)
 */
export function resolveVikingUri(
  memory: Pick<MemoryRecord, 'id' | 'type' | 'scope' | 'slot_key' | 'workspace_id'>,
  entities?: string[]
): string {
  const category = classifyVikingCategory(memory);
  if (category === 'core' && memory.slot_key) {
    const block = memory.slot_key.replace(/^core:/, '').trim() || 'project';
    return `viking://agent/core/${sanitizePathSegment(block)}`;
  }

  const domainPrefix =
    category === 'profile' || (category === 'preferences' && memory.scope === 'user')
      ? 'viking://user/memories'
      : 'viking://workspace/memories';

  const shortId = memory.id.slice(0, 8);

  if (memory.slot_key) {
    if (memory.slot_key.startsWith('hindsight.model.')) {
      const cleanModelSlug = memory.slot_key
        .replace(/^hindsight\.model\./, '')
        .split('.')
        .map(sanitizePathSegment)
        .filter(Boolean);
      if (cleanModelSlug.length > 0) {
        return `${domainPrefix}/${category}/hindsight/${cleanModelSlug.join('/')}`;
      }
      return `${domainPrefix}/${category}/hindsight/${shortId}`;
    }

    const cleanSlot = memory.slot_key
      .split('.')
      .map(sanitizePathSegment)
      .filter(Boolean);
    if (cleanSlot.length > 0) {
      return `${domainPrefix}/${category}/${cleanSlot.join('/')}`;
    }
  }

  if (entities && entities.length > 0) {
    const primaryEnt = sanitizePathSegment(entities[0]);
    if (primaryEnt && primaryEnt.length >= 2) {
      return `${domainPrefix}/${category}/${primaryEnt}/${shortId}`;
    }
  }

  return `${domainPrefix}/${category}/${shortId}`;
}

/**
 * 批量确定性解析一组记忆的 OpenViking URI（分批 400 查询 memory_entities ORDER BY entity ASC）
 */
export function resolveVikingUrisBatch(db: Db, records: MemoryRecord[]): Map<string, string> {
  const result = new Map<string, string>();
  if (!records || records.length === 0) return result;
  const entitiesByMem = loadEntitiesBatch(
    db,
    records.map((r) => r.id)
  );
  for (const r of records) {
    const sortedEntities = entitiesByMem.get(r.id) || [];
    result.set(r.id, resolveVikingUri(r, sortedEntities));
  }
  return result;
}

/**
 * 生成 L0 (Abstract) 一句话超简摘要 (~15-50 tokens)
 */
export function buildL0Abstract(memory: MemoryRecord): string {
  const raw = (memory.summary || memory.content || '').trim();
  const clean = redactSecrets(raw).text.replace(/\s+/g, ' ').trim();
  return clean.length <= 100 ? clean : `${clean.slice(0, 97)}...`;
}

/**
 * 生成单行内联 L1 (Overview) 结构化中层概览 (~45-110 tokens)
 * 严格保证输出字符数不超过 maxChars（即便 slot_key 很长也不会越界）
 */
export function buildInlineL1Overview(memory: MemoryRecord, maxChars: number = 210): string {
  const limit = Math.max(16, Math.floor(Number.isFinite(maxChars) ? maxChars : 210));
  const cleanSummary = redactSecrets((memory.summary || '').trim())
    .text.replace(/\s+/g, ' ')
    .trim();
  const cleanContent = redactSecrets((memory.content || '').trim())
    .text.replace(/\s+/g, ' ')
    .trim();

  let slotTag = '';
  if (memory.slot_key && !memory.slot_key.startsWith('core:')) {
    const maxSlotChars = Math.max(0, Math.min(Math.floor(limit * 0.45), limit - 16));
    if (maxSlotChars >= 6) {
      const rawSlot = memory.slot_key.trim();
      const slotInner =
        rawSlot.length + 3 <= maxSlotChars
          ? rawSlot
          : `${rawSlot.slice(0, Math.max(1, maxSlotChars - 6))}...`;
      slotTag = `[${slotInner}] `;
    }
  }

  const bodyBudget = Math.max(0, limit - slotTag.length);
  if (bodyBudget === 0) {
    return slotTag.trim().slice(0, limit);
  }

  let body = cleanContent || cleanSummary;
  if (
    cleanSummary &&
    cleanContent &&
    cleanContent.length + cleanSummary.length + 3 <= bodyBudget &&
    !cleanContent.startsWith(cleanSummary.slice(0, 16))
  ) {
    body = `${cleanSummary} — ${cleanContent}`;
  }

  if (body.length > bodyBudget) {
    const sliced = body.slice(0, bodyBudget);
    const lastPunct = Math.max(
      sliced.lastIndexOf('。'),
      sliced.lastIndexOf('；'),
      sliced.lastIndexOf('; '),
      sliced.lastIndexOf('. ')
    );
    if (lastPunct >= Math.floor(bodyBudget * 0.5) && lastPunct + 1 <= bodyBudget) {
      body = sliced.slice(0, lastPunct + 1).trimEnd();
    } else if (bodyBudget >= 4) {
      body = `${body.slice(0, bodyBudget - 3).trimEnd()}...`;
    } else {
      body = body.slice(0, bodyBudget);
    }
  }

  const combined = `${slotTag}${body}`.trim();
  return combined.length <= limit ? combined : combined.slice(0, limit);
}

export interface TieredMemoryView {
  id: string;
  uri: string;
  category: VikingCategory;
  network: string;
  l0Abstract: string;
  l1Overview: string;
  l2Detail: string;
}

/**
 * 构建单条记忆的完整 OpenViking L0 / L1 / L2 三层视图
 */
export function buildTieredMemoryView(
  memory: MemoryRecord,
  options?: {
    entities?: string[];
    sources?: MemorySource[];
    relations?: Array<{
      dir: string;
      rel: string;
      otherId: string;
      otherStatus: string;
      otherSummary: string;
    }>;
  }
): TieredMemoryView {
  const ents =
    options?.entities && options.entities.length > 0
      ? options.entities
      : extractEntities(`${memory.summary} ${memory.content}`, 6);
  const uri = resolveVikingUri(memory, ents);
  const category = classifyVikingCategory(memory);
  const network = classifyHindsightNetwork(memory.type, memory.slot_key);

  const l0Abstract = buildL0Abstract(memory);
  const inlineOverview = buildInlineL1Overview(memory, 240);
  const entBadge = ents.length > 0 ? ` | Entities: ${ents.slice(0, 4).join(', ')}` : '';
  const slotBadge = memory.slot_key ? ` | Slot: ${memory.slot_key}` : '';
  const l1Overview = `[L1 ${uri}] (${network.toUpperCase()} · c=${memory.confidence.toFixed(2)}, u=${memory.utility.toFixed(2)}${slotBadge}${entBadge})\n${inlineOverview}`;

  const cleanContent = redactSecrets(memory.content).text;
  const l2Lines: string[] = [
    `[L2 ${uri}] (id=${memory.id}, rev=${memory.content_rev}, network=${network.toUpperCase()}, type=${memory.type}, c=${memory.confidence.toFixed(2)}, u=${memory.utility.toFixed(2)})`,
    cleanContent,
  ];

  if (options?.sources && options.sources.length > 0) {
    l2Lines.push('Sources:');
    for (const s of options.sources.slice(0, 3)) {
      const sessShort = (s.session_id || '').slice(0, 8);
      const excerpt = s.excerpt ? ` "${redactSecrets(s.excerpt).text.slice(0, 60)}"` : '';
      l2Lines.push(`  - session ${sessShort} seq ${s.seq} (${s.kind})${excerpt}`);
    }
  }

  if (options?.relations && options.relations.length > 0) {
    l2Lines.push('Relations:');
    for (const r of options.relations.slice(0, 4)) {
      const sum = redactSecrets(r.otherSummary || '').text.slice(0, 60);
      l2Lines.push(`  - ${r.dir} [${r.otherId}] (${r.otherStatus}) ${sum}`);
    }
  }

  return {
    id: memory.id,
    uri,
    category,
    network,
    l0Abstract,
    l1Overview,
    l2Detail: l2Lines.join('\n'),
  };
}

/**
 * 规范化用户输入的虚拟路径或目录简写为标准 `viking://` 前缀
 * 折叠连续斜杠，并显式拒绝 `..` 路径遍历段
 */
export function normalizeVikingUriInput(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '/' || trimmed === 'viking://' || trimmed === 'viking://~' || trimmed === 'viking://~/') {
    return 'viking://';
  }

  const normalizedSlashes = trimmed.toLowerCase().replace(/\\/g, '/');
  const hasScheme = normalizedSlashes.startsWith('viking://');
  const rawBody = hasScheme ? normalizedSlashes.slice('viking://'.length) : normalizedSlashes;
  const collapsed = rawBody.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');

  if (!collapsed || collapsed === '~') {
    return 'viking://';
  }

  const segments = collapsed.split('/');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Invalid Viking URI: path traversal segment ".." is not allowed`);
    }
  }

  const filteredSegs = segments.filter((s) => s !== '' && s !== '.');
  if (filteredSegs.length === 0) {
    return 'viking://';
  }

  if (hasScheme) {
    if (filteredSegs[0] === '~') {
      filteredSegs[0] = 'user';
    }
    return `viking://${filteredSegs.join('/')}`;
  }

  const clean = filteredSegs.join('/');
  if (clean === 'core' || clean.startsWith('core/')) {
    return `viking://agent/${clean}`;
  }
  if (clean === 'profile' || clean.startsWith('profile/')) {
    return `viking://user/memories/${clean}`;
  }
  if (clean === 'preferences' || clean.startsWith('preferences/')) {
    return `viking://user/memories/${clean}`;
  }
  const wsCategories: VikingCategory[] = ['entities', 'events', 'cases', 'skills', 'models'];
  for (const cat of wsCategories) {
    if (clean === cat || clean.startsWith(`${cat}/`)) {
      return `viking://workspace/memories/${clean}`;
    }
  }
  return `viking://${clean}`;
}

interface ParsedVikingTarget {
  domain?: 'user' | 'workspace' | 'agent';
  category?: VikingCategory;
  subFilter: string;
  explicitWorkspaceDomain: boolean;
}

function parseVikingTarget(targetUri: string, rawInput?: string | null): ParsedVikingTarget {
  const m = targetUri.match(
    /^viking:\/\/(user|workspace|agent)\/(?:memories\/)?(core|profile|preferences|entities|events|cases|skills|models)(?:\/(.*))?$/i
  );
  if (!m) {
    return { subFilter: '', explicitWorkspaceDomain: false };
  }
  const domain = m[1].toLowerCase() as 'user' | 'workspace' | 'agent';
  const category = m[2].toLowerCase() as VikingCategory;
  const subFilter = (m[3] || '').toLowerCase().replace(/^\/+|\/+$/g, '');
  const rawLower = (rawInput || '').trim().toLowerCase().replace(/\\/g, '/');
  const explicitWorkspaceDomain = rawLower.startsWith('viking://workspace/');
  return { domain, category, subFilter, explicitWorkspaceDomain };
}

/**
 * 提取某条记忆 URI 中位于 `/<category>/` 之后的子路径段
 */
function extractCategorySubpath(uri: string, category: VikingCategory): string {
  const low = uri.toLowerCase();
  const marker = `/${category}/`;
  const idx = low.indexOf(marker);
  if (idx === -1) return '';
  return low.slice(idx + marker.length).replace(/^\/+|\/+$/g, '');
}

/**
 * 在 `/` 路径段边界上判断 subFilter 是否命中（禁止任意子串 .includes() 误匹配）
 */
function matchesSubFilterBoundary(
  uri: string,
  category: VikingCategory,
  slotKey: string | null | undefined,
  subFilter: string
): boolean {
  if (!subFilter) return true;
  const canonSub = canonUri(subFilter);
  const uriSub = canonUri(extractCategorySubpath(uri, category));
  if (uriSub && (uriSub === canonSub || uriSub.startsWith(`${canonSub}/`))) {
    return true;
  }
  if (slotKey) {
    const slotAsPath = canonUri(
      slotKey
        .replace(/^core:/i, '')
        .replace(/^hindsight\.model\./i, 'hindsight/')
        .replace(/\./g, '/')
    );
    if (slotAsPath === canonSub || slotAsPath.startsWith(`${canonSub}/`)) {
      return true;
    }
  }
  return false;
}

function matchesVikingSubtree(
  item: { record: MemoryRecord; uri: string; category: VikingCategory },
  targetUri: string,
  parsed: ParsedVikingTarget
): boolean {
  if (targetUri === 'viking://') return true;
  const lowUri = item.uri.toLowerCase();
  const canonItem = canonUri(lowUri);
  const canonTarget = canonUri(targetUri);

  if (canonItem === canonTarget || canonItem.startsWith(`${canonTarget}/`)) {
    return true;
  }

  if (parsed.category && item.category === parsed.category) {
    // 若用户显式指定 viking://workspace/memories/preferences，则仅匹配 workspace 域偏好；
    // 若使用简写 preferences 或根目录默认入口 viking://user/memories/preferences，则同时兼容 user 与 workspace 偏好。
    if (parsed.category === 'preferences' && parsed.explicitWorkspaceDomain) {
      if (item.record.scope !== 'workspace') return false;
    }
    return matchesSubFilterBoundary(item.uri, parsed.category, item.record.slot_key, parsed.subFilter);
  }

  return false;
}

/**
 * 将输出严格收敛在 maxTokens (默认 1500 tokens) 内，超限时截断并附 `+N more` 提示
 */
function enforceTokenCap(
  header: string,
  itemBlocks: string[],
  totalCount: number,
  maxTokens: number = MAX_VIKING_OUTPUT_TOKENS
): string {
  const kept: string[] = [];
  for (let i = 0; i < itemBlocks.length; i++) {
    const nextKept = [...kept, itemBlocks[i]];
    const remaining = Math.max(0, totalCount - nextKept.length);
    const footer = remaining > 0 ? `... (+${remaining} more)` : '';
    const candidate = footer
      ? [header, ...nextKept, footer].join('\n')
      : [header, ...nextKept].join('\n');
    if (budgetTokens(candidate) <= maxTokens) {
      kept.push(itemBlocks[i]);
    } else {
      break;
    }
  }

  if (kept.length === 0 && itemBlocks.length > 0) {
    const remaining = Math.max(0, totalCount - 1);
    const footer = remaining > 0 ? `... (+${remaining} more)` : '';
    const fixedOverhead = budgetTokens(footer ? `${header}\n\n${footer}` : header);
    const availTokens = Math.max(40, maxTokens - fixedOverhead - 10);
    let truncated = itemBlocks[0];
    while (truncated.length > 40 && budgetTokens(truncated) > availTokens) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.75));
    }
    truncated = `${truncated.trimEnd()}...`;
    kept.push(truncated);
  }

  const remaining = Math.max(0, totalCount - kept.length);
  while (kept.length > 0) {
    const rem = Math.max(0, totalCount - kept.length);
    const lines = rem > 0 ? [header, ...kept, `... (+${rem} more)`] : [header, ...kept];
    const out = lines.join('\n');
    if (budgetTokens(out) <= maxTokens) return out;
    kept.pop();
  }

  const fallback =
    remaining > 0 ? `${header}\n... (+${totalCount} more)` : header;
  return budgetTokens(fallback) <= maxTokens
    ? fallback
    : `${fallback.slice(0, Math.min(fallback.length, 400))}...`;
}

function capSingleOutputToTokens(text: string, maxTokens: number = MAX_VIKING_OUTPUT_TOKENS): string {
  if (budgetTokens(text) <= maxTokens) return text;
  let cut = text;
  const suffix = '\n... (truncated to token limit)';
  while (cut.length > 60 && budgetTokens(`${cut}${suffix}`) > maxTokens) {
    cut = cut.slice(0, Math.floor(cut.length * 0.8));
  }
  return `${cut.trimEnd()}${suffix}`;
}

/**
 * 支持通过 `viking://` 虚拟路径或传统记忆 ID/短码解析目标记忆
 * 安全约束：必须显式提供 workspaceId；URI 解析严格校验 status IN ('active','frozen') 与路径前缀匹配
 */
export function resolveMemoryByVikingUriOrId(
  db: Db,
  idOrUri: string,
  scopeCtx?: { workspaceId?: string; sessionId?: string }
): MemoryRecord | undefined {
  const raw = (idOrUri || '').trim();
  if (!raw) return undefined;

  const rawWs = scopeCtx?.workspaceId?.trim();
  if (!rawWs) return undefined;
  const wsId = workspaceId(rawWs);
  if (!wsId) return undefined;

  const scopedCtx = { workspaceId: wsId, sessionId: scopeCtx?.sessionId };

  if (!raw.toLowerCase().startsWith('viking://') && !raw.includes('/')) {
    const hit = get(db, raw, scopedCtx);
    return hit ? hydrateMemoryRow(hit as MemoryRow) : undefined;
  }

  let targetUri: string;
  try {
    targetUri = normalizeVikingUriInput(raw);
  } catch {
    return undefined;
  }

  if (targetUri === 'viking://') {
    return undefined;
  }

  const scope = scopeFilterSQL(scopedCtx);
  const parsedTarget = parseVikingTarget(targetUri, raw);

  // 1. Core Memory 路径: viking://agent/core/{block}
  const coreMatch = targetUri.match(/^viking:\/\/agent\/core\/([a-z0-9_-]+)$/i);
  if (coreMatch) {
    const block = coreMatch[1].toLowerCase();
    const coreRow = db.get<MemoryRow>(
      `SELECT * FROM memories
       WHERE slot_key = ?
         AND (${scope.sql})
         AND status IN ('active', 'frozen')
       ORDER BY version DESC LIMIT 1`,
      [`core:${block}`, ...scope.params]
    );
    return hydrateMemoryRow(coreRow);
  }

  // 纯目录路径（无子路径段）不能错误解析成某个叶子节点
  if (parsedTarget.category && !parsedTarget.subFilter) {
    return undefined;
  }

  const canonTarget = canonUri(targetUri);

  // 2. 末尾带有 m_xxxx 短码：必须同时校验 status IN ('active','frozen')、非 meta 及路径前缀匹配
  const segments = targetUri.split('/').filter(Boolean);
  const lastSeg = segments[segments.length - 1] || '';
  if (lastSeg.startsWith('m_') && lastSeg.length >= 6) {
    try {
      const byShort = get(db, lastSeg, scopedCtx);
      if (
        byShort &&
        (byShort.status === 'active' || byShort.status === 'frozen') &&
        byShort.type !== 'meta'
      ) {
        const hydrated = hydrateMemoryRow(byShort as MemoryRow);
        const uriMap = resolveVikingUrisBatch(db, [hydrated]);
        const resolvedUri = uriMap.get(hydrated.id) || resolveVikingUri(hydrated);
        const canonResolved = canonUri(resolvedUri);

        if (canonResolved === canonTarget) {
          return hydrated;
        }

        // 校验请求的父目录前缀是否与实际解析路径匹配（阻止跨目录伪造路径如 cases/m_entityId）
        const targetDirPrefix = canonUri(
          targetUri.slice(0, targetUri.length - lastSeg.length).replace(/\/+$/, '')
        );
        const memCat = classifyVikingCategory(hydrated);
        if (
          targetDirPrefix &&
          (canonResolved.startsWith(`${targetDirPrefix}/`) ||
            (parsedTarget.category === 'preferences' &&
              !parsedTarget.explicitWorkspaceDomain &&
              memCat === 'preferences' &&
              matchesSubFilterBoundary(
                resolvedUri,
                'preferences',
                hydrated.slot_key,
                parsedTarget.subFilter
              )))
        ) {
          return hydrated;
        }
      }
    } catch {
      // ignore short-id ambiguity and fall through to exact URI lookup
    }
  }

  // 3. 将 category 谓词下推至 SQL WHERE，消除 LIMIT 300 饥饿，并使用批量确定性 URI 精确匹配
  const catFilter = parsedTarget.category ? categoryFilterSQL(parsedTarget.category) : null;
  const whereParts = [
    `(${scope.sql})`,
    `status IN ('active', 'frozen')`,
    `type != 'meta'`,
  ];
  const params: unknown[] = [...scope.params];
  if (catFilter) {
    whereParts.push(catFilter.sql);
    params.push(...catFilter.params);
  }
  if (parsedTarget.category === 'preferences' && parsedTarget.explicitWorkspaceDomain) {
    whereParts.push(`scope = 'workspace'`);
  }

  const rows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE ${whereParts.join(' AND ')}
       ORDER BY pinned DESC, utility DESC, updated_at DESC
       LIMIT 1000`,
      params
    )
    .map((r) => hydrateMemoryRow(r));

  if (rows.length === 0) return undefined;

  const uriMap = resolveVikingUrisBatch(db, rows);
  for (const r of rows) {
    const resolvedUri = uriMap.get(r.id) || resolveVikingUri(r);
    const canonResolved = canonUri(resolvedUri);
    if (canonResolved === canonTarget) {
      return r;
    }
    // 兼容 preferences 简写对 workspace 偏好精确叶子匹配
    if (
      parsedTarget.category === 'preferences' &&
      !parsedTarget.explicitWorkspaceDomain &&
      classifyVikingCategory(r) === 'preferences' &&
      parsedTarget.subFilter
    ) {
      const resolvedSub = canonUri(extractCategorySubpath(resolvedUri, 'preferences'));
      if (resolvedSub === canonUri(parsedTarget.subFilter)) {
        return r;
      }
    }
  }

  return undefined;
}

/**
 * OpenViking 目录递归检索与分层浏览 (`browseVikingDirectory`)
 * 支持在 `viking://` 树上进行 L0 (abstract) / L1 (overview) / L2 (detail) 渐进式浏览
 */
export function browseVikingDirectory(
  db: Db,
  options: {
    uri?: string;
    workspaceId?: string;
    sessionId?: string;
    tier?: VikingContextTier;
    limit?: number;
  } = {}
): string {
  const wsId = workspaceId(options.workspaceId || process.cwd());
  const tier: VikingContextTier = options.tier || 'L0';
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const targetUri = normalizeVikingUriInput(options.uri);
  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId });

  // 1. 根目录 viking://：按 8 个语义分类下推 SQL 统计与预览，彻底消除全局 LIMIT 300 饥饿
  if (targetUri === 'viking://') {
    const orderedCats: VikingCategory[] = [
      'core',
      'preferences',
      'entities',
      'skills',
      'cases',
      'models',
      'events',
      'profile',
    ];
    const previewCount = tier === 'L0' ? 3 : 2;

    const catBuckets: Array<{
      cat: VikingCategory;
      count: number;
      preview: MemoryRecord[];
    }> = [];
    const allPreviewRows: MemoryRecord[] = [];
    let totalMemories = 0;

    for (const cat of orderedCats) {
      const catFilter = categoryFilterSQL(cat);
      const cnt =
        db.get<{ c: number }>(
          `SELECT COUNT(*) AS c FROM memories
           WHERE (${scope.sql})
             AND status IN ('active', 'frozen')
             AND type != 'meta'
             AND ${catFilter.sql}`,
          [...scope.params, ...catFilter.params]
        )?.c || 0;
      if (cnt === 0) continue;

      totalMemories += cnt;
      const preview = db
        .all<MemoryRow>(
          `SELECT * FROM memories
           WHERE (${scope.sql})
             AND status IN ('active', 'frozen')
             AND type != 'meta'
             AND ${catFilter.sql}
           ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
           LIMIT ?`,
          [...scope.params, ...catFilter.params, previewCount]
        )
        .map((r) => hydrateMemoryRow(r));
      catBuckets.push({ cat, count: cnt, preview });
      allPreviewRows.push(...preview);
    }

    if (totalMemories === 0) {
      return `📂 [OpenViking Context Tree] (${targetUri})\n(当前工作区暂无活跃记忆)`;
    }

    const uriMap = resolveVikingUrisBatch(db, allPreviewRows);
    const header = `📂 [OpenViking Context Filesystem] root=viking:// (tier=${tier}, total=${totalMemories})`;
    const categoryBlocks: string[] = [];

    for (const bucket of catBuckets) {
      const { cat, count, preview } = bucket;
      const dirUri =
        cat === 'core'
          ? 'viking://agent/core/'
          : cat === 'preferences' || cat === 'profile'
            ? `viking://user/memories/${cat}/`
            : `viking://workspace/memories/${cat}/`;

      const blockLines: string[] = [
        `\n📁 ${dirUri} (${count} items) — ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`,
      ];
      for (const m of preview) {
        const uri = uriMap.get(m.id) || resolveVikingUri(m);
        const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
        if (tier === 'L1') {
          blockLines.push(
            `  ├─ [${m.id}] ${uri} (${net}, c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})\n  │    ${buildInlineL1Overview(m, 180)}`
          );
        } else {
          blockLines.push(`  ├─ [${m.id}] ${uri} — ${buildL0Abstract(m)}`);
        }
      }
      if (count > preview.length) {
        blockLines.push(`  └─ ... (+${count - preview.length} more, inspect via "${dirUri}")`);
      }
      categoryBlocks.push(blockLines.join('\n'));
    }

    return enforceTokenCap(header, categoryBlocks, categoryBlocks.length, MAX_VIKING_OUTPUT_TOKENS);
  }

  // 2. 子目录或单节点浏览：先下推 categoryFilterSQL 至 WHERE，避免 LIMIT 截断
  const parsedTarget = parseVikingTarget(targetUri, options.uri);
  const whereParts = [
    `(${scope.sql})`,
    `status IN ('active', 'frozen')`,
    `type != 'meta'`,
  ];
  const params: unknown[] = [...scope.params];
  if (parsedTarget.category) {
    const catFilter = categoryFilterSQL(parsedTarget.category);
    whereParts.push(catFilter.sql);
    params.push(...catFilter.params);
    if (parsedTarget.category === 'preferences' && parsedTarget.explicitWorkspaceDomain) {
      whereParts.push(`scope = 'workspace'`);
    }
  }

  const sqlLimit = parsedTarget.subFilter ? 1000 : Math.max(limit * 4, 200);
  const rows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE ${whereParts.join(' AND ')}
       ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
       LIMIT ?`,
      [...params, sqlLimit]
    )
    .map((r) => hydrateMemoryRow(r));

  if (rows.length === 0) {
    return `📂 [OpenViking Context Tree] No memories found under '${targetUri}'.`;
  }

  const entitiesByMem = loadEntitiesBatch(
    db,
    rows.map((r) => r.id)
  );
  const itemsWithUri = rows.map((r) => {
    const ents = entitiesByMem.get(r.id) || [];
    const uri = resolveVikingUri(r, ents);
    const category = classifyVikingCategory(r);
    return { record: r, uri, category, entities: ents };
  });

  const matched = itemsWithUri.filter((it) => matchesVikingSubtree(it, targetUri, parsedTarget));

  if (matched.length === 0) {
    return `📂 [OpenViking Context Tree] No memories found under '${targetUri}'.`;
  }

  // 若精确命中单条叶子节点且请求 L2（或精确匹配单条 URI），直接展示分层详情
  if (
    matched.length === 1 &&
    (tier === 'L2' || canonUri(matched[0].uri) === canonUri(targetUri))
  ) {
    const hit = matched[0];
    const srcList = sources(db, hit.record.id, hit.record.content_rev);
    const view = buildTieredMemoryView(hit.record, {
      entities: hit.entities,
      sources: srcList,
    });
    if (tier === 'L0') {
      return capSingleOutputToTokens(`[L0 ${view.uri}] [${hit.record.id}] ${view.l0Abstract}`);
    }
    if (tier === 'L1') {
      return capSingleOutputToTokens(view.l1Overview);
    }
    return capSingleOutputToTokens(view.l2Detail);
  }

  const slice = matched.slice(0, limit);
  const header = `📂 [OpenViking Directory] ${targetUri} (tier=${tier}, showing ${slice.length}/${matched.length})`;
  const itemBlocks: string[] = [];

  for (const it of slice) {
    const m = it.record;
    const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
    if (tier === 'L2') {
      const view = buildTieredMemoryView(m, { entities: it.entities });
      itemBlocks.push(`\n${view.l2Detail}`);
    } else if (tier === 'L1') {
      itemBlocks.push(
        `• [${m.id}] ${it.uri} (${net}, c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})\n  ${buildInlineL1Overview(m, 200)}`
      );
    } else {
      itemBlocks.push(
        `• [${m.id}] ${it.uri} (${net}, c=${m.confidence.toFixed(2)}) — ${buildL0Abstract(m)}`
      );
    }
  }

  return enforceTokenCap(header, itemBlocks, matched.length, MAX_VIKING_OUTPUT_TOKENS);
}

export interface VikingExportResult {
  dir: string;
  totalMemories: number;
  categoriesExported: VikingCategory[];
  filesWritten: string[];
}

function assertSafeDir(dirPath: string, createIfMissing: boolean): void {
  const resolved = path.resolve(dirPath);
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to operate on symlink directory: ${resolved}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      if (!createIfMissing) {
        throw new Error(`OpenViking directory not found: ${dirPath}`);
      }
      fs.mkdirSync(resolved, { recursive: true });
      const st = fs.lstatSync(resolved);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new Error(`Refusing to operate on symlink directory: ${resolved}`);
      }
      return;
    }
    throw err;
  }
}

function writeVikingFileIfChanged(filePath: string, rootDir: string, content: string): boolean {
  if (!isPathInsideRoot(filePath, rootDir)) {
    throw new Error(`Refusing to write outside OpenViking directory: ${filePath}`);
  }
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${filePath}`);
    }
    if (st.isFile() && st.size === Buffer.byteLength(content, 'utf8')) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return false;
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
  atomicWriteFileSync(filePath, content);
  return true;
}

/**
 * 导出 OpenViking L0 (.abstract.md) / L1 (.overview.md) / L2 (<id>.md) 三层虚拟文件系统目录树
 * - 批量加载 memory_entities (ORDER BY entity ASC)
 * - 原子写盘并跳过未变化文件
 * - 清理已失效/归档/被取代记忆遗留的陈旧 m_*.md 与空分类目录，避免重新导入时死灰复燃
 */
export function exportVikingContextTree(
  db: Db,
  outputDir: string,
  options?: { workspaceId?: string; excludeWorkspaces?: string[] }
): VikingExportResult {
  assertSafeDir(outputDir, true);

  const wsId = workspaceId(options?.workspaceId || process.cwd());
  const scope = scopeFilterSQL({ workspaceId: wsId });
  const rows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE (${scope.sql})
         AND status IN ('active', 'frozen')
         AND type != 'meta'
       ORDER BY pinned DESC, importance DESC, utility DESC, updated_at DESC`,
      scope.params
    )
    .map((r) => hydrateMemoryRow(r));

  // 批量加载实体与确定性 URI，消除 N+1 查询
  const entitiesByMem = loadEntitiesBatch(
    db,
    rows.map((r) => r.id)
  );
  const uriByMem = new Map<string, string>();
  for (const r of rows) {
    uriByMem.set(r.id, resolveVikingUri(r, entitiesByMem.get(r.id) || []));
  }

  const byCat = new Map<VikingCategory, MemoryRecord[]>();
  for (const r of rows) {
    const cat = classifyVikingCategory(r);
    const list = byCat.get(cat) || [];
    list.push(r);
    byCat.set(cat, list);
  }

  const filesWritten: string[] = [];
  const categoriesExported: VikingCategory[] = [];
  const expectedL2ByCat = new Map<VikingCategory, Set<string>>();

  const latestTs = rows.reduce(
    (mx, r) => (Number.isFinite(r.updated_at) ? Math.max(mx, r.updated_at) : mx),
    0
  );
  const latestIso = new Date(latestTs).toISOString();

  const rootAbstractLines: string[] = [
    '# OpenViking Context Database — L0 Root Abstract (.abstract.md)',
    '',
    `> Workspace: \`${wsId}\` | Total Memories: **${rows.length}** | Updated: ${latestIso}`,
    '',
  ];
  const rootOverviewLines: string[] = [
    '# OpenViking Context Database — L1 Root Overview (.overview.md)',
    '',
    `> Tiered Context Architecture: L0 (\`.abstract.md\`) -> L1 (\`.overview.md\`) -> L2 (\`<id>.md\`)`,
    '',
  ];

  for (const cat of ALL_VIKING_CATEGORIES) {
    const list = byCat.get(cat);
    if (!list || list.length === 0) continue;

    categoriesExported.push(cat);
    const catDir = path.join(outputDir, cat);
    if (!isPathInsideRoot(catDir, outputDir)) {
      throw new Error(`Refusing to create category directory outside outputDir: ${catDir}`);
    }
    assertSafeDir(catDir, true);

    const expectedSet = new Set<string>();
    expectedL2ByCat.set(cat, expectedSet);

    rootAbstractLines.push(
      `- **[${cat}/](./${cat}/.abstract.md)** (${list.length} items): ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`
    );
    rootOverviewLines.push(`## 📁 ${cat}/ (${list.length} items)`);
    rootOverviewLines.push(`> ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`);
    rootOverviewLines.push('');

    const catAbstractLines: string[] = [
      `# [L0 Abstract] viking://${cat}/ (${list.length} items)`,
      '',
      `> ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`,
      '',
    ];
    const catOverviewLines: string[] = [
      `# [L1 Overview] viking://${cat}/ (${list.length} items)`,
      '',
      `> ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`,
      '',
    ];

    for (const m of list) {
      const ents = entitiesByMem.get(m.id) || [];
      const uri = uriByMem.get(m.id) || resolveVikingUri(m, ents);
      const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
      const l0 = buildL0Abstract(m);
      const l1 = buildInlineL1Overview(m, 220);
      const safeId = safeFilenameId(m.id);

      catAbstractLines.push(`- \`${m.id}\` (\`${uri}\`) [${net}]: ${l0}`);
      catOverviewLines.push(`### [${net} ${m.id}] ${l0}`);
      catOverviewLines.push(
        `- **URI**: \`${uri}\` | **Confidence**: \`${m.confidence.toFixed(2)}\` | **Utility**: \`${m.utility.toFixed(2)}\`${m.slot_key ? ` | **Slot**: \`${m.slot_key}\`` : ''}`
      );
      catOverviewLines.push(`- **Overview**: ${l1}`);
      catOverviewLines.push('');

      rootOverviewLines.push(`- **[\`${m.id}\`](./${cat}/${safeId}.md)** (\`${uri}\`): ${l0}`);

      // L2 Full Detail Markdown
      const l2Md = serializeMemoryToMarkdown(m, ents);
      const l2Path = path.join(catDir, `${safeId}.md`);
      if (writeVikingFileIfChanged(l2Path, outputDir, l2Md)) {
        filesWritten.push(l2Path);
      }
      expectedSet.add(normalizePathKey(l2Path));
    }

    rootOverviewLines.push('');

    const catAbstractPath = path.join(catDir, '.abstract.md');
    if (writeVikingFileIfChanged(catAbstractPath, outputDir, catAbstractLines.join('\n') + '\n')) {
      filesWritten.push(catAbstractPath);
    }

    const catOverviewPath = path.join(catDir, '.overview.md');
    if (writeVikingFileIfChanged(catOverviewPath, outputDir, catOverviewLines.join('\n') + '\n')) {
      filesWritten.push(catOverviewPath);
    }
  }

  // 删除已不再 active/frozen 的陈旧 m_*.md 文件及已清空的分类目录
  for (const cat of ALL_VIKING_CATEGORIES) {
    const catDir = path.join(outputDir, cat);
    try {
      const st = fs.lstatSync(catDir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (!isPathInsideRoot(catDir, outputDir)) continue;
    } catch {
      continue;
    }

    const expectedSet = expectedL2ByCat.get(cat);
    try {
      const entries = fs.readdirSync(catDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isSymbolicLink() || !ent.isFile() || !ent.name.endsWith('.md')) continue;
        const full = path.join(catDir, ent.name);
        if (!isPathInsideRoot(full, outputDir)) continue;

        const isIndexFile = ent.name === '.abstract.md' || ent.name === '.overview.md';
        if (!expectedSet) {
          // 整个分类已无活跃记忆：移除陈旧 m_*.md/id_*.md 与旧分类索引
          if (isIndexFile || ent.name.startsWith('m_') || ent.name.startsWith('id_')) {
            fs.unlinkSync(full);
          }
        } else if (
          !isIndexFile &&
          (ent.name.startsWith('m_') || ent.name.startsWith('id_')) &&
          !expectedSet.has(normalizePathKey(full))
        ) {
          fs.unlinkSync(full);
        }
      }

      if (!expectedSet && fs.readdirSync(catDir).length === 0) {
        fs.rmdirSync(catDir);
      }
    } catch {
      // ignore concurrent fs modification
    }
  }

  const rootAbstractPath = path.join(outputDir, '.abstract.md');
  if (writeVikingFileIfChanged(rootAbstractPath, outputDir, rootAbstractLines.join('\n') + '\n')) {
    filesWritten.push(rootAbstractPath);
  }

  const rootOverviewPath = path.join(outputDir, '.overview.md');
  if (writeVikingFileIfChanged(rootOverviewPath, outputDir, rootOverviewLines.join('\n') + '\n')) {
    filesWritten.push(rootOverviewPath);
  }

  // 同步写入 OpenViking 自进化审计快照 memory_diff.json
  try {
    const diff = getVikingEvolutionDiff(db, {
      workspaceId: wsId,
      excludeWorkspaces: options?.excludeWorkspaces,
    });
    const diffPath = path.join(outputDir, 'memory_diff.json');
    if (writeVikingFileIfChanged(diffPath, outputDir, JSON.stringify(diff, null, 2) + '\n')) {
      filesWritten.push(diffPath);
    }
  } catch {
    // ignore diff snapshot error
  }

  return {
    dir: outputDir,
    totalMemories: rows.length,
    categoriesExported,
    filesWritten,
  };
}

/**
 * 全自动后台同步 OpenViking 虚拟上下文目录树 (`syncAutonomousVikingTree`)
 * 当工作区已启用 `.dsh/viking-context` 目录（或显式 forceCreate）时，后台自动增量刷新 L0/L1/L2 与 memory_diff.json
 */
export function syncAutonomousVikingTree(
  db: Db,
  options: { workspacePath?: string; workspaceId?: string; forceCreate?: boolean } = {}
): { synced: boolean; dir?: string; totalMemories: number } {
  try {
    const rawWsPath = options.workspacePath || resolveWorkspaceCwd(db, options.workspaceId) || '';
    const wsPath = rawWsPath && fs.existsSync(rawWsPath) ? rawWsPath : '';
    if (!wsPath && !options.forceCreate) {
      return { synced: false, totalMemories: 0 };
    }
    const baseDir = wsPath || process.cwd();
    const targetDir = path.join(baseDir, '.dsh', 'viking-context');
    if (!isPathInsideRoot(targetDir, baseDir)) {
      return { synced: false, totalMemories: 0 };
    }
    if (!options.forceCreate && !fs.existsSync(targetDir)) {
      return { synced: false, totalMemories: 0 };
    }
    if (fs.existsSync(targetDir)) {
      const st = fs.lstatSync(targetDir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return { synced: false, totalMemories: 0 };
      }
    }
    const res = exportVikingContextTree(db, targetDir, {
      workspaceId: options.workspaceId || wsPath,
    });
    return { synced: true, dir: res.dir, totalMemories: res.totalMemories };
  } catch {
    return { synced: false, totalMemories: 0 };
  }
}

/**
 * 从 OpenViking 目录树导入 L2 记忆文件（自动跳过 .abstract.md 与 .overview.md 索引文件）
 * 安全约束：
 * - 拒绝符号链接目录/文件、限制递归深度(6)、文件大小(256KB)与文件总数(500)
 * - 强制校验 type / scope 枚举
 * - !trusted 时强制 scope='workspace', workspaceId=wsId, 剥离 core:* 槽位, 拒绝 type='meta', confidence<=0.5, status='candidate', origin_kinds=['tool']
 * - trusted 时完整往返还原 pinned, status='frozen', session_id
 */
export function importVikingContextTree(
  db: Db,
  inputDir: string,
  options?: { workspaceId?: string; trusted?: boolean }
): { importedCount: number; updatedCount: number; skippedIndexes: number } {
  assertSafeDir(inputDir, false);

  const wsId = workspaceId(options?.workspaceId || process.cwd());
  const trusted = options?.trusted !== false;
  let importedCount = 0;
  let updatedCount = 0;
  let skippedIndexes = 0;
  const now = Date.now();

  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_VIKING_IMPORT_DEPTH || files.length >= MAX_VIKING_IMPORT_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= MAX_VIKING_IMPORT_FILES) break;
      if (ent.name === '.trash' || ent.name === 'node_modules' || ent.name === '.git') continue;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (!isPathInsideRoot(full, inputDir)) continue;

      if (ent.isDirectory()) {
        if (depth < MAX_VIKING_IMPORT_DEPTH) {
          walk(full, depth + 1);
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        if (ent.name === '.abstract.md' || ent.name === '.overview.md') {
          skippedIndexes++;
          continue;
        }
        files.push(full);
      }
    }
  };

  walk(inputDir, 0);

  db.transaction(() => {
    for (const file of files) {
      try {
        const raw = safeReadTextFileSync(file, inputDir, MAX_VIKING_IMPORT_FILE_BYTES);
        if (raw === null) continue;

        const parsed = parseMemoryMarkdown(raw);
        const fm = parsed.frontmatter;

        let memType: MemoryType = 'semantic';
        if (fm.type !== undefined) {
          if (typeof fm.type === 'string' && VALID_MEMORY_TYPES.has(fm.type as MemoryType)) {
            memType = fm.type as MemoryType;
          } else {
            continue;
          }
        }

        let memScope: Scope = 'workspace';
        if (fm.scope !== undefined) {
          if (typeof fm.scope === 'string' && VALID_SCOPES.has(fm.scope as Scope)) {
            memScope = fm.scope as Scope;
          } else {
            continue;
          }
        }

        if (!trusted && memType === 'meta') {
          continue;
        }

        const rawSlotKey =
          typeof fm.slot_key === 'string' && fm.slot_key.trim() ? fm.slot_key.trim() : null;
        const effectiveSlotKey =
          !trusted && rawSlotKey && rawSlotKey.toLowerCase().startsWith('core:')
            ? null
            : rawSlotKey;

        const effectiveScope: Scope = !trusted ? 'workspace' : memScope;
        const fmWorkspaceId =
          typeof fm.workspace_id === 'string' && fm.workspace_id.trim()
            ? fm.workspace_id.trim()
            : undefined;
        const effectiveWorkspaceId = !trusted
          ? wsId
          : effectiveScope === 'user' || effectiveScope === 'global'
            ? undefined
            : fmWorkspaceId || wsId;

        const fmSessionId =
          typeof fm.session_id === 'string' && fm.session_id.trim()
            ? fm.session_id.trim()
            : undefined;
        const effectiveSessionId =
          trusted && effectiveScope === 'session' ? fmSessionId || 'viking_import' : undefined;

        const rawConfidence =
          typeof fm.confidence === 'number' && Number.isFinite(fm.confidence)
            ? Math.max(0, Math.min(1, fm.confidence))
            : trusted
              ? 0.9
              : 0.5;
        const effectiveConfidence = !trusted ? Math.min(0.5, rawConfidence) : rawConfidence;

        const validEntities = Array.isArray(fm.entities)
          ? fm.entities
              .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
              .slice(0, 32)
          : undefined;

        const res = upsertCandidate(
          db,
          {
            type: memType,
            content: parsed.content || parsed.summary,
            summary: parsed.summary || (typeof fm.summary === 'string' ? fm.summary : undefined),
            slot_key: effectiveSlotKey,
            scope: effectiveScope,
            workspaceId: effectiveWorkspaceId,
            sessionId: effectiveSessionId,
            source_kind: trusted ? 'user' : 'system',
            origin_kinds: [trusted ? 'user' : 'tool'],
            confidence: effectiveConfidence,
            status: trusted ? 'active' : 'candidate',
            sources: [{ session_id: 'viking_import', seq: 0, kind: 'manual' }],
            actor: trusted ? 'user' : 'maintenance',
            entities: validEntities,
          },
          now
        );

        if (res.action === 'inserted') importedCount++;
        else if (res.action === 'merged' || res.action === 'superseded') updatedCount++;

        if (
          trusted &&
          (res.action === 'inserted' || res.action === 'merged' || res.action === 'superseded')
        ) {
          if (fm.pinned === 1) {
            pin(db, res.id, 'user', now);
          }
          if (fm.status === 'frozen') {
            freeze(db, res.id, 'user', now);
          }
        }
      } catch {
        // ignore malformed file
      }
    }
  });

  return { importedCount, updatedCount, skippedIndexes };
}

/**
 * OpenViking 子树限定混合检索 (`findInVikingTree` — Directory-Scoped Subtree Hybrid Grep/Find)
 * 将 category 谓词与 FTS5 词法预过滤下推至 SQL WHERE（LIMIT 之前），并强制 1500 tokens 输出封顶
 */
export function findInVikingTree(
  db: Db,
  options: {
    query: string;
    uri?: string;
    workspaceId?: string;
    sessionId?: string;
    tier?: VikingContextTier;
    limit?: number;
  }
): string {
  const rawQuery = (options.query || '').trim();
  if (!rawQuery) {
    return browseVikingDirectory(db, options);
  }

  const wsId = workspaceId(options.workspaceId || process.cwd());
  const tier: VikingContextTier = options.tier || 'L1';
  const limit = Math.max(1, Math.min(25, options.limit ?? 8));
  const targetUri = normalizeVikingUriInput(options.uri);
  const parsedTarget = parseVikingTarget(targetUri, options.uri);

  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId }, 'm');
  const catFilter = parsedTarget.category
    ? categoryFilterSQL(parsedTarget.category, 'm')
    : null;

  const baseWhereParts = [
    `(${scope.sql})`,
    `m.status IN ('active', 'frozen')`,
    `m.type != 'meta'`,
  ];
  const baseParams: unknown[] = [...scope.params];
  if (catFilter) {
    baseWhereParts.push(catFilter.sql);
    baseParams.push(...catFilter.params);
    if (parsedTarget.category === 'preferences' && parsedTarget.explicitWorkspaceDomain) {
      baseWhereParts.push(`m.scope = 'workspace'`);
    }
  }
  const baseWhereSql = baseWhereParts.join(' AND ');

  // 1) FTS5 词法预过滤通道（在 LIMIT 之前通过倒排索引命中全库任意位置，彻底消除 LIMIT 300 饥饿）
  const candidateMap = new Map<string, MemoryRecord>();
  const ftsTokens = Array.from(
    new Set(
      segment(rawQuery)
        .slice(0, 24)
        .map((t) => `"${t.replace(/"/g, '')}"`)
        .filter((t) => t.length > 2)
    )
  );

  if (ftsTokens.length > 0) {
    try {
      const matchExpr = ftsTokens.join(' OR ');
      const ftsRows = db.all<MemoryRow>(
        `SELECT m.*
         FROM memory_fts f
         JOIN memories m ON m.rowid_ = f.rowid
         WHERE memory_fts MATCH ?
           AND ${baseWhereSql}
         ORDER BY bm25(memory_fts)
         LIMIT 300`,
        [matchExpr, ...baseParams]
      );
      for (const r of ftsRows) {
        candidateMap.set(r.id, hydrateMemoryRow(r));
      }
    } catch {
      // ignore FTS syntax edge case and rely on fallback scan
    }
  }

  // 2) 补充同分类高价值候选（覆盖纯语义向量匹配或仅 slot_key 子串命中）
  const fallbackRows = db.all<MemoryRow>(
    `SELECT m.*
     FROM memories m
     WHERE ${baseWhereSql}
     ORDER BY m.pinned DESC, m.utility DESC, m.updated_at DESC
     LIMIT 200`,
    baseParams
  );
  for (const r of fallbackRows) {
    if (!candidateMap.has(r.id)) {
      candidateMap.set(r.id, hydrateMemoryRow(r));
    }
  }

  const rows = Array.from(candidateMap.values());
  if (rows.length === 0) {
    return `🔍 [OpenViking Subtree Find] No memories in current workspace.`;
  }

  const entitiesByMem = loadEntitiesBatch(
    db,
    rows.map((r) => r.id)
  );

  const qTokens = Array.from(tokenSet(rawQuery));
  const qVec = computeLocalEmbedding(rawQuery);
  const qLower = rawQuery.toLowerCase();

  const scored: Array<{ record: MemoryRecord; uri: string; entities: string[]; score: number }> = [];

  for (const r of rows) {
    const ents = entitiesByMem.get(r.id) || [];
    const uri = resolveVikingUri(r, ents);
    const cat = classifyVikingCategory(r);

    if (!matchesVikingSubtree({ record: r, uri, category: cat }, targetUri, parsedTarget)) {
      continue;
    }

    const docText = `${r.summary} ${r.content} ${r.slot_key || ''} ${uri} ${ents.join(' ')}`;
    const docTokens = tokenSet(docText);
    let matchedCount = 0;
    for (const qt of qTokens) {
      if (isTokenMatch(qt, docTokens)) matchedCount++;
    }
    const lexCov = qTokens.length > 0 ? matchedCount / qTokens.length : 0;
    const exactSub = docText.toLowerCase().includes(qLower) ? 0.35 : 0;

    const docVec = getOrComputeEmbedding(r);
    const vecSim = docVec ? Math.max(0, cosineSimilarity(qVec, docVec)) : 0;

    if (matchedCount === 0 && exactSub === 0 && vecSim < 0.52) continue;

    const score =
      0.48 * Math.max(lexCov, exactSub) +
      0.34 * vecSim +
      0.1 * r.utility +
      0.08 * r.confidence;
    scored.push({ record: r, uri, entities: ents, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (top.length === 0) {
    return `🔍 [OpenViking Subtree Find] No matches for "${rawQuery}" under ${targetUri}.`;
  }

  const header = `🔍 [OpenViking Subtree Find] subtree=${targetUri} query="${rawQuery}" (tier=${tier}, hits=${top.length}/${scored.length})`;
  const itemBlocks: string[] = [];

  for (const item of top) {
    const m = item.record;
    const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
    if (tier === 'L2') {
      const view = buildTieredMemoryView(m, { entities: item.entities });
      itemBlocks.push(`\n${view.l2Detail}`);
    } else if (tier === 'L1') {
      itemBlocks.push(
        `• [${m.id}] ${item.uri} (${net}, score=${item.score.toFixed(2)}, c=${m.confidence.toFixed(2)})\n  ${buildInlineL1Overview(m, 200)}`
      );
    } else {
      itemBlocks.push(
        `• [${m.id}] ${item.uri} (${net}, score=${item.score.toFixed(2)}) — ${buildL0Abstract(m)}`
      );
    }
  }

  return enforceTokenCap(header, itemBlocks, scored.length, MAX_VIKING_OUTPUT_TOKENS);
}

export interface VikingEvolutionDiff {
  workspaceId: string;
  added: Array<{ id: string; uri: string; network: string; summary: string; createdAt: number }>;
  evolved: Array<{
    id: string;
    uri: string;
    network: string;
    version: number;
    fromSummary: string;
    toSummary: string;
    reason: string;
    updatedAt: number;
  }>;
  synthesizedModels: Array<{
    id: string;
    uri: string;
    slotKey: string | null;
    summary: string;
    confidence: number;
    sourceCount: number;
  }>;
  supersededCount: number;
}

function buildExcludeWorkspaceSQL(
  excludeWorkspaces: string[] = [],
  tableAlias?: string
): { sql: string; params: string[] } {
  const excludedIds = [
    ...new Set(
      excludeWorkspaces
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .flatMap((x) => {
          const trimmed = x.trim();
          const hashed = workspaceId(trimmed);
          return hashed ? [trimmed, hashed] : [trimmed];
        })
        .filter(Boolean)
    ),
  ];
  if (excludedIds.length === 0) return { sql: '', params: [] };
  const p = tableAlias ? `${tableAlias}.` : '';
  const ph = excludedIds.map(() => '?').join(', ');
  return {
    sql: `AND COALESCE(${p}workspace_id, '') NOT IN (${ph})
          AND NOT EXISTS (
            SELECT 1 FROM memory_sources ms
            JOIN session_workspace_owners swo ON swo.session_id = ms.session_id
            WHERE ms.memory_id = ${p}id AND swo.workspace_id IN (${ph})
          )`,
    params: [...excludedIds, ...excludedIds],
  };
}

/**
 * OpenViking Self-Evolving Context Diff Audit (`memory_diff.json` 等价审计视图)
 * 批量加载 versions / relations / superseded 目标记忆（全量带 scopeFilterSQL 与 excludeWorkspaces 隔离），消除 N+1 查询
 */
export function getVikingEvolutionDiff(
  db: Db,
  options: {
    workspaceId?: string;
    sessionId?: string;
    limit?: number;
    excludeWorkspaces?: string[];
  } = {}
): VikingEvolutionDiff {
  const rawWs = options.workspaceId || process.cwd();
  const wsId = workspaceId(rawWs);
  const limit = Math.max(1, Math.min(30, options.limit ?? 10));

  if (options.excludeWorkspaces?.length && isWorkspaceExcluded(rawWs, options.excludeWorkspaces)) {
    return {
      workspaceId: wsId,
      added: [],
      evolved: [],
      synthesizedModels: [],
      supersededCount: 0,
    };
  }

  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId });
  const excludeClause = buildExcludeWorkspaceSQL(options.excludeWorkspaces);

  const activeRows = db
    .all<MemoryRow>(
      `SELECT * FROM memories
       WHERE (${scope.sql})
         AND status IN ('active', 'frozen')
         AND type != 'meta'
         ${excludeClause.sql}
       ORDER BY updated_at DESC
       LIMIT 100`,
      [...scope.params, ...excludeClause.params]
    )
    .map((r) => hydrateMemoryRow(r));

  const supersededCount =
    db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM memories
       WHERE (${scope.sql})
         AND status = 'superseded'
         ${excludeClause.sql}`,
      [...scope.params, ...excludeClause.params]
    )?.c || 0;

  if (activeRows.length === 0) {
    return {
      workspaceId: wsId,
      added: [],
      evolved: [],
      synthesizedModels: [],
      supersededCount,
    };
  }

  // 1) 批量确定性解析 URI
  const uriMap = resolveVikingUrisBatch(db, activeRows);

  // 2) 批量获取 version > 1 记忆的最近一条版本快照
  const versionedIds = activeRows.filter((r) => r.version > 1).map((r) => r.id);
  const latestVersionByMem = new Map<string, { snapshot: string; reason: string }>();
  for (let i = 0; i < versionedIds.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = versionedIds.slice(i, i + SQL_IN_CHUNK_SIZE);
    const ph = chunk.map(() => '?').join(', ');
    const verRows = db.all<{ memory_id: string; snapshot: string; reason: string }>(
      `SELECT mv.memory_id, mv.snapshot, mv.reason
       FROM memory_versions mv
       JOIN (
         SELECT memory_id, MAX(version) AS max_ver
         FROM memory_versions
         WHERE memory_id IN (${ph})
         GROUP BY memory_id
       ) latest ON latest.memory_id = mv.memory_id AND latest.max_ver = mv.version`,
      chunk
    );
    for (const vr of verRows) {
      latestVersionByMem.set(vr.memory_id, { snapshot: vr.snapshot, reason: vr.reason });
    }
  }

  // 3) 批量获取 supersedes 与 derived_from 关系边
  const activeIds = activeRows.map((r) => r.id);
  const supersedesTargetByMem = new Map<string, string>();
  const derivedCountByMem = new Map<string, number>();
  for (let i = 0; i < activeIds.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = activeIds.slice(i, i + SQL_IN_CHUNK_SIZE);
    const ph = chunk.map(() => '?').join(', ');
    const relRows = db.all<{ from_id: string; to_id: string; rel: string }>(
      `SELECT from_id, to_id, rel
       FROM memory_relations
       WHERE from_id IN (${ph})
         AND rel IN ('supersedes', 'derived_from')`,
      chunk
    );
    for (const rel of relRows) {
      if (rel.rel === 'supersedes') {
        if (!supersedesTargetByMem.has(rel.from_id)) {
          supersedesTargetByMem.set(rel.from_id, rel.to_id);
        }
      } else if (rel.rel === 'derived_from') {
        derivedCountByMem.set(rel.from_id, (derivedCountByMem.get(rel.from_id) || 0) + 1);
      }
    }
  }

  // 4) 批量加载被取代目标记忆，严格附带 scopeFilterSQL 与 excludeWorkspaces 隔离
  const supersededTargetIds = [...new Set(supersedesTargetByMem.values())];
  const oldMemById = new Map<string, MemoryRecord>();
  for (let i = 0; i < supersededTargetIds.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = supersededTargetIds.slice(i, i + SQL_IN_CHUNK_SIZE);
    const ph = chunk.map(() => '?').join(', ');
    const oldRows = db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE id IN (${ph})
         AND (${scope.sql})
         ${excludeClause.sql}`,
      [...chunk, ...scope.params, ...excludeClause.params]
    );
    for (const om of oldRows) {
      oldMemById.set(om.id, hydrateMemoryRow(om));
    }
  }

  const added = activeRows
    .filter((r) => r.version === 1 && !r.slot_key?.startsWith('core:'))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      uri: uriMap.get(r.id) || resolveVikingUri(r),
      network: classifyHindsightNetwork(r.type, r.slot_key),
      summary: buildL0Abstract(r),
      createdAt: r.created_at,
    }));

  const evolved: VikingEvolutionDiff['evolved'] = [];
  for (const r of activeRows) {
    if (evolved.length >= limit) break;
    const uri = uriMap.get(r.id) || resolveVikingUri(r);

    if (r.version > 1) {
      const prevVer = latestVersionByMem.get(r.id);
      if (prevVer) {
        try {
          const snap = JSON.parse(prevVer.snapshot);
          evolved.push({
            id: r.id,
            uri,
            network: classifyHindsightNetwork(r.type, r.slot_key),
            version: r.version,
            fromSummary: redactSecrets(String(snap.summary || snap.content || '').slice(0, 80)).text,
            toSummary: buildL0Abstract(r),
            reason: prevVer.reason,
            updatedAt: r.updated_at,
          });
          continue;
        } catch {
          // fall through to supersedes check
        }
      }
    }

    const oldId = supersedesTargetByMem.get(r.id);
    if (oldId) {
      const oldMem = oldMemById.get(oldId);
      if (oldMem) {
        evolved.push({
          id: r.id,
          uri,
          network: classifyHindsightNetwork(r.type, r.slot_key),
          version: r.version,
          fromSummary: buildL0Abstract(oldMem),
          toSummary: buildL0Abstract(r),
          reason: `supersedes:${oldMem.id}`,
          updatedAt: r.updated_at,
        });
      }
    }
  }

  const synthesizedModels: VikingEvolutionDiff['synthesizedModels'] = [];
  for (const r of activeRows) {
    const derivedCnt = derivedCountByMem.get(r.id) || 0;
    if (derivedCnt > 0 || r.slot_key?.startsWith('hindsight.model.')) {
      synthesizedModels.push({
        id: r.id,
        uri: uriMap.get(r.id) || resolveVikingUri(r),
        slotKey: r.slot_key ?? null,
        summary: buildL0Abstract(r),
        confidence: Number(r.confidence.toFixed(2)),
        sourceCount: derivedCnt,
      });
    }
  }

  return {
    workspaceId: wsId,
    added,
    evolved,
    synthesizedModels: synthesizedModels.slice(0, limit),
    supersededCount,
  };
}

export function formatVikingEvolutionDiff(diff: VikingEvolutionDiff): string {
  const lines: string[] = [
    `🧬 [OpenViking Self-Evolving Context Diff Audit] (workspace=${diff.workspaceId}, historical_superseded=${diff.supersededCount})`,
  ];

  if (diff.evolved.length > 0) {
    lines.push(`\n🔄 上下文演进与取代 (${diff.evolved.length}):`);
    for (const ev of diff.evolved) {
      lines.push(
        `  • [${ev.id}] ${ev.uri} (v${ev.version}, ${ev.reason}):\n    - 旧: ${ev.fromSummary}\n    + 新: ${ev.toSummary}`
      );
    }
  }

  if (diff.synthesizedModels.length > 0) {
    lines.push(`\n🧠 归纳合成心智模型 (${diff.synthesizedModels.length}):`);
    for (const m of diff.synthesizedModels) {
      lines.push(
        `  • [${m.id}] ${m.uri} (c=${m.confidence.toFixed(2)}, 派生源=${m.sourceCount}) — ${m.summary}`
      );
    }
  }

  if (diff.added.length > 0) {
    lines.push(`\n✨ 最近沉淀节点 (${diff.added.length}):`);
    for (const a of diff.added.slice(0, 6)) {
      lines.push(`  • [${a.id}] ${a.uri} (${a.network.toUpperCase()}) — ${a.summary}`);
    }
  }

  return lines.join('\n');
}
