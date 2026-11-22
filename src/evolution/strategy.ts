import type { ChannelName, Db, StrategyConfig } from '../types.js';
import { DEFAULTS, type PluginConfig } from '../config.js';
import { DEFAULT_STRATEGY as RETRIEVAL_DEFAULT_STRATEGY } from '../retrieval/fuse.js';

export const SENTINEL_RESTORED_VERSION_KEY = 'sentinel.restored_version';

const CHANNEL_NAMES: readonly ChannelName[] = [
  'lexical',
  'entity',
  'typed',
  'temporal',
  'preference',
  'vector',
];

const SCORE_WEIGHT_KEYS = [
  'relevance',
  'confidence',
  'utility',
  'freshness',
  'consistency',
  'specificity',
  'importance',
] as const;

export const DEFAULT_STRATEGY: StrategyConfig = {
  ...RETRIEVAL_DEFAULT_STRATEGY,
  channelWeights: {
    ...RETRIEVAL_DEFAULT_STRATEGY.channelWeights,
  },
  scoreWeights: {
    ...RETRIEVAL_DEFAULT_STRATEGY.scoreWeights,
    importance: RETRIEVAL_DEFAULT_STRATEGY.scoreWeights.importance ?? 0.05,
  },
};

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

export function clearStrategyCache(db?: Db): void {
  if (db) {
    cachedActiveByDb.delete(db);
    return;
  }
  cachedActiveByDb = new WeakMap<Db, { version: number; config: StrategyConfig }>();
}

function clampFinite(value: unknown, minVal: number, maxVal: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minVal, Math.min(maxVal, num));
}

/**
 * 校验并根据当前 PluginConfig 约束策略参数：
 * - rrfK ∈ [10, 200]
 * - channelWeights[*] ∈ [0.05, 5.0]
 * - scoreWeights 各项非负且总和 > 0（全零/非法时回退默认权重），归一化为 1.0
 * - minRelevance ∈ [0.05, 0.4]
 * - dynamicBudgetTokens ∈ [min(800, cap), cap] 或 0
 * - maxItems ∈ [1, cfg.maxLabItems || 12]
 */
export function validateAndClampStrategy(
  strategy: StrategyConfig,
  cfg: PluginConfig = DEFAULTS
): StrategyConfig {
  const safeStrategy = (strategy && typeof strategy === 'object' ? strategy : DEFAULT_STRATEGY) as Partial<StrategyConfig>;

  const rrfK = Math.round(clampFinite(safeStrategy.rrfK, 10, 200, DEFAULT_STRATEGY.rrfK));

  const rawChannels =
    safeStrategy.channelWeights && typeof safeStrategy.channelWeights === 'object'
      ? safeStrategy.channelWeights
      : DEFAULT_STRATEGY.channelWeights;
  const channelWeights = {} as Record<ChannelName, number>;
  for (const ch of CHANNEL_NAMES) {
    channelWeights[ch] = Number(
      clampFinite(rawChannels[ch], 0.05, 5.0, DEFAULT_STRATEGY.channelWeights[ch]).toFixed(4)
    );
  }

  const dynamicCap = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  const minDyn = Math.min(800, dynamicCap);
  const rawDyn =
    typeof safeStrategy.dynamicBudgetTokens === 'number' && Number.isFinite(safeStrategy.dynamicBudgetTokens)
      ? safeStrategy.dynamicBudgetTokens
      : DEFAULT_STRATEGY.dynamicBudgetTokens;
  const dynBudget =
    cfg.dynamicBudgetTokens === 0 || rawDyn === 0
      ? 0
      : Math.round(Math.max(minDyn, Math.min(rawDyn, dynamicCap)));

  const maxLabItems = cfg.maxLabItems || 12;
  const maxItems = Math.round(
    clampFinite(safeStrategy.maxItems, 1, maxLabItems, DEFAULT_STRATEGY.maxItems)
  );
  const minRelevance = Number(
    clampFinite(safeStrategy.minRelevance, 0.05, 0.4, DEFAULT_STRATEGY.minRelevance).toFixed(4)
  );

  // 归一化 scoreWeights（保证 sum > 0，否则回退 DEFAULT_STRATEGY.scoreWeights）
  const rawWeights =
    safeStrategy.scoreWeights && typeof safeStrategy.scoreWeights === 'object'
      ? safeStrategy.scoreWeights
      : DEFAULT_STRATEGY.scoreWeights;
  const cleanedWeights: Record<string, number> = {};
  let sum = 0;
  for (const k of SCORE_WEIGHT_KEYS) {
    const rawVal = rawWeights[k];
    if (k === 'importance' && rawVal === undefined) {
      continue;
    }
    const clamped = typeof rawVal === 'number' && Number.isFinite(rawVal) ? Math.max(0, rawVal) : 0;
    cleanedWeights[k] = clamped;
    sum += clamped;
  }

  const effectiveSource =
    sum > 0 ? cleanedWeights : { ...(DEFAULT_STRATEGY.scoreWeights as Record<string, number>) };
  const effectiveSum = Object.values(effectiveSource).reduce((acc, v) => acc + v, 0);
  const scoreWeights = {} as StrategyConfig['scoreWeights'];
  for (const [k, v] of Object.entries(effectiveSource)) {
    (scoreWeights as Record<string, number>)[k] = Number((v / effectiveSum).toFixed(4));
  }

  return {
    rrfK,
    channelWeights,
    scoreWeights,
    minRelevance,
    dynamicBudgetTokens: dynBudget,
    maxItems,
  };
}

function tryParseStrategyConfig(raw: string): StrategyConfig | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as StrategyConfig;
    }
  } catch {}
  return null;
}

