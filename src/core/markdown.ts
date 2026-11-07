import fs from 'node:fs';
import path from 'node:path';
import type { Db, MemoryRecord, MarkdownFrontmatter, Scope, MemoryType, MemoryStatus } from '../types.js';
import { upsertCandidate, restoreMemory } from './writer.js';
import { redactSecrets } from './privacy.js';
import { workspaceId as resolveWorkspaceId } from './scope.js';

/**
 * 序列化单条记忆为 Markdown (带 YAML Frontmatter)
 */
export function serializeMemoryToMarkdown(record: MemoryRecord, entities: string[] = []): string {
  const cleanSummary = redactSecrets(record.summary || '').text.replace(/\r?\n/g, ' ');
  const cleanContent = redactSecrets(record.content || '').text;

  const createdIso = new Date(record.created_at).toISOString();
  const updatedIso = new Date(record.updated_at).toISOString();

  const lines: string[] = [
    '---',
    `id: ${record.id}`,
    `type: ${record.type}`,
    `scope: ${record.scope}`,
    `status: ${record.status}`,
    `summary: ${JSON.stringify(cleanSummary)}`,
    `confidence: ${record.confidence.toFixed(2)}`,
    `utility: ${record.utility.toFixed(2)}`,
    `pinned: ${record.pinned ? 1 : 0}`,
    `content_rev: ${record.content_rev}`,
  ];

  if (record.slot_key) {
    lines.push(`slot_key: ${JSON.stringify(record.slot_key)}`);
  }
  if (record.workspace_id) {
    lines.push(`workspace_id: ${JSON.stringify(record.workspace_id)}`);
  }
  if (record.session_id) {
    lines.push(`session_id: ${JSON.stringify(record.session_id)}`);
  }
  if (entities.length > 0) {
    lines.push('entities:');
    for (const ent of entities) {
      lines.push(`  - ${JSON.stringify(ent)}`);
    }
  }

  lines.push(`created_at: ${createdIso}`);
  lines.push(`updated_at: ${updatedIso}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${cleanSummary}`);
  lines.push('');
  lines.push(cleanContent);
  lines.push('');

  return lines.join('\n');
}

/**
 * 解析 Markdown 文本，提取 Frontmatter 与正文
 */
export function parseMemoryMarkdown(markdownText: string): {
  frontmatter: Partial<MarkdownFrontmatter>;
  content: string;
  summary: string;
} {
  const match = markdownText.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    // 没有 frontmatter，视为普通 markdown
    const body = markdownText.trim();
    const firstLine = body.split('\n')[0].replace(/^#+\s*/, '').trim();
    return {
      frontmatter: {},
      summary: firstLine.slice(0, 80),
      content: body,
    };
  }

  const fmRaw = match[1];
  const bodyRaw = match[2].trim();

  const fm: any = {};
  const lines = fmRaw.split(/\r?\n/);
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentArrayKey && trimmed.startsWith('- ')) {
      const rawItem = trimmed.slice(2).trim();
      let val = rawItem.replace(/^["']|["']$/g, '');
      if (rawItem.startsWith('"') && rawItem.endsWith('"')) {
        try { val = JSON.parse(rawItem); } catch {}
      }
      fm[currentArrayKey].push(val);
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const rawVal = line.slice(colonIdx + 1).trim();

      if (!rawVal) {
        // 可能接下来是数组
        fm[key] = [];
        currentArrayKey = key;
      } else {
        currentArrayKey = null;
        let parsedVal: any = rawVal;
        if (/^(true|false)$/i.test(rawVal)) {
          parsedVal = rawVal.toLowerCase() === 'true';
        } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
          parsedVal = Number(rawVal);
        } else {
          if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
            try { parsedVal = JSON.parse(rawVal); } catch { parsedVal = rawVal.slice(1, -1); }
          } else {
            parsedVal = rawVal.replace(/^["']|["']$/g, '');
          }
        }
        fm[key] = parsedVal;
      }
    }
  }

  // 从 bodyRaw 提取正文（去掉首个 # 标题）
  let content = bodyRaw;
  let summary = fm.summary || '';
  const titleMatch = bodyRaw.match(/^#+\s*(.+)\r?\n([\s\S]*)$/);
  if (titleMatch) {
    if (!summary) summary = titleMatch[1].trim();
    content = titleMatch[2].trim();
  }
  if (!content) content = bodyRaw;

  return { frontmatter: fm, content, summary };
}

/**
 * 导出数据库记忆到 Markdown 目录
 */
export function exportToMarkdown(
  db: Db,
  outputDir: string,
  options?: {
    scope?: string;
    workspaceId?: string;
    status?: string[];
  }
): { exportedCount: number; dir: string; files: string[] } {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const statusList = options?.status || ['active', 'candidate', 'frozen'];
  const placeholders = statusList.map(() => '?').join(', ');
  const params: any[] = [...statusList];

  let sql = `SELECT * FROM memories WHERE status IN (${placeholders})`;

  if (options?.scope) {
    sql += ' AND scope = ?';
    params.push(options.scope);
  }
  if (options?.workspaceId) {
    sql += ' AND (workspace_id = ? OR workspace_id IS NULL)';
    params.push(resolveWorkspaceId(options.workspaceId));
  }

  sql += ' ORDER BY pinned DESC, updated_at DESC';

  const rows = db.all<MemoryRecord>(sql, params);
  const exportedFiles: string[] = [];

  for (const row of rows) {
    const entRows = db.all<{ entity: string }>(
      `SELECT entity FROM memory_entities WHERE memory_id = ?`,
      [row.id]
    );
    const entities = entRows.map((r) => r.entity);

    const md = serializeMemoryToMarkdown(row, entities);

    // 目录组织：outputDir / scope / type / <id>.md
    const subDir = path.join(outputDir, row.scope, row.type);
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }

    const filePath = path.join(subDir, `${row.id}.md`);
    fs.writeFileSync(filePath, md, 'utf8');
    exportedFiles.push(filePath);
  }

  return { exportedCount: rows.length, dir: outputDir, files: exportedFiles };
}

