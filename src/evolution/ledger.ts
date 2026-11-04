import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { ReserveParams, ReserveResult, SettleParams } from './types.js';
import { redactSecrets } from '../core/privacy.js';

export function getLocalDayString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface LedgerUsage {
  day: string;
  callsCount: number;
  callsLimit: number;
  tokensConsumed: number;
  tokensLimit: number;
  tokensSettled: number;
  tokensPending: number;
}

/**
 * 原子预留每日 LLM 额度（Token 与 调用次数）
 */
export function reserve(db: Db, params: ReserveParams, cfg: PluginConfig): ReserveResult {
  const now = params.now ?? Date.now();
  const day = getLocalDayString(new Date(now));

  return db.transaction(() => {
    // 统计当日已消费与预留中额度
    const row = db.get<{ total_calls: number; used_tokens: number | null }>(
      `SELECT
        COUNT(*) as total_calls,
        SUM(CASE
          WHEN status = 'succeeded' THEN in_tokens + out_tokens
          WHEN status IN ('reserved', 'unknown') THEN reserved_tokens
          WHEN status = 'failed' THEN (in_tokens + out_tokens)
          ELSE 0
        END) as used_tokens
      FROM llm_ledger
      WHERE day = ? AND status != 'cancelled'`,
      [day]
    );

    const totalCalls = row?.total_calls ?? 0;
    const usedTokens = row?.used_tokens ?? 0;

    // 检查每日调用上限
    if (totalCalls >= cfg.dailyLLMCalls) {
      return {
        reserved: false,
        reason: 'daily_calls_exceeded',
      };
    }

    // 检查每日 Token 上限 (含当前申请的预留)
    if (usedTokens + params.reservedTokens > cfg.dailyLLMTokens) {
      return {
        reserved: false,
        reason: 'daily_tokens_exceeded',
      };
    }

    // 预留成功，插入账本行
    const res = db.run(
      `INSERT INTO llm_ledger (
        day, job_kind, model, prompt_version, reserved_tokens,
        in_tokens, out_tokens, status, ok, created_at
      ) VALUES (?, ?, ?, ?, ?, 0, 0, 'reserved', 0, ?)`,
      [day, params.jobKind, params.model, params.promptVersion, params.reservedTokens, now]
    );

    return {
      reserved: true,
      ledgerId: Number(res.lastInsertRowid),
    };
  });
}

/**
 * 结算账本记录
 */
export function settle(db: Db, params: SettleParams): void {
  const now = params.now ?? Date.now();

  // 读取原预留记录
  const row = db.get<{ reserved_tokens: number; status: string }>(
    `SELECT reserved_tokens, status FROM llm_ledger WHERE id = ?`,
    [params.ledgerId]
  );

  if (!row) return;

  let note = params.note ?? '';
  if (note) {
    const redacted = redactSecrets(note);
    note = redacted.text;
  }

  const inTokens = params.inTokens ?? 0;
  const outTokens = params.outTokens ?? 0;

  // 检查是否超出预留（合同破坏）
  if (params.status === 'succeeded' && inTokens + outTokens > row.reserved_tokens) {
    const warning = `[CONTRACT_BREACH:usage_${inTokens + outTokens}_exceeded_reserved_${row.reserved_tokens}]`;
    note = note ? `${note} ${warning}` : warning;
  }

  db.run(
    `UPDATE llm_ledger
     SET status = ?,
         ok = ?,
         in_tokens = ?,
         out_tokens = ?,
         note = ?,
         finished_at = ?
     WHERE id = ?`,
    [params.status, params.ok, inTokens, outTokens, note || null, now, params.ledgerId]
  );
}

/**
 * 取消未发送的请求，释放额度
 */
export function cancel(db: Db, ledgerId: number, note?: string, now: number = Date.now()): boolean {
  let cleanNote = note ?? 'cancelled_before_send';
  if (cleanNote) {
    cleanNote = redactSecrets(cleanNote).text;
  }

  const res = db.run(
    `UPDATE llm_ledger
     SET status = 'cancelled',
         ok = 0,
         in_tokens = 0,
         out_tokens = 0,
         note = ?,
         finished_at = ?
     WHERE id = ? AND status = 'reserved'`,
    [cleanNote, now, ledgerId]
  );

  return Number(res.changes) > 0;
}

/**
 * 重启或崩溃恢复：将未完成的 reserved 状态转为 unknown，保留额度占用
 */
export function recoverReservedToUnknown(db: Db, now: number = Date.now()): number {
  const res = db.run(
    `UPDATE llm_ledger
     SET status = 'unknown',
         ok = 0,
         note = 'recovered_on_startup',
         finished_at = ?
     WHERE status = 'reserved'`,
    [now]
  );

  return Number(res.changes);
}

/**
 * 获取指定日期的使用量统计
 */
export function getLedgerUsage(db: Db, day?: string, cfg?: PluginConfig): LedgerUsage {
  const targetDay = day ?? getLocalDayString();
  const callsLimit = cfg?.dailyLLMCalls ?? 40;
  const tokensLimit = cfg?.dailyLLMTokens ?? 200_000;

  const row = db.get<{
    total_calls: number;
    tokens_consumed: number | null;
    tokens_settled: number | null;
    tokens_pending: number | null;
  }>(
    `SELECT
      COUNT(*) as total_calls,
      SUM(CASE
        WHEN status = 'succeeded' THEN in_tokens + out_tokens
        WHEN status IN ('reserved', 'unknown') THEN reserved_tokens
        WHEN status = 'failed' THEN (in_tokens + out_tokens)
        ELSE 0
      END) as tokens_consumed,
      SUM(CASE
        WHEN status IN ('succeeded', 'failed') THEN in_tokens + out_tokens
        ELSE 0
      END) as tokens_settled,
      SUM(CASE
        WHEN status IN ('reserved', 'unknown') THEN reserved_tokens
        ELSE 0
      END) as tokens_pending
    FROM llm_ledger
    WHERE day = ? AND status != 'cancelled'`,
    [targetDay]
  );

  return {
    day: targetDay,
    callsCount: row?.total_calls ?? 0,
    callsLimit,
    tokensConsumed: row?.tokens_consumed ?? 0,
    tokensLimit,
    tokensSettled: row?.tokens_settled ?? 0,
    tokensPending: row?.tokens_pending ?? 0,
  };
}
