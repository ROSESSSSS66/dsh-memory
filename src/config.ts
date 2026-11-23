import * as z from 'zod';
import type { Db } from './types.js';

export const DEFAULTS = {
  enabled: true,
  dataDir: '', // 为空时使用 <dshHome>/storages/dsh-memory
  dbPath: '', // 为空时使用 <dshHome>/storages/dsh-memory/memory.db
  webAdminEnabled: false, // 默认关闭未使用的 Web 运维写端点（仅显式开启或走 /memory CLI）
  // 在线
  onlineBudgetMs: 150,
  hardBudgetTokens: 3200, // 稳定层 + 动态层的硬上限
  stableBudgetTokens: 600,
  dynamicBudgetTokens: 1600, // 初始值，之后由 strategy 接管
  maxItems: 6,
  queryMaxChars: 2000,
  maxContentTokens: 400,
  maxSummaryTokens: 60,
  maxEntitiesPerText: 16,
  minLexicalCoverage: 0.25, // 绝对相关性硬约束，不参与进化
  minVectorSimilarity: 0.65,
  // 写入
  dupJaccard: 0.8,
  utilityLR: 0.1,
  // 离线
  offlineLLM: {
    useDshLlm: true,
    baseURL: '',
    model: 'deepseek-ai/deepseek-v4-flash-0731',
    apiKeyEnv: '',
    apiKey: '',
    protocol: 'chat/completions' as 'chat/completions' | 'responses' | 'messages',
  },
  dailyLLMCalls: 40,
  dailyLLMTokens: 200_000,
  distillMaxInputTokens: 6000,
  distillMinEvents: 40,
  idleMinutes: 10,
  nightlyAt: '03:30',
  jobTimeoutMs: 120_000,
  coldDays: 60,
  consolidateMaxClusters: 5,
  repairCooldownDays: 7,
  // 进化
  labCandidates: 8,
  labMinEvalCases: 30,
  maxLabItems: 12,
  // 向量（默认本地 128D 内存矩阵，开启 openai-compatible 后优先走远程 Embedding 并在离线/异常时无缝回退本地）
  embedding: {
    provider: 'none' as 'none' | 'openai-compatible',
    baseURL: '',
    model: '',
    apiKeyEnv: '',
    apiKey: '',
    dim: 0,
    batchSize: 32,
    timeoutMs: 15_000,
  },
  // 隐私
  defaultScope: 'workspace' as 'session' | 'workspace' | 'user' | 'global',
  excludeWorkspaces: [] as string[], // 这些工作区的 cwd 完全不记录、也不召回
  privacy: {
    offlineConsent: false,
    allowedOfflineEndpoints: [] as string[],
  },
};

export interface OfflineLLMConfig {
  useDshLlm: boolean;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  apiKey?: string;
  protocol?: 'chat/completions' | 'responses' | 'messages';
}

export interface EmbeddingConfig {
  provider: 'none' | 'openai-compatible';
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  apiKey?: string;
  dim: number;
  batchSize?: number;
  timeoutMs?: number;
}

export type PluginConfig = Omit<typeof DEFAULTS, 'offlineLLM' | 'embedding'> & {
  offlineLLM: OfflineLLMConfig;
  embedding: EmbeddingConfig;
};

const safeString = (fallback: string) =>
  z.preprocess((v) => (typeof v === 'string' ? v : fallback), z.string());

const safeBoolean = (fallback: boolean) =>
  z.preprocess((v) => (typeof v === 'boolean' ? v : fallback), z.boolean());

const safePositiveInt = (fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : fallback),
    z.number().int().positive()
  );

const safeNonNegativeInt = (fallback: number) =>
  z.preprocess(
    (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback),
    z.number().int().min(0)
  );

const safeRatio = (fallback: number) =>
  z.preprocess(
    (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : fallback),
    z.number().min(0).max(1)
  );