/**
 * 从 Markdown 目录导入记忆到数据库
 */
export function importFromMarkdown(
  db: Db,
  inputDir: string,
  options?: {
    workspaceId?: string;
    sessionId?: string;
    actor?: 'user' | 'maintenance';
  }
): { importedCount: number; updatedCount: number; errors: string[] } {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Directory not found: ${inputDir}`);
  }

  const errors: string[] = [];
  let importedCount = 0;
  let updatedCount = 0;
  const now = Date.now();
  const actor = options?.actor || 'user';

  function scanDir(dir: string): string[] {
    const list: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== '.trash' && ent.name !== 'node_modules') {
          list.push(...scanDir(full));
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        list.push(full);
      }
    }
    return list;
  }

  const mdFiles = scanDir(inputDir);

  for (const file of mdFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = parseMemoryMarkdown(content);
      const fm = parsed.frontmatter;

      const memType: MemoryType = (fm.type as MemoryType) || 'semantic';
      const memScope: Scope = (fm.scope as Scope) || 'workspace';
      const memSummary = parsed.summary || fm.summary || 'Imported memory';
      const memContent = parsed.content || memSummary;

      const res = upsertCandidate(
        db,
        {
          type: memType,
          content: memContent,
          summary: memSummary,
          slot_key: fm.slot_key || null,
          scope: memScope,
          workspaceId: memScope === 'user' || memScope === 'global' ? undefined : (fm.workspace_id || options?.workspaceId),
          sessionId: memScope === 'session' ? (fm.session_id || options?.sessionId || 'import_session') : undefined,
          source_kind: 'system',
          origin_kinds: ['system'],
          confidence: typeof fm.confidence === 'number' ? fm.confidence : 0.9,
          sources: [{ session_id: 'import', seq: 0, kind: 'markdown_import' }],
          actor,
          entities: fm.entities,
        },
        now
      );

      if (res.action === 'inserted') {
        importedCount++;
      } else if (res.action === 'merged' || res.action === 'superseded') {
        updatedCount++;
      }
    } catch (err: any) {
      errors.push(`File ${path.basename(file)}: ${err?.message || err}`);
    }
  }

  return { importedCount, updatedCount, errors };
}

/**
 * 安全回收站：在遗忘或删除记忆前，存根至 .trash 目录
 */
export function trashMemory(
  db: Db,
  id: string,
  trashDir: string
): { trashed: boolean; path?: string } {
  const memory = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
  if (!memory) return { trashed: false };

  if (!fs.existsSync(trashDir)) {
    fs.mkdirSync(trashDir, { recursive: true });
  }

  const entRows = db.all<{ entity: string }>(
    `SELECT entity FROM memory_entities WHERE memory_id = ?`,
    [id]
  );
  const entities = entRows.map((r) => r.entity);
  const md = serializeMemoryToMarkdown(memory, entities);

  const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
  const trashPath = path.join(trashDir, `${safeId}.md`);
  fs.writeFileSync(trashPath, md, 'utf8');

  return { trashed: true, path: trashPath };
}

/**
 * 从回收站或数据库恢复记忆
 */
export function restoreFromTrash(
  db: Db,
  id: string,
  trashDir?: string
): { restored: boolean; message: string } {
  // 1. 如果还在 DB 中 (status='archived')，直接 restore
  const existing = db.get<MemoryRecord>(`SELECT * FROM memories WHERE id = ?`, [id]);
  if (existing) {
    const res = restoreMemory(db, id);
    return { restored: res.success, message: res.message };
  }

  // 2. 如果 DB 中彻底不存在但 trashDir 中有 md 文件，则重新导入
  if (trashDir) {
    const safeId = path.basename(id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const trashFile = path.join(trashDir, `${safeId}.md`);
    if (fs.existsSync(trashFile)) {
      const content = fs.readFileSync(trashFile, 'utf8');
      const parsed = parseMemoryMarkdown(content);
      const res = upsertCandidate(
        db,
        {
          type: parsed.frontmatter.type || 'semantic',
          content: parsed.content,
          summary: parsed.summary,
          scope: parsed.frontmatter.scope || 'workspace',
          workspaceId: parsed.frontmatter.workspace_id || undefined,
          source_kind: 'system',
          origin_kinds: ['system'],
          confidence: parsed.frontmatter.confidence ?? 0.8,
          sources: [{ session_id: 'trash_restore', seq: 0, kind: 'trash_restore' }],
          actor: 'user',
        },
        Date.now()
      );
      if (res.action === 'inserted' || res.action === 'merged') {
        return { restored: true, message: `Memory '${id}' successfully restored from trash file` };
      }
    }
  }

  return { restored: false, message: `Memory '${id}' not found in database or trash` };
}

export interface MemoryBankExportResult {
  filesWritten: string[];
  totalMemories: number;
}

export interface MemoryBankImportResult {
  imported: number;
  filesProcessed: number;
}

/**
 * 将记忆库聚合导出为标准化 Memory Bank (汲取自 Cline / Roo-Code Memory Bank 规范)
 * 输出 4 个核心文件: activeContext.md, systemPatterns.md, productContext.md, progress.md
 */
export function exportMemoryBank(
  db: Db,
  outputDir: string,
  options?: { workspaceId?: string }
): MemoryBankExportResult {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const wsId = options?.workspaceId ? resolveWorkspaceId(options.workspaceId) : resolveWorkspaceId(process.cwd());
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE (scope IN ('user', 'global') OR (scope = 'workspace' AND workspace_id = ?))
       AND status IN ('active', 'frozen')
     ORDER BY pinned DESC, importance DESC, updated_at DESC`,
    [wsId]
  );

  const activeContextItems: MemoryRecord[] = [];
  const systemPatternsItems: MemoryRecord[] = [];
  const productContextItems: MemoryRecord[] = [];
  const progressItems: MemoryRecord[] = [];

  for (const m of rows) {
    if (m.type === 'goal' || m.type === 'episodic' || m.slot_key?.startsWith('core:project')) {
      activeContextItems.push(m);
    } else if (m.type === 'procedural' || m.type === 'semantic') {
      systemPatternsItems.push(m);
    } else if (m.type === 'preference' || m.type === 'belief' || m.slot_key?.startsWith('core:human') || m.slot_key?.startsWith('core:persona')) {
      productContextItems.push(m);
    } else if (m.type === 'failure') {
      progressItems.push(m);
    } else {
      systemPatternsItems.push(m);
    }
  }

  const filesWritten: string[] = [];

  const formatSection = (title: string, desc: string, items: MemoryRecord[]): string => {
    const lines: string[] = [`# ${title}`, '', `> ${desc}`, '', `*生成时间: ${new Date().toISOString()} | 包含 ${items.length} 条记忆*`, ''];
    if (items.length === 0) {
      lines.push('_暂无沉淀记录_');
      lines.push('');
      return lines.join('\n');
    }
    for (const item of items) {
      const cleanSummary = redactSecrets(item.summary || item.content).text;
      const cleanContent = redactSecrets(item.content).text;
      lines.push(`### [${item.type.toUpperCase()} ${item.id}] ${cleanSummary}`);
      lines.push(`- **ID**: \`${item.id}\` | **重要度**: \`${item.importance ?? 5}/10\` | **置信度**: \`${item.confidence.toFixed(2)}\``);
      if (item.slot_key) lines.push(`- **槽位**: \`${item.slot_key}\``);
      lines.push('');
      lines.push(cleanContent);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  };

  // 1. activeContext.md
  const activePath = path.join(outputDir, 'activeContext.md');
  fs.writeFileSync(
    activePath,
    formatSection('Active Context', '当前活跃目标、正在进行的任务会话与进行中状态', activeContextItems),
    'utf8'
  );
  filesWritten.push(activePath);

  // 2. systemPatterns.md
  const patternsPath = path.join(outputDir, 'systemPatterns.md');
  fs.writeFileSync(
    patternsPath,
    formatSection('System Patterns', '系统架构规范、核心技术栈、设计模式与常用操作步骤', systemPatternsItems),
    'utf8'
  );
  filesWritten.push(patternsPath);

  // 3. productContext.md
  const productPath = path.join(outputDir, 'productContext.md');
  fs.writeFileSync(
    productPath,
    formatSection('Product Context', '产品背景、开发者个人画像、强偏好与人设准则', productContextItems),
    'utf8'
  );
  filesWritten.push(productPath);

  // 4. progress.md
  const progressPath = path.join(outputDir, 'progress.md');
  fs.writeFileSync(
    progressPath,
    formatSection('Progress & Known Issues', '系统已突破进展、排查记录与已知失败/避坑防错指南', progressItems),
    'utf8'
  );
  filesWritten.push(progressPath);

  return {
    filesWritten,
    totalMemories: rows.length,
  };
}

