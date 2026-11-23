import type { PluginConfig } from '../config.js';
import { redactSecrets } from '../core/privacy.js';
import type { Db } from '../types.js';
import type { JobHandler, JobHandlerResult, JobKind, JobRecord } from './types.js';

export type AbortReason = 'timeout' | 'shutdown';

const MAX_JOB_ATTEMPTS = 3;
const MAX_SKIP_DEFERRALS = 14;
const MIN_STALE_RUNNING_MS = 300_000;
const SKIP_COUNT_META_PREFIX = 'job_skip_count:';

export function getNextDayStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 1, 0);
  return d.getTime();
}

export function getBackoffMs(attempts: number): number {
  if (attempts <= 1) return 60_000; // 1 分钟
  return 600_000; // 10 分钟
}

function readSkipCount(db: Db, jobId: number): number {
  try {
    const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      `${SKIP_COUNT_META_PREFIX}${jobId}`,
    ]);
    const parsed = row ? parseInt(row.value, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSkipCount(db: Db, jobId: number, count: number): void {
  try {
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      `${SKIP_COUNT_META_PREFIX}${jobId}`,
      String(count),
    ]);
  } catch {}
}

function clearSkipCount(db: Db, jobId: number): void {
  try {
    db.run('DELETE FROM meta WHERE key = ?', [`${SKIP_COUNT_META_PREFIX}${jobId}`]);
  } catch {}
}

type ClaimOutcome =
  | { kind: 'none' }
  | { kind: 'no_handler' }
  | { kind: 'claimed'; job: JobRecord; handler: JobHandler; newAttempts: number };

/**
 * 实例隔离的离线任务执行器：支持多插件实例/多测试完全隔离，
 * 具备原子抢占、僵尸 running 回收、超时/优雅关闭区分、硬关闭看门狗及跳过次数上限控制。
 */
export class JobRunner {
  private handlers = new Map<JobKind, JobHandler>();
  private isRunning = false;
  private activeController: AbortController | null = null;
  private activePromise: Promise<boolean> | null = null;
  private abortReason: AbortReason | null = null;