const safeStringArray = (maxItems = 200) =>
  z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v
            .filter((item): item is string => typeof item === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, maxItems)
        : [],
    z.array(z.string())
  );

const safeNightlyAt = z.preprocess(
  (v) =>
    typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())
      ? v.trim()
      : DEFAULTS.nightlyAt,
  z.string()
);

const OfflineLLMSchema = z
  .object({
    useDshLlm: safeBoolean(DEFAULTS.offlineLLM.useDshLlm),
    baseURL: safeString(DEFAULTS.offlineLLM.baseURL),
    model: safeString(DEFAULTS.offlineLLM.model),
    apiKeyEnv: safeString(DEFAULTS.offlineLLM.apiKeyEnv),
    apiKey: safeString(DEFAULTS.offlineLLM.apiKey),
    protocol: z.preprocess(
      (v) =>
        v === 'chat/completions' || v === 'responses' || v === 'messages' ? v : 'chat/completions',
      z.enum(['chat/completions', 'responses', 'messages'])
    ),
  })
  .strip();

const EmbeddingSchema = z
  .object({
    provider: z.preprocess(
      (v) => (v === 'none' || v === 'openai-compatible' ? v : 'none'),
      z.enum(['none', 'openai-compatible'])
    ),
    baseURL: safeString(DEFAULTS.embedding.baseURL),
    model: safeString(DEFAULTS.embedding.model),
    apiKeyEnv: safeString(DEFAULTS.embedding.apiKeyEnv),
    apiKey: safeString(DEFAULTS.embedding.apiKey),
    dim: safeNonNegativeInt(DEFAULTS.embedding.dim),
    batchSize: safePositiveInt(DEFAULTS.embedding.batchSize, 256),
    timeoutMs: safePositiveInt(DEFAULTS.embedding.timeoutMs, 120_000),
  })
  .strip();

const PrivacySchema = z
  .object({
    offlineConsent: safeBoolean(DEFAULTS.privacy.offlineConsent),
    allowedOfflineEndpoints: safeStringArray(100),
  })
  .strip();

const PluginConfigSchema = z
  .object({
    enabled: safeBoolean(DEFAULTS.enabled),
    dataDir: safeString(DEFAULTS.dataDir),
    dbPath: safeString(DEFAULTS.dbPath),
    webAdminEnabled: safeBoolean(DEFAULTS.webAdminEnabled),
    onlineBudgetMs: safePositiveInt(DEFAULTS.onlineBudgetMs),
    hardBudgetTokens: safePositiveInt(DEFAULTS.hardBudgetTokens),
    stableBudgetTokens: safeNonNegativeInt(DEFAULTS.stableBudgetTokens),
    dynamicBudgetTokens: safeNonNegativeInt(DEFAULTS.dynamicBudgetTokens),
    maxItems: safePositiveInt(DEFAULTS.maxItems),
    queryMaxChars: safePositiveInt(DEFAULTS.queryMaxChars),
    maxContentTokens: safePositiveInt(DEFAULTS.maxContentTokens),
    maxSummaryTokens: safePositiveInt(DEFAULTS.maxSummaryTokens),
    maxEntitiesPerText: safePositiveInt(DEFAULTS.maxEntitiesPerText),
    minLexicalCoverage: safeRatio(DEFAULTS.minLexicalCoverage),
    minVectorSimilarity: safeRatio(DEFAULTS.minVectorSimilarity),
    dupJaccard: safeRatio(DEFAULTS.dupJaccard),
    utilityLR: safeRatio(DEFAULTS.utilityLR),
    offlineLLM: OfflineLLMSchema,
    dailyLLMCalls: safePositiveInt(DEFAULTS.dailyLLMCalls),
    dailyLLMTokens: safePositiveInt(DEFAULTS.dailyLLMTokens),
    distillMaxInputTokens: safePositiveInt(DEFAULTS.distillMaxInputTokens),
    distillMinEvents: safePositiveInt(DEFAULTS.distillMinEvents),
    idleMinutes: safePositiveInt(DEFAULTS.idleMinutes),
    nightlyAt: safeNightlyAt,
    jobTimeoutMs: safePositiveInt(DEFAULTS.jobTimeoutMs),
    coldDays: safePositiveInt(DEFAULTS.coldDays),
    consolidateMaxClusters: safePositiveInt(DEFAULTS.consolidateMaxClusters),
    repairCooldownDays: safePositiveInt(DEFAULTS.repairCooldownDays),
    labCandidates: safePositiveInt(DEFAULTS.labCandidates),
    labMinEvalCases: safePositiveInt(DEFAULTS.labMinEvalCases),
    maxLabItems: safePositiveInt(DEFAULTS.maxLabItems),
    embedding: EmbeddingSchema,
    defaultScope: z.preprocess(
      (v) =>
        v === 'session' || v === 'workspace' || v === 'user' || v === 'global'
          ? v
          : DEFAULTS.defaultScope,
      z.enum(['session', 'workspace', 'user', 'global'])
    ),
    excludeWorkspaces: safeStringArray(200),
    privacy: PrivacySchema,
  })
  .strip();

