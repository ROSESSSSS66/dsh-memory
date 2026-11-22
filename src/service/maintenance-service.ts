import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import { workspaceId, resolveWorkspaceCwd } from '../core/scope.js';
import { isWorkspaceExcluded, type LookupFn } from '../core/privacy.js';
import {
  backfillMissingEmbeddings,
  backfillRemoteEmbeddingsAsync,
} from '../core/vector.js';
import { autoHealMemoryHealth, weaveZettelkastenLinks } from '../core/health.js';
import { syncAutonomousVikingTree } from '../core/viking.js';
import {
  archiveColdMemories,
  autoPinMemories,
  backupDatabase,
  checkAndRepairFts,
  cleanOldTelemetry,
  curateMemoriesWithLLM,
  expireCandidates,
  getBackupTimestamp,
  pruneInvalidMemories,
} from '../evolution/maintenance.js';
import { checkSentinelAndRollback } from '../evolution/lab.js';
import { listActiveWorkspaces } from './scope-guard.js';

export interface UnifiedMaintenanceOptions {
  workspaceId?: string;
  workspacePath?: string;
  cfg: PluginConfig;
  now?: number;
  signal?: AbortSignal;
  deadline?: number;
  runLlmCurate?: boolean;
  runRemoteEmbeddings?: boolean;
  runBackup?: boolean;
  runSentinel?: boolean;
  /** 仅每日热备一次（默认 false：显式传 runBackup: true 时立即执行） */
  backupOncePerDay?: boolean;
  backupDir?: string;
  dbFilePath?: string;
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  skipDnsLookup?: boolean;
}

export interface UnifiedMaintenanceResult {
  archivedCold: number;
  expiredCandidates: number;
  prunedInvalid: number;
  ftsRepaired: number;
  localEmbeddingsBackfilled: number;
  remoteEmbeddingsBackfilled: number;
  autoPinned: number;
  healthHealed: number;
  linksWeaved: number;
  modelsSynthesized: number;
  vikingSynced: boolean;
  telemetryCleaned: number;
  curated: { ran: boolean; skippedReason?: string };
  sentinelRolledBack: boolean;
  backupPath?: string;
  errors: string[];
}

function formatErr(stage: string, err: unknown): string {
  return `${stage}: ${err instanceof Error ? err.message : String(err)}`;
}

function buildStageSignal(
  externalSignal?: AbortSignal,
  deadline?: number
): { signal?: AbortSignal; stopped: boolean } {
  if (externalSignal?.aborted) {
    return { signal: externalSignal, stopped: true };
  }
  if (typeof deadline === 'number' && Number.isFinite(deadline)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { signal: externalSignal, stopped: true };
    }
    const timeoutSig = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)));
    return {
      signal: externalSignal ? AbortSignal.any([externalSignal, timeoutSig]) : timeoutSig,
      stopped: false,
    };
  }
  return { signal: externalSignal, stopped: false };
}

function verifyWorkspaceDirectory(
  candidatePath: string | undefined,
  expectedWsId: string | undefined,
  excludeWorkspaces: string[]
): { dir: string; wsId: string } | null {
  const trimmed = (candidatePath || '').trim();
  if (!trimmed) return null;
  try {
    if (!fs.existsSync(trimmed)) return null;
    if (!fs.statSync(trimmed).isDirectory()) return null;
  } catch {
    return null;
  }
  const pathWsId = workspaceId(trimmed);
  if (!pathWsId) return null;
  if (expectedWsId && pathWsId !== expectedWsId) return null;
  if (
    excludeWorkspaces.length > 0 &&
    (isWorkspaceExcluded(trimmed, excludeWorkspaces) ||
      isWorkspaceExcluded(pathWsId, excludeWorkspaces))
  ) {
    return null;
  }
  return { dir: trimmed, wsId: pathWsId };
}

const CLEAN_CURATE_SKIP_REASONS = new Set([
  'privacy_offline_consent_required',
  'workspace_excluded',
  'aborted',
  'job_deadline_exceeded',
]);

/**
 * 统一单通道记忆维护管线（取代 plugin.ts 与 web.ts 中各自重复执行 2x-3x 的维护流程）：
 * - 在每个阶段间检查 signal?.aborted 与 deadline
 * - prune / FTS / local embeddings / autoHeal(skip*) / weave 严格各执行一次
 * - 仅在 workspacePath 真实存在且 workspaceId(workspacePath) === targetWsId 时同步 OpenViking 目录树
 * - 在 VACUUM INTO 热备前再次校验未中止
 */
