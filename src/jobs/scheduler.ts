import type { PluginConfig } from '../config.js';
import { recoverReservedToUnknown } from '../evolution/ledger.js';
import type { Db } from '../types.js';
import { defaultJobRunner, type JobRunner } from './runner.js';

export interface EnqueueJobParams {
  kind: string;
  key: string;
  payload?: any;
  now?: number;
}

export interface RecoverJobsOptions {
  staleThresholdMs?: number;
  recoverAll?: boolean;
}

export interface JobSchedulerOptions {
  runner?: JobRunner;
  idleMs?: number;
}

/** 终态失败的任务在此冷却期内不因同键再次入队而复活 */
export const FAILED_REQUEUE_COOLDOWN_MS = 3600_000;

const DEFAULT_IDLE_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_HEARTBEAT_SLICE_MS = 60_000;
const BUSY_RETRY_DELAY_MS = 1_000;
const DB_ERROR_RETRY_DELAY_MS = 5_000;
const DEFAULT_STALE_RUNNING_MS = 300_000;

/**
 * 幂等将离线任务入队 (kind + key 唯一约束)
 * 失败任务的键在输入未变时保持不变（如 distill 水位线键），若每次入队都立即复活，
 * 同一份无法解析的输入会在每轮对话后重发并耗尽当日配额，因此需经过冷却期。
 */
export function enqueueJob(db: Db, params: EnqueueJobParams): boolean {
  const now = params.now ?? Date.now();
  const payloadStr = params.payload ? JSON.stringify(params.payload) : null;

  const res = db.run(
    `INSERT INTO jobs (kind, key, payload, status, attempts, created_at, next_eligible_at)
     VALUES (?, ?, ?, 'queued', 0, ?, 0)
     ON CONFLICT(kind, key) DO UPDATE SET
       status = 'queued',
       attempts = 0,
       payload = excluded.payload,
       created_at = excluded.created_at,
       next_eligible_at = 0,
       error = NULL
     WHERE jobs.status = 'done'
        OR (jobs.status = 'failed' AND COALESCE(jobs.finished_at, 0) <= excluded.created_at - ?)`,
    [params.kind, params.key, payloadStr, now, FAILED_REQUEUE_COOLDOWN_MS]
  );

  return Number(res.changes) > 0;
}

/**
 * 启动时恢复：仅将超过陈旧阈值（默认 5 分钟）的僵尸 running 任务恢复为 failed，
 * 避免多窗口并行启动时误杀兄弟进程仍在执行的合法任务；同时将 ledger reserved 转为 unknown。
 */
export function recoverJobsOnStartup(
  db: Db,
  now: number = Date.now(),
  staleThresholdOrOptions: number | RecoverJobsOptions = DEFAULT_STALE_RUNNING_MS
): { recoveredJobs: number; recoveredLedger: number } {
  const opts: RecoverJobsOptions =
    typeof staleThresholdOrOptions === 'number'
      ? { staleThresholdMs: staleThresholdOrOptions }
      : staleThresholdOrOptions;
  const staleThresholdMs = Math.max(0, opts.staleThresholdMs ?? DEFAULT_STALE_RUNNING_MS);
  const recoverAll = opts.recoverAll ?? false;

  const jobRes = recoverAll
    ? db.run(
        `UPDATE jobs
         SET status = 'failed',
             error = 'recovered_from_running_on_restart',
             finished_at = ?
         WHERE status = 'running'`,
        [now]
      )
    : db.run(
        `UPDATE jobs
         SET status = 'failed',
             error = 'recovered_from_running_on_restart',
             finished_at = ?
         WHERE status = 'running'
           AND (started_at IS NULL OR started_at < ?)`,
        [now, now - staleThresholdMs]
      );

  const recoveredJobs = Number(jobRes.changes);
  const recoveredLedger = recoverReservedToUnknown(db, now);

  return { recoveredJobs, recoveredLedger };
}