export function validateConfig(
  raw: Partial<PluginConfig> & Record<string, any> = {}
): PluginConfig {
  const safeRaw = raw && typeof raw === 'object' ? raw : {};
  const rawOffline: Record<string, unknown> =
    safeRaw.offlineLLM && typeof safeRaw.offlineLLM === 'object' ? { ...safeRaw.offlineLLM } : {};

  if (typeof safeRaw.llmBaseUrl === 'string' && safeRaw.llmBaseUrl.trim() && !rawOffline.baseURL) {
    rawOffline.baseURL = safeRaw.llmBaseUrl.trim();
    if (rawOffline.useDshLlm === undefined) rawOffline.useDshLlm = false;
  }
  if (typeof safeRaw.llmApiKey === 'string' && safeRaw.llmApiKey.trim() && !rawOffline.apiKey) {
    rawOffline.apiKey = safeRaw.llmApiKey.trim();
  }
  if (typeof safeRaw.llmModel === 'string' && safeRaw.llmModel.trim() && !rawOffline.model) {
    rawOffline.model = safeRaw.llmModel.trim();
  }

  // 安全策略：不再通过遗留别名 llmBaseUrl / llmApiKey 隐式开启 privacy.offlineConsent
  const rawPrivacy: Record<string, unknown> =
    safeRaw.privacy && typeof safeRaw.privacy === 'object' ? { ...safeRaw.privacy } : {};
  const rawEmbedding: Record<string, unknown> =
    safeRaw.embedding && typeof safeRaw.embedding === 'object' ? { ...safeRaw.embedding } : {};

  const parsed = PluginConfigSchema.parse({
    ...DEFAULTS,
    ...safeRaw,
    offlineLLM: { ...DEFAULTS.offlineLLM, ...rawOffline },
    embedding: { ...DEFAULTS.embedding, ...rawEmbedding },
    privacy: { ...DEFAULTS.privacy, ...rawPrivacy },
    excludeWorkspaces: safeRaw.excludeWorkspaces ?? DEFAULTS.excludeWorkspaces,
  });

  const cfg: PluginConfig = parsed;

  // 预算联动约束：hardBudgetTokens >= stableBudgetTokens + dynamicBudgetTokens
  if (cfg.stableBudgetTokens > cfg.hardBudgetTokens) {
    cfg.stableBudgetTokens = cfg.hardBudgetTokens;
  }
  const maxDynamic = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  if (
    typeof safeRaw.dynamicBudgetTokens !== 'number' ||
    !Number.isInteger(safeRaw.dynamicBudgetTokens) ||
    safeRaw.dynamicBudgetTokens < 0
  ) {
    cfg.dynamicBudgetTokens = Math.min(DEFAULTS.dynamicBudgetTokens, maxDynamic);
  } else if (cfg.dynamicBudgetTokens > maxDynamic) {
    cfg.dynamicBudgetTokens = maxDynamic;
  }

  // embedding 校验：openai-compatible 需合法 model 与有效正整数 dim（<= 8192）
  if (cfg.embedding.provider === 'none') {
    cfg.embedding.dim = 0;
  } else if (cfg.embedding.provider === 'openai-compatible') {
    if (
      !cfg.embedding.model.trim() ||
      !Number.isInteger(cfg.embedding.dim) ||
      cfg.embedding.dim <= 0 ||
      cfg.embedding.dim > 8192
    ) {
      cfg.embedding.provider = 'none';
      cfg.embedding.dim = 0;
    }
  }

  cfg.offlineLLM.baseURL = cfg.offlineLLM.baseURL.trim();
  cfg.offlineLLM.model = cfg.offlineLLM.model.trim();
  cfg.offlineLLM.apiKeyEnv = cfg.offlineLLM.apiKeyEnv.trim();
  cfg.embedding.baseURL = cfg.embedding.baseURL.trim();
  cfg.embedding.model = cfg.embedding.model.trim();
  cfg.embedding.apiKeyEnv = cfg.embedding.apiKeyEnv.trim();

  return cfg;
}

