import type { Db, StrategyConfig } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { DEFAULT_STRATEGY } from '../retrieval/fuse.js';

export interface StrategyRecord {
  version: number;
  config: StrategyConfig;
  status: 'active' | 'retired' | 'candidate' | 'rejected';
  parent: number | null;
  eval_report: any | null;
  created_at: number;
  promoted_at: number | null;
}

let cachedActiveByDb = new WeakMap<Db, { version: number; config: StrategyConfig }>();

export function clearStrategyCache(): void {
  cachedActiveByDb = new WeakMap<Db, { version: number; config: StrategyConfig }>();
}

/**
 * 校验并根据当前 PluginConfig 约束策略参数
 */
export function validateAndClampStrategy(
  strategy: StrategyConfig,
  cfg: PluginConfig = DEFAULTS
): StrategyConfig {
  const dynamicCap = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  const minDyn = Math.min(800, dynamicCap);
  const dynBudget = cfg.dynamicBudgetTokens === 0 || strategy.dynamicBudgetTokens === 0
    ? 0 : Math.max(minDyn, Math.min(strategy.dynamicBudgetTokens ?? 1600, dynamicCap));

  const maxItems = Math.max(1, Math.min(Math.round(strategy.maxItems || 6), cfg.maxLabItems || 12));
  const minRelevance = Math.max(0.05, Math.min(strategy.minRelevance || 0.15, 0.4));

  // 归一化 scoreWeights
  const rawWeights = { ...strategy.scoreWeights };
  let sum = 0;
  for (const k of Object.keys(rawWeights) as (keyof typeof rawWeights)[]) {
    rawWeights[k] = Math.max(0, rawWeights[k] || 0);
    sum += rawWeights[k];
  }
  const scoreWeights = { ...rawWeights };
  if (sum > 0) {
    for (const k of Object.keys(scoreWeights) as (keyof typeof scoreWeights)[]) {
      scoreWeights[k] = Number(((scoreWeights[k] ?? 0) / sum).toFixed(4));
    }
  }

  return {
    ...strategy,
    dynamicBudgetTokens: dynBudget,
    maxItems,
    minRelevance,
    scoreWeights,
  };
}

/**
 * 初始化并写入 v1 默认策略
 */
export function initDefaultStrategy(
  db: Db,
  cfg: PluginConfig = DEFAULTS,
  initialReport: any = null
): { version: number; config: StrategyConfig } {
  const now = Date.now();
  const v1Config = validateAndClampStrategy(DEFAULT_STRATEGY, cfg);

  db.transaction(() => {
    const existing = db.get<{ version: number; config: string }>(
      "SELECT version, config FROM strategies WHERE status = 'active' LIMIT 1"
    );
    if (!existing) {
      db.run(
        `INSERT OR IGNORE INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
         VALUES (1, ?, 'active', NULL, ?, ?, ?)`,
        [JSON.stringify(v1Config), initialReport ? JSON.stringify(initialReport) : null, now, now]
      );
    }
  });

  const entry = { version: 1, config: v1Config };
  cachedActiveByDb.set(db, entry);
  return entry;
}

/**
 * 获取当前 active 策略 (带内存缓存与动态配置约束)
 */
export function getActiveStrategy(
  db: Db,
  cfg: PluginConfig = DEFAULTS
): { version: number; config: StrategyConfig } {
  const cachedActive = cachedActiveByDb.get(db);
  if (cachedActive) {
    // 每次读取仍按当前配置约束动态预算上限
    const clamped = validateAndClampStrategy(cachedActive.config, cfg);
    return { version: cachedActive.version, config: clamped };
  }

  const row = db.get<{ version: number; config: string }>(
    "SELECT version, config FROM strategies WHERE status = 'active' LIMIT 1"
  );

  if (!row) {
    return initDefaultStrategy(db, cfg);
  }

  try {
    const parsed = JSON.parse(row.config) as StrategyConfig;
    const clamped = validateAndClampStrategy(parsed, cfg);
    const entry = { version: row.version, config: clamped };
    cachedActiveByDb.set(db, entry);
    return entry;
  } catch {
    return initDefaultStrategy(db, cfg);
  }
}

/**
 * 列出所有策略版本
 */
export function listStrategies(db: Db): StrategyRecord[] {
  const rows = db.all<{
    version: number;
    config: string;
    status: 'active' | 'retired' | 'candidate' | 'rejected';
    parent: number | null;
    eval_report: string | null;
    created_at: number;
    promoted_at: number | null;
  }>('SELECT * FROM strategies ORDER BY version DESC');

  return rows.map((r) => ({
    version: r.version,
    config: JSON.parse(r.config),
    status: r.status,
    parent: r.parent,
    eval_report: r.eval_report ? JSON.parse(r.eval_report) : null,
    created_at: r.created_at,
    promoted_at: r.promoted_at,
  }));
}

/**
 * 原子晋升新策略
 */
export function promoteStrategy(
  db: Db,
  newVersion: number,
  newConfig: StrategyConfig,
  parentVersion: number,
  evalReport: any,
  cfg: PluginConfig = DEFAULTS
): void {
  const now = Date.now();
  const clamped = validateAndClampStrategy(newConfig, cfg);

  db.transaction(() => {
    // 退休当前 active 策略
    db.run("UPDATE strategies SET status = 'retired' WHERE status = 'active'");

    // 写入新 active 策略
    db.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      [newVersion, JSON.stringify(clamped), parentVersion, JSON.stringify(evalReport), now, now]
    );
  });

  cachedActiveByDb.set(db, { version: newVersion, config: clamped });
}

/**
 * 回滚到 parent 版本或指定版本
 */
export function rollbackStrategy(
  db: Db,
  targetVersion?: number
): { ok: boolean; rolledBackTo?: number; reason?: string } {
  return db.transaction(() => {
    const active = db.get<{ version: number; parent: number | null }>(
      "SELECT version, parent FROM strategies WHERE status = 'active' LIMIT 1"
    );

    if (!active) {
      return { ok: false, reason: 'No active strategy found to rollback' };
    }

    const toVersion = targetVersion !== undefined ? targetVersion : active.parent;
    if (toVersion === null || toVersion === undefined) {
      return { ok: false, reason: `Active strategy v${active.version} has no parent version` };
    }

    const target = db.get<{ version: number; config: string }>(
      'SELECT version, config FROM strategies WHERE version = ?',
      [toVersion]
    );

    if (!target) {
      return { ok: false, reason: `Target strategy v${toVersion} does not exist` };
    }

    // 标记当前 active 为 rejected
    db.run("UPDATE strategies SET status = 'rejected' WHERE version = ?", [active.version]);
    // 恢复目标为 active
    db.run("UPDATE strategies SET status = 'active' WHERE version = ?", [toVersion]);

    clearStrategyCache();
    return { ok: true, rolledBackTo: toVersion };
  });
}
