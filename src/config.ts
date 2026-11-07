export const DEFAULTS = {
  enabled: true,
  dataDir: '', // 为空时使用 <dshHome>/storages/dsh-memory
  dbPath: '', // 为空时使用 <dshHome>/storages/dsh-memory/memory.db
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
  // 向量（默认关闭）
  embedding: {
    provider: 'none' as 'none' | 'openai-compatible',
    baseURL: '',
    model: '',
    apiKeyEnv: '',
    dim: 0,
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

export type PluginConfig = Omit<typeof DEFAULTS, 'offlineLLM'> & {
  offlineLLM: OfflineLLMConfig;
};

export function validateConfig(raw: Partial<PluginConfig> & Record<string, any> = {}): PluginConfig {
  const rawOffline: Partial<OfflineLLMConfig> = { ...(raw.offlineLLM || {}) };
  if (typeof raw.llmBaseUrl === 'string' && raw.llmBaseUrl.trim() && !rawOffline.baseURL) {
    rawOffline.baseURL = raw.llmBaseUrl.trim();
    if (rawOffline.useDshLlm === undefined) rawOffline.useDshLlm = false;
  }
  if (typeof raw.llmApiKey === 'string' && raw.llmApiKey.trim() && !rawOffline.apiKey) {
    rawOffline.apiKey = raw.llmApiKey.trim();
  }
  if (typeof raw.llmModel === 'string' && raw.llmModel.trim() && !rawOffline.model) {
    rawOffline.model = raw.llmModel.trim();
  }

  const rawPrivacy = { ...(raw.privacy || {}) };
  if ((raw.llmBaseUrl || raw.llmApiKey) && rawPrivacy.offlineConsent === undefined) {
    rawPrivacy.offlineConsent = true;
  }

  const cfg: PluginConfig = {
    ...DEFAULTS,
    ...raw,
    offlineLLM: { ...DEFAULTS.offlineLLM, ...rawOffline },
    embedding: { ...DEFAULTS.embedding, ...(raw.embedding || {}) },
    privacy: { ...DEFAULTS.privacy, ...rawPrivacy },
    excludeWorkspaces: Array.isArray(raw.excludeWorkspaces)
      ? [...raw.excludeWorkspaces]
      : [...DEFAULTS.excludeWorkspaces],
  };

  // hardBudgetTokens 为正整数
  if (typeof cfg.hardBudgetTokens !== 'number' || !Number.isInteger(cfg.hardBudgetTokens) || cfg.hardBudgetTokens <= 0) {
    cfg.hardBudgetTokens = DEFAULTS.hardBudgetTokens;
  }

  // stableBudgetTokens 为非负整数，且 <= hardBudgetTokens
  if (typeof cfg.stableBudgetTokens !== 'number' || !Number.isInteger(cfg.stableBudgetTokens) || cfg.stableBudgetTokens < 0) {
    cfg.stableBudgetTokens = DEFAULTS.stableBudgetTokens;
  }
  if (cfg.stableBudgetTokens > cfg.hardBudgetTokens) {
    cfg.stableBudgetTokens = cfg.hardBudgetTokens;
  }

  // dynamicBudgetTokens 为非负整数，且 <= hardBudgetTokens - stableBudgetTokens
  const maxDynamic = Math.max(0, cfg.hardBudgetTokens - cfg.stableBudgetTokens);
  if (typeof cfg.dynamicBudgetTokens !== 'number' || !Number.isInteger(cfg.dynamicBudgetTokens) || cfg.dynamicBudgetTokens < 0) {
    cfg.dynamicBudgetTokens = Math.min(DEFAULTS.dynamicBudgetTokens, maxDynamic);
  } else if (cfg.dynamicBudgetTokens > maxDynamic) {
    cfg.dynamicBudgetTokens = maxDynamic;
  }

  // 其余正整数校验
  const positiveIntFields: (keyof PluginConfig)[] = [
    'onlineBudgetMs',
    'maxItems',
    'queryMaxChars',
    'maxContentTokens',
    'maxSummaryTokens',
    'maxEntitiesPerText',
    'dailyLLMCalls',
    'dailyLLMTokens',
    'distillMaxInputTokens',
    'distillMinEvents',
    'idleMinutes',
    'jobTimeoutMs',
    'coldDays',
    'consolidateMaxClusters',
    'repairCooldownDays',
    'labCandidates',
    'labMinEvalCases',
    'maxLabItems',
  ];

  for (const field of positiveIntFields) {
    const val = cfg[field];
    if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
      (cfg as any)[field] = DEFAULTS[field];
    }
  }

  // 概率与相似度在 [0,1] 且有限
  const ratioFields: (keyof PluginConfig)[] = [
    'minLexicalCoverage',
    'minVectorSimilarity',
    'dupJaccard',
    'utilityLR',
  ];

  for (const field of ratioFields) {
    const val = cfg[field];
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      (cfg as any)[field] = DEFAULTS[field];
    }
  }

  // embedding 校验
  if (cfg.embedding.provider === 'none') {
    cfg.embedding.dim = 0;
  } else if (cfg.embedding.provider === 'openai-compatible') {
    if (!cfg.embedding.model || typeof cfg.embedding.dim !== 'number' || cfg.embedding.dim <= 0) {
      // 回退为 none
      cfg.embedding.provider = 'none';
      cfg.embedding.dim = 0;
    }
  } else {
    cfg.embedding.provider = 'none';
    cfg.embedding.dim = 0;
  }

  // offlineLLM protocol 校验
  const validProtocols = ['chat/completions', 'responses', 'messages'];
  if (!validProtocols.includes(cfg.offlineLLM.protocol as string)) {
    cfg.offlineLLM.protocol = 'chat/completions';
  }

  // 默认 scope 校验
  if (!['session', 'workspace', 'user', 'global'].includes(cfg.defaultScope)) {
    cfg.defaultScope = DEFAULTS.defaultScope;
  }

  return cfg;
}