/**
 * 控制台可以修改的配置项。覆盖层只保存这些键：若保存整份合并后的配置，
 * 之后宿主配置里新增的 excludeWorkspaces、预算等修改都会被旧快照盖掉。
 */
const OVERRIDE_KEYS = [
  'offlineLLM',
  'privacy',
  'embedding',
  'dailyLLMCalls',
  'dailyLLMTokens',
  'distillMaxInputTokens',
] as const;

function pickOverride(source: Record<string, any> | null | undefined): Record<string, any> {
  const picked: Record<string, any> = {};
  if (!source || typeof source !== 'object') return picked;
  for (const key of OVERRIDE_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

function readStoredOverride(db: Db): Record<string, any> | null {
  const row = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
    'config_override',
  ]);
  if (!row?.value) return null;
  return pickOverride(JSON.parse(row.value));
}

export function loadConfigFromDb(db: Db, baseCfg: PluginConfig = DEFAULTS): PluginConfig {
  try {
    const parsed = readStoredOverride(db);
    if (parsed) {
      return validateConfig({
        ...baseCfg,
        ...parsed,
        offlineLLM: { ...baseCfg.offlineLLM, ...(parsed.offlineLLM || {}) },
        privacy: { ...baseCfg.privacy, ...(parsed.privacy || {}) },
        embedding: { ...baseCfg.embedding, ...(parsed.embedding || {}) },
      });
    }
  } catch (err) {
    console.warn(
      '[dsh-memory] Failed to load config_override from meta:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return validateConfig(baseCfg);
}

export function saveConfigToDb(
  db: Db,
  patch: Partial<PluginConfig>,
  baseCfg: PluginConfig = DEFAULTS
): PluginConfig {
  return db.transaction(() => {
    let stored: Record<string, any> = {};
    try {
      stored = readStoredOverride(db) || {};
    } catch {}
    const incoming = pickOverride(patch as Record<string, any>);
    const override: Record<string, any> = { ...stored, ...incoming };
    if (stored.offlineLLM || incoming.offlineLLM) {
      override.offlineLLM = { ...(stored.offlineLLM || {}), ...(incoming.offlineLLM || {}) };
    }
    if (stored.privacy || incoming.privacy) {
      override.privacy = { ...(stored.privacy || {}), ...(incoming.privacy || {}) };
    }
    if (stored.embedding || incoming.embedding) {
      override.embedding = { ...(stored.embedding || {}), ...(incoming.embedding || {}) };
    }
    db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      'config_override',
      JSON.stringify(override),
    ]);
    return loadConfigFromDb(db, baseCfg);
  });
}
