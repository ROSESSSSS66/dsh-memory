import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import { runNextJob } from './runner.js';
import { recoverReservedToUnknown } from '../evolution/ledger.js';

export interface EnqueueJobParams {
  kind: string;
  key: string;
  payload?: any;
  now?: number;
}

/**
 * 幂等将离线任务入队 (kind + key 唯一约束)
 */
export function enqueueJob(db: Db, params: EnqueueJobParams): boolean {
  const now = params.now ?? Date.now();
  const payloadStr = params.payload ? JSON.stringify(params.payload) : null;

  const res = db.run(
    `INSERT INTO jobs (kind, key, payload, status, attempts, created_at, next_eligible_at)
     VALUES (?, ?, ?, 'queued', 0, ?, 0)
     ON CONFLICT(kind, key) DO NOTHING`,
    [params.kind, params.key, payloadStr, now]
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
  private timers: Set<ReturnType<typeof setTimeout>> = new Set();
  private isStopped = false;
  private db: Db;
  private cfg: PluginConfig;

  constructor(db: Db, cfg: PluginConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  /**
   * 将任务入队 (幂等)
   */
  enqueue(kind: string, key: string, payload?: any): boolean {
    return enqueueJob(this.db, { kind, key, payload });
  }

  /**
   * 立即触发一次离线任务消化循环
   */
  async triggerNow(): Promise<number> {
    if (this.isStopped) return 0;
    let executed = 0;
    while (!this.isStopped) {
      const ran = await runNextJob(this.db, this.cfg);
      if (!ran) break;
      executed++;
    }
    return executed;
  }

  /**
   * turn-stopping 延迟 30s 触发
   */
  scheduleTurnStopping(): void {
    if (this.isStopped) return;
    const timer = setTimeout(async () => {
      this.timers.delete(timer);
      await this.triggerNow();
    }, 30_000);
    this.timers.add(timer);
  }

  /**
   * 停止调度器，清除所有未触发定时器
   */
  stop(): void {
    this.isStopped = true;
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
  }
}
