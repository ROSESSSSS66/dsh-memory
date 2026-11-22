import { hydrateMemoryRow, type Db, type MemoryRow } from '../../types.js';
import { tokenSet, jaccard } from '../text.js';
import { estimateTokens } from '../tokens.js';
import { workspaceId } from '../scope.js';
import { isWorkspaceExcluded, memoryPrivacyFilterSQL } from '../privacy.js';
import { hasUntrustedOrigin } from '../trust.js';
import { getCoreMemory, setCoreMemory } from '../core-memory.js';

export interface CoreSyncOptions {
  workspaceId?: string;
  sessionId?: string;
  excludeWorkspaces?: string[];
  maxBlockTokens?: number;
  now?: number;
  onError?: (message: string) => void;
}

export type CoreSyncResult = number;

/**
 * 全自动高置信度/高效用规则晋升同步至 Core Memory (Autonomous Core Memory Sync)
 * 仅将线上正反馈验证过 (pinned=1 或 success_count>=1)、confidence >= 0.88 且 utility >= 0.65 的无污点规则
 * 幂等蒸馏进 human (用户偏好) 与 project (项目核心规范) 块，严格限制每块 <= maxBlockTokens 且绝不覆盖 frozen 块。
 */
export function syncAutonomousCoreMemory(
  db: Db,
  options: CoreSyncOptions = {}
): CoreSyncResult {
  const now = options.now ?? Date.now();
  const maxBlockTokens = options.maxBlockTokens ?? 220;
  const wsFilter = options.workspaceId ? workspaceId(options.workspaceId) : undefined;
  const privacy = memoryPrivacyFilterSQL(options.excludeWorkspaces);
  let blocksUpdated = 0;

  const trySyncBlock = (
    block: 'human' | 'project',
    candidates: Array<{ summary: string; content: string }>,
    wsId?: string
  ) => {
    if (candidates.length === 0) return;

    // 若目标 Core Memory 已处于 frozen 状态，绝不改动
    const rawCore = db.get<{ status: string }>(
      `SELECT status FROM memories
       WHERE slot_key = ?
         AND scope = ?
         AND COALESCE(workspace_id, '') = ?
         AND status IN ('active', 'frozen')
       LIMIT 1`,
      [
        `core:${block}`,
        block === 'human' ? 'user' : 'workspace',
        block === 'project' ? wsId || '' : '',
      ]
    );
    if (rawCore?.status === 'frozen') return;

    const existing = getCoreMemory(db, block, wsId ? { workspaceId: wsId } : undefined);
    let currentContent = existing?.content?.trim() || '';
    const existingLines = currentContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const existingLineTokens = existingLines.map((l) => tokenSet(l));
    let changed = false;

    for (const cand of candidates) {
      const cleanText = (cand.summary?.trim().length >= 8 ? cand.summary : cand.content)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 110);
      if (!cleanText) continue;

      const bullet = cleanText.startsWith('-') ? cleanText : `- ${cleanText}`;
      const candToks = tokenSet(cleanText);

      // 幂等去重：避免子串包含或高词法重叠
      const alreadyCovered =
        currentContent.includes(cleanText) ||
        existingLineTokens.some((lt) => jaccard(candToks, lt) >= 0.58);
      if (alreadyCovered) continue;

      const nextContent = currentContent ? `${currentContent}\n${bullet}` : bullet;
      if (estimateTokens(nextContent) > maxBlockTokens) {
        break;
      }

      currentContent = nextContent;
      existingLineTokens.push(candToks);
      changed = true;
    }

    if (changed && currentContent) {
      try {
        const writeOptions = {
          workspaceId: wsId,
          actor: 'system',
          now,
        } as Parameters<typeof setCoreMemory>[3] & { now?: number };
        setCoreMemory(db, block, currentContent, writeOptions);
        blocksUpdated++;
      } catch (err) {
        options.onError?.(
          `core_sync(${block}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };

  // 1. 同步用户级高效用偏好 -> core:human（受 privacy 隔离保护，排除不可信来源）
  const rawUserPrefs = db.all<MemoryRow>(
    `SELECT * FROM memories
     WHERE status IN ('active', 'frozen')
       AND scope = 'user'
       AND type = 'preference'
       AND source_kind NOT IN ('web', 'tool')
       AND COALESCE(slot_key, '') NOT LIKE 'core:%'
       AND confidence >= 0.88
       AND utility >= 0.65
       AND (pinned = 1 OR success_count >= 1)
       AND (${privacy.sql})
     ORDER BY pinned DESC, utility DESC, success_count DESC, updated_at DESC
     LIMIT 6`,
    privacy.params
  );
  const userPrefs = rawUserPrefs
    .map((r) => hydrateMemoryRow(r))
    .filter((r) => !hasUntrustedOrigin(r))
    .slice(0, 3);
  trySyncBlock('human', userPrefs);

  // 2. 同步当前工作区高效用架构/规范规则 -> core:project (仅在提供明确且未被排除的 workspaceId 时执行)
  if (wsFilter && !isWorkspaceExcluded(wsFilter, options.excludeWorkspaces)) {
    const rawWsRules = db.all<MemoryRow>(
      `SELECT * FROM memories
       WHERE status IN ('active', 'frozen')
         AND scope = 'workspace'
         AND workspace_id = ?
         AND type IN ('procedural', 'semantic', 'preference')
         AND source_kind NOT IN ('web', 'tool')
         AND COALESCE(slot_key, '') NOT LIKE 'core:%'
         AND confidence >= 0.88
         AND utility >= 0.65
         AND (pinned = 1 OR success_count >= 1)
         AND (${privacy.sql})
       ORDER BY pinned DESC, utility DESC, success_count DESC, updated_at DESC
       LIMIT 6`,
      [wsFilter, ...privacy.params]
    );
    const wsRules = rawWsRules
      .map((r) => hydrateMemoryRow(r))
      .filter((r) => !hasUntrustedOrigin(r))
      .slice(0, 3);
    trySyncBlock('project', wsRules, wsFilter);
  }

  return blocksUpdated;
}