/**
 * 初始化或自愈默认策略：
 * - 若已有合法 active 策略，直接返回当前 active 版本（不降级覆盖 v2+）
 * - 若 active 策略 JSON 损坏，原地修复其 config 为默认策略
 * - 若无 active 策略但 v1 已存在（如 retired/rejected），重新激活 v1；否则写入 v1
 */
export function initDefaultStrategy(
  db: Db,
  cfg: PluginConfig = DEFAULTS,
  initialReport: any = null
): { version: number; config: StrategyConfig } {
  const now = Date.now();
  const v1Config = validateAndClampStrategy(DEFAULT_STRATEGY, cfg);

  const entry = db.transaction(() => {
    const existing = db.get<{ version: number; config: string }>(
      "SELECT version, config FROM strategies WHERE status = 'active' LIMIT 1"
    );
    if (existing) {
      const parsed = tryParseStrategyConfig(existing.config);
      if (parsed) {
        return {
          version: existing.version,
          config: validateAndClampStrategy(parsed, cfg),
        };
      }
      // 修复损坏的 active 行 JSON
      db.run(
        `UPDATE strategies
         SET config = ?, promoted_at = COALESCE(promoted_at, ?)
         WHERE version = ?`,
        [JSON.stringify(v1Config), now, existing.version]
      );
      return { version: existing.version, config: v1Config };
    }

    // 无 active 策略：检查 v1 是否已存在（如曾被 retired/rejected）
    const existingV1 = db.get<{ version: number }>(
      'SELECT version FROM strategies WHERE version = 1 LIMIT 1'
    );
    if (existingV1) {
      db.run(
        `UPDATE strategies
         SET status = 'active', config = ?, promoted_at = COALESCE(promoted_at, ?)
         WHERE version = 1`,
        [JSON.stringify(v1Config), now]
      );
      return { version: 1, config: v1Config };
    }

    db.run(
      `INSERT INTO strategies (version, config, status, parent, eval_report, created_at, promoted_at)
       VALUES (1, ?, 'active', NULL, ?, ?, ?)`,
      [JSON.stringify(v1Config), initialReport ? JSON.stringify(initialReport) : null, now, now]
    );
    return { version: 1, config: v1Config };
  });

  cachedActiveByDb.set(db, entry);
  return entry;
}

/**
 * 获取当前 active 策略 (带内存缓存与动态配置约束；在只读库或无行/坏行场景下安全回退不抛错)
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

  let row: { version: number; config: string } | undefined;
  try {
    row = db.get<{ version: number; config: string }>(
      "SELECT version, config FROM strategies WHERE status = 'active' LIMIT 1"
    );
  } catch {
    return { version: 1, config: validateAndClampStrategy(DEFAULT_STRATEGY, cfg) };
  }

  if (!row) {
    try {
      return initDefaultStrategy(db, cfg);
    } catch {
      // 只读数据库连接无法写入默认行时，直接返回内存默认策略
      return { version: 1, config: validateAndClampStrategy(DEFAULT_STRATEGY, cfg) };
    }
  }

  const parsed = tryParseStrategyConfig(row.config);
  if (parsed) {
    const clamped = validateAndClampStrategy(parsed, cfg);
    const entry = { version: row.version, config: clamped };
    cachedActiveByDb.set(db, entry);
    return entry;
  }

  try {
    return initDefaultStrategy(db, cfg);
  } catch {
    return { version: row.version, config: validateAndClampStrategy(DEFAULT_STRATEGY, cfg) };
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

  return rows.map((r) => {
    const parsedConfig = tryParseStrategyConfig(r.config) ?? DEFAULT_STRATEGY;
    let parsedReport: any = null;
    if (r.eval_report) {
      try {
        parsedReport = JSON.parse(r.eval_report);
      } catch {
        parsedReport = null;
      }
    }
    return {
      version: r.version,
      config: parsedConfig,
      status: r.status,
      parent: r.parent,
      eval_report: parsedReport,
      created_at: r.created_at,
      promoted_at: r.promoted_at,
    };
  });
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

    // 晋升新版本后清除哨兵恢复标记，使新版本重新接受哨兵监控
    db.run('DELETE FROM meta WHERE key = ?', [SENTINEL_RESTORED_VERSION_KEY]);
  });

  cachedActiveByDb.set(db, { version: newVersion, config: clamped });
}

/**
 * 回滚到 parent 版本或指定版本（禁止回滚到 rejected 版本或自身；记录恢复标记防止连锁回滚）
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

    if (toVersion === active.version) {
      return { ok: false, reason: `Target strategy v${toVersion} is already active` };
    }

    const target = db.get<{ version: number; config: string; status: string }>(
      'SELECT version, config, status FROM strategies WHERE version = ?',
      [toVersion]
    );

    if (!target) {
      return { ok: false, reason: `Target strategy v${toVersion} does not exist` };
    }

    if (target.status === 'rejected') {
      return { ok: false, reason: `Cannot rollback to rejected strategy v${toVersion}` };
    }

    // 标记当前 active 为 rejected
    db.run("UPDATE strategies SET status = 'rejected' WHERE version = ?", [active.version]);
    // 恢复目标为 active
    db.run("UPDATE strategies SET status = 'active' WHERE version = ?", [toVersion]);
    // 记录已恢复版本，避免哨兵对历史已回滚版本发生连锁回滚
    db.run(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [SENTINEL_RESTORED_VERSION_KEY, String(toVersion)]
    );

    clearStrategyCache(db);
    return { ok: true, rolledBackTo: toVersion };
  });
}
