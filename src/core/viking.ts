import fs from 'node:fs';
import path from 'node:path';
import type {
  Db,
  MemoryRecord,
  MemorySource,
  VikingCategory,
  VikingContextTier,
} from '../types.js';
import { workspaceId, scopeFilterSQL } from './scope.js';
import { get, sources } from './store.js';
import { redactSecrets } from './privacy.js';
import { extractEntities, tokenSet, isTokenMatch } from './text.js';
import { computeLocalEmbedding, cosineSimilarity, getOrComputeEmbedding } from './vector.js';
import { serializeMemoryToMarkdown, parseMemoryMarkdown } from './markdown.js';
import { upsertCandidate } from './writer.js';
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

  const shortId = memory.id.startsWith('m_') ? memory.id.slice(0, 8) : memory.id.slice(0, 8);

  if (memory.slot_key) {
    const cleanSlot = memory.slot_key
      .replace(/^hindsight\.model\./, '')
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
 * 生成 L0 (Abstract) 一句话超简摘要 (~15-50 tokens)
 */
export function buildL0Abstract(memory: MemoryRecord): string {
  const raw = (memory.summary || memory.content || '').trim();
  const clean = redactSecrets(raw).text.replace(/\s+/g, ' ').trim();
  return clean.length <= 100 ? clean : `${clean.slice(0, 97)}...`;
}

/**
 * 生成单行内联 L1 (Overview) 结构化中层概览 (~45-110 tokens)
 * 用于动态预算装箱 (governor.ts)：当 L2 全文放不下、但剩余预算充裕时，提供比 L0 丰富得多的关键槽位/步骤参数信息
 */
export function buildInlineL1Overview(memory: MemoryRecord, maxChars: number = 210): string {
  const cleanSummary = redactSecrets((memory.summary || '').trim())
    .text.replace(/\s+/g, ' ')
    .trim();
  const cleanContent = redactSecrets((memory.content || '').trim())
    .text.replace(/\s+/g, ' ')
    .trim();

  const slotTag =
    memory.slot_key && !memory.slot_key.startsWith('core:') ? `[${memory.slot_key}] ` : '';
  const bodyBudget = Math.max(24, maxChars - slotTag.length);

  let body = cleanContent;
  if (
    cleanSummary &&
    cleanContent.length + cleanSummary.length + 3 <= bodyBudget &&
    !cleanContent.startsWith(cleanSummary.slice(0, 16))
  ) {
    body = `${cleanSummary} — ${cleanContent}`;
  }

  if (body.length > bodyBudget) {
    // 优先在分号、句号或逗号边界截断
    const sliced = body.slice(0, bodyBudget);
    const lastPunct = Math.max(
      sliced.lastIndexOf('。'),
      sliced.lastIndexOf('；'),
      sliced.lastIndexOf('; '),
      sliced.lastIndexOf('. ')
    );
    body =
      lastPunct >= Math.floor(bodyBudget * 0.5)
        ? sliced.slice(0, lastPunct + 1)
        : `${sliced}...`;
  }

  return `${slotTag}${body}`.trim();
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
    relations?: Array<{ dir: string; rel: string; otherId: string; otherStatus: string; otherSummary: string }>;
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
 */
export function normalizeVikingUriInput(raw?: string | null): string {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed === '/' || trimmed === 'viking://' || trimmed === 'viking://~') {
    return 'viking://';
  }
  const lower = trimmed.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
  if (lower.startsWith('viking://')) {
    return lower.replace('viking://~/', 'viking://user/');
  }
  const clean = lower.replace(/^\/+/, '');
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

/**
 * 支持通过 `viking://` 虚拟路径或传统记忆 ID/短码解析目标记忆
 */
export function resolveMemoryByVikingUriOrId(
  db: Db,
  idOrUri: string,
  scopeCtx?: { workspaceId?: string; sessionId?: string }
): MemoryRecord | undefined {
  const raw = (idOrUri || '').trim();
  if (!raw) return undefined;

  if (!raw.toLowerCase().startsWith('viking://') && !raw.includes('/')) {
    return get(db, raw, scopeCtx);
  }

  const targetUri = normalizeVikingUriInput(raw);
  const wsId = scopeCtx?.workspaceId ? workspaceId(scopeCtx.workspaceId) : undefined;
  const scope = scopeFilterSQL({ workspaceId: wsId || '', sessionId: scopeCtx?.sessionId });

  // 1. 检查是否为 Core Memory 路径: viking://agent/core/{block}
  const coreMatch = targetUri.match(/^viking:\/\/agent\/core\/([a-z0-9_-]+)$/i);
  if (coreMatch) {
    const block = coreMatch[1].toLowerCase();
    return db.get<MemoryRecord>(
      `SELECT * FROM memories
       WHERE slot_key = ?
         AND (${scope.sql})
         AND status IN ('active', 'frozen')
       ORDER BY version DESC LIMIT 1`,
      [`core:${block}`, ...scope.params]
    );
  }

  // 2. 检查末尾是否带有 m_xxxx 短码
  const segments = targetUri.split('/').filter(Boolean);
  const lastSeg = segments[segments.length - 1] || '';
  if (lastSeg.startsWith('m_') && lastSeg.length >= 6) {
    try {
      const byShort = get(db, lastSeg, { workspaceId: wsId, sessionId: scopeCtx?.sessionId });
      if (byShort) return byShort;
    } catch {
      // ignore ambiguity and continue URI matching
    }
  }

  // 3. 在当前作用域内匹配完整或前缀 URI
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
     ORDER BY pinned DESC, utility DESC, updated_at DESC
     LIMIT 300`,
    scope.params
  );

  const canon = (s: string) => s.toLowerCase().replace(/[-_]+/g, '-');
  const canonTarget = canon(targetUri);
  const canonLastSeg = canon(lastSeg);

  for (const r of rows) {
    const uri = canon(resolveVikingUri(r));
    if (uri === canonTarget) return r;
  }

  for (const r of rows) {
    const uri = canon(resolveVikingUri(r));
    if (uri.startsWith(canonTarget + '/') || uri.endsWith('/' + canonLastSeg)) {
      return r;
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
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
       AND type != 'meta'
     ORDER BY pinned DESC, utility DESC, confidence DESC, updated_at DESC
     LIMIT 300`,
    scope.params
  );

  if (rows.length === 0) {
    return `📂 [OpenViking Context Tree] (${targetUri})\n(当前工作区暂无活跃记忆)`;
  }

  const rowIds = rows.map((r) => r.id);
  const placeholders = rowIds.map(() => '?').join(', ');
  const entRows = db.all<{ memory_id: string; entity: string }>(
    `SELECT memory_id, entity FROM memory_entities WHERE memory_id IN (${placeholders})`,
    rowIds
  );
  const entitiesByMem = new Map<string, string[]>();
  for (const er of entRows) {
    const list = entitiesByMem.get(er.memory_id) || [];
    list.push(er.entity);
    entitiesByMem.set(er.memory_id, list);
  }

  const itemsWithUri = rows.map((r) => {
    const ents = entitiesByMem.get(r.id) || [];
    const uri = resolveVikingUri(r, ents);
    const category = classifyVikingCategory(r);
    return { record: r, uri, category, entities: ents };
  });

  // 1. 若请求的是根目录 viking://，展示目录树统计 + 各目录 Top 摘要
  if (targetUri === 'viking://') {
    const byCat = new Map<VikingCategory, typeof itemsWithUri>();
    for (const it of itemsWithUri) {
      const list = byCat.get(it.category) || [];
      list.push(it);
      byCat.set(it.category, list);
    }

    const lines: string[] = [
      `📂 [OpenViking Context Filesystem] root=viking:// (tier=${tier}, total=${itemsWithUri.length})`,
    ];

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

    for (const cat of orderedCats) {
      const list = byCat.get(cat);
      if (!list || list.length === 0) continue;
      const dirUri =
        cat === 'core'
          ? 'viking://agent/core/'
          : cat === 'preferences' || cat === 'profile'
            ? `viking://user/memories/${cat}/`
            : `viking://workspace/memories/${cat}/`;

      lines.push(`\n📁 ${dirUri} (${list.length} items) — ${VIKING_CATEGORY_DESCRIPTIONS[cat]}`);
      const previewCount = tier === 'L0' ? 3 : 2;
      for (const entry of list.slice(0, previewCount)) {
        const m = entry.record;
        const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
        if (tier === 'L1') {
          lines.push(
            `  ├─ [${m.id}] ${entry.uri} (${net}, c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})\n  │    ${buildInlineL1Overview(m, 180)}`
          );
        } else {
          lines.push(`  ├─ [${m.id}] ${entry.uri} — ${buildL0Abstract(m)}`);
        }
      }
      if (list.length > previewCount) {
        lines.push(`  └─ ... (+${list.length - previewCount} more, inspect via "${dirUri}")`);
      }
    }

    return lines.join('\n');
  }

  // 2. 子目录或单节点过滤（兼容 user/workspace 偏好路径跨作用域检索）
  const catShorthandMatch = targetUri.match(
    /^viking:\/\/(?:user|workspace|agent)\/(?:memories\/)?(core|profile|preferences|entities|events|cases|skills|models)(?:\/(.*))?$/i
  );
  const requestedCategory = catShorthandMatch
    ? (catShorthandMatch[1].toLowerCase() as VikingCategory)
    : undefined;
  const subFilter = catShorthandMatch?.[2]?.toLowerCase() || '';

  const matched = itemsWithUri.filter((it) => {
    const lowUri = it.uri.toLowerCase();
    if (lowUri === targetUri || lowUri.startsWith(targetUri + '/')) return true;
    if (requestedCategory && it.category === requestedCategory) {
      if (!subFilter) return true;
      return (
        lowUri.includes(subFilter) ||
        (it.record.slot_key || '').toLowerCase().includes(subFilter)
      );
    }
    return false;
  });

  if (matched.length === 0) {
    return `📂 [OpenViking Context Tree] No memories found under '${targetUri}'.`;
  }

  // 若精确命中单条叶子节点且请求 L2 (或仅命中 1 条且带具体子路径)，直接展示分层详情
  if (matched.length === 1 && (tier === 'L2' || matched[0].uri.toLowerCase() === targetUri)) {
    const hit = matched[0];
    const srcList = sources(db, hit.record.id, hit.record.content_rev);
    const view = buildTieredMemoryView(hit.record, {
      entities: hit.entities,
      sources: srcList,
    });
    if (tier === 'L0') return `[L0 ${view.uri}] [${hit.record.id}] ${view.l0Abstract}`;
    if (tier === 'L1') return view.l1Overview;
    return view.l2Detail;
  }

  const slice = matched.slice(0, limit);
  const lines: string[] = [
    `📂 [OpenViking Directory] ${targetUri} (tier=${tier}, showing ${slice.length}/${matched.length})`,
  ];

  for (const it of slice) {
    const m = it.record;
    const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
    if (tier === 'L2') {
      const view = buildTieredMemoryView(m, { entities: it.entities });
      lines.push(`\n${view.l2Detail}`);
    } else if (tier === 'L1') {
      lines.push(
        `• [${m.id}] ${it.uri} (${net}, c=${m.confidence.toFixed(2)}, u=${m.utility.toFixed(2)})\n  ${buildInlineL1Overview(m, 200)}`
      );
    } else {
      lines.push(
        `• [${m.id}] ${it.uri} (${net}, c=${m.confidence.toFixed(2)}) — ${buildL0Abstract(m)}`
      );
    }
  }

  return lines.join('\n');
}

export interface VikingExportResult {
  dir: string;
  totalMemories: number;
  categoriesExported: VikingCategory[];
  filesWritten: string[];
}

/**
 * 导出 OpenViking L0 (.abstract.md) / L1 (.overview.md) / L2 (<id>.md) 三层虚拟文件系统目录树
 */
export function exportVikingContextTree(
  db: Db,
  outputDir: string,
  options?: { workspaceId?: string }
): VikingExportResult {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const wsId = workspaceId(options?.workspaceId || process.cwd());
  const scope = scopeFilterSQL({ workspaceId: wsId });
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
       AND type != 'meta'
     ORDER BY pinned DESC, importance DESC, utility DESC, updated_at DESC`,
    scope.params
  );

  const byCat = new Map<VikingCategory, MemoryRecord[]>();
  for (const r of rows) {
    const cat = classifyVikingCategory(r);
    const list = byCat.get(cat) || [];
    list.push(r);
    byCat.set(cat, list);
  }

  const filesWritten: string[] = [];
  const categoriesExported: VikingCategory[] = [];

  const rootAbstractLines: string[] = [
    '# OpenViking Context Database — L0 Root Abstract (.abstract.md)',
    '',
    `> Workspace: \`${wsId}\` | Total Memories: **${rows.length}** | Generated: ${new Date().toISOString()}`,
    '',
  ];
  const rootOverviewLines: string[] = [
    '# OpenViking Context Database — L1 Root Overview (.overview.md)',
    '',
    `> Tiered Context Architecture: L0 (\`.abstract.md\`) -> L1 (\`.overview.md\`) -> L2 (\`<id>.md\`)`,
    '',
  ];

  for (const [cat, list] of byCat.entries()) {
    categoriesExported.push(cat);
    const catDir = path.join(outputDir, cat);
    if (!fs.existsSync(catDir)) {
      fs.mkdirSync(catDir, { recursive: true });
    }

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
      const entRows = db.all<{ entity: string }>(
        `SELECT entity FROM memory_entities WHERE memory_id = ?`,
        [m.id]
      );
      const ents = entRows.map((e) => e.entity);
      const uri = resolveVikingUri(m, ents);
      const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
      const l0 = buildL0Abstract(m);
      const l1 = buildInlineL1Overview(m, 220);

      catAbstractLines.push(`- \`${m.id}\` (\`${uri}\`) [${net}]: ${l0}`);
      catOverviewLines.push(`### [${net} ${m.id}] ${l0}`);
      catOverviewLines.push(
        `- **URI**: \`${uri}\` | **Confidence**: \`${m.confidence.toFixed(2)}\` | **Utility**: \`${m.utility.toFixed(2)}\`${m.slot_key ? ` | **Slot**: \`${m.slot_key}\`` : ''}`
      );
      catOverviewLines.push(`- **Overview**: ${l1}`);
      catOverviewLines.push('');

      rootOverviewLines.push(`- **[\`${m.id}\`](./${cat}/${m.id}.md)** (\`${uri}\`): ${l0}`);

      // L2 Full Detail Markdown
      const l2Md = serializeMemoryToMarkdown(m, ents);
      const l2Path = path.join(catDir, `${m.id}.md`);
      fs.writeFileSync(l2Path, l2Md, 'utf8');
      filesWritten.push(l2Path);
    }

    rootOverviewLines.push('');

    const catAbstractPath = path.join(catDir, '.abstract.md');
    fs.writeFileSync(catAbstractPath, catAbstractLines.join('\n') + '\n', 'utf8');
    filesWritten.push(catAbstractPath);

    const catOverviewPath = path.join(catDir, '.overview.md');
    fs.writeFileSync(catOverviewPath, catOverviewLines.join('\n') + '\n', 'utf8');
    filesWritten.push(catOverviewPath);
  }

  const rootAbstractPath = path.join(outputDir, '.abstract.md');
  fs.writeFileSync(rootAbstractPath, rootAbstractLines.join('\n') + '\n', 'utf8');
  filesWritten.push(rootAbstractPath);

  const rootOverviewPath = path.join(outputDir, '.overview.md');
  fs.writeFileSync(rootOverviewPath, rootOverviewLines.join('\n') + '\n', 'utf8');
  filesWritten.push(rootOverviewPath);

  // 同步写入 OpenViking 自进化审计快照 memory_diff.json
  try {
    const diff = getVikingEvolutionDiff(db, { workspaceId: wsId });
    const diffPath = path.join(outputDir, 'memory_diff.json');
    fs.writeFileSync(diffPath, JSON.stringify(diff, null, 2) + '\n', 'utf8');
    filesWritten.push(diffPath);
  } catch {}

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
    const wsPath = options.workspacePath && fs.existsSync(options.workspacePath)
      ? options.workspacePath
      : '';
    if (!wsPath && !options.forceCreate) {
      return { synced: false, totalMemories: 0 };
    }
    const targetDir = path.join(wsPath || process.cwd(), '.dsh', 'viking-context');
    if (!options.forceCreate && !fs.existsSync(targetDir)) {
      return { synced: false, totalMemories: 0 };
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
 */
export function importVikingContextTree(
  db: Db,
  inputDir: string,
  options?: { workspaceId?: string; trusted?: boolean }
): { importedCount: number; updatedCount: number; skippedIndexes: number } {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`OpenViking directory not found: ${inputDir}`);
  }

  const wsId = workspaceId(options?.workspaceId || process.cwd());
  const trusted = options?.trusted !== false;
  let importedCount = 0;
  let updatedCount = 0;
  let skippedIndexes = 0;
  const now = Date.now();

  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== '.trash' && ent.name !== 'node_modules') {
          out.push(...walk(full));
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        if (ent.name === '.abstract.md' || ent.name === '.overview.md') {
          skippedIndexes++;
          continue;
        }
        out.push(full);
      }
    }
    return out;
  };

  const files = walk(inputDir);
  for (const file of files) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = parseMemoryMarkdown(raw);
      const fm = parsed.frontmatter;
      if (fm.slot_key && String(fm.slot_key).startsWith('core:') && !trusted) {
        continue;
      }
      const memType = fm.type || 'semantic';
      const memScope = fm.scope || 'workspace';
      const res = upsertCandidate(
        db,
        {
          type: memType,
          content: parsed.content || parsed.summary,
          summary: parsed.summary || fm.summary,
          slot_key: fm.slot_key || null,
          scope: memScope,
          workspaceId:
            memScope === 'user' || memScope === 'global'
              ? undefined
              : fm.workspace_id || wsId,
          source_kind: trusted ? 'user' : 'system',
          origin_kinds: [trusted ? 'user' : 'system'],
          confidence: typeof fm.confidence === 'number' ? fm.confidence : 0.9,
          status: trusted ? 'active' : 'candidate',
          sources: [{ session_id: 'viking_import', seq: 0, kind: 'manual' }],
          actor: trusted ? 'user' : 'maintenance',
          entities: fm.entities,
        },
        now
      );
      if (res.action === 'inserted') importedCount++;
      else if (res.action === 'merged' || res.action === 'superseded') updatedCount++;
    } catch {
      // ignore malformed file
    }
  }

  return { importedCount, updatedCount, skippedIndexes };
}

