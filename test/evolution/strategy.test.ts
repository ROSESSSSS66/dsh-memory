import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/core/db.js';
import { DEFAULTS } from '../../src/config.js';
import {
  DEFAULT_STRATEGY,
  clearStrategyCache,
  getActiveStrategy,
  initDefaultStrategy,
  listStrategies,
  promoteStrategy,
  rollbackStrategy,
  validateAndClampStrategy,
} from '../../src/evolution/strategy.js';
import type { Db, StrategyConfig } from '../../src/types.js';

describe('Strategy Store & Validation (strategy.ts)', () => {
  let db: Db;

  beforeEach(() => {
    db = openDb(':memory:');
    clearStrategyCache();
  });

  afterEach(() => {
    clearStrategyCache();
    db.close();
  });

  it('validates and clamps rrfK [10,200], channelWeights [0.05,5.0], and falls back when scoreWeights sum <= 0', () => {
    const extreme: StrategyConfig = {
      rrfK: 9999,
      channelWeights: {
        lexical: 0.001,
        entity: 99,
        typed: -5,
        temporal: Number.NaN,
        preference: 0.5,
        vector: 1.5,
      },
      scoreWeights: {
        relevance: 0,
        confidence: -1,
        utility: 0,
        freshness: 0,
        consistency: 0,
        specificity: 0,
        importance: 0,
      },
      minRelevance: 5,
      dynamicBudgetTokens: 99999,
      maxItems: 100,
    };

    const clamped = validateAndClampStrategy(extreme, DEFAULTS);
    expect(clamped.rrfK).toBe(200);
    expect(clamped.channelWeights.lexical).toBe(0.05);
    expect(clamped.channelWeights.entity).toBe(5.0);
    expect(clamped.channelWeights.typed).toBe(0.05);
    expect(clamped.channelWeights.temporal).toBe(DEFAULT_STRATEGY.channelWeights.temporal);
    expect(clamped.minRelevance).toBe(0.4);
    expect(clamped.maxItems).toBe(DEFAULTS.maxLabItems);

    // Zero-sum scoreWeights must fall back to DEFAULT_STRATEGY weights with importance: 0.05
    const sum = Object.values(clamped.scoreWeights).reduce((acc, v) => acc + (v ?? 0), 0);
    expect(sum).toBeCloseTo(1.0, 2);
    expect(clamped.scoreWeights.importance).toBeCloseTo(0.05, 3);

    // Low rrfK clamp
    expect(validateAndClampStrategy({ ...DEFAULT_STRATEGY, rrfK: 2 }).rrfK).toBe(10);
  });

  it('recovers from corrupt active JSON and retired v1 without losing active v2+', () => {
    // 1. Corrupt active JSON row
    db.run(
      `INSERT INTO strategies (version, config, status, parent, created_at, promoted_at)
       VALUES (1, '{corrupt-json', 'active', NULL, 1000, 1000)`
    );
    const recovered = getActiveStrategy(db);
    expect(recovered.version).toBe(1);
    expect(recovered.config.rrfK).toBe(DEFAULT_STRATEGY.rrfK);
    // DB row itself is repaired
    const raw = db.get<{ config: string }>('SELECT config FROM strategies WHERE version = 1')!.config;
    expect(() => JSON.parse(raw)).not.toThrow();

    // 2. Retired v1 with no active row -> initDefaultStrategy reactivates v1
    clearStrategyCache(db);
    db.run("UPDATE strategies SET status = 'retired' WHERE version = 1");
    const reactivated = initDefaultStrategy(db);
    expect(reactivated.version).toBe(1);
    expect(db.get<{ status: string }>('SELECT status FROM strategies WHERE version = 1')?.status).toBe('active');

    // 3. Active v2 must NOT be clobbered or mis-cached as v1 when initDefaultStrategy is called
    promoteStrategy(db, 2, { ...DEFAULT_STRATEGY, rrfK: 42 }, 1, { overall: {} });
    const kept = initDefaultStrategy(db);
    expect(kept.version).toBe(2);
    expect(kept.config.rrfK).toBe(42);
  });

  it('is read-only safe in getActiveStrategy when DB has no strategies or corrupt JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-strat-ro-'));
    const dbPath = path.join(tmpDir, 'ro.db');
    try {
      const rw = openDb(dbPath);
      rw.close();

      // Empty strategies table on read-only DB
      const ro1 = openDb(dbPath, { readOnly: true });
      try {
        const strat = getActiveStrategy(ro1);
        expect(strat.version).toBe(1);
        expect(strat.config.rrfK).toBe(DEFAULT_STRATEGY.rrfK);
      } finally {
        ro1.close();
      }

      // Corrupt JSON on read-only DB
      const rw2 = openDb(dbPath);
      rw2.run(
        `INSERT INTO strategies (version, config, status, parent, created_at) VALUES (1, 'bad-json', 'active', NULL, 1000)`
      );
      rw2.close();

      const ro2 = openDb(dbPath, { readOnly: true });
      try {
        const strat = getActiveStrategy(ro2);
        expect(strat.version).toBe(1);
        expect(strat.config.rrfK).toBe(DEFAULT_STRATEGY.rrfK);
      } finally {
        ro2.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('disallows rolling back to rejected or self and lists strategies safely', () => {
    initDefaultStrategy(db);
    promoteStrategy(db, 2, { ...DEFAULT_STRATEGY, rrfK: 35 }, 1, { score: 0.9 });
    expect(rollbackStrategy(db, 2)).toMatchObject({ ok: false });
    expect(rollbackStrategy(db, 1)).toEqual({ ok: true, rolledBackTo: 1 });
    // v2 is now rejected -> cannot rollback to rejected v2
    promoteStrategy(db, 3, { ...DEFAULT_STRATEGY, rrfK: 40 }, 1, { score: 0.95 });
    expect(rollbackStrategy(db, 2)).toMatchObject({ ok: false });
    const all = listStrategies(db);
    expect(all.map((s) => s.version)).toEqual([3, 2, 1]);
  });
});
