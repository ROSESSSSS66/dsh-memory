import type { PluginConfig } from '../config.js';
import { isRemoteEmbeddingEnabled } from '../core/embedding-client.js';
import { runHindsightReflect } from '../core/hindsight.js';
import { consolidateCluster, findConsolidationClusters } from '../evolution/consolidator.js';
import { distillSession, findEligibleDistillSession } from '../evolution/extractor.js';
import { runStrategyEvolution } from '../evolution/lab.js';
import { curateMemoriesWithLLM } from '../evolution/maintenance.js';
import { runReflectJob } from '../evolution/reflector.js';
import { executeRepair } from '../evolution/repair.js';
import { runBackfill } from '../ingest/backfill.js';
import type { JobRunner } from '../jobs/runner.js';
import type { JobScheduler } from '../jobs/scheduler.js';
import { type JobHandlerResult, type JobRecord, jobFailure } from '../jobs/types.js';
import { listActiveWorkspaces, runUnifiedMaintenance } from '../service/index.js';
import type { Db } from '../types.js';
import { isResolvedScopeExcluded, resolveRuntimeScope } from './scope-resolver.js';

export const PLUGIN_JOB_KINDS = [
  'distill',
  'reflect',
  'consolidate',
  'maintain',
  'curate',
  'evolve',
  'repair',
  'backfill',
] as const;

export type ParsedJobPayload =
  | { ok: true; payload: Record<string, any> }
  | { ok: false; failure: Extract<JobHandlerResult, { action: 'failed' }> };

/**
 * 安全解析任务 JSON 载荷：格式损坏时返回不可重试失败，避免无意义重试消耗队列与配额
 */
export function parseJobPayload(
  job: Pick<JobRecord, 'payload'> | null | undefined
): ParsedJobPayload {
  if (!job?.payload || !job.payload.trim()) {
    return { ok: true, payload: {} };
  }
  try {
    const parsed = JSON.parse(job.payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        failure: { action: 'failed', nonRetryable: true, error: 'malformed_payload' },
      };
    }
    return { ok: true, payload: parsed as Record<string, any> };
  } catch {
    return {
      ok: false,
      failure: { action: 'failed', nonRetryable: true, error: 'malformed_payload' },
    };
  }
}

function isDeadlineExceeded(deadline?: number): boolean {
  return typeof deadline === 'number' && Number.isFinite(deadline) && Date.now() >= deadline;
}

function composeDeadlineSignal(signal: AbortSignal, deadline?: number): AbortSignal {
  if (signal.aborted) return signal;
  if (typeof deadline === 'number' && Number.isFinite(deadline)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return AbortSignal.abort('job_deadline_exceeded');
    }
    if (remainingMs < 2_147_483_647) {
      const timeoutSig = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)));
      return AbortSignal.any([signal, timeoutSig]);
    }
  }
  return signal;
}

const BENIGN_MAINTAIN_CURATE_SKIPS = new Set([
  'disabled',
  'privacy_offline_consent_required',
  'workspace_excluded',
  'aborted',
  'job_deadline_exceeded',
  'deadline_exceeded',
]);

export interface PluginJobHandlerDeps {
  db: Db;
  ctx?: any;
  getLiveCfg: () => PluginConfig;
  scheduler?: Pick<JobScheduler, 'enqueue'>;
  dbPath?: string;
}

/**
 * 将插件全部后台任务处理器注册到实例隔离的 JobRunner 上（绝不修改全局 defaultJobRunner）
 */