  public registerHandler(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  public unregisterHandler(kind: JobKind): void {
    this.handlers.delete(kind);
  }

  public clearHandlers(): void {
    this.handlers.clear();
  }

  public isBusy(): boolean {
    return this.isRunning;
  }

  private getAbortReason(): AbortReason | null {
    return this.abortReason;
  }

  public abortRunningJob(reason: AbortReason = 'shutdown'): void {
    if (!this.isRunning) return;
    if (!this.abortReason) {
      this.abortReason = reason;
    }
    if (this.activeController && !this.activeController.signal.aborted) {
      try {
        this.activeController.abort(reason);
      } catch {}
    }
  }

  public async abortAndAwaitRunningJob(
    graceMs: number = 10_000,
    reason: AbortReason = 'shutdown'
  ): Promise<void> {
    this.abortRunningJob(reason);
    const pending = this.activePromise;
    if (!pending) return;

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending.catch(() => {}),
        new Promise<void>((resolve) => {
          watchdog = setTimeout(resolve, Math.max(0, graceMs));
          watchdog.unref?.();
        }),
      ]);
    } finally {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
      }
    }
  }

  /**
   * 运行单个就绪任务
   * 严格保证：实例内互斥、事务内原子抢占、超时中止且等待收敛、
   * 优雅关闭放回 queued、预算不足跳过不消耗失败重试次数、非瞬时错误不重试。
   */
  public runNextJob(db: Db, cfg: PluginConfig, customNow?: number): Promise<boolean> {
    if (this.isRunning) {
      return Promise.resolve(false);
    }

    this.isRunning = true;
    this.abortReason = null;

    // 经由 Promise.resolve().then(...) 确保 activePromise 赋值永远先于 executeNextJob 与 finally 执行
    const tracked: Promise<boolean> = Promise.resolve()
      .then(() => this.executeNextJob(db, cfg, customNow))
      .finally(() => {
        if (this.activePromise === tracked) {
          this.activePromise = null;
          this.isRunning = false;
          this.abortReason = null;
        }
      });

    this.activePromise = tracked;
    return tracked;
  }

  private async executeNextJob(db: Db, cfg: PluginConfig, customNow?: number): Promise<boolean> {
    if (this.abortReason === 'shutdown') {
      return false;
    }

    const hasCustomNow = customNow !== undefined;
    const now = customNow ?? Date.now();
    const timeoutMs = cfg.jobTimeoutMs || 120_000;
    const staleThresholdMs = Math.max(timeoutMs * 2, MIN_STALE_RUNNING_MS);

    // 1. 事务内回收僵尸 running 任务并原子抢占下一条就绪任务
    const claimed: ClaimOutcome = db.transaction(() => {
      const staleCutoff = now - staleThresholdMs;

      db.run(
        `UPDATE jobs
         SET status = 'queued', started_at = NULL, next_eligible_at = 0, error = 'reclaimed_stale_running'
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ? AND attempts < ?`,
        [staleCutoff, MAX_JOB_ATTEMPTS]
      );
      db.run(
        `UPDATE jobs
         SET status = 'failed', finished_at = ?, error = 'stale_running_max_attempts'
         WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ? AND attempts >= ?`,
        [now, staleCutoff, MAX_JOB_ATTEMPTS]
      );

      const job = db.get<JobRecord>(
        `SELECT * FROM jobs
         WHERE (status = 'queued' AND next_eligible_at <= ?)
            OR (status = 'skipped' AND next_eligible_at <= ?)
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [now, now]
      );

      if (!job) {
        return { kind: 'none' };
      }

      const handler = this.handlers.get(job.kind);
      if (!handler) {
        db.run(
          `UPDATE jobs
           SET status = 'failed', error = ?, finished_at = ?
           WHERE id = ? AND status IN ('queued', 'skipped')`,
          [`no_handler_registered_for_kind_${job.kind}`, now, job.id]
        );
        clearSkipCount(db, job.id);
        return { kind: 'no_handler' };
      }

      const claimRes = db.run(
        `UPDATE jobs
         SET status = 'running', started_at = ?, attempts = attempts + 1
         WHERE id = ? AND status IN ('queued', 'skipped')`,
        [now, job.id]
      );

      if (Number(claimRes.changes) !== 1) {
        return { kind: 'none' };
      }

      return {
        kind: 'claimed',
        job,
        handler,
        newAttempts: job.attempts + 1,
      };
    });

    if (claimed.kind === 'none') {
      return false;
    }
    if (claimed.kind === 'no_handler') {
      return true;
    }

    const { job, handler, newAttempts } = claimed;

    // 2. 设置执行超时 (默认 120s)，并传递绝对 deadline 给 handler
    const jobDeadline = now + timeoutMs;
    const controller = new AbortController();
    this.activeController = controller;
    let isTimedOut = false;

    const timer = setTimeout(() => {
      isTimedOut = true;
      if (!this.abortReason) {
        this.abortReason = 'timeout';
      }
      try {
        controller.abort('timeout');
      } catch {}
    }, timeoutMs);
    timer.unref?.();

    let result: JobHandlerResult = { action: 'failed', error: 'unknown_handler_error' };
    try {
      result = await handler(job, controller.signal, jobDeadline);
    } catch (err: any) {
      const errMsg = err?.message || 'unknown_handler_error';
      const abortReason = this.getAbortReason();
      if (abortReason === 'shutdown' && !isTimedOut) {
        // 优雅关闭在下方统一将任务放回 queued
      } else if (isTimedOut || abortReason === 'timeout' || controller.signal.aborted) {
        result = { action: 'failed', error: 'job_timeout_aborted', nonRetryable: true };
      } else {
        const lowerErr = errMsg.toLowerCase();
        const isNonRetryable =
          err instanceof SyntaxError ||
          lowerErr.includes('parse') ||
          lowerErr.includes('schema') ||
          lowerErr.includes('invalid') ||
          lowerErr.includes('quote');
        result = { action: 'failed', error: errMsg, nonRetryable: isNonRetryable };
      }
    } finally {
      clearTimeout(timer);
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }

    // 3. 优雅关闭中断：放回 queued 且恢复 attempts，不将任务误判为永久失败
    const finalAbortReason = this.getAbortReason();
    if (finalAbortReason === 'shutdown' && !isTimedOut) {
      try {
        db.run(
          `UPDATE jobs
           SET status = 'queued', attempts = ?, started_at = NULL, next_eligible_at = 0
           WHERE id = ? AND status = 'running'`,
          [job.attempts, job.id]
        );
      } catch {}
      return true;
    }

    if (isTimedOut || finalAbortReason === 'timeout' || controller.signal.aborted) {
      result = { action: 'failed', error: 'job_timeout_aborted', nonRetryable: true };
    }

    // 4. 时钟一致性：若调用方显式注入 now 则沿用注入时钟，否则取单调不倒退的当前时钟
    const finishedTime = hasCustomNow ? now : Math.max(now, Date.now());

    // 5. 根据执行结果更新 job 状态
    if (result.action === 'done') {
      db.run(`UPDATE jobs SET status = 'done', error = NULL, finished_at = ? WHERE id = ?`, [
        finishedTime,
        job.id,
      ]);
      clearSkipCount(db, job.id);
    } else if (result.action === 'skipped') {
      const cleanErr = redactSecrets(result.reason).text;
      if (result.nonRetryable) {
        // 终态跳过：保留原因备查并收尾，不消耗失败重试计数
        db.run(
          `UPDATE jobs SET status = 'done', attempts = ?, error = ?, finished_at = ? WHERE id = ?`,
          [job.attempts, cleanErr, finishedTime, job.id]
        );
        clearSkipCount(db, job.id);
      } else {
        const deferrals = readSkipCount(db, job.id) + 1;
        if (deferrals >= MAX_SKIP_DEFERRALS) {
          db.run(
            `UPDATE jobs SET status = 'failed', attempts = ?, error = ?, finished_at = ? WHERE id = ?`,
            [job.attempts, `max_deferrals_exceeded:${cleanErr}`, finishedTime, job.id]
          );
          clearSkipCount(db, job.id);
        } else {
          const nextEligible = result.nextEligibleAt ?? getNextDayStartMs(finishedTime);
          // 跳过（如每日预算耗尽）还原 attempts，避免连续数日跳过耗尽 3 次真实失败重试额度
          db.run(
            `UPDATE jobs SET status = 'skipped', attempts = ?, next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
            [job.attempts, nextEligible, cleanErr, finishedTime, job.id]
          );
          writeSkipCount(db, job.id, deferrals);
        }
      }
    } else if (result.action === 'failed') {
      const cleanErr = redactSecrets(result.error).text;
      if (result.nonRetryable || newAttempts >= MAX_JOB_ATTEMPTS) {
        db.run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, [
          cleanErr,
          finishedTime,
          job.id,
        ]);
        clearSkipCount(db, job.id);
      } else {
        const backoff = getBackoffMs(newAttempts);
        db.run(
          `UPDATE jobs SET status = 'queued', next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
          [finishedTime + backoff, cleanErr, finishedTime, job.id]
        );
      }
    } else if (result.action === 'retry') {
      const cleanErr = redactSecrets(result.error).text;
      if (newAttempts >= MAX_JOB_ATTEMPTS) {
        db.run(`UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, [
          cleanErr,
          finishedTime,
          job.id,
        ]);
        clearSkipCount(db, job.id);
      } else {
        const backoff = getBackoffMs(newAttempts);
        db.run(
          `UPDATE jobs SET status = 'queued', next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
          [finishedTime + backoff, cleanErr, finishedTime, job.id]
        );
      }
    }

    return true;
  }
}

export const defaultJobRunner = new JobRunner();

export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  defaultJobRunner.registerHandler(kind, handler);
}

export function unregisterJobHandler(kind: JobKind): void {
  defaultJobRunner.unregisterHandler(kind);
}

export function clearJobHandlers(): void {
  defaultJobRunner.clearHandlers();
}

export function isRunnerBusy(): boolean {
  return defaultJobRunner.isBusy();
}

export function abortRunningJob(reason: AbortReason = 'shutdown'): void {
  defaultJobRunner.abortRunningJob(reason);
}

export async function abortAndAwaitRunningJob(
  graceMs: number = 10_000,
  reason: AbortReason = 'shutdown'
): Promise<void> {
  return defaultJobRunner.abortAndAwaitRunningJob(graceMs, reason);
}

export async function runNextJob(db: Db, cfg: PluginConfig, now?: number): Promise<boolean> {
  return defaultJobRunner.runNextJob(db, cfg, now);
}