/**
 * OpenViking 子树限定混合检索 (`findInVikingTree` — Directory-Scoped Subtree Hybrid Grep/Find)
 * 在指定 `viking://` 目录子树内融合词法覆盖率、128D 语义向量余弦与实体命中，按 L0/L1/L2 层级返回精准上下文
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

  const scope = scopeFilterSQL({ workspaceId: wsId, sessionId: options.sessionId });
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
       AND type != 'meta'
     ORDER BY pinned DESC, utility DESC, updated_at DESC
     LIMIT 300`,
    scope.params
  );

  if (rows.length === 0) {
    return `🔍 [OpenViking Subtree Find] No memories in current workspace.`;
  }

  const catShorthandMatch = targetUri.match(
    /^viking:\/\/(?:user|workspace|agent)\/(?:memories\/)?(core|profile|preferences|entities|events|cases|skills|models)(?:\/(.*))?$/i
  );
  const requestedCategory = catShorthandMatch
    ? (catShorthandMatch[1].toLowerCase() as VikingCategory)
    : undefined;
  const subFilter = catShorthandMatch?.[2]?.toLowerCase() || '';

  const qTokens = Array.from(tokenSet(rawQuery));
  const qVec = computeLocalEmbedding(rawQuery);
  const qLower = rawQuery.toLowerCase();

  const scored: Array<{ record: MemoryRecord; uri: string; score: number }> = [];

  for (const r of rows) {
    const uri = resolveVikingUri(r);
    const lowUri = uri.toLowerCase();
    const cat = classifyVikingCategory(r);

    if (targetUri !== 'viking://') {
      const inSubtree =
        lowUri === targetUri ||
        lowUri.startsWith(targetUri + '/') ||
        (requestedCategory &&
          cat === requestedCategory &&
          (!subFilter ||
            lowUri.includes(subFilter) ||
            (r.slot_key || '').toLowerCase().includes(subFilter)));
      if (!inSubtree) continue;
    }

    const docText = `${r.summary} ${r.content} ${r.slot_key || ''} ${uri}`;
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
    scored.push({ record: r, uri, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  if (top.length === 0) {
    return `🔍 [OpenViking Subtree Find] No matches for "${rawQuery}" under ${targetUri}.`;
  }

  const lines: string[] = [
    `🔍 [OpenViking Subtree Find] subtree=${targetUri} query="${rawQuery}" (tier=${tier}, hits=${top.length}/${scored.length})`,
  ];

  for (const item of top) {
    const m = item.record;
    const net = classifyHindsightNetwork(m.type, m.slot_key).toUpperCase();
    if (tier === 'L2') {
      const view = buildTieredMemoryView(m);
      lines.push(`\n${view.l2Detail}`);
    } else if (tier === 'L1') {
      lines.push(
        `• [${m.id}] ${item.uri} (${net}, score=${item.score.toFixed(2)}, c=${m.confidence.toFixed(2)})\n  ${buildInlineL1Overview(m, 200)}`
      );
    } else {
      lines.push(
        `• [${m.id}] ${item.uri} (${net}, score=${item.score.toFixed(2)}) — ${buildL0Abstract(m)}`
      );
    }
  }

  return lines.join('\n');
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

/**
 * OpenViking Self-Evolving Context Diff Audit (`memory_diff.json` 等价审计视图)
 * 追踪虚拟上下文文件系统的最近新增节点、版本演进差异 (`from -> to`) 与归纳心智模型
 */