export function registerPluginJobHandlers(
  runner: JobRunner,
  deps: PluginJobHandlerDeps
): () => void {
  const { db, ctx, getLiveCfg, scheduler, dbPath } = deps;

  // 1. distill
  runner.registerHandler('distill', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const payload = parsed.payload;
    const scope = resolveRuntimeScope(
      ctx,
      db,
      {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        workspaceId: payload.workspaceId,
      },
      { allowCwdFallback: false }
    );
    if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, db)) {
      return { action: 'skipped', nonRetryable: true, reason: 'workspace_excluded' };
    }

    const cwd = scope.workspacePath || scope.cwd || undefined;
    const res = await distillSession(db, liveCfg, {
      sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      cwd,
      signal,
      jobDeadline: deadline,
    });
    if (!res.success) {
      return jobFailure(res.error || 'distill_failed');
    }

    if (res.sessionId && res.consumedCount > 0 && scheduler) {
      const nextBatch = findEligibleDistillSession(db, liveCfg, true, res.sessionId);
      if (nextBatch) {
        scheduler.enqueue('distill', `${nextBatch.sessionId}:seq:${nextBatch.minSeq}`, {
          sessionId: nextBatch.sessionId,
          ...(cwd ? { cwd } : {}),
          ...(nextBatch.workspaceId ? { workspaceId: nextBatch.workspaceId } : {}),
        });
      }
    }
    return { action: 'done' };
  });

  // 2. reflect
  runner.registerHandler('reflect', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }
    const liveCfg = getLiveCfg();
    const effectiveSignal = composeDeadlineSignal(signal, deadline);
    return runReflectJob(db, liveCfg, job, effectiveSignal);
  });

  // 3. consolidate (集群间检查 signal.aborted + 单簇错误隔离 + 始终执行零网络 Hindsight Reflect)
  runner.registerHandler('consolidate', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const payload = parsed.payload;
    const scope = resolveRuntimeScope(
      ctx,
      db,
      {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        workspaceId: payload.workspaceId,
      },
      { allowCwdFallback: false }
    );
    if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, db)) {
      return { action: 'skipped', nonRetryable: true, reason: 'workspace_excluded' };
    }

    const targetWsIds = scope.workspaceId
      ? [scope.workspaceId]
      : listActiveWorkspaces(db, liveCfg).map((w) => w.workspaceId);

    const effectiveSignal = composeDeadlineSignal(signal, deadline);
    let firstFailure: JobHandlerResult | null = null;
    let budgetSkipped: JobHandlerResult | null = null;
    let anySucceeded = false;

    for (const wsId of targetWsIds) {
      if (signal.aborted || isDeadlineExceeded(deadline)) {
        break;
      }

      const clusters = findConsolidationClusters(db, wsId, liveCfg);
      for (const c of clusters) {
        if (signal.aborted || isDeadlineExceeded(deadline)) {
          break;
        }
        try {
          const clusterOpts: Parameters<typeof consolidateCluster>[3] & { jobDeadline?: number } = {
            signal: effectiveSignal,
            jobDeadline: deadline,
          };
          const res = await consolidateCluster(db, liveCfg, c, clusterOpts);
          if (!res.success) {
            const mapped = jobFailure(res.error || 'consolidate_failed');
            if (mapped.action === 'skipped') {
              budgetSkipped = mapped;
              break;
            }
            if (!firstFailure) {
              firstFailure = mapped;
            }
          } else {
            anySucceeded = true;
          }
        } catch (err: any) {
          if (!firstFailure) {
            firstFailure = jobFailure(err?.message || 'consolidate_failed');
          }
        }
      }

      // 即使单个集群失败或配额耗尽，仍执行零网络开销的确定性跨网络心智模型合成
      if (!signal.aborted && !isDeadlineExceeded(deadline)) {
        try {
          runHindsightReflect(db, {
            workspaceId: wsId,
            autoSynthesize: true,
            minClusterSize: 3,
            persistCalibration: true,
            excludeWorkspaces: liveCfg.excludeWorkspaces,
          });
        } catch {}
      }

      if (budgetSkipped) {
        break;
      }
    }

    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }
    if (budgetSkipped) {
      return budgetSkipped;
    }
    if (firstFailure && !anySucceeded) {
      return firstFailure;
    }
    return { action: 'done' };
  });

  // 4. maintain (委托统一维护管线 runUnifiedMaintenance)
  runner.registerHandler('maintain', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const payload = parsed.payload;
    const scope = resolveRuntimeScope(
      ctx,
      db,
      {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        workspaceId: payload.workspaceId,
      },
      { allowCwdFallback: false }
    );
    if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, db)) {
      return { action: 'skipped', nonRetryable: true, reason: 'workspace_excluded' };
    }

    const maintRes = await runUnifiedMaintenance(db, {
      workspaceId: scope.workspaceId || undefined,
      workspacePath: scope.workspacePath,
      cfg: liveCfg,
      signal,
      deadline,
      runLlmCurate: true,
      runRemoteEmbeddings: isRemoteEmbeddingEnabled(liveCfg),
      runBackup: true,
      backupOncePerDay: true,
      runSentinel: true,
      dbFilePath: dbPath ?? db.filePath,
    });

    // 若线上自动收割样本 (eval_cases.suite = 'harvested') 新增达到阈值，自动排队策略进化任务
    if (scheduler && !signal.aborted && !isDeadlineExceeded(deadline)) {
      try {
        const sampleCnt =
          db.get<{ cnt: number }>(
            "SELECT COUNT(*) as cnt FROM eval_cases WHERE suite = 'harvested'"
          )?.cnt || 0;
        const lastRow = db.get<{ value: string }>(
          "SELECT value FROM meta WHERE key = 'lab.last_evolved_harvest_count'"
        );
        const lastCnt = lastRow ? Number(lastRow.value) || 0 : 0;
        if (sampleCnt >= 5 && sampleCnt >= lastCnt + 5) {
          const bucket6h = Math.floor(Date.now() / (6 * 3600_000));
          scheduler.enqueue('evolve', `auto_evolve:${bucket6h}:n${sampleCnt}`, { auto: true });
        }
      } catch {}
    }

    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    // 本地维护已完成时，若仅因 privacy_offline_consent_required / disabled / workspace_excluded 跳过 LLM 策展，仍返回 done
    if (
      !maintRes.curated.ran &&
      maintRes.curated.skippedReason &&
      !BENIGN_MAINTAIN_CURATE_SKIPS.has(maintRes.curated.skippedReason)
    ) {
      return jobFailure(maintRes.curated.skippedReason);
    }

    return { action: 'done' };
  });

  // 5. curate (兼容显式单步 LLM 策展任务)
  runner.registerHandler('curate', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const payload = parsed.payload;
    const scope = resolveRuntimeScope(
      ctx,
      db,
      {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        workspaceId: payload.workspaceId,
      },
      { allowCwdFallback: false }
    );
    if (scope.resolved && isResolvedScopeExcluded(scope, liveCfg.excludeWorkspaces, db)) {
      return { action: 'skipped', nonRetryable: true, reason: 'workspace_excluded' };
    }

    const effectiveSignal = composeDeadlineSignal(signal, deadline);
    const curateOpts: Parameters<typeof curateMemoriesWithLLM>[2] & { jobDeadline?: number } = {
      workspaceId: scope.workspaceId || undefined,
      cwd: scope.workspacePath,
      signal: effectiveSignal,
      jobDeadline: deadline,
    };
    const res = await curateMemoriesWithLLM(db, liveCfg, curateOpts);
    if (!res.ok) {
      return jobFailure(res.error || 'curate_failed');
    }
    return { action: 'done' };
  });

  // 6. repair
  runner.registerHandler('repair', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const effectiveSignal = composeDeadlineSignal(signal, deadline);
    const repairOpts: Parameters<typeof executeRepair>[2] & { jobDeadline?: number } = {
      signal: effectiveSignal,
      jobDeadline: deadline,
    };
    return executeRepair(
      db,
      { id: job.id, key: job.key, payload: job.payload || '{}' },
      repairOpts,
      liveCfg
    );
  });

  // 7. evolve
  runner.registerHandler('evolve', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    runStrategyEvolution(db, {}, liveCfg);
    try {
      const sampleCnt =
        db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM eval_cases WHERE suite = 'harvested'")
          ?.cnt || 0;
      db.run(
        `INSERT INTO meta (key, value) VALUES ('lab.last_evolved_harvest_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(sampleCnt)]
      );
    } catch {}
    return { action: 'done' };
  });

  // 8. backfill
  runner.registerHandler('backfill', async (job, signal, deadline) => {
    const parsed = parseJobPayload(job);
    if (!parsed.ok) return parsed.failure;
    if (signal.aborted || isDeadlineExceeded(deadline)) {
      return { action: 'failed', nonRetryable: true, error: 'job_timeout_aborted' };
    }

    const liveCfg = getLiveCfg();
    const payload = parsed.payload;
    runBackfill(db, {
      dryRun: Boolean(payload.dryRun),
      force: Boolean(payload.force),
      sessionsDir: typeof payload.sessionsDir === 'string' ? payload.sessionsDir : undefined,
      filePaths: Array.isArray(payload.filePaths)
        ? payload.filePaths.filter((p: unknown): p is string => typeof p === 'string')
        : undefined,
      cfg: liveCfg,
    });
    return { action: 'done' };
  });

  return () => {
    for (const kind of PLUGIN_JOB_KINDS) {
      runner.unregisterHandler(kind);
    }
  };
}