function ensureConfiguredEndpointAllowed(cfg: PluginConfig): PluginConfig {
  const baseURL = cfg.offlineLLM?.baseURL?.trim();
  if (
    cfg.privacy?.offlineConsent &&
    baseURL &&
    (!Array.isArray(cfg.privacy.allowedOfflineEndpoints) ||
      cfg.privacy.allowedOfflineEndpoints.length === 0)
  ) {
    const allowed = new Set<string>([baseURL]);
    try {
      const u = new URL(baseURL);
      allowed.add(u.origin);
    } catch {}
    cfg.privacy.allowedOfflineEndpoints = Array.from(allowed);
  }
  return cfg;
}

export function loadConfigFromDb(db: any, baseCfg: PluginConfig = DEFAULTS): PluginConfig {
  try {
    const row = db.get('SELECT value FROM meta WHERE key = ?', ['config_override']);
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      return ensureConfiguredEndpointAllowed(
        validateConfig({
          ...baseCfg,
          ...parsed,
          offlineLLM: { ...baseCfg.offlineLLM, ...(parsed.offlineLLM || {}) },
          privacy: { ...baseCfg.privacy, ...(parsed.privacy || {}) },
          embedding: { ...baseCfg.embedding, ...(parsed.embedding || {}) },
        })
      );
    }
  } catch {}
  return baseCfg;
}

export function saveConfigToDb(
  db: any,
  patch: Partial<PluginConfig>,
  baseCfg: PluginConfig = DEFAULTS
): PluginConfig {
  const current = loadConfigFromDb(db, baseCfg);
  const merged: any = {
    ...current,
    ...patch,
    offlineLLM: { ...current.offlineLLM, ...(patch.offlineLLM || {}) },
    privacy: { ...current.privacy, ...(patch.privacy || {}) },
    embedding: { ...current.embedding, ...(patch.embedding || {}) },
  };
  const updated = ensureConfiguredEndpointAllowed(validateConfig(merged));
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
    'config_override',
    JSON.stringify(updated),
  ]);
  return updated;
}

