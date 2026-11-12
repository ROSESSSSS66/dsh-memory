import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import { runNextJob, abortRunningJob, abortAndAwaitRunningJob } from './runner.js';
import { recoverReservedToUnknown } from '../evolution/ledger.js';

export interface EnqueueJobParams {
  kind: string;
  key: string;
  payload?: any;
  now?: number;
}

/** 终态失败的任务在此冷却期内不因同键再次入队而复活 */
export const FAILED_REQUEUE_COOLDOWN_MS = 3600_000;

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
 * 启动时恢复：将上次运行残留的 running 任务恢复为 failed，并将 ledger reserved 转为 unknown
 */
export function recoverJobsOnStartup(
  db: Db,
  now: number = Date.now()
): { recoveredJobs: number; recoveredLedger: number } {
  const jobRes = db.run(
    `UPDATE jobs
     SET status = 'failed',
         error = 'recovered_from_running_on_restart',
         finished_at = ?
     WHERE status = 'running'`,
    [now]
  );

  const recoveredJobs = Number(jobRes.changes);
  const recoveredLedger = recoverReservedToUnknown(db, now);

  return { recoveredJobs, recoveredLedger };
}

export class JobScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private activeCycle?: Promise<number>;
  private idleUntil = Date.now() + 30_000;
  private isStopped = false;
  private db: Db;
  private cfg: PluginConfig;

  constructor(db: Db, cfg: PluginConfig) {
    this.db = db;
    this.cfg = cfg;
    this.schedulePending();
  }

  /**
   * 将任务入队 (幂等)
   */
  enqueue(kind: string, key: string, payload?: any): boolean {
    if (this.isStopped) return false;
    const enqueued = enqueueJob(this.db, { kind, key, payload });
    this.schedulePending();
    return enqueued;
  }

  /**
   * 立即触发一次离线任务消化循环
   */
  async triggerNow(): Promise<number> {
    if (this.isStopped) return 0;
    if (this.activeCycle) return this.activeCycle;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.idleUntil = 0;
    this.activeCycle = Promise.resolve().then(async () => {
      let executed = 0;
      while (!this.isStopped) {
        const ran = await runNextJob(this.db, this.cfg);
        if (!ran) break;
        executed++;
      }
      return executed;
    }).finally(() => {
      this.activeCycle = undefined;
      this.schedulePending();
    });
    return this.activeCycle;
  }

  private schedulePending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.isStopped || this.activeCycle) return;
    const next = this.db.get<{ due: number | null }>(
      "SELECT MIN(next_eligible_at) AS due FROM jobs WHERE status IN ('queued', 'skipped')"
    )?.due;
    if (next == null) return;
    // A busy global runner may leave an already-eligible job. Avoid a tight polling loop.
    const delay = Math.min(2_147_483_647, Math.max(1_000, Math.max(next, this.idleUntil) - Date.now()));
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try {
        await this.triggerNow();
      } catch (err: any) {
        console.warn('[dsh-memory] scheduled job cycle failed:', err?.message || err);
      }
    }, delay);
    this.timer.unref?.();
  }

  /**
   * turn-stopping 延迟 30s 触发
   */
  scheduleTurnStopping(): void {
    if (this.isStopped) return;
    this.idleUntil = Date.now() + 30_000;
    this.schedulePending();
  }

  /**
   * 停止调度器，清除所有未触发定时器
   */
  stop(): void {
    this.isStopped = true;
    abortRunningJob();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  async stopAndWait(): Promise<void> {
    this.stop();
    await abortAndAwaitRunningJob();
    await this.activeCycle?.catch(() => {});
  }
}
