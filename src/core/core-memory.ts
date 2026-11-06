import type { Db, MemoryRecord, CoreMemoryBlock, CoreMemoryEntry, Scope, MemoryType } from '../types.js';
import { workspaceId as resolveWorkspaceId, scopeFilterSQL } from './scope.js';
import { upsertCandidate, editContent } from './writer.js';
import { estimateTokens } from './tokens.js';
import { redactSecrets } from './privacy.js';

export const DEFAULT_CORE_BLOCKS: CoreMemoryBlock[] = ['human', 'persona', 'project'];

function resolveBlockScopeAndType(block: string): { scope: Scope; type: MemoryType } {
  const b = block.toLowerCase().trim();
  if (b === 'human') {
    return { scope: 'user', type: 'preference' };
  }
  if (b === 'persona') {
    return { scope: 'global', type: 'belief' };
  }
  return { scope: 'workspace', type: 'procedural' };
}

/**
 * 获取指定名称的 Core Memory 块 (汲取自 Letta/MemGPT 虚拟内存系统)
 */
export function getCoreMemory(
  db: Db,
  block: CoreMemoryBlock,
  scopeCtx?: { workspaceId?: string }
): CoreMemoryEntry | null {
  const normBlock = block.toLowerCase().trim();
  const slotKey = `core:${normBlock}`;
  const { scope } = resolveBlockScopeAndType(normBlock);
  const wsId = scope === 'workspace' ? resolveWorkspaceId(scopeCtx?.workspaceId || process.cwd()) : null;

  const row = db.get<MemoryRecord>(
    `SELECT * FROM memories
     WHERE slot_key = ?
       AND scope = ?
       AND COALESCE(workspace_id, '') = ?
       AND status IN ('active', 'frozen')
     ORDER BY version DESC
     LIMIT 1`,
    [slotKey, scope, wsId || '']
  );

  if (!row) return null;

  return {
    block: normBlock,
    content: row.content,
    updated_at: row.updated_at,
    version: row.version,
    id: row.id,
  };
}

/**
 * 获取所有活跃的 Core Memory 块
 */
export function getAllCoreMemories(
  db: Db,
  scopeCtx?: { workspaceId?: string }
): CoreMemoryEntry[] {
  const wsId = resolveWorkspaceId(scopeCtx?.workspaceId || process.cwd());
  const scopeFilter = scopeFilterSQL({ workspaceId: wsId });

  const rows = db.all<MemoryRecord>(
    `SELECT * FROM memories
     WHERE slot_key LIKE 'core:%'
       AND ${scopeFilter.sql}
       AND status IN ('active', 'frozen')
     ORDER BY slot_key ASC`,
    scopeFilter.params
  );

  return rows.map((r) => {
    const block = (r.slot_key || '').replace(/^core:/, '');
    return {
      block,
      content: r.content,
      updated_at: r.updated_at,
      version: r.version,
      id: r.id,
    };
  });
}

/**
 * 设定/重置 Core Memory 块的内容
 */
export function setCoreMemory(
  db: Db,
  block: CoreMemoryBlock,
  content: string,
  options?: { workspaceId?: string; actor?: string }
): { id: string; action: 'created' | 'updated' } {
  const normBlock = block.toLowerCase().trim();
  const cleanContent = redactSecrets(content.trim()).text;
  if (!cleanContent) {
    throw new Error(`Core memory block '${normBlock}' content cannot be empty.`);
  }

  const { scope, type } = resolveBlockScopeAndType(normBlock);
  const wsId = scope === 'workspace' ? resolveWorkspaceId(options?.workspaceId || process.cwd()) : undefined;
  const slotKey = `core:${normBlock}`;
  const actor = (options?.actor || 'user') as any;
  const now = Date.now();

  const existing = getCoreMemory(db, normBlock, { workspaceId: wsId });
  if (existing) {
    const editRes = editContent(
      db,
      existing.id,
      cleanContent,
      `[Core Memory] ${normBlock.toUpperCase()}`,
      actor,
      now
    );
    if (!editRes.ok) {
      throw new Error(`Failed to update core memory '${normBlock}'`);
    }
    // 确保 pinned=1 与 importance=10
    db.run(`UPDATE memories SET pinned = 1, importance = 10, confidence = 1.0, utility = 1.0 WHERE id = ?`, [existing.id]);
    return { id: existing.id, action: 'updated' };
  }

  const summary = `[Core Memory] ${normBlock.toUpperCase()}`;
  const upsertRes = upsertCandidate(
    db,
    {
      type,
      content: cleanContent,
      summary,
      slot_key: slotKey,
      scope,
      workspaceId: wsId,
      source_kind: 'user',
      confidence: 1.0,
      importance: 10,
      origin_kinds: ['user'],
      sources: [{ session_id: 'core_memory', seq: 0, kind: 'manual', excerpt: cleanContent.slice(0, 100) }],
      actor: 'user',
      status: 'active',
    },
    now
  );

  if ('id' in upsertRes) {
    // 强制设为 pinned=1
    db.run(`UPDATE memories SET pinned = 1, importance = 10, confidence = 1.0, utility = 1.0 WHERE id = ?`, [upsertRes.id]);
    return { id: upsertRes.id, action: 'created' };
  }

  throw new Error(`Failed to initialize core memory '${normBlock}': ${JSON.stringify(upsertRes)}`);
}

/**
 * 向 Core Memory 块追加内容 (汲取自 MemGPT core_memory_append)
 */
export function appendCoreMemory(
  db: Db,
  block: CoreMemoryBlock,
  textToAppend: string,
  options?: { workspaceId?: string; actor?: string }
): { id: string; newContent: string } {
  const normBlock = block.toLowerCase().trim();
  const addition = redactSecrets(textToAppend.trim()).text;
  if (!addition) {
    throw new Error('Cannot append empty text to core memory block.');
  }

  const existing = getCoreMemory(db, normBlock, options);
  if (!existing) {
    const initRes = setCoreMemory(db, normBlock, addition, options);
    return { id: initRes.id, newContent: addition };
  }

  const newContent = `${existing.content}\n${addition}`;
  setCoreMemory(db, normBlock, newContent, options);
  return { id: existing.id, newContent };
}

/**
 * 格式化渲染 Core Memory 结构化 Markdown 块 (用于 System Prompt 顶部呈现)
 */
export function renderCoreMemoryMarkdown(entries: CoreMemoryEntry[]): string {
  if (!entries || entries.length === 0) return '';

  const lines: string[] = ['### 🧠 Core Memory (Letta/MemGPT Scratchpad)'];
  for (const e of entries) {
    const blockTitle = e.block.toUpperCase();
    lines.push(`- **[${blockTitle}]**: ${e.content}`);
  }
  lines.push('');
  return lines.join('\n');
}
