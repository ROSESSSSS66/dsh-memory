import type { CoreMemoryBlock, CoreMemoryEntry, Db, MemoryType, Scope } from '../types.js';
import { redactSecrets } from './privacy.js';
import { workspaceId as resolveWorkspaceId, scopeFilterSQL } from './scope.js';
import { editContent, truncateCodePoints, upsertCandidate } from './writer.js';

export const DEFAULT_CORE_BLOCKS: CoreMemoryBlock[] = ['human', 'persona', 'project'];

const CORE_BLOCK_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;

export interface CoreMemoryWriteOptions {
  workspaceId?: string;
  sessionId?: string;
  actor?: string;
  now?: number;
}

interface CoreMemoryWriteResult {
  id: string;
  action: 'created' | 'updated' | 'proposed' | 'unchanged';
}

function normalizeBlockName(block: string): string {
  return (typeof block === 'string' ? block : '').toLowerCase().trim();
}

function assertValidCoreBlock(block: string): string {
  const normBlock = normalizeBlockName(block);
  if (!CORE_BLOCK_NAME_REGEX.test(normBlock)) {
    throw new Error('invalid_core_block');
  }
  return normBlock;
}

function resolveBlockScopeAndType(block: string): { scope: Scope; type: MemoryType } {
  const b = normalizeBlockName(block);
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
  const normBlock = normalizeBlockName(block);
  if (!CORE_BLOCK_NAME_REGEX.test(normBlock)) return null;

  const slotKey = `core:${normBlock}`;
  const { scope } = resolveBlockScopeAndType(normBlock);
  const wsId =
    scope === 'workspace' ? resolveWorkspaceId(scopeCtx?.workspaceId || process.cwd()) : null;

  const row = db.get<{
    id: string;
    content: string;
    updated_at: number;
    version: number;
  }>(
    `SELECT id, content, updated_at, version FROM memories
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
 * 获取所有活跃的 Core Memory 块（按块名去重，优先选用各块的规范 scope）
 */
export function getAllCoreMemories(db: Db, scopeCtx?: { workspaceId?: string }): CoreMemoryEntry[] {
  const wsId = resolveWorkspaceId(scopeCtx?.workspaceId || process.cwd());
  const scopeFilter = scopeFilterSQL({ workspaceId: wsId });

  const rows = db.all<{
    id: string;
    slot_key: string;
    scope: Scope;
    content: string;
    updated_at: number;
    version: number;
  }>(
    `SELECT id, slot_key, scope, content, updated_at, version FROM memories
     WHERE slot_key >= 'core:' AND slot_key < 'core;'
       AND ${scopeFilter.sql}
       AND status IN ('active', 'frozen')
     ORDER BY slot_key ASC, version DESC, updated_at DESC`,
    scopeFilter.params
  );

  const byBlock = new Map<string, { entry: CoreMemoryEntry; isCanonical: boolean }>();

  for (const r of rows) {
    const block = (r.slot_key || '').slice(5);
    if (!block) continue;

    const canonicalScope = resolveBlockScopeAndType(block).scope;
    const isCanonical = r.scope === canonicalScope;
    const prev = byBlock.get(block);

    if (!prev || (isCanonical && !prev.isCanonical)) {
      byBlock.set(block, {
        isCanonical,
        entry: {
          block,
          content: r.content,
          updated_at: r.updated_at,
          version: r.version,
          id: r.id,
        },
      });
    }
  }

  return Array.from(byBlock.values()).map((v) => v.entry);
}

/**
 * 设定/重置 Core Memory 块的内容
 */
export function setCoreMemory(
  db: Db,
  block: CoreMemoryBlock,
  content: string,
  options?: CoreMemoryWriteOptions
): CoreMemoryWriteResult {
  return db.transaction(() => {
    const normBlock = assertValidCoreBlock(block);
    const trimmed = (typeof content === 'string' ? content : '').trim();
    if (!trimmed) {
      throw new Error(`Core memory block '${normBlock}' content cannot be empty.`);
    }

    const priv = redactSecrets(trimmed);
    if (priv.hasSensitive) {
      throw new Error('sensitive_content_detected');
    }
    const cleanContent = trimmed;

    const { scope, type } = resolveBlockScopeAndType(normBlock);
    const wsId =
      scope === 'workspace' ? resolveWorkspaceId(options?.workspaceId || process.cwd()) : undefined;
    const slotKey = `core:${normBlock}`;
    const actor = options?.actor ?? 'user';
    const trusted = actor === 'user' || actor === 'system';
    const now =
      typeof options?.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();

    const existing = getCoreMemory(db, normBlock, { workspaceId: wsId });
    if (existing && !trusted && existing.content === cleanContent) {
      return { id: existing.id, action: 'unchanged' };
    }
    if (existing && trusted) {
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
      db.run(
        `UPDATE memories SET pinned = 1, importance = 10, confidence = 1.0, utility = 1.0 WHERE id = ?`,
        [existing.id]
      );
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
        source_kind: trusted ? actor : 'assistant',
        confidence: trusted ? 1.0 : 0.5,
        importance: 10,
        origin_kinds: [trusted ? actor : 'assistant'],
        sources: [
          {
            session_id: options?.sessionId || 'core_memory',
            seq: 0,
            kind: trusted ? 'manual' : 'assistant',
            excerpt: truncateCodePoints(cleanContent, 100),
          },
        ],
        actor: trusted ? actor : 'llm',
        status: trusted ? 'active' : 'candidate',
      },
      now
    );

    if ('id' in upsertRes) {
      // Candidates only enter the stable layer after explicit approval.
      if (trusted) {
        db.run(
          `UPDATE memories SET pinned = 1, importance = 10, confidence = 1.0, utility = 1.0 WHERE id = ?`,
          [upsertRes.id]
        );
      }
      return { id: upsertRes.id, action: trusted ? 'created' : 'proposed' };
    }

    throw new Error(
      `Failed to initialize core memory '${normBlock}': ${JSON.stringify(upsertRes)}`
    );
  });
}

/**
 * 向 Core Memory 块追加内容 (汲取自 MemGPT core_memory_append)
 */
export function appendCoreMemory(
  db: Db,
  block: CoreMemoryBlock,
  textToAppend: string,
  options?: CoreMemoryWriteOptions
): CoreMemoryWriteResult & { newContent: string } {
  return db.transaction(() => {
    const normBlock = assertValidCoreBlock(block);
    const trimmed = (typeof textToAppend === 'string' ? textToAppend : '').trim();
    if (!trimmed) {
      throw new Error('Cannot append empty text to core memory block.');
    }

    const priv = redactSecrets(trimmed);
    if (priv.hasSensitive) {
      throw new Error('sensitive_content_detected');
    }
    const addition = trimmed;

    const existing = getCoreMemory(db, normBlock, options);
    if (!existing) {
      const initRes = setCoreMemory(db, normBlock, addition, options);
      return { ...initRes, newContent: addition };
    }

    const newContent = `${existing.content}\n${addition}`;
    const result = setCoreMemory(db, normBlock, newContent, options);
    return { ...result, newContent };
  });
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
