import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { JobRecord, JobHandler, JobHandlerResult } from './types.js';
import { redactSecrets } from '../core/privacy.js';

const jobHandlers = new Map<string, JobHandler>();
let isJobRunning = false;
let activeJobController: AbortController | null = null;
let activeJobPromise: Promise<boolean> | null = null;

export function abortRunningJob(): void {
  if (activeJobController) {
    try { activeJobController.abort(); } catch {}
  }
}

export async function abortAndAwaitRunningJob(): Promise<void> {
  abortRunningJob();
  if (activeJobPromise) {
    try { await activeJobPromise; } catch {}
  }
}

export function registerJobHandler(kind: string, handler: JobHandler): void {
  jobHandlers.set(kind, handler);
}

export function unregisterJobHandler(kind: string): void {
  jobHandlers.delete(kind);
}

export function isRunnerBusy(): boolean {
  return isJobRunning;
}

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

/**
 * 运行单个就绪任务
 * 严格保证：全局互斥、超时中止且等待收敛、预算不足跳过次日恢复、非瞬时错误不重试
 */
export async function runNextJob(
  db: Db,
  cfg: PluginConfig,
  now: number = Date.now()
): Promise<boolean> {
  // 全局互斥锁检查：同一时刻只运行 1 个离线任务
  if (isJobRunning) {
    return false;
  }

  isJobRunning = true;
  const runInternal = async (): Promise<boolean> => {
  try {
    // 查找下一个就绪任务 (queued 且 next_eligible_at <= now，或 skipped 且到了次日恢复时间)
    const job = db.get<JobRecord>(
      `SELECT * FROM jobs
       WHERE (status = 'queued' AND next_eligible_at <= ?)
          OR (status = 'skipped' AND next_eligible_at <= ?)
       ORDER BY created_at ASC
       LIMIT 1`,
      [now, now]
    );

    if (!job) {
      return false;
    }

    const handler = jobHandlers.get(job.kind);
    if (!handler) {
      // 找不到 handler，标记为 failed
      db.run(
        `UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
        [`no_handler_registered_for_kind_${job.kind}`, now, job.id]
      );
      return true;
    }

    // 标记为 running 并递增 attempts
    const newAttempts = job.attempts + 1;
    db.run(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = ? WHERE id = ?`,
      [now, newAttempts, job.id]
    );

    // 设置执行超时 (默认 120s)
    const timeoutMs = cfg.jobTimeoutMs || 120_000;
    const controller = new AbortController();
    activeJobController = controller;
    let isTimedOut = false;
    const timer = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);

    let result: JobHandlerResult;
    try {
      // 执行任务并等待其完全收敛
      result = await handler(job, controller.signal);
    } catch (err: any) {
      const errMsg = err?.message || 'unknown_handler_error';
      if (isTimedOut || controller.signal.aborted) {
        result = { action: 'failed', error: 'job_timeout_aborted', nonRetryable: true };
      } else {
        // 判断是否为不可重试的解析/schema错误
        const isNonRetryable =
          errMsg.includes('parse') ||
          errMsg.includes('schema') ||
          errMsg.includes('invalid') ||
          errMsg.includes('quote');
        result = { action: 'failed', error: errMsg, nonRetryable: isNonRetryable };
      }
    } finally {
      clearTimeout(timer);
      if (activeJobController === controller) activeJobController = null;
    }

    if (isTimedOut || controller.signal.aborted) {
      result = { action: 'failed', error: 'job_timeout_aborted', nonRetryable: true };
    }

    const finishedTime = Date.now();

    // 根据执行结果更新 job 状态
    if (result.action === 'done') {
      db.run(
        `UPDATE jobs SET status = 'done', error = NULL, finished_at = ? WHERE id = ?`,
        [finishedTime, job.id]
      );
    } else if (result.action === 'skipped') {
      const nextEligible = result.nextEligibleAt ?? getNextDayStartMs(finishedTime);
      const cleanErr = redactSecrets(result.reason).text;
      db.run(
        `UPDATE jobs SET status = 'skipped', next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
        [nextEligible, cleanErr, finishedTime, job.id]
      );
    } else if (result.action === 'failed') {
      const cleanErr = redactSecrets(result.error).text;
      // 如果不可重试或已达到最大尝试次数 (最多 3 次)
      if (result.nonRetryable || newAttempts >= 3) {
        db.run(
          `UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
          [cleanErr, finishedTime, job.id]
        );
      } else {
        // 退避并重新排队
        const backoff = getBackoffMs(newAttempts);
        db.run(
          `UPDATE jobs SET status = 'queued', next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
          [finishedTime + backoff, cleanErr, finishedTime, job.id]
        );
      }
    } else if (result.action === 'retry') {
      const cleanErr = redactSecrets(result.error).text;
      if (newAttempts >= 3) {
        db.run(
          `UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
          [cleanErr, finishedTime, job.id]
        );
      } else {
        const backoff = getBackoffMs(newAttempts);
        db.run(
          `UPDATE jobs SET status = 'queued', next_eligible_at = ?, error = ?, finished_at = ? WHERE id = ?`,
          [finishedTime + backoff, cleanErr, finishedTime, job.id]
        );
      }
    }

    return true;
  } finally {
    isJobRunning = false;
    activeJobPromise = null;
  }
  };
  activeJobPromise = runInternal();
  return activeJobPromise;
}