export function getVikingEvolutionDiff(
  db: Db,
  options: { workspaceId?: string; limit?: number } = {}
): VikingEvolutionDiff {
  const wsId = workspaceId(options.workspaceId || process.cwd());
  const limit = Math.max(1, Math.min(30, options.limit ?? 10));
  const scope = scopeFilterSQL({ workspaceId: wsId });

  const activeRows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (${scope.sql})
       AND status IN ('active', 'frozen')
       AND type != 'meta'
     ORDER BY updated_at DESC
     LIMIT 100`,
    scope.params
  );

  const added = activeRows
    .filter((r) => r.version === 1 && !r.slot_key?.startsWith('core:'))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      uri: resolveVikingUri(r),
      network: classifyHindsightNetwork(r.type, r.slot_key),
      summary: buildL0Abstract(r),
      createdAt: r.created_at,
    }));

  const evolved: VikingEvolutionDiff['evolved'] = [];
  for (const r of activeRows) {
    if (evolved.length >= limit) break;

    // 1) 原地版本修订 (version > 1)
    if (r.version > 1) {
      const prevVer = db.get<{ snapshot: string; reason: string }>(
        `SELECT snapshot, reason FROM memory_versions
         WHERE memory_id = ? ORDER BY version DESC LIMIT 1`,
        [r.id]
      );
      if (prevVer) {
        try {
          const snap = JSON.parse(prevVer.snapshot);
          evolved.push({
            id: r.id,
            uri: resolveVikingUri(r),
            network: classifyHindsightNetwork(r.type, r.slot_key),
            version: r.version,
            fromSummary: redactSecrets(String(snap.summary || snap.content || '').slice(0, 80)).text,
            toSummary: buildL0Abstract(r),
            reason: prevVer.reason,
            updatedAt: r.updated_at,
          });
          continue;
        } catch {}
      }
    }

    // 2) 跨记录槽位/事实取代 (supersedes)
    const supRel = db.get<{ to_id: string }>(
      `SELECT to_id FROM memory_relations WHERE from_id = ? AND rel = 'supersedes' LIMIT 1`,
      [r.id]
    );
    if (supRel) {
      const oldMem = db.get<MemoryRecord>('SELECT * FROM memories WHERE id = ?', [supRel.to_id]);
      if (oldMem) {
        evolved.push({
          id: r.id,
          uri: resolveVikingUri(r),
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
    const derivedCnt =
      db.get<{ c: number }>(
        `SELECT COUNT(*) as c FROM memory_relations WHERE from_id = ? AND rel = 'derived_from'`,
        [r.id]
      )?.c || 0;
    if (derivedCnt > 0 || r.slot_key?.startsWith('hindsight.model.')) {
      synthesizedModels.push({
        id: r.id,
        uri: resolveVikingUri(r),
        slotKey: r.slot_key ?? null,
        summary: buildL0Abstract(r),
        confidence: Number(r.confidence.toFixed(2)),
        sourceCount: derivedCnt,
      });
    }
  }

  const supersededCount =
    db.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM memories WHERE (${scope.sql}) AND status = 'superseded'`,
      scope.params
    )?.c || 0;

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
