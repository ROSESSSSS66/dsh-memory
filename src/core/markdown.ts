import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  Db,
  MemoryRecord,
  MarkdownFrontmatter,
  Scope,
  MemoryType,
} from '../types.js';
import { upsertCandidate, restoreMemory, pin } from './writer.js';
import { redactSecrets } from './privacy.js';
import { workspaceId as resolveWorkspaceId, scopeFilterSQL } from './scope.js';
import { get } from './store.js';

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

const MANAGED_SCOPES: Scope[] = ['session', 'workspace', 'user', 'global'];
const MANAGED_TYPES: MemoryType[] = [
  'episodic',
  'semantic',
  'procedural',
  'belief',
  'preference',
  'goal',
  'failure',
  'meta',
];

const NUMERIC_FM_KEYS = new Set(['confidence', 'utility', 'pinned', 'content_rev']);
const FORBIDDEN_FM_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_IMPORT_DEPTH = 6;
const MAX_IMPORT_FILES = 500;
const MAX_IMPORT_FILE_BYTES = 256 * 1024;
const SQL_IN_CHUNK_SIZE = 400;

const MEMORY_BANK_ENTRY_MARKER = '<!-- dsh-memory:entry -->';

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // bounded fallback spin
    }
  }
}

function isInsideNormalized(target: string, root: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const cmpRoot = caseInsensitive ? root.toLowerCase() : root;
  const cmpTarget = caseInsensitive ? target.toLowerCase() : target;
  const rel = path.relative(cmpRoot, cmpTarget);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

function resolveExistingRealPath(p: string): string | null {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Dangling symlink exists in lstatSync but fails realpathSync -> fail closed
    try {
      fs.lstatSync(abs);
      return null;
    } catch {
      // Does not exist yet; walk up to nearest existing ancestor
    }
  }

  const tail: string[] = [];
  let cur = abs;
  while (true) {
    const parent = path.dirname(cur);
    if (parent === cur) {
      return path.join(cur, ...tail);
    }
    tail.unshift(path.basename(cur));
    cur = parent;
    try {
      const realParent = fs.realpathSync(cur);
      return path.join(realParent, ...tail);
    } catch {
      try {
        fs.lstatSync(cur);
        return null;
      } catch {
        // Keep walking up
      }
    }
  }
}

/**
 * Verify targetPath stays strictly confined within rootDir (resolving realpath when present
 * so symlinks escaping rootDir and dangling symlinks are rejected).
 */
export function isPathInsideRoot(targetPath: string, rootDir: string): boolean {
  if (!targetPath || !rootDir) return false;
  const rootReal = resolveExistingRealPath(rootDir);
  const targetReal = resolveExistingRealPath(targetPath);
  if (!rootReal || !targetReal) return false;
  return isInsideNormalized(targetReal, rootReal);
}

/**
 * Safely read a UTF-8 text file confined inside rootDir:
 * rejects symlinks, non-regular files, files exceeding maxBytes, and paths escaping rootDir.
 */