export class JobScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<number>;
  private idleMs: number;
  private idleUntil: number;
  private isStopped = false;
  private rescheduleRequested = false;
  private bypassIdleInActiveCycle = false;
  private db: Db;
  private cfg: PluginConfig;
  private runner: JobRunner;

  constructor(db: Db, cfg: PluginConfig, options: JobSchedulerOptions = {}) {
    this.db = db;
    this.cfg = cfg;
    this.runner = options.runner ?? defaultJobRunner;

    if (
      typeof options.idleMs === 'number' &&
      Number.isFinite(options.idleMs) &&
      options.idleMs >= 0
    ) {
      this.idleMs = Math.min(options.idleMs, MAX_TIMER_MS);
    } else if (
      typeof cfg.idleMinutes === 'number' &&
      Number.isFinite(cfg.idleMinutes) &&
      cfg.idleMinutes > 0
    ) {
      this.idleMs = Math.min(cfg.idleMinutes * 60_000, MAX_TIMER_MS);
    } else {
      this.idleMs = DEFAULT_IDLE_MS;
    }

    this.idleUntil = Date.now() + this.idleMs;
    this.schedulePending();
  }

  /**
   * 将任务入队 (幂等) 并唤醒调度器
   */
  enqueue(kind: string, key: string, payload?: any): boolean {
    if (this.isStopped) return false;
    const enqueued = enqueueJob(this.db, { kind, key, payload });
    this.notifyPending();
    return enqueued;
  }

  /**
   * 供外部生产者（如 IngestQueue 规则抽取）在新任务写入后主动唤醒调度器
   */
  notifyPending(): void {
    if (this.isStopped) return;
    if (this.activeCycle) {
      this.rescheduleRequested = true;
      return;
    }
    this.schedulePending();
  }

  /**
   * 立即触发一次离线任务消化循环（绕过 idleUntil 静默等待）
   */
  async triggerNow(): Promise<number> {
    if (this.isStopped) return 0;
    this.idleUntil = 0;
    return this.runCycle(false);
  }

  private runCycle(respectIdle: boolean): Promise<number> {
    if (this.isStopped) return Promise.resolve(0);
    if (this.activeCycle) {
      this.rescheduleRequested = true;
      if (!respectIdle) {
        this.bypassIdleInActiveCycle = true;
      }
      return this.activeCycle;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    this.rescheduleRequested = false;
    this.bypassIdleInActiveCycle = !respectIdle;

    const cycle = Promise.resolve()
      .then(async () => {
        let executed = 0;
        while (!this.isStopped) {
          if (!this.bypassIdleInActiveCycle && Date.now() < this.idleUntil) {
            break;
          }
          const ran = await this.runner.runNextJob(this.db, this.cfg);
          if (!ran) {
            // 若在上一轮检查期间有新任务通知且 runner 未被占用，再补查一轮以消除微任务竞态
            if (this.rescheduleRequested && !this.runner.isBusy()) {
              this.rescheduleRequested = false;
              continue;
            }
            break;
          }
          executed++;
        }
        return executed;
      })
      .finally(() => {
        if (this.activeCycle === cycle) {
          this.activeCycle = undefined;
          this.bypassIdleInActiveCycle = false;
        }
        this.rescheduleRequested = false;
        if (!this.isStopped) {
          this.schedulePending();
        }
      });

    this.activeCycle = cycle;
    return cycle;
  }

  private scheduleSelfHealRetry(): void {
    if (this.isStopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.isStopped) {
        this.schedulePending();
      }
    }, DB_ERROR_RETRY_DELAY_MS);
    this.timer.unref?.();
  }

  private schedulePending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.isStopped || this.activeCycle) return;

    let next: number | null | undefined;
    try {
      next = this.db.get<{ due: number | null }>(
        "SELECT MIN(next_eligible_at) AS due FROM jobs WHERE status IN ('queued', 'skipped')"
      )?.due;
    } catch (err: any) {
      if (this.isStopped) return;
      console.warn(
        '[dsh-memory] JobScheduler schedulePending DB error, retrying in 5s:',
        err?.message || err
      );
      this.scheduleSelfHealRetry();
      return;
    }

    if (next == null) return;

    const now = Date.now();
    const target = Math.max(next, this.idleUntil);
    // 已到点但因忙锁遗留时等待至少 1s 防自旋；未来时刻按 60s 心跳切片，确保系统休眠唤醒后迅速补追且不越过精确截止时刻
    const delay =
      target <= now
        ? BUSY_RETRY_DELAY_MS
        : Math.min(MAX_HEARTBEAT_SLICE_MS, Math.min(MAX_TIMER_MS, target - now));

    this.timer = setTimeout(async () => {
      this.timer = undefined;
      if (this.isStopped) return;

      const currentNow = Date.now();
      if (currentNow < this.idleUntil) {
        this.schedulePending();
        return;
      }

      let currentDue: number | null | undefined;
      try {
        currentDue = this.db.get<{ due: number | null }>(
          "SELECT MIN(next_eligible_at) AS due FROM jobs WHERE status IN ('queued', 'skipped')"
        )?.due;
      } catch (err: any) {
        if (this.isStopped) return;
        console.warn(
          '[dsh-memory] JobScheduler heartbeat DB error, retrying in 5s:',
          err?.message || err
        );
        this.scheduleSelfHealRetry();
        return;
      }

      if (currentDue == null) return;
      if (currentNow < currentDue) {
        // 中间 60s 心跳切片，尚未到达实际执行时刻，继续切片等待
        this.schedulePending();
        return;
      }

      try {
        await this.runCycle(true);
      } catch (err: any) {
        console.warn('[dsh-memory] scheduled job cycle failed:', err?.message || err);
      }
    }, delay);
    this.timer.unref?.();
  }

  /**
   * turn-stopping 延迟静默窗口后触发（默认遵循 cfg.idleMinutes / options.idleMs）
   */
  scheduleTurnStopping(): void {
    if (this.isStopped) return;
    this.idleUntil = Date.now() + this.idleMs;
    if (!this.activeCycle) {
      this.schedulePending();
    }
  }

  /**
   * 停止调度器，向运行中任务发出优雅关闭中止信号并清除定时器
   */
  stop(): void {
    this.isStopped = true;
    this.rescheduleRequested = false;
    this.runner.abortRunningJob('shutdown');
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async stopAndWait(graceMs: number = 10_000): Promise<void> {
    const started = Date.now();
    this.stop();
    await this.runner.abortAndAwaitRunningJob(graceMs, 'shutdown');
    const cycle = this.activeCycle;
    if (!cycle) return;
    const remainingMs = Math.max(0, graceMs - (Date.now() - started));
    if (remainingMs === 0) return;

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cycle.catch(() => {}),
        new Promise<void>((resolve) => {
          watchdog = setTimeout(resolve, remainingMs);
          watchdog.unref?.();
        }),
      ]);
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
    }
  }
}