export async function runUnifiedMaintenance(
  db: Db,
  options: UnifiedMaintenanceOptions
): Promise<UnifiedMaintenanceResult> {
  const { cfg } = options;
  const now = options.now ?? Date.now();
  const excludeWorkspaces = cfg.excludeWorkspaces || [];

  const result: UnifiedMaintenanceResult = {
    archivedCold: 0,
    expiredCandidates: 0,
    prunedInvalid: 0,
    ftsRepaired: 0,
    localEmbeddingsBackfilled: 0,
    remoteEmbeddingsBackfilled: 0,
    autoPinned: 0,
    healthHealed: 0,
    linksWeaved: 0,
    modelsSynthesized: 0,
    vikingSynced: false,
    telemetryCleaned: 0,
    curated: { ran: false },
    sentinelRolledBack: false,
    errors: [],
  };

  const isStopped = (): boolean => {
    if (options.signal?.aborted) return true;
    if (
      typeof options.deadline === 'number' &&
      Number.isFinite(options.deadline) &&
      Date.now() >= options.deadline
    ) {
      return true;
    }
    return false;
  };

  const stopIfAborted = (): UnifiedMaintenanceResult | null => {
    if (!isStopped()) return null;
    if (!result.curated.ran && !result.curated.skippedReason) {
      result.curated = {
        ran: false,
        skippedReason: options.signal?.aborted ? 'aborted' : 'deadline_exceeded',
      };
    }
    return result;
  };

  const rawWsIdInput = typeof options.workspaceId === 'string' ? options.workspaceId.trim() : '';
  const rawWsPathInput = typeof options.workspacePath === 'string' ? options.workspacePath.trim() : '';
  const targetWsId = rawWsIdInput
    ? workspaceId(rawWsIdInput)
    : rawWsPathInput
      ? workspaceId(rawWsPathInput)
      : undefined;

  // 若显式指定的工作区或路径命中排除名单，直接安全跳过
  if (excludeWorkspaces.length > 0) {
    const mappedPath = targetWsId ? resolveWorkspaceCwd(db, targetWsId) : undefined;
    if (
      (rawWsIdInput && isWorkspaceExcluded(rawWsIdInput, excludeWorkspaces)) ||
      (rawWsPathInput && isWorkspaceExcluded(rawWsPathInput, excludeWorkspaces)) ||
      (targetWsId && isWorkspaceExcluded(targetWsId, excludeWorkspaces)) ||
      (mappedPath && isWorkspaceExcluded(mappedPath, excludeWorkspaces))
    ) {
      result.curated = { ran: false, skippedReason: 'workspace_excluded' };
      return result;
    }
  }

  // Stage 1: 冷记忆归档
  if (stopIfAborted()) return result;
  try {
    result.archivedCold = archiveColdMemories(db, cfg, now);
  } catch (err) {
    result.errors.push(formatErr('archive_cold', err));
  }

  // Stage 2: 候选与修复提案过期
  if (stopIfAborted()) return result;
  try {
    const exp = expireCandidates(db, now);
    result.expiredCandidates = exp.expiredCandidates;
  } catch (err) {
    result.errors.push(formatErr('expire_candidates', err));
  }

  // 若未指定 workspaceId 且存在 excludeWorkspaces，仅枚举未排除工作区执行作用域写操作
  const nonExcludedWorkspaces =
    !targetWsId && excludeWorkspaces.length > 0
      ? listActiveWorkspaces(db, cfg).map((w) => w.workspaceId)
      : [];

  // Stage 3: 本地确定性无效记忆清理（仅一次）
  if (stopIfAborted()) return result;
  try {
    if (targetWsId) {
      result.prunedInvalid = pruneInvalidMemories(db, { workspaceId: targetWsId, now }).prunedCount;
    } else if (excludeWorkspaces.length > 0) {
      for (const ws of nonExcludedWorkspaces) {
        if (stopIfAborted()) return result;
        result.prunedInvalid += pruneInvalidMemories(db, { workspaceId: ws, now }).prunedCount;
      }
    } else {
      result.prunedInvalid = pruneInvalidMemories(db, { now }).prunedCount;
    }
  } catch (err) {
    result.errors.push(formatErr('prune_invalid', err));
  }

  // Stage 4: FTS5 索引一致性检查与修复（仅一次）
  if (stopIfAborted()) return result;
  try {
    const ftsRes = checkAndRepairFts(db);
    result.ftsRepaired = ftsRes.rebuilt ? 1 : 0;
  } catch (err) {
    result.errors.push(formatErr('fts_repair', err));
  }

  // Stage 5: 本地 128D 特征向量回填（仅一次）
  if (stopIfAborted()) return result;
  try {
    if (targetWsId) {
      result.localEmbeddingsBackfilled = backfillMissingEmbeddings(db, {
        workspaceId: targetWsId,
        limit: 500,
      });
    } else if (excludeWorkspaces.length > 0) {
      for (const ws of nonExcludedWorkspaces) {
        if (stopIfAborted()) return result;
        result.localEmbeddingsBackfilled += backfillMissingEmbeddings(db, {
          workspaceId: ws,
          limit: 500,
        });
      }
    } else {
      result.localEmbeddingsBackfilled = backfillMissingEmbeddings(db, { limit: 500 });
    }
  } catch (err) {
    result.errors.push(formatErr('local_embeddings', err));
  }

  // Stage 6: 可选远程 OpenAI-compatible 向量增量回填
  if (stopIfAborted()) return result;
  if (options.runRemoteEmbeddings && cfg.embedding?.provider === 'openai-compatible') {
    const stageSig = buildStageSignal(options.signal, options.deadline);
    if (stageSig.stopped) {
      stopIfAborted();
      return result;
    }
    try {
      const remoteRes = await backfillRemoteEmbeddingsAsync(db, cfg, {
        workspaceId: targetWsId,
        limit: 200,
        signal: stageSig.signal,
        fetchFn: options.fetchFn,
        lookupFn: options.lookupFn,
        skipDnsLookup: options.skipDnsLookup,
      });
      result.remoteEmbeddingsBackfilled = remoteRes.updated;
    } catch (err) {
      result.errors.push(formatErr('remote_embeddings', err));
    }
  }

  // Stage 7: 自动置顶高价值稳定记忆
  if (stopIfAborted()) return result;
  try {
    result.autoPinned = autoPinMemories(db, now);
  } catch (err) {
    result.errors.push(formatErr('auto_pin', err));
  }

  // Stage 8: 可选离线 LLM 智能策展（仅在 runLlmCurate && privacy.offlineConsent 时执行）
  if (stopIfAborted()) return result;
  if (!options.runLlmCurate) {
    result.curated = { ran: false, skippedReason: 'disabled' };
  } else if (!cfg.privacy?.offlineConsent) {
    // 缺少外发授权属于正常隐私跳过，绝不计为错误
    result.curated = { ran: false, skippedReason: 'privacy_offline_consent_required' };
  } else {
    const stageSig = buildStageSignal(options.signal, options.deadline);
    if (stageSig.stopped) {
      stopIfAborted();
      return result;
    }
    try {
      const verifiedPath = verifyWorkspaceDirectory(
        rawWsPathInput || (targetWsId ? resolveWorkspaceCwd(db, targetWsId) : undefined),
        targetWsId,
        excludeWorkspaces
      );
      type CurateOptionsExt = NonNullable<Parameters<typeof curateMemoriesWithLLM>[2]> & {
        deadline?: number;
        jobDeadline?: number;
        skipLocalPrune?: boolean;
      };
      const curateOpts: CurateOptionsExt = {
        workspaceId: targetWsId,
        cwd: verifiedPath?.dir,
        signal: stageSig.signal,
        fetchFn: options.fetchFn,
        now,
        deadline: options.deadline,
        jobDeadline: options.deadline,
        skipLocalPrune: true,
      };
      const curateRes = await curateMemoriesWithLLM(db, cfg, curateOpts);
      if (curateRes.ok) {
        result.curated = { ran: true };
      } else {
        const reason = curateRes.error || 'curate_failed';
        result.curated = { ran: false, skippedReason: reason };
        if (!CLEAN_CURATE_SKIP_REASONS.has(reason)) {
          result.errors.push(`curate: ${reason}`);
        }
      }
    } catch (err) {
      result.curated = {
        ran: false,
        skippedReason: err instanceof Error ? err.message : String(err),
      };
      result.errors.push(formatErr('curate', err));
    }
  }

  // Stage 9: 记忆健康度自愈（仅一次，跳过已执行的 FTS / Embeddings / Prune / Weave）
  if (stopIfAborted()) return result;
  try {
    const healRes = autoHealMemoryHealth(db, {
      workspaceId: targetWsId,
      excludeWorkspaces,
      now,
      skipFts: true,
      skipEmbeddings: true,
      skipPrune: true,
      skipWeave: true,
    });
    result.healthHealed =
      healRes.duplicatesMerged +
      healRes.contradictionsResolved +
      (healRes.candidatesPromoted ?? 0) +
      (healRes.coreBlocksSynced ?? 0) +
      (healRes.confidenceCalibrated ?? 0);
    result.modelsSynthesized = healRes.modelsSynthesized ?? 0;
    if (healRes.errors.length > 0) {
      result.errors.push(...healRes.errors);
    }
  } catch (err) {
    result.errors.push(formatErr('auto_heal', err));
  }

  // Stage 10: A-Mem Zettelkasten 双链织网（仅一次）
  if (stopIfAborted()) return result;
  try {
    result.linksWeaved = weaveZettelkastenLinks(db, {
      workspaceId: targetWsId,
      excludeWorkspaces,
      maxNewLinks: 60,
      now,
    });
  } catch (err) {
    result.errors.push(formatErr('weave_links', err));
  }

  // Stage 11: OpenViking 上下文树同步（严格要求真实存在且 workspaceId(workspacePath) === targetWsId，绝不写入 process.cwd()）
  if (stopIfAborted()) return result;
  try {
    const candidateVikingPath = rawWsPathInput
      ? rawWsPathInput
      : targetWsId
        ? resolveWorkspaceCwd(db, targetWsId)
        : undefined;
    const verifiedViking = verifyWorkspaceDirectory(
      candidateVikingPath,
      targetWsId,
      excludeWorkspaces
    );
    if (verifiedViking) {
      const syncRes = syncAutonomousVikingTree(db, {
        workspacePath: verifiedViking.dir,
        workspaceId: verifiedViking.wsId,
      });
      result.vikingSynced = syncRes.synced;
    }
  } catch (err) {
    result.errors.push(formatErr('viking_sync', err));
  }

  // Stage 12: 清理过期原始事件与遥测数据
  if (stopIfAborted()) return result;
  try {
    const cleaned = cleanOldTelemetry(db, now);
    result.telemetryCleaned = cleaned.deletedEvents + cleaned.deletedMetrics;
  } catch (err) {
    result.errors.push(formatErr('clean_telemetry', err));
  }

  // Stage 13: 可选策略哨兵自动回滚检查
  if (stopIfAborted()) return result;
  if (options.runSentinel) {
    try {
      const sentinel = checkSentinelAndRollback(db);
      result.sentinelRolledBack = sentinel.rolledBack;
    } catch (err) {
      result.errors.push(formatErr('sentinel_check', err));
    }
  }

  // Stage 14: 可选数据库安全热备（在 VACUUM INTO 前再次确认未中止）
  if (stopIfAborted()) return result;
  if (options.runBackup) {
    const dbFilePath = options.dbFilePath || db.filePath || '';
    if (dbFilePath && dbFilePath !== ':memory:') {
      try {
        const today = getBackupTimestamp(new Date(now)).slice(0, 8);
        let shouldRunBackup = true;
        if (options.backupOncePerDay) {
          const lastBackupDay = db.get<{ value: string }>(
            "SELECT value FROM meta WHERE key = 'backup.last_day'"
          )?.value;
          shouldRunBackup = lastBackupDay !== today;
        }
        if (shouldRunBackup && !isStopped()) {
          const backupDir =
            options.backupDir || path.join(path.dirname(path.resolve(dbFilePath)), 'backups');
          const backupPath = backupDatabase(db, dbFilePath, backupDir, now);
          result.backupPath = backupPath;
          db.run(
            `INSERT INTO meta (key, value) VALUES ('backup.last_day', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [today]
          );
        }
      } catch (err) {
        result.errors.push(formatErr('backup_database', err));
      }
    }
  }

  return result;
}
