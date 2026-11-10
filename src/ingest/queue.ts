import type { Db, RawEvent } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { runRules } from './rules.js';

/** 缓冲区上限：数据库长期不可写时防止内存无限增长 */
const MAX_BUFFERED_EVENTS = 5000;

export interface IngestQueueOptions {
  batchSize?: number;
  flushIntervalMs?: number;
}

export class IngestQueue {
  private db: Db;
  private cfg: PluginConfig;
  private buffer: RawEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private batchSize: number;
  private flushIntervalMs: number;
  private isFlushing = false;
  private activeFlushPromise: Promise<number> | null = null;
  private isClosed = false;

  constructor(db: Db, cfg: PluginConfig = DEFAULTS, options: IngestQueueOptions = {}) {
    this.db = db;
    this.cfg = cfg;
    this.batchSize = options.batchSize ?? 50;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;

    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        console.warn('[dsh-memory] IngestQueue periodic flush error:', err?.message || err);
      });
    }, this.flushIntervalMs);

    // 允许 Node 进程在只有该定时器存活时正常退出
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  public push(event: RawEvent): void {
    if (this.isClosed) return;
    this.buffer.push(event);
    // 防御：数据库长期不可写时缓冲区不能无限增长，丢弃最旧事件
    if (this.buffer.length > MAX_BUFFERED_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
    }
    if (this.buffer.length >= this.batchSize) {
      // 触发异步写入
      this.flush().catch((err) => {
        console.warn('[dsh-memory] IngestQueue threshold flush error:', err?.message || err);
      });
    }
  }

  public async flush(): Promise<number> {
    if (this.isFlushing) {
      return this.activeFlushPromise ?? 0;
    }
    if (this.buffer.length === 0) {
      return 0;
    }
    this.isFlushing = true;
    const run = async (): Promise<number> => {
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      let insertedCount = 0;

      this.db.transaction(() => {
        for (const ev of batch) {
          let res;
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
            // 单条事件违反约束（如非法 origin_kind）只跳过该条，不拖垮整批
            console.warn('[dsh-memory] raw_event insert skipped:', insErr?.message || insErr);
            continue;
          }

          if (Number(res.changes) > 0) {
            insertedCount++;
            // 仅对真正新插入的行做规则抽取
            try {
              runRules(this.db, ev, this.cfg, ev.time);
            } catch (ruleErr: any) {
              console.warn('[dsh-memory] runRules error:', ruleErr?.message || ruleErr);
            }
          }
        }
      });

      return insertedCount;
    } catch (err) {
      // 整批事务失败（如 SQLITE_BUSY）：放回缓冲区头部等待下次重试，避免静默丢失事件
      if (!this.isClosed) {
        this.buffer.unshift(...batch);
        if (this.buffer.length > MAX_BUFFERED_EVENTS) {
          this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_EVENTS);
        }
      }
      throw err;
    } finally {
      this.isFlushing = false;
      this.activeFlushPromise = null;
      if (!this.isClosed && this.buffer.length >= this.batchSize) {
        // 若在清空期间又积累了足够事件，继续下一次 flush
        setTimeout(() => {
          this.flush().catch(() => {});
        }, 0);
      }
    }
    };
    this.activeFlushPromise = run();
    return this.activeFlushPromise;
  }

  public size(): number {
    return this.buffer.length;
  }

  public async close(): Promise<void> {
    this.isClosed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeFlushPromise) {
      try { await this.activeFlushPromise; } catch {}
    }
    // 关闭时尽力落盘；失败则放弃剩余事件，避免死循环阻塞宿主退出
    while (this.buffer.length > 0) {
      try {
        await this.flush();
      } catch (err: any) {
        console.warn('[dsh-memory] IngestQueue final flush failed, dropping buffered events:', err?.message || err);
        this.buffer.length = 0;
        break;
      }
    }
  }
}