/**
 * 从标准化 Memory Bank 目录导入/同步记忆 (汲取自 Cline / Roo-Code Memory Bank 规范)
 */
export function importMemoryBank(
  db: Db,
  inputDir: string,
  options?: { workspaceId?: string }
): MemoryBankImportResult {
  if (!fs.existsSync(inputDir)) {
    throw new Error(`Memory bank directory not found: ${inputDir}`);
  }

  const targetFiles = [
    { file: 'activeContext.md', defaultType: 'goal' as MemoryType },
    { file: 'systemPatterns.md', defaultType: 'semantic' as MemoryType },
    { file: 'productContext.md', defaultType: 'preference' as MemoryType },
    { file: 'progress.md', defaultType: 'failure' as MemoryType },
  ];

  let imported = 0;
  let filesProcessed = 0;
  const wsId = options?.workspaceId ? resolveWorkspaceId(options.workspaceId) : resolveWorkspaceId(process.cwd());

  for (const item of targetFiles) {
    const fullPath = path.join(inputDir, item.file);
    if (!fs.existsSync(fullPath)) continue;

    filesProcessed++;
    const text = fs.readFileSync(fullPath, 'utf8');
    const sections = text.split(/\n###\s+/);

    for (let i = 1; i < sections.length; i++) {
      const sec = sections[i].trim();
      if (!sec) continue;

      const headerLine = sec.split('\n')[0].trim();
      const rawBodyLines = sec
        .slice(headerLine.length)
        .replace(/^---[\s\S]*?---/, '')
        .replace(/---\s*$/, '')
        .trim()
        .split('\n');

      let parsedSlotKey: string | undefined;
      const contentLines: string[] = [];
      let inLeadingMeta = true;
      for (const line of rawBodyLines) {
        const trimmedLine = line.trim();
        if (inLeadingMeta) {
          if (!trimmedLine) continue;
          const slotMatch = /^-\s*\*\*槽位\*\*:\s*`([^`]+)`/.exec(trimmedLine);
          if (slotMatch) {
            parsedSlotKey = slotMatch[1].trim();
            continue;
          }
          if (/^-\s*\*\*(?:ID|重要度|置信度|更新时间)\*\*:/.test(trimmedLine)) {
            continue;
          }
          inLeadingMeta = false;
        }
        contentLines.push(line);
      }

      const body = contentLines.join('\n').trim();
      if (!body) continue;

      let parsedType: MemoryType = item.defaultType;
      const typeMatch = /^\[([A-Z_]+)(?:\s+[^\]]+)?\]/i.exec(headerLine);
      if (typeMatch) {
        const candidateType = typeMatch[1].toLowerCase() as MemoryType;
        if (
          [
            'episodic',
            'semantic',
            'procedural',
            'belief',
            'preference',
            'goal',
            'failure',
            'meta',
          ].includes(candidateType)
        ) {
          parsedType = candidateType;
        }
      }

      const cleanSummary = headerLine.replace(/^\[.*?\]\s*/, '').trim();

      const upsertRes = upsertCandidate(
        db,
        {
          type: parsedType,
          content: body,
          summary: cleanSummary.slice(0, 80),
          slot_key: parsedSlotKey,
          scope: parsedType === 'preference' ? 'user' : 'workspace',
          workspaceId: wsId,
          source_kind: 'user',
          confidence: 0.9,
          importance: 8,
          status: 'active',
          origin_kinds: ['user'],
          sources: [{ session_id: 'memory_bank_import', seq: 0, kind: 'manual', excerpt: cleanSummary }],
          actor: 'user',
        },
        Date.now()
      );

      if (upsertRes.action === 'inserted' || upsertRes.action === 'superseded') {
        imported++;
      }
    }
  }

  return { imported, filesProcessed };
}