export function safeReadTextFileSync(
  filePath: string,
  rootDir: string,
  maxBytes: number = MAX_IMPORT_FILE_BYTES
): string | null {
  try {
    const resolvedFile = path.resolve(filePath);
    const st = fs.lstatSync(resolvedFile);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > maxBytes) return null;

    const rootReal = fs.realpathSync(path.resolve(rootDir));
    const fileReal = fs.realpathSync(resolvedFile);
    if (!isInsideNormalized(fileReal, rootReal)) return null;

    const fd = fs.openSync(fileReal, 'r');
    try {
      const fst = fs.fstatSync(fd);
      if (!fst.isFile() || fst.size > maxBytes) return null;
      const buf = Buffer.allocUnsafe(fst.size);
      let offset = 0;
      while (offset < fst.size) {
        const n = fs.readSync(fd, buf, offset, fst.size - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      return buf.subarray(0, offset).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Sanitize a memory ID into a safe filename stem (no path separators, traversal, or Windows reserved names).
 * Appends a short SHA-256 hash suffix whenever modified to prevent collisions.
 */
export function safeFilenameId(id: string): string {
  const raw = String(id ?? '');
  let sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
  let modified = sanitized !== raw;

  if (sanitized.length > 80) {
    sanitized = sanitized.slice(0, 80);
    modified = true;
  }
  if (
    !sanitized ||
    sanitized === '.' ||
    sanitized === '..' ||
    WINDOWS_RESERVED_FILENAME.test(sanitized)
  ) {
    sanitized = sanitized ? `id_${sanitized}` : 'id';
    modified = true;
  }
  if (modified) {
    const shortHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
    sanitized = `${sanitized}_${shortHash}`;
  }
  return sanitized;
}

/**
 * Windows-safe atomic UTF-8 file write:
 * - Refuses to overwrite symlinks or directories
 * - Writes to a unique temporary file in the same directory using exclusive flag 'wx'
 * - Renames into place with bounded retries on transient Windows EPERM/EBUSY/EACCES
 * - Cleans up the temp file on failure
 */
export function atomicWriteFileSync(destPath: string, data: string): void {
  const resolvedDest = path.resolve(destPath);
  try {
    const st = fs.lstatSync(resolvedDest);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${resolvedDest}`);
    }
    if (st.isDirectory()) {
      throw new Error(`Refusing to overwrite directory: ${resolvedDest}`);
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }

  const tmpPath = `${resolvedDest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(tmpPath, data, { encoding: 'utf8', flag: 'wx' });
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        fs.renameSync(tmpPath, resolvedDest);
        renamed = true;
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        const retryable = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!retryable || attempt === maxAttempts) {
          throw err;
        }
        sleepSync(15 * attempt);
      }
    }
  } finally {
    if (!renamed) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
  }
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
        throw new Error(`Directory not found: ${dirPath}`);
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

function writeIfChangedSync(filePath: string, rootDir: string, content: string): void {
  if (!isPathInsideRoot(filePath, rootDir)) {
    throw new Error(`Refusing to write outside root directory: ${filePath}`);
  }
  try {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink: ${filePath}`);
    }
    if (st.isFile() && st.size === Buffer.byteLength(content, 'utf8')) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) return;
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
  atomicWriteFileSync(filePath, content);
}

function safeIsoTimestamp(ts: unknown): string {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (Number.isFinite(n)) {
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) {
      return d.toISOString();
    }
  }
  return new Date(0).toISOString();
}

function normalizePathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

/**
 * 回收站目录跟随数据库文件所在目录（其次是配置的 dataDir）。
 * 内存库或未知路径返回 undefined：不得退回用户主目录，否则自定义 dbPath 与测试都会写进真实的 ~/.dsh。
 */
export function resolveTrashDir(db: Db, dataDir?: string): string | undefined {
  const filePath = db.filePath;
  if (typeof filePath === 'string' && filePath && filePath !== ':memory:') {
    return path.join(path.dirname(path.resolve(filePath)), '.trash');
  }
  return dataDir ? path.join(dataDir, '.trash') : undefined;
}

/**
 * 序列化单条记忆为 Markdown (带 YAML Frontmatter)
 */
export function serializeMemoryToMarkdown(record: MemoryRecord, entities: string[] = []): string {
  const cleanSummary = redactSecrets(record.summary || '').text.replace(/\r?\n/g, ' ');
  const cleanContent = redactSecrets(record.content || '').text;

  const createdIso = safeIsoTimestamp(record.created_at);
  const updatedIso = safeIsoTimestamp(record.updated_at);
  const confidence = Number.isFinite(record.confidence) ? record.confidence : 0.5;
  const utility = Number.isFinite(record.utility) ? record.utility : 0.5;
  const contentRev =
    typeof record.content_rev === 'number' && Number.isFinite(record.content_rev)
      ? record.content_rev
      : 1;

  const lines: string[] = [
    '---',
    `id: ${record.id}`,
    `type: ${record.type}`,
    `scope: ${record.scope}`,
    `status: ${record.status}`,
    `summary: ${JSON.stringify(cleanSummary)}`,
    `confidence: ${confidence.toFixed(2)}`,
    `utility: ${utility.toFixed(2)}`,
    `pinned: ${record.pinned ? 1 : 0}`,
    `content_rev: ${contentRev}`,
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
  const normalized = markdownText.replace(/\r\n?/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/);
  if (!match) {
    // 没有 frontmatter，视为普通 markdown
    const body = normalized.trim();
    const firstLine = (body.split('\n')[0] || '').replace(/^#+\s*/, '').trim();
    return {
      frontmatter: Object.create(null) as Partial<MarkdownFrontmatter>,
      summary: firstLine.slice(0, 80),
      content: body,
    };
  }

  const fmRaw = match[1];
  const bodyRaw = (match[2] || '').trim();

  const fm: Record<string, unknown> = Object.create(null);
  const lines = fmRaw.split('\n');
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (currentArrayKey && trimmed.startsWith('- ')) {
      const rawItem = trimmed.slice(2).trim();
      let val = rawItem.replace(/^["']|["']$/g, '');
      if (rawItem.startsWith('"') && rawItem.endsWith('"')) {
        try {
          const parsedItem = JSON.parse(rawItem);
          if (typeof parsedItem === 'string') val = parsedItem;
        } catch {
          // keep stripped string
        }
      }
      const arr = fm[currentArrayKey];
      if (Array.isArray(arr)) {
        arr.push(val);
      }
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      if (!key || FORBIDDEN_FM_KEYS.has(key)) {
        currentArrayKey = null;
        continue;
      }
      const rawVal = line.slice(colonIdx + 1).trim();

      if (!rawVal) {
        fm[key] = [];
        currentArrayKey = key;
      } else {
        currentArrayKey = null;
        let parsedVal: unknown = rawVal;
        if (NUMERIC_FM_KEYS.has(key) && /^-?\d+(\.\d+)?$/.test(rawVal)) {
          parsedVal = Number(rawVal);
        } else if (key === 'pinned' && /^(true|false)$/i.test(rawVal)) {
          parsedVal = rawVal.toLowerCase() === 'true' ? 1 : 0;
        } else if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
          try {
            const unquoted = JSON.parse(rawVal);
            parsedVal = typeof unquoted === 'string' ? unquoted : String(unquoted);
          } catch {
            parsedVal = rawVal.slice(1, -1);
          }
        } else {
          parsedVal = rawVal.replace(/^["']|["']$/g, '');
        }
        fm[key] = parsedVal;
      }
    }
  }

  // 仅当首行 # 标题与 fm.summary 一致，或 fm.summary 缺省时才剥离标题，避免误删正文自有小节标题
  let content = bodyRaw;
  let summary = typeof fm.summary === 'string' ? fm.summary : '';
  const h1Match = bodyRaw.match(/^#\s+([^\n]+)(?:\n([\s\S]*))?$/);
  const anyHeadingMatch = !summary ? bodyRaw.match(/^#+\s+([^\n]+)(?:\n([\s\S]*))?$/) : null;
  const titleMatch = h1Match || anyHeadingMatch;
  if (titleMatch) {
    const headingText = titleMatch[1].trim();
    const rest = (titleMatch[2] || '').trim();
    if (!summary) {
      summary = headingText;
      if (rest) content = rest;
    } else if (headingText === summary.trim()) {
      if (rest) content = rest;
    }
  }
  if (!content) content = bodyRaw;

  return {
    frontmatter: fm as Partial<MarkdownFrontmatter>,
    content,
    summary,
  };
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
    sessionId?: string;
    status?: string[];
  }
): { exportedCount: number; dir: string; files: string[] } {
  assertSafeDir(outputDir, true);

  const statusList = options?.status || ['active', 'candidate', 'frozen'];
  const placeholders = statusList.map(() => '?').join(', ');
  const params: unknown[] = [...statusList];

  let sql = `SELECT * FROM memories WHERE status IN (${placeholders})`;

  if (options?.scope) {
    sql += ' AND scope = ?';
    params.push(options.scope);
  }

  if (options?.workspaceId) {
    const scope = scopeFilterSQL({
      workspaceId: resolveWorkspaceId(options.workspaceId),
      sessionId: options.sessionId,
    });
    sql += ` AND ${scope.sql}`;
    params.push(...scope.params);
  } else if (options?.sessionId) {
    sql += ` AND (scope != 'session' OR session_id = ?)`;
    params.push(options.sessionId);
  } else if (options?.scope !== 'session') {
    // 无 sessionId 时严禁跨会话导出 session 私有记忆
    sql += ` AND scope != 'session'`;
  }

  sql += ' ORDER BY pinned DESC, updated_at DESC';

  const rows = db.all<MemoryRecord>(sql, params);

  // 批量加载 memory_entities，消除 N+1 查询
  const entitiesByMem = new Map<string, string[]>();
  const rowIds = rows.map((r) => r.id);
  for (let i = 0; i < rowIds.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = rowIds.slice(i, i + SQL_IN_CHUNK_SIZE);
    const entRows = db.all<{ memory_id: string; entity: string }>(
      `SELECT memory_id, entity
       FROM memory_entities
       WHERE memory_id IN (${chunk.map(() => '?').join(', ')})
       ORDER BY entity ASC`,
      chunk
    );
    for (const er of entRows) {
      let list = entitiesByMem.get(er.memory_id);
      if (!list) {
        list = [];
        entitiesByMem.set(er.memory_id, list);
      }
      list.push(er.entity);
    }
  }

  const exportedFiles: string[] = [];
  const expectedFileKeys = new Set<string>();

  for (const row of rows) {
    const entities = entitiesByMem.get(row.id) || [];
    const md = serializeMemoryToMarkdown(row, entities);

    const safeScope = VALID_SCOPES.has(row.scope) ? row.scope : safeFilenameId(row.scope);
    const safeType = VALID_MEMORY_TYPES.has(row.type) ? row.type : safeFilenameId(row.type);
    const subDir = path.join(outputDir, safeScope, safeType);
    if (!isPathInsideRoot(subDir, outputDir)) {
      throw new Error(`Refusing to create directory outside outputDir: ${subDir}`);
    }
    assertSafeDir(subDir, true);

    const filePath = path.join(subDir, `${safeFilenameId(row.id)}.md`);
    if (!isPathInsideRoot(filePath, subDir) || !isPathInsideRoot(filePath, outputDir)) {
      throw new Error(`Refusing to write file outside outputDir: ${filePath}`);
    }

    writeIfChangedSync(filePath, outputDir, md);
    exportedFiles.push(filePath);
    expectedFileKeys.add(normalizePathKey(filePath));
  }

  // 清理托管目录 (<scope>/<type>/) 下已失效的旧 .md 文件及空目录
  const scopesToPrune: Scope[] =
    options?.scope && VALID_SCOPES.has(options.scope as Scope)
      ? [options.scope as Scope]
      : MANAGED_SCOPES;

  for (const sc of scopesToPrune) {
    const scopeDir = path.join(outputDir, sc);
    try {
      const scStat = fs.lstatSync(scopeDir);
      if (scStat.isSymbolicLink() || !scStat.isDirectory()) continue;
      if (!isPathInsideRoot(scopeDir, outputDir)) continue;
    } catch {
      continue;
    }

    for (const tp of MANAGED_TYPES) {
      const typeDir = path.join(scopeDir, tp);
      try {
        const tpStat = fs.lstatSync(typeDir);
        if (tpStat.isSymbolicLink() || !tpStat.isDirectory()) continue;
        if (!isPathInsideRoot(typeDir, outputDir)) continue;

        const entries = fs.readdirSync(typeDir, { withFileTypes: true });
        for (const ent of entries) {
          if (ent.isSymbolicLink() || !ent.isFile() || !ent.name.endsWith('.md')) continue;
          const full = path.join(typeDir, ent.name);
          if (!isPathInsideRoot(full, outputDir)) continue;
          if (!expectedFileKeys.has(normalizePathKey(full))) {
            fs.unlinkSync(full);
          }
        }
        if (fs.readdirSync(typeDir).length === 0) {
          fs.rmdirSync(typeDir);
        }
      } catch {
        // ignore missing or concurrent fs error
      }
    }

    try {
      if (fs.readdirSync(scopeDir).length === 0) {
        fs.rmdirSync(scopeDir);
      }
    } catch {
      // ignore
    }
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
    trusted?: boolean;
  }
): { importedCount: number; updatedCount: number; errors: string[] } {
  assertSafeDir(inputDir, false);

  const errors: string[] = [];
  let importedCount = 0;
  let updatedCount = 0;
  const now = Date.now();
  const actor = options?.actor || 'user';
  const trusted = options?.trusted ?? actor === 'user';
  const resolvedWsId = options?.workspaceId
    ? resolveWorkspaceId(options.workspaceId)
    : resolveWorkspaceId(process.cwd());

  const mdFiles: string[] = [];
  function scanDir(dir: string, depth: number): void {
    if (depth > MAX_IMPORT_DEPTH || mdFiles.length >= MAX_IMPORT_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: unknown) {
      errors.push(`Dir ${path.basename(dir)}: ${(err as Error)?.message || String(err)}`);
      return;
    }
    for (const ent of entries) {
      if (mdFiles.length >= MAX_IMPORT_FILES) break;
      if (ent.name === '.trash' || ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (!isPathInsideRoot(full, inputDir)) continue;
      if (ent.isDirectory()) {
        if (depth < MAX_IMPORT_DEPTH) {
          scanDir(full, depth + 1);
        }
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        mdFiles.push(full);
      }
    }
  }

  scanDir(inputDir, 0);

  db.transaction(() => {
    for (const file of mdFiles) {
      try {
        const content = safeReadTextFileSync(file, inputDir, MAX_IMPORT_FILE_BYTES);
        if (content === null) {
          errors.push(`File ${path.basename(file)}: skipped (unsafe path, symlink, or exceeds size limit)`);
          continue;
        }
        const parsed = parseMemoryMarkdown(content);
        const fm = parsed.frontmatter;

        let memType: MemoryType = 'semantic';
        if (fm.type !== undefined) {
          if (typeof fm.type === 'string' && VALID_MEMORY_TYPES.has(fm.type as MemoryType)) {
            memType = fm.type as MemoryType;
          } else {
            errors.push(`File ${path.basename(file)}: invalid memory type '${String(fm.type)}'`);
            continue;
          }
        }

        let memScope: Scope = 'workspace';
        if (fm.scope !== undefined) {
          if (typeof fm.scope === 'string' && VALID_SCOPES.has(fm.scope as Scope)) {
            memScope = fm.scope as Scope;
          } else {
            errors.push(`File ${path.basename(file)}: invalid scope '${String(fm.scope)}'`);
            continue;
          }
        }

        if (!trusted && memType === 'meta') {
          errors.push(`File ${path.basename(file)}: untrusted meta memory rejected`);
          continue;
        }

        const validEntities = Array.isArray(fm.entities)
          ? fm.entities
              .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
              .slice(0, 32)
          : undefined;

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
          ? resolvedWsId
          : effectiveScope === 'user' || effectiveScope === 'global'
            ? undefined
            : fmWorkspaceId || options?.workspaceId;
        const fmSessionId =
          typeof fm.session_id === 'string' && fm.session_id.trim()
            ? fm.session_id.trim()
            : undefined;
        const effectiveSessionId =
          effectiveScope === 'session'
            ? fmSessionId || options?.sessionId || 'import_session'
            : undefined;

        const rawConfidence =
          typeof fm.confidence === 'number' && Number.isFinite(fm.confidence)
            ? Math.max(0, Math.min(1, fm.confidence))
            : trusted
              ? 0.9
              : 0.5;
        const effectiveConfidence = !trusted ? Math.min(0.5, rawConfidence) : rawConfidence;

        const memSummary =
          parsed.summary || (typeof fm.summary === 'string' ? fm.summary : '') || 'Imported memory';
        const memContent = parsed.content || memSummary;

        const isTrustedUser = trusted && actor === 'user';
        const res = upsertCandidate(
          db,
          {
            type: memType,
            content: memContent,
            summary: memSummary,
            slot_key: effectiveSlotKey,
            scope: effectiveScope,
            workspaceId: effectiveWorkspaceId,
            sessionId: effectiveSessionId,
            source_kind: isTrustedUser ? 'user' : 'system',
            origin_kinds: !trusted ? ['tool'] : isTrustedUser ? ['user'] : ['system'],
            status: !trusted ? 'candidate' : isTrustedUser ? 'active' : 'candidate',
            confidence: effectiveConfidence,
            sources: [{ session_id: 'import', seq: 0, kind: 'markdown_import' }],
            actor: trusted ? actor : 'maintenance',
            entities: validEntities,
          },
          now
        );

        if (res.action === 'inserted') {
          importedCount++;
        } else if (res.action === 'merged' || res.action === 'superseded') {
          updatedCount++;
        }
      } catch (err: unknown) {
        errors.push(`File ${path.basename(file)}: ${(err as Error)?.message || String(err)}`);
      }
    }
  });

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

  assertSafeDir(trashDir, true);

  const entRows = db.all<{ entity: string }>(
    `SELECT entity FROM memory_entities WHERE memory_id = ? ORDER BY entity ASC`,
    [id]
  );
  const entities = entRows.map((r) => r.entity);
  const md = serializeMemoryToMarkdown(memory, entities);

  const safeId = safeFilenameId(memory.id);
  const trashPath = path.join(trashDir, `${safeId}.md`);
  if (!isPathInsideRoot(trashPath, trashDir)) {
    throw new Error(`Refusing to write trash file outside trashDir: ${trashPath}`);
  }
  atomicWriteFileSync(trashPath, md);

  return { trashed: true, path: trashPath };
}

/**
 * 从回收站或数据库恢复记忆
 */
export function restoreFromTrash(
  db: Db,
  id: string,
  trashDir?: string,
  scopeCtx?: { workspaceId: string; sessionId?: string }
): { restored: boolean; message: string } {
  const rawId = (id || '').trim();
  if (!rawId) {
    return { restored: false, message: `Memory id is required` };
  }

  // 1. 先通过 store.get 查找（完整 ID 与短码均支持，且带作用域隔离）
  let existingInScope: MemoryRecord | undefined;
  try {
    existingInScope = get(db, rawId, scopeCtx);
  } catch (err: unknown) {
    return { restored: false, message: (err as Error)?.message || `Lookup failed for '${rawId}'` };
  }

  if (existingInScope) {
    const res = restoreMemory(db, existingInScope.id, 'user');
    return { restored: res.success, message: res.message };
  }

  // 如果记录存在于 DB 但不在当前作用域内，立即拒绝，避免跨作用域通过 .trash 绕过
  if (scopeCtx) {
    let existsElsewhere = false;
    try {
      existsElsewhere = Boolean(get(db, rawId));
    } catch {
      existsElsewhere = true;
    }
    if (existsElsewhere) {
      return { restored: false, message: `Memory '${rawId}' not found in current scope` };
    }
  }

  // 2. 如果 DB 中彻底不存在但 trashDir 中有 md 文件，则重新导入并还原 slot_key/entities/pinned/utility
  if (trashDir) {
    try {
      const dirStat = fs.lstatSync(trashDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        return { restored: false, message: `Trash directory is invalid: ${trashDir}` };
      }
    } catch {
      return { restored: false, message: `Memory '${rawId}' not found in database or trash` };
    }

    let trashFile = path.join(trashDir, `${safeFilenameId(rawId)}.md`);
    if (!isPathInsideRoot(trashFile, trashDir)) {
      return { restored: false, message: `Invalid memory id '${rawId}'` };
    }

    if (!fs.existsSync(trashFile)) {
      // 支持按短码在 .trash 目录匹配唯一文件
      const prefix = rawId.startsWith('m_') ? safeFilenameId(rawId) : safeFilenameId(`m_${rawId}`);
      try {
        const candidates = fs
          .readdirSync(trashDir, { withFileTypes: true })
          .filter(
            (ent) =>
              !ent.isSymbolicLink() &&
              ent.isFile() &&
              ent.name.endsWith('.md') &&
              ent.name.startsWith(prefix)
          );
        if (candidates.length === 1) {
          trashFile = path.join(trashDir, candidates[0].name);
        } else if (candidates.length > 1) {
          return {
            restored: false,
            message: `Ambiguous short id '${rawId}' in trash, matches: ${candidates.map((c) => c.name.replace(/\.md$/, '')).join(', ')}`,
          };
        }
      } catch {
        // fall through
      }
    }

    const content = safeReadTextFileSync(trashFile, trashDir, MAX_IMPORT_FILE_BYTES);
    if (content !== null) {
      const parsed = parseMemoryMarkdown(content);
      const fm = parsed.frontmatter;
      const scope: Scope =
        typeof fm.scope === 'string' && VALID_SCOPES.has(fm.scope as Scope)
          ? (fm.scope as Scope)
          : 'workspace';
      const memType: MemoryType =
        typeof fm.type === 'string' && VALID_MEMORY_TYPES.has(fm.type as MemoryType)
          ? (fm.type as MemoryType)
          : 'semantic';

      if (
        scopeCtx &&
        scope !== 'user' &&
        scope !== 'global' &&
        (resolveWorkspaceId(String(fm.workspace_id || '')) !==
          resolveWorkspaceId(scopeCtx.workspaceId) ||
          (scope === 'session' && fm.session_id !== scopeCtx.sessionId))
      ) {
        return { restored: false, message: `Memory '${rawId}' not found in current scope` };
      }

      const entities = Array.isArray(fm.entities)
        ? fm.entities.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        : undefined;
      const slotKey =
        typeof fm.slot_key === 'string' && fm.slot_key.trim() ? fm.slot_key.trim() : null;
      const now = Date.now();

      const restoredOk = db.transaction(() => {
        const res = upsertCandidate(
          db,
          {
            type: memType,
            content: parsed.content,
            summary: parsed.summary,
            slot_key: slotKey,
            scope,
            workspaceId:
              scope === 'user' || scope === 'global'
                ? undefined
                : typeof fm.workspace_id === 'string' && fm.workspace_id.trim()
                  ? fm.workspace_id.trim()
                  : scopeCtx?.workspaceId,
            sessionId:
              scope === 'session'
                ? typeof fm.session_id === 'string' && fm.session_id.trim()
                  ? fm.session_id.trim()
                  : scopeCtx?.sessionId
                : undefined,
            source_kind: 'user',
            origin_kinds: ['user'],
            status: 'active',
            confidence:
              typeof fm.confidence === 'number' && Number.isFinite(fm.confidence)
                ? fm.confidence
                : 0.8,
            sources: [{ session_id: 'trash_restore', seq: 0, kind: 'trash_restore' }],
            entities,
            actor: 'user',
          },
          now
        );

        if (res.action === 'inserted' || res.action === 'merged' || res.action === 'superseded') {
          if (fm.pinned === 1) {
            pin(db, res.id, 'user', now);
          }
          if (typeof fm.utility === 'number' && Number.isFinite(fm.utility)) {
            const clampedUtil = Math.max(0, Math.min(1, fm.utility));
            db.run(`UPDATE memories SET utility = ? WHERE id = ?`, [clampedUtil, res.id]);
          }
          return true;
        }
        return false;
      });

      if (restoredOk) {
        return {
          restored: true,
          message: `Memory '${rawId}' successfully restored from trash file`,
        };
      }
    }
  }

  return { restored: false, message: `Memory '${rawId}' not found in database or trash` };
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
  assertSafeDir(outputDir, true);

  const wsId = options?.workspaceId
    ? resolveWorkspaceId(options.workspaceId)
    : resolveWorkspaceId(process.cwd());
  const scope = scopeFilterSQL({ workspaceId: wsId });
  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE ${scope.sql}
       AND status IN ('active', 'frozen')
     ORDER BY pinned DESC, importance DESC, updated_at DESC`,
    scope.params
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
    } else if (
      m.type === 'preference' ||
      m.type === 'belief' ||
      m.slot_key?.startsWith('core:human') ||
      m.slot_key?.startsWith('core:persona')
    ) {
      productContextItems.push(m);
    } else if (m.type === 'failure') {
      progressItems.push(m);
    } else {
      systemPatternsItems.push(m);
    }
  }

  const filesWritten: string[] = [];

  const formatSection = (title: string, desc: string, items: MemoryRecord[]): string => {
    const lines: string[] = [
      `# ${title}`,
      '',
      `> ${desc}`,
      '',
      `*生成时间: ${new Date().toISOString()} | 包含 ${items.length} 条记忆*`,
      '',
    ];
    if (items.length === 0) {
      lines.push('_暂无沉淀记录_');
      lines.push('');
      return lines.join('\n');
    }
    for (const item of items) {
      const cleanSummary = redactSecrets(item.summary || item.content).text.replace(/\r?\n/g, ' ');
      const cleanContent = redactSecrets(item.content).text.replace(/\r\n?/g, '\n');
      const conf = Number.isFinite(item.confidence) ? item.confidence : 0.5;
      lines.push(MEMORY_BANK_ENTRY_MARKER);
      lines.push(`### [${item.type.toUpperCase()} ${item.id}] ${cleanSummary}`);
      lines.push(
        `- **ID**: \`${item.id}\` | **作用域**: \`${item.scope}\` | **重要度**: \`${item.importance ?? 5}/10\` | **置信度**: \`${conf.toFixed(2)}\``
      );
      if (item.slot_key) lines.push(`- **槽位**: \`${item.slot_key}\``);
      lines.push('');
      lines.push(cleanContent);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  };

  const outputs: Array<{ name: string; title: string; desc: string; items: MemoryRecord[] }> = [
    {
      name: 'activeContext.md',
      title: 'Active Context',
      desc: '当前活跃目标、正在进行的任务会话与进行中状态',
      items: activeContextItems,
    },
    {
      name: 'systemPatterns.md',
      title: 'System Patterns',
      desc: '系统架构规范、核心技术栈、设计模式与常用操作步骤',
      items: systemPatternsItems,
    },
    {
      name: 'productContext.md',
      title: 'Product Context',
      desc: '产品背景、开发者个人画像、强偏好与人设准则',
      items: productContextItems,
    },
    {
      name: 'progress.md',
      title: 'Progress & Known Issues',
      desc: '系统已突破进展、排查记录与已知失败/避坑防错指南',
      items: progressItems,
    },
  ];

  for (const out of outputs) {
    const filePath = path.join(outputDir, out.name);
    if (!isPathInsideRoot(filePath, outputDir)) {
      throw new Error(`Refusing to write outside outputDir: ${filePath}`);
    }
    atomicWriteFileSync(filePath, formatSection(out.title, out.desc, out.items));
    filesWritten.push(filePath);
  }

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
  // trusted=false：文件并非用户显式指定（如启动时自动扫描到的仓库内文件），只写入待审批候选
  options?: { workspaceId?: string; trusted?: boolean }
): MemoryBankImportResult {
  const trusted = options?.trusted !== false;
  assertSafeDir(inputDir, false);

  const targetFiles = [
    { file: 'activeContext.md', defaultType: 'goal' as MemoryType },
    { file: 'systemPatterns.md', defaultType: 'semantic' as MemoryType },
    { file: 'productContext.md', defaultType: 'preference' as MemoryType },
    { file: 'progress.md', defaultType: 'failure' as MemoryType },
  ];

  let imported = 0;
  let filesProcessed = 0;
  const wsId = options?.workspaceId
    ? resolveWorkspaceId(options.workspaceId)
    : resolveWorkspaceId(process.cwd());
  const now = Date.now();

  db.transaction(() => {
    for (const item of targetFiles) {
      const fullPath = path.join(inputDir, item.file);
      if (!fs.existsSync(fullPath)) continue;

      const rawText = safeReadTextFileSync(fullPath, inputDir, MAX_IMPORT_FILE_BYTES);
      if (rawText === null) continue;

      filesProcessed++;
      const text = rawText.replace(/\r\n?/g, '\n');

      // 若包含新格式条目分隔注释，则按显式边界切分，避免正文内 `### 子标题` 或 `---` 破坏往返一致性；
      // 否则回退兼容旧格式 `\n### ` 切分。
      const hasExplicitMarker = text.includes(MEMORY_BANK_ENTRY_MARKER);
      const sections: string[] = hasExplicitMarker
        ? text
            .split(/(?:^|\n)<!--\s*dsh-memory:entry\s*-->\s*\n/)
            .slice(1)
            .map((chunk) => chunk.replace(/^###\s+/, ''))
        : text.split(/(?:^|\n)###\s+/).slice(1);

      for (const rawSec of sections) {
        const sec = rawSec.trim();
        if (!sec) continue;

        const firstNewline = sec.indexOf('\n');
        const headerLine = (firstNewline === -1 ? sec : sec.slice(0, firstNewline)).trim();
        const afterHeader = firstNewline === -1 ? '' : sec.slice(firstNewline + 1);
        // 仅剥离导出时在条目末尾附加的单条 `---` 分隔线，不误删正文内部的 `---` 块
        const strippedTail = afterHeader.replace(/\n---\s*$/, '');
        const rawBodyLines = strippedTail.split('\n');

        let parsedSlotKey: string | undefined;
        let parsedScope: Scope | undefined;
        const contentLines: string[] = [];
        let inLeadingMeta = true;
        for (const line of rawBodyLines) {
          const trimmedLine = line.trim();
          if (inLeadingMeta) {
            if (!trimmedLine) continue;
            const slotMatch = /^-\s*\*\*槽位\*\*:\s*`([^`]+)`/.exec(trimmedLine);
            if (slotMatch) {
              // core:* 常驻核心块不接受文件导入，避免仓库内文件替换用户的核心块
              const slot = slotMatch[1].trim();
              if (!slot.toLowerCase().startsWith('core:')) parsedSlotKey = slot;
              continue;
            }
            if (/^-\s*\*\*(?:ID|作用域|重要度|置信度|更新时间)\*\*:/.test(trimmedLine)) {
              const scopeMatch = /\*\*作用域\*\*:\s*`(user|workspace|global|session)`/i.exec(
                trimmedLine
              );
              if (scopeMatch) {
                parsedScope = scopeMatch[1].toLowerCase() as Scope;
              }
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
          if (VALID_MEMORY_TYPES.has(candidateType)) {
            parsedType = candidateType;
          }
        }

        if (!trusted && parsedType === 'meta') {
          continue;
        }

        const cleanSummary = headerLine.replace(/^\[.*?\]\s*/, '').trim();

        const effectiveScope: Scope = !trusted
          ? 'workspace'
          : parsedScope && parsedScope !== 'session'
            ? parsedScope
            : parsedType === 'preference'
              ? 'user'
              : 'workspace';

        const upsertRes = upsertCandidate(
          db,
          {
            type: parsedType,
            content: body,
            summary: cleanSummary.slice(0, 80),
            slot_key: parsedSlotKey,
            scope: effectiveScope,
            workspaceId: effectiveScope === 'user' || effectiveScope === 'global' ? undefined : wsId,
            source_kind: trusted ? 'user' : 'system',
            confidence: trusted ? 0.9 : 0.5,
            importance: 8,
            status: trusted ? 'active' : 'candidate',
            origin_kinds: [trusted ? 'user' : 'tool'],
            sources: [
              { session_id: 'memory_bank_import', seq: 0, kind: 'manual', excerpt: cleanSummary },
            ],
            actor: trusted ? 'user' : 'maintenance',
          },
          now
        );

        if (upsertRes.action === 'inserted' || upsertRes.action === 'superseded') {
          imported++;
        }
      }
    }
  });

  return { imported, filesProcessed };
}
