import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import {
  reserve,
  settle,
  cancel,
  recoverReservedToUnknown,
  getLedgerUsage,
} from '../../src/evolution/ledger.js';
import type { Db } from '../../src/types.js';

describe('Evolution Ledger (M3-T1)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('successfully reserves within budget', () => {
    const res = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 5000,
      },
      DEFAULTS
    );

    expect(res.reserved).toBe(true);
    expect(res.ledgerId).toBeGreaterThan(0);

    const usage = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usage.callsCount).toBe(1);
    expect(usage.tokensConsumed).toBe(5000);
    expect(usage.tokensPending).toBe(5000);
  });

  it('rejects reservation when daily tokens limit is exceeded (已用199000、输入500、maxOutput1500时预留失败)', () => {
    // 模拟当日已使用 199,000 tokens (例如一次成功的调用)
    const firstReserve = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 199000,
      },
      DEFAULTS
    );
    expect(firstReserve.reserved).toBe(true);

    settle(db, {
      ledgerId: firstReserve.ledgerId!,
      status: 'succeeded',
      ok: 1,
      inTokens: 150000,
      outTokens: 49000, // 150000 + 49000 = 199000
    });

    const usageAfterFirst = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usageAfterFirst.tokensConsumed).toBe(199000);

    // 新请求：输入 500，maxOutput 1500 -> reservedTokens = 2000
    // 199,000 + 2000 = 201,000 > 200,000 (dailyLLMTokens) -> 预留失败
    const secondReserve = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 2000,
      },
      DEFAULTS
    );

    expect(secondReserve.reserved).toBe(false);
    expect(secondReserve.reason).toBe('daily_tokens_exceeded');
  });

  it('rejects reservation when daily calls limit is reached (40次调用上限)', () => {
    // 消耗 40 次调用（每次使用极少 token，如 100 tokens）
    for (let i = 0; i < 40; i++) {
      const res = reserve(
        db,
        {
          jobKind: 'distill',
          model: 'deepseek-v4-flash',
          promptVersion: 'distill-v2',
          reservedTokens: 100,
        },
        DEFAULTS
      );
      expect(res.reserved).toBe(true);
      settle(db, {
        ledgerId: res.ledgerId!,
        status: 'succeeded',
        ok: 1,
        inTokens: 50,
        outTokens: 50,
      });
    }

    // 第 41 次调用应该被拒绝
    const res41 = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 100,
      },
      DEFAULTS
    );

    expect(res41.reserved).toBe(false);
    expect(res41.reason).toBe('daily_calls_exceeded');
  });

  it('releases quota on cancellation before send (未发送取消释放)', () => {
    const res = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 50000,
      },
      DEFAULTS
    );
    expect(res.reserved).toBe(true);

    let usage = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usage.callsCount).toBe(1);
    expect(usage.tokensConsumed).toBe(50000);

    // 取消
    const cancelled = cancel(db, res.ledgerId!, 'cancelled_before_http');
    expect(cancelled).toBe(true);

    usage = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usage.callsCount).toBe(0);
    expect(usage.tokensConsumed).toBe(0);
  });

  it('retains full reserved quota for unknown usage or on recovery (未知usage/重启保留额度)', () => {
    const res1 = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 10000,
      },
      DEFAULTS
    );
    // 模拟无 usage 返回结算为 unknown
    settle(db, {
      ledgerId: res1.ledgerId!,
      status: 'unknown',
      ok: 1,
      note: 'no_usage_returned',
    });

    let usage = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usage.tokensConsumed).toBe(10000);

    // 模拟系统异常重启前处于 reserved 状态的记录
    const res2 = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 8000,
      },
      DEFAULTS
    );

    // 重启恢复
    const recovered = recoverReservedToUnknown(db);
    expect(recovered).toBe(1);

    const row = db.get<{ status: string; note: string }>(
      'SELECT status, note FROM llm_ledger WHERE id = ?',
      [res2.ledgerId!]
    );
    expect(row?.status).toBe('unknown');
    expect(row?.note).toBe('recovered_on_startup');

    usage = getLedgerUsage(db, undefined, DEFAULTS);
    expect(usage.tokensConsumed).toBe(18000); // 10000 + 8000
  });

  it('redacts secrets in settle/cancel notes', () => {
    const res = reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 1000,
      },
      DEFAULTS
    );

    settle(db, {
      ledgerId: res.ledgerId!,
      status: 'failed',
      ok: 0,
      note: 'Failed with api_key="sk-1234567890abcdef1234"',
    });

    const row = db.get<{ note: string }>(
      'SELECT note FROM llm_ledger WHERE id = ?',
      [res.ledgerId!]
    );
    expect(row?.note).not.toContain('sk-1234567890abcdef1234');
    expect(row?.note).toContain('[REDACTED:SECRET]');
  });

  it('normalizes non-date day strings in getLedgerUsage to today', () => {
    reserve(
      db,
      {
        jobKind: 'distill',
        model: 'deepseek-v4-flash',
        promptVersion: 'distill-v2',
        reservedTokens: 1200,
      },
      DEFAULTS
    );
    const usage = getLedgerUsage(db, 'enforce', DEFAULTS);
    expect(usage.callsCount).toBe(1);
    expect(usage.tokensConsumed).toBe(1200);
  });
});
