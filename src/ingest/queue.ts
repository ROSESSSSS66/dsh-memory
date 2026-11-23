import { DEFAULTS, type PluginConfig } from '../config.js';
import type { CommittedInjection } from '../dsh/memory-visibility.js';
import type { Db, RawEvent } from '../types.js';
import { runRules } from './rules.js';

/** 缓冲区上限：数据库长期不可写时防止内存无限增长 */
const MAX_BUFFERED_EVENTS = 5000;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const POISON_PILL_FAILURE_THRESHOLD = 3;

export interface IngestQueueOptions {
  batchSize?: number;
  flushIntervalMs?: number;
  onJobEnqueued?: () => void;
}

function sqlitePrimaryCode(err: any): number | null {
  if (err && typeof err.errcode === 'number' && Number.isFinite(err.errcode)) {
    return err.errcode & 0xff;
  }
  return null;
}

function isConstraintSqliteError(err: any): boolean {
  if (sqlitePrimaryCode(err) === 19) return true;
  const code = String(err?.code || '');
  const errstr = String(err?.errstr || '');
  return code.startsWith('SQLITE_CONSTRAINT') || errstr.startsWith('SQLITE_CONSTRAINT');
}

function isLockSqliteError(err: any): boolean {
  const primary = sqlitePrimaryCode(err);
  if (primary === 5 || primary === 6) return true;
  const text = `${err?.code || ''} ${err?.errstr || ''} ${err?.message || ''}`;
  return /SQLITE_(?:BUSY|LOCKED)|database(?: table)? is locked/i.test(text);
}

function isTransientSqliteError(err: any): boolean {
  const primary = sqlitePrimaryCode(err);
  // 5=SQLITE_BUSY, 6=SQLITE_LOCKED, 10=SQLITE_IOERR, 13=SQLITE_FULL
  if (primary === 5 || primary === 6 || primary === 10 || primary === 13) return true;
  const text = `${err?.code || ''} ${err?.errstr || ''} ${err?.message || ''}`;
  return /SQLITE_(?:BUSY|LOCKED|IOERR|FULL)|database(?: table)? is locked|disk I\/O error|database or disk is full/i.test(
    text
  );
}

export class IngestQueue {
  private db: Db;
  private cfg: PluginConfig;
  private buffer: Array<RawEvent | CommittedInjection> = [];
  private timer: NodeJS.Timeout | null = null;
  private batchSize: number;
  private flushIntervalMs: number;
  private onJobEnqueued?: () => void;
  private isFlushing = false;
  private thresholdFlushScheduled = false;
  private activeFlushPromise: Promise<number> | null = null;
  private consecutiveFailures = 0;
  private nextRetryAt = 0;
  private droppedCount = 0;
  private isClosed = false;

  constructor(db: Db, cfg: PluginConfig = DEFAULTS, options: IngestQueueOptions = {}) {
    this.db = db;
    this.cfg = cfg;
    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.flushIntervalMs = Math.max(10, options.flushIntervalMs ?? 2000);
    this.onJobEnqueued = options.onJobEnqueued;

    this.timer = setInterval(() => {
      if (this.isClosed || this.isFlushing || this.buffer.length === 0) return;
      if (Date.now() < this.nextRetryAt) return;
      this.flush().catch((err) => {
        console.warn('[dsh-memory] IngestQueue periodic flush error:', err?.message || err);
      });
    }, this.flushIntervalMs);

    // 允许 Node 进程在只有该定时器存活时正常退出
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public push(event: RawEvent | CommittedInjection): void {
    if (this.isClosed) return;
    this.buffer.push(event);
    // 防御：数据库长期不可写时缓冲区不能无限增长，丢弃最旧事件
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }
    if (
      this.buffer.length >= this.batchSize &&
      !this.isFlushing &&
      !this.thresholdFlushScheduled &&
      Date.now() >= this.nextRetryAt
    ) {
      // 异步触发批写入，绝不在调用栈中同步阻塞 5s busy_timeout
      this.thresholdFlushScheduled = true;
      queueMicrotask(() => {
        this.thresholdFlushScheduled = false;
        if (this.isClosed || this.isFlushing || this.buffer.length === 0) return;
        if (Date.now() < this.nextRetryAt) return;
        this.flush().catch((err) => {
          console.warn('[dsh-memory] IngestQueue threshold flush error:', err?.message || err);
        });
      });
    }
  }

  public flush(): Promise<number> {
    if (this.isFlushing && this.activeFlushPromise) {
      return this.activeFlushPromise;
    }
    if (this.buffer.length === 0) {
      return Promise.resolve(0);
    }

    this.isFlushing = true;
    let resolveFn!: (value: number) => void;
    let rejectFn!: (reason?: unknown) => void;
    const promise = new Promise<number>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // 先登记 activeFlushPromise 再执行同步事务，避免 async 无 await 时 finally 先于赋值执行
    this.activeFlushPromise = promise;

    try {
      const totalInserted = this.drainBuffer();
      this.isFlushing = false;
      this.activeFlushPromise = null;
      resolveFn(totalInserted);
    } catch (err) {
      this.isFlushing = false;
      this.activeFlushPromise = null;
      rejectFn(err);
    }

    return promise;
  }

  private drainBuffer(): number {
    let totalInserted = 0;
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.buffer.length);
      const { inserted, hadRequeued } = this.flushBatch(batch);
      totalInserted += inserted;
      if (hadRequeued) {
        break;
      }
    }
    return totalInserted;
  }

  private processSingleEvent(ev: RawEvent | CommittedInjection): {
    inserted: number;
    jobsEnqueued: number;
  } {
    if ('items' in ev) {
      let inserted = 0;
      for (const item of ev.items) {
        const result = this.db.run(
          `INSERT OR IGNORE INTO injections (
            session_id, turn, memory_id, content_rev, layer, rank, tokens, form, strategy_v, created_at
          ) VALUES (?, ?, ?, ?, 'dynamic', ?, ?, ?, ?, ?)`,
          [
            ev.sessionId,
            ev.turn,
            item.ref.id,
            item.ref.contentRev,
            item.rank,
            item.tokens,
            item.form,
            ev.strategyVersion,
            ev.time,
          ]
        );
        if (Number(result.changes) > 0) {
          inserted++;
          this.db.run(
            'UPDATE memories SET use_count = use_count + 1, last_used_at = MAX(COALESCE(last_used_at, 0), ?) WHERE id = ?',
            [ev.time, item.ref.id]
          );
          this.db.run(
            `UPDATE turn_metrics SET injected = injected + 1, inject_tokens = inject_tokens + ?
             WHERE session_id = ? AND turn = ?`,
            [item.tokens, ev.sessionId, ev.turn]
          );
        }
      }
      return { inserted, jobsEnqueued: 0 };
    }

    let res: ReturnType<Db['run']>;
    try {
      res = this.db.run(
        `INSERT INTO raw_events (session_id, seq, workspace_id, type, time, turn, role, origin_kind, tool_name, is_error, text, processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (session_id, seq) DO NOTHING`,
        [
          ev.session_id,
          ev.seq,
          ev.workspace_id,
          ev.type,
          ev.time,
          ev.turn ?? null,
          ev.role ?? null,
          ev.origin_kind,
          ev.tool_name ?? null,
          ev.is_error,
          ev.text ?? null,
        ]
      );
    } catch (insErr: any) {
      if (!isConstraintSqliteError(insErr)) {
        throw insErr;
      }
      // 单条事件违反约束（如非法 origin_kind）只跳过该条，不拖垮整批
      console.warn('[dsh-memory] raw_event insert skipped:', insErr?.message || insErr);
      return { inserted: 0, jobsEnqueued: 0 };
    }

    if (Number(res.changes) > 0) {
      let jobsEnqueued = 0;
      // 仅对真正新插入的行做规则抽取，并用嵌套 SAVEPOINT 隔离局部规则异常
      try {
        const ruleRes = this.db.transaction(() => runRules(this.db, ev, this.cfg, ev.time));
        jobsEnqueued = ruleRes.jobsEnqueued;
      } catch (ruleErr: any) {
        if (isTransientSqliteError(ruleErr)) {
          throw ruleErr;
        }
        console.warn('[dsh-memory] runRules error:', ruleErr?.message || ruleErr);
      }
      return { inserted: 1, jobsEnqueued };
    }

    return { inserted: 0, jobsEnqueued: 0 };
  }

  private notifyJobsEnqueued(jobsEnqueued: number): void {
    if (jobsEnqueued > 0 && this.onJobEnqueued) {
      try {
        this.onJobEnqueued();
      } catch (err: any) {
        console.warn('[dsh-memory] onJobEnqueued callback error:', err?.message || err);
      }
    }
  }

  private requeueFront(items: Array<RawEvent | CommittedInjection>): void {
    if (this.isClosed || items.length === 0) return;
    this.buffer.unshift(...items);
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }
  }

  private isolateBatchWithSavepoints(batch: Array<RawEvent | CommittedInjection>): {
    inserted: number;
    jobsEnqueued: number;
    requeued: Array<RawEvent | CommittedInjection>;
  } {
    let inserted = 0;
    let jobsEnqueued = 0;
    const requeued: Array<RawEvent | CommittedInjection> = [];

    this.db.transaction(() => {
      for (const ev of batch) {
        try {
          const itemRes = this.db.transaction(() => this.processSingleEvent(ev));
          inserted += itemRes.inserted;
          jobsEnqueued += itemRes.jobsEnqueued;
        } catch (itemErr: any) {
          if (isLockSqliteError(itemErr)) {
            requeued.push(ev);
          } else {
            this.droppedCount++;
            const label =
              'items' in ev
                ? `CommittedInjection(session=${ev.sessionId},turn=${ev.turn})`
                : `RawEvent(session=${ev.session_id},seq=${ev.seq},type=${ev.type})`;
            console.warn(
              `[dsh-memory] IngestQueue isolated and dropped poison-pill ${label}:`,
              itemErr?.message || itemErr
            );
          }
        }
      }
    });

    return { inserted, jobsEnqueued, requeued };
  }

  private flushBatch(batch: Array<RawEvent | CommittedInjection>): {
    inserted: number;
    hadRequeued: boolean;
  } {
    try {
      let insertedCount = 0;
      let jobsEnqueued = 0;

      this.db.transaction(() => {
        for (const ev of batch) {
          const itemRes = this.processSingleEvent(ev);
          insertedCount += itemRes.inserted;
          jobsEnqueued += itemRes.jobsEnqueued;
        }
      });

      this.consecutiveFailures = 0;
      this.nextRetryAt = 0;
      this.notifyJobsEnqueued(jobsEnqueued);
      return { inserted: insertedCount, hadRequeued: false };
    } catch (err) {
      this.consecutiveFailures++;
      const backoffMs = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** this.consecutiveFailures);
      this.nextRetryAt = Date.now() + backoffMs;

      const shouldIsolate =
        !isTransientSqliteError(err) ||
        (this.consecutiveFailures >= POISON_PILL_FAILURE_THRESHOLD && !isLockSqliteError(err));

      if (shouldIsolate) {
        try {
          const isolated = this.isolateBatchWithSavepoints(batch);
          if (isolated.requeued.length > 0) {
            this.requeueFront(isolated.requeued);
            if (isolated.requeued.length === batch.length) {
              throw err;
            }
          } else {
            this.consecutiveFailures = 0;
            this.nextRetryAt = 0;
          }
          this.notifyJobsEnqueued(isolated.jobsEnqueued);
          return {
            inserted: isolated.inserted,
            hadRequeued: isolated.requeued.length > 0,
          };
        } catch {
          // 若连外层事务都无法开启（例如数据库整体锁死/离线），保留整批等待重试
        }
      }

      // 整批事务失败（如 SQLITE_BUSY / 瞬时 IOERR）：放回缓冲区头部等待退避后重试
      this.requeueFront(batch);
      throw err;
    }
  }

  public size(): number {
    return this.buffer.length;
  }

  public getDroppedCount(): number {
    return this.droppedCount;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeFlushPromise) {
      try {
        await this.activeFlushPromise;
      } catch {}
    }
    // 关闭时尽力落盘；失败则放弃剩余事件，避免死循环阻塞宿主退出
    while (this.buffer.length > 0) {
      try {
        await this.flush();
      } catch (err: any) {
        console.warn(
          '[dsh-memory] IngestQueue final flush failed, dropping buffered events:',
          err?.message || err
        );
        this.buffer.length = 0;
        break;
      }
    }
  }
}
