import type { UiLocale } from './types.js';

export interface UiMessages {
  panelLabel: string;
  header: {
    title: string;
    running: string;
    loading: string;
    offline: string;
    health: (grade: string, score?: number) => string;
    strategy: (version: number) => string;
    configButton: string;
    configReadyTitle: (model: string) => string;
    configUnsetTitle: string;
    dshHostLabel: string;
    workspaceLabel: string;
    workspaceCount: (count: number) => string;
    defaultWorkspace: string;
  };
  banners: {
    offlineTitle: string;
    offlineDetail: (detail: string) => string;
    retry: string;
    pendingRepairs: (count: number) => string;
    networkError: string;
    serviceUnavailable: string;
    invalidResponse: string;
  };
  overview: {
    ariaLabel: string;
    title: string;
    caption: string;
    tokUnit: string;
    tiles: {
      activeLabel: string;
      activeSub: (total: number, candidate: number) => string;
      healthLabel: string;
      healthSubHealing: string;
      healthSubVector: (ready: number, total: number) => string;
      healthSubSynced: string;
      dynamicLabel: string;
      dynamicSub: (budget: number) => string;
      stableLabel: string;
      stableSub: (budget: number) => string;
      accuracyLabel: string;
      accuracySub: (injections: number) => string;
      quotaLabel: string;
      quotaSub: (tokensK: string) => string;
      syncing: string;
    };
    yardstick: {
      legend: (stable: number, core: number, dynamic: number) => string;
      hardCap: (hardBudget: number) => string;
    };
  };
  coreMemory: {
    ariaLabel: string;
    title: string;
    sub: string;
    emptyBlock: string;
    blocks: Record<string, string>;
  };
  epistemic: {
    ariaLabel: string;
    title: string;
    summaryCounts: (models: number, indexed: number) => string;
    hindsightTitle: string;
    networks: {
      world: string;
      experience: string;
      observation: string;
      opinion: string;
    };
    mentalModelsTitle: string;
    mentalModelsEmpty: string;
    vikingTitle: string;
    vikingTotal: (total: number) => string;
    vikingEmpty: string;
    vikingCategories: Record<string, string>;
    confidence: (pct: number) => string;
  };
  memories: {
    ariaLabel: string;
    title: string;
    searchPlaceholder: string;
    searchAria: string;
    countSummary: (loaded: number, total: number, isFiltered: boolean) => string;
    clickToExpand: string;
    emptyReady: string;
    emptyFiltered: string;
    loadingState: string;
    loadMore: (remaining: number) => string;
    loadingMore: string;
    meta: {
      id: string;
      network: string;
      uri: string;
      version: string;
      scope: string;
      confidence: string;
      importance: string;
      recall: (useCount: number, successCount: number, failCount: number) => string;
      cost: (tokens: number) => string;
    };
    types: Record<string, string>;
    scopes: Record<string, string>;
  };
  jobs: {
    ariaLabel: string;
    title: string;
    sub: string;
    attempts: (count: number) => string;
    status: Record<string, string>;
  };
  errorBoundary: {
    title: string;
    description: string;
    retry: string;
  };
  modal: {
    title: string;
    closeAria: string;
    presetLabel: string;
    presetDesc: string;
    presetPlaceholder: string;
    presets: Record<string, string>;
    dshHostDefaultModel: string;
    consentLabel: string;
    consentDesc: string;
    baseUrlLabel: string;
    baseUrlPlaceholderDsh: string;
    baseUrlPlaceholderCustom: string;
    protocolLabel: string;
    protocols: {
      chatCompletions: string;
      responses: string;
      messages: string;
    };
    modelLabel: string;
    modelPlaceholderDsh: string;
    modelPlaceholderCustom: string;
    apiKeyLabel: string;
    apiKeySaved: (masked: string) => string;
    apiKeyClearBtn: string;
    apiKeyClearAria: string;
    apiKeyClearing: string;
    apiKeyUndoBtn: string;
    apiKeyPlaceholderSaved: string;
    apiKeyPlaceholderEmpty: string;
    apiKeyEnvLabel: string;
    dailyCallsLabel: string;
    dailyTokensLabel: string;
    embeddingSectionTitle: string;
    embeddingSectionBadgeOn: string;
    embeddingSectionBadgeOff: string;
    embeddingProviderLabel: string;
    embeddingProviderNone: string;
    embeddingProviderOpenai: string;
    embeddingBaseUrlLabel: string;
    embeddingBaseUrlPlaceholder: string;
    embeddingModelLabel: string;
    embeddingModelPlaceholder: string;
    embeddingDimLabel: string;
    embeddingApiKeyLabel: string;
    embeddingApiKeyEnvLabel: string;
    saveAndTestBtn: string;
    saveBtn: string;
    savingBtn: string;
    statusReady: string;
    statusSaving: string;
    statusTesting: string;
    statusSavedOk: string;
    statusSavedLocalOnly: string;
    statusSavedDsh: string;
    statusTestOk: (latencyMs: number, model?: string) => string;
    statusTestWarn: (error: string) => string;
    statusSaveErr: (error: string) => string;
    validationInvalidCalls: string;
    validationInvalidTokens: string;
    validationInvalidDim: string;
    footerHint: string;
  };
  time: {
    justNow: string;
    minutesAgo: (n: number) => string;
    hoursAgo: (n: number) => string;
    daysAgo: (n: number) => string;
  };
}

const ZH_MESSAGES: UiMessages = {
  panelLabel: '长期记忆',
  header: {
    title: '长期记忆',
    running: '全自动闭环运行中',
    loading: '正在同步记忆引擎...',
    offline: '记忆服务暂不可达',
    health: (grade, score) =>
      score !== undefined ? `健康度 ${grade} (${score})` : `健康度 ${grade}`,
    strategy: (version) => `策略 v${version}`,
    configButton: '模型配置',
    configReadyTitle: (model) => `后台进化模型已就绪: ${model}`,
    configUnsetTitle: '配置后台慢环进化模型',
    dshHostLabel: 'DSH Host',
    workspaceLabel: '切换工作区',
    workspaceCount: (count) => `${count} 条`,
    defaultWorkspace: '当前工作区',
  },
  banners: {
    offlineTitle: '无法连接长期记忆服务',
    offlineDetail: (detail) => `已暂停状态更新（${detail}），本地存储未受影响。`,
    retry: '重新同步',
    pendingRepairs: (count) => `${count} 项待处理修复建议`,
    networkError: '网络连接异常',
    serviceUnavailable: '服务暂不可用',
    invalidResponse: '服务响应格式异常',
  },
  overview: {
    ariaLabel: '系统概览',
    title: 'Overview',
    caption: '本地七路混合快环 < 1ms · 128D 内联向量 · 每 8s 自动同步',
    tokUnit: 'tok',
    tiles: {
      activeLabel: '生效记忆',
      activeSub: (total, candidate) => `共 ${total} · 观察 ${candidate}`,
      healthLabel: '健康医生',
      healthSubHealing: '自愈同步中',
      healthSubVector: (ready, total) => `FTS5 · 向量 ${ready}/${total}`,
      healthSubSynced: 'FTS5 · 向量同步',
      dynamicLabel: '单轮动态注入',
      dynamicSub: (budget) => `/ ${budget} 上限`,
      stableLabel: '常驻稳定层',
      stableSub: (budget) => `/ ${budget} 预算`,
      accuracyLabel: '归因信噪比',
      accuracySub: (injections) => `累计 ${injections} 轮`,
      quotaLabel: '今日慢环配额',
      quotaSub: (tokensK) => `${tokensK}k tok`,
      syncing: '同步中',
    },
    yardstick: {
      legend: (stable, core, dynamic) =>
        `常驻稳定层 ${stable}t (Core ${core}t) · 动态检索层 ${dynamic}t`,
      hardCap: (hardBudget) => `总上下文硬上限 ${hardBudget} tok`,
    },
  },
  coreMemory: {
    ariaLabel: '常驻核心记忆',
    title: '常驻核心记忆 · Core Memory',
    sub: '智能体对话与高效用规则自动演进同步',
    emptyBlock: '等待智能体自动提炼填充...',
    blocks: {
      human: 'Human · 用户画像',
      persona: 'Persona · 协作准则',
      project: 'Project · 工程规范',
    },
  },
  epistemic: {
    ariaLabel: '认知网络与上下文目录',
    title: '认知洞察 · Hindsight & OpenViking',
    summaryCounts: (models, indexed) => `${models} 心智模型 · ${indexed} 目录节点`,
    hindsightTitle: 'Hindsight 四维记忆网络',
    networks: {
      world: 'WORLD · 事实',
      experience: 'EXPERIENCE · 经验',
      observation: 'OBSERVATION · 观察',
      opinion: 'OPINION · 观点',
    },
    mentalModelsTitle: '综合心智模型',
    mentalModelsEmpty: '尚未沉淀心智模型，后台慢环反思后将自动生成。',
    vikingTitle: 'OpenViking L0/L1 上下文目录',
    vikingTotal: (total) => `共索引 ${total} 条`,
    vikingEmpty: '目录暂无索引节点。',
    vikingCategories: {
      core: '核心块',
      preferences: '偏好',
      entities: '实体事实',
      events: '情景事件',
      cases: '排错案例',
      skills: '流程技能',
      models: '心智模型',
      profile: '用户画像',
    },
    confidence: (pct) => `置信 ${pct}%`,
  },
  memories: {
    ariaLabel: '活跃记忆流',
    title: '活跃记忆流 · Active Memories',
    searchPlaceholder: '搜索槽位 / 内容 / 类型...',
    searchAria: '搜索活跃记忆',
    countSummary: (loaded, total, isFiltered) =>
      isFiltered ? `匹配 ${loaded} / ${total} 条` : `已加载 ${loaded} / ${total} 条`,
    clickToExpand: '点击行展开',
    emptyReady:
      '全自动记忆引擎已就绪。在对话过程中，系统将自动捕获事实、开发偏好与排错经验，并在后台完成冲突消解与沉淀。',
    emptyFiltered: '未匹配到符合当前搜索词的记忆。清空搜索框即可查看全部生效记忆。',
    loadingState: '正在加载活跃记忆...',
    loadMore: (remaining) => `加载更多（剩余 ${remaining} 条）`,
    loadingMore: '正在加载...',
    meta: {
      id: 'ID',
      network: '网络',
      uri: 'URI',
      version: '版本',
      scope: '作用域',
      confidence: '置信度',
      importance: '重要度',
      recall: (useCount, successCount, failCount) => {
        if (successCount > 0 || failCount > 0) {
          return `召回: ${useCount} 次 (+${successCount} / -${failCount})`;
        }
        return `召回: ${useCount} 次`;
      },
      cost: (tokens) => `开销: ${tokens} tok`,
    },
    types: {
      semantic: '事实',
      preference: '偏好',
      procedural: '流程',
      episodic: '情景',
      failure: '教训',
      belief: '推断',
      goal: '目标',
      meta: '元认知',
    },
    scopes: {
      global: '全局',
      user: '用户',
      workspace: '工作区',
      session: '会话',
    },
  },
  jobs: {
    ariaLabel: '后台自治流水',
    title: '后台自治流水 · Slow-Loop Jobs',
    sub: '水位线无死锁闭环调度',
    attempts: (count) => `第 ${count} 次`,
    status: {
      pending: '排队中',
      running: '执行中',
      done: '已完成',
      failed: '失败',
    },
  },
  errorBoundary: {
    title: '记忆面板渲染遇到异常',
    description: '界面渲染出现意外错误，后端长期记忆引擎不受影响。',
    retry: '重新加载面板',
  },
  modal: {
    title: '模型配置',
    closeAria: '关闭模型配置',
    presetLabel: '服务商预设',
    presetDesc: '仅用于后台慢环进化，0 热路径阻塞',
    presetPlaceholder: '选择主流模型服务商快速填充...',
    presets: {
      'dsh-host': 'DSH 宿主内置模型（零外部配置）',
      deepseek: 'DeepSeek (api.deepseek.com)',
      'openai-chat': 'OpenAI Chat Completions',
      'openai-responses': 'OpenAI Responses API',
      anthropic: 'Anthropic Claude Messages',
      dashscope: '通义千问 DashScope',
      ollama: 'Ollama 本地模型 (127.0.0.1:11434)',
    },
    dshHostDefaultModel: '宿主默认模型',
    consentLabel: '授权后台慢环外发数据',
    consentDesc: '开启后，后台提炼与冲突消解可将脱敏文本发送至以下模型端点；关闭后仅在本地运行。',
    baseUrlLabel: '接口地址 (Base URL)',
    baseUrlPlaceholderDsh: '当前使用 DSH 宿主内置通道（输入地址可切换自定义接口）',
    baseUrlPlaceholderCustom: 'https://api.deepseek.com/v1',
    protocolLabel: '协议类型',
    protocols: {
      chatCompletions: 'Chat Completions',
      responses: 'Responses API',
      messages: 'Anthropic Messages',
    },
    modelLabel: '模型名称 (Model ID)',
    modelPlaceholderDsh: '留空自动继承 DSH 宿主默认模型',
    modelPlaceholderCustom: 'deepseek-chat / gpt-4o-mini / claude-3-5-haiku-latest',
    apiKeyLabel: 'API Key',
    apiKeySaved: (masked) => `已保存 (${masked})`,
    apiKeyClearBtn: '清空',
    apiKeyClearAria: '清空已保存的 API Key',
    apiKeyClearing: '保存后清空密钥',
    apiKeyUndoBtn: '撤销',
    apiKeyPlaceholderSaved: '留空保持不变，输入新密钥覆盖',
    apiKeyPlaceholderEmpty: 'sk-...',
    apiKeyEnvLabel: '环境变量兜底',
    dailyCallsLabel: '每日调用上限 (次)',
    dailyTokensLabel: '每日 Token 上限',
    embeddingSectionTitle: '远程 Embedding 向量通道（可选）',
    embeddingSectionBadgeOn: '已启用',
    embeddingSectionBadgeOff: '本地 128D',
    embeddingProviderLabel: '向量提供方',
    embeddingProviderNone: '仅本地 128D 内联向量（默认，零外发）',
    embeddingProviderOpenai: 'OpenAI 兼容接口（异常自动回退本地）',
    embeddingBaseUrlLabel: 'Embedding 接口地址',
    embeddingBaseUrlPlaceholder: 'https://api.openai.com/v1/embeddings',
    embeddingModelLabel: 'Embedding 模型',
    embeddingModelPlaceholder: 'text-embedding-3-small',
    embeddingDimLabel: '向量维度 (0=自动)',
    embeddingApiKeyLabel: 'Embedding API Key',
    embeddingApiKeyEnvLabel: 'Embedding 环境变量',
    saveAndTestBtn: '保存并测试',
    saveBtn: '保存配置',
    savingBtn: '保存中...',
    statusReady: '修改后点击保存或按 Enter 生效',
    statusSaving: '正在保存配置...',
    statusTesting: '配置已保存 · 正在检测连通性...',
    statusSavedOk: '已保存并激活后台慢环进化',
    statusSavedLocalOnly: '已保存（后台外发已关闭，仅本地快环运行）',
    statusSavedDsh: '已保存并启用 DSH 宿主内置模型通道',
    statusTestOk: (latencyMs, model) =>
      model
        ? `已保存 · 连通正常 (${latencyMs}ms · ${model})`
        : `已保存 · 连通正常 (${latencyMs}ms)`,
    statusTestWarn: (error) => `配置已保存 · 连通提示：${error}`,
    statusSaveErr: (error) => `保存失败：${error}`,
    validationInvalidCalls: '每日调用上限需为 1 - 10000 之间的整数',
    validationInvalidTokens: '每日 Token 上限需为 1000 - 100000000 之间的整数',
    validationInvalidDim: '向量维度需为 0 - 8192 之间的整数',
    footerHint: 'Esc 或点击外部关闭',
  },
  time: {
    justNow: '刚刚',
    minutesAgo: (n) => `${n}m 前`,
    hoursAgo: (n) => `${n}h 前`,
    daysAgo: (n) => `${n}d 前`,
  },
};

const EN_MESSAGES: UiMessages = {
  panelLabel: 'Memory',
  header: {
    title: 'Long-Term Memory',
    running: 'Autonomous loop active',
    loading: 'Syncing memory engine...',
    offline: 'Memory service unreachable',
    health: (grade, score) =>
      score !== undefined ? `Health ${grade} (${score})` : `Health ${grade}`,
    strategy: (version) => `Strategy v${version}`,
    configButton: 'Model Settings',
    configReadyTitle: (model) => `Background evolution model ready: ${model}`,
    configUnsetTitle: 'Configure background slow-loop model',
    dshHostLabel: 'DSH Host',
    workspaceLabel: 'Switch workspace',
    workspaceCount: (count) => `${count}`,
    defaultWorkspace: 'Default workspace',
  },
  banners: {
    offlineTitle: 'Unable to reach memory service',
    offlineDetail: (detail) => `Live sync paused (${detail}). Local storage remains intact.`,
    retry: 'Retry',
    pendingRepairs: (count) =>
      count === 1 ? '1 pending repair proposal' : `${count} pending repair proposals`,
    networkError: 'Network error',
    serviceUnavailable: 'Service unavailable',
    invalidResponse: 'Invalid server response',
  },
  overview: {
    ariaLabel: 'System overview',
    title: 'Overview',
    caption: '7-channel local recall < 1ms · 128D vectors · 8s auto-sync',
    tokUnit: 'tok',
    tiles: {
      activeLabel: 'Active Memories',
      activeSub: (total, candidate) => `${total} total · ${candidate} pending`,
      healthLabel: 'Memory Health',
      healthSubHealing: 'Self-healing FTS',
      healthSubVector: (ready, total) => `FTS5 · Vectors ${ready}/${total}`,
      healthSubSynced: 'FTS5 · Vectors synced',
      dynamicLabel: 'Dynamic Recall / Turn',
      dynamicSub: (budget) => `/ ${budget} cap`,
      stableLabel: 'Stable Prompt Layer',
      stableSub: (budget) => `/ ${budget} budget`,
      accuracyLabel: 'Signal Accuracy',
      accuracySub: (injections) => `${injections} turns`,
      quotaLabel: 'Daily Slow-Loop Quota',
      quotaSub: (tokensK) => `${tokensK}k tok`,
      syncing: 'Syncing',
    },
    yardstick: {
      legend: (stable, core, dynamic) =>
        `Stable layer ${stable}t (Core ${core}t) · Dynamic recall ${dynamic}t`,
      hardCap: (hardBudget) => `Hard context cap ${hardBudget} tok`,
    },
  },
  coreMemory: {
    ariaLabel: 'Core Memory',
    title: 'Core Memory · Stable Layer',
    sub: 'Auto-evolved from dialogues and high-utility rules',
    emptyBlock: 'Waiting for autonomous distillation...',
    blocks: {
      human: 'Human · Profile',
      persona: 'Persona · Collaboration',
      project: 'Project · Engineering',
    },
  },
  epistemic: {
    ariaLabel: 'Epistemic networks and context tree',
    title: 'Epistemic Insights · Hindsight & OpenViking',
    summaryCounts: (models, indexed) => `${models} mental models · ${indexed} indexed`,
    hindsightTitle: 'Hindsight 4-Network Bank',
    networks: {
      world: 'WORLD',
      experience: 'EXPERIENCE',
      observation: 'OBSERVATION',
      opinion: 'OPINION',
    },
    mentalModelsTitle: 'Synthesized Mental Models',
    mentalModelsEmpty:
      'No mental models yet. Synthesized automatically during slow-loop reflection.',
    vikingTitle: 'OpenViking L0/L1 Context Tree',
    vikingTotal: (total) => `${total} indexed`,
    vikingEmpty: 'No indexed nodes yet.',
    vikingCategories: {
      core: 'Core',
      preferences: 'Preferences',
      entities: 'Entities',
      events: 'Events',
      cases: 'Cases',
      skills: 'Skills',
      models: 'Mental Models',
      profile: 'Profile',
    },
    confidence: (pct) => `Conf ${pct}%`,
  },
  memories: {
    ariaLabel: 'Active Memories',
    title: 'Active Memories',
    searchPlaceholder: 'Search slot / content / type...',
    searchAria: 'Search active memories',
    countSummary: (loaded, total, isFiltered) =>
      isFiltered ? `${loaded} / ${total} matched` : `${loaded} / ${total} loaded`,
    clickToExpand: 'Click row to expand',
    emptyReady:
      'Autonomous memory engine is ready. Facts, preferences, and debugging lessons will be distilled and reconciled automatically in the background.',
    emptyFiltered:
      'No memories match your search query. Clear the filter to view all active memories.',
    loadingState: 'Loading active memories...',
    loadMore: (remaining) => `Load more (${remaining} remaining)`,
    loadingMore: 'Loading...',
    meta: {
      id: 'ID',
      network: 'Network',
      uri: 'URI',
      version: 'Version',
      scope: 'Scope',
      confidence: 'Confidence',
      importance: 'Importance',
      recall: (useCount, successCount, failCount) => {
        if (successCount > 0 || failCount > 0) {
          return `Recalls: ${useCount} (+${successCount} / -${failCount})`;
        }
        return `Recalls: ${useCount}`;
      },
      cost: (tokens) => `Cost: ${tokens} tok`,
    },
    types: {
      semantic: 'Fact',
      preference: 'Pref',
      procedural: 'Rule',
      episodic: 'Event',
      failure: 'Lesson',
      belief: 'Belief',
      goal: 'Goal',
      meta: 'Meta',
    },
    scopes: {
      global: 'Global',
      user: 'User',
      workspace: 'Workspace',
      session: 'Session',
    },
  },
  jobs: {
    ariaLabel: 'Slow-Loop Jobs',
    title: 'Slow-Loop Jobs',
    sub: 'Watermark-scheduled autonomous loop',
    attempts: (count) => `try #${count}`,
    status: {
      pending: 'pending',
      running: 'running',
      done: 'done',
      failed: 'failed',
    },
  },
  errorBoundary: {
    title: 'Memory Studio encountered an error',
    description:
      'An unexpected rendering error occurred. Your background memory engine is unaffected.',
    retry: 'Reload Studio',
  },
  modal: {
    title: 'Model Settings',
    closeAria: 'Close model settings',
    presetLabel: 'Provider Preset',
    presetDesc: 'Used only for background slow-loop evolution; zero hot-path latency',
    presetPlaceholder: 'Choose a provider preset to prefill...',
    presets: {
      'dsh-host': 'DSH Host Built-in Model (Zero external config)',
      deepseek: 'DeepSeek (api.deepseek.com)',
      'openai-chat': 'OpenAI Chat Completions',
      'openai-responses': 'OpenAI Responses API',
      anthropic: 'Anthropic Claude Messages',
      dashscope: 'Alibaba DashScope (Qwen)',
      ollama: 'Ollama Local Model (127.0.0.1:11434)',
    },
    dshHostDefaultModel: 'Host default model',
    consentLabel: 'Allow background model egress',
    consentDesc:
      'When enabled, slow-loop distillation and consolidation may send redacted excerpts to the configured endpoint. Disable to stay strictly local.',
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholderDsh: 'Using DSH host LLM channel (enter a URL to override)',
    baseUrlPlaceholderCustom: 'https://api.deepseek.com/v1',
    protocolLabel: 'Protocol',
    protocols: {
      chatCompletions: 'Chat Completions',
      responses: 'Responses API',
      messages: 'Anthropic Messages',
    },
    modelLabel: 'Model ID',
    modelPlaceholderDsh: 'Leave blank to inherit DSH host default model',
    modelPlaceholderCustom: 'deepseek-chat / gpt-4o-mini / claude-3-5-haiku-latest',
    apiKeyLabel: 'API Key',
    apiKeySaved: (masked) => `Saved (${masked})`,
    apiKeyClearBtn: 'Clear',
    apiKeyClearAria: 'Clear saved API key',
    apiKeyClearing: 'Key will be cleared',
    apiKeyUndoBtn: 'Undo',
    apiKeyPlaceholderSaved: 'Leave blank to keep existing key, or enter a new one',
    apiKeyPlaceholderEmpty: 'sk-...',
    apiKeyEnvLabel: 'Env Var Fallback',
    dailyCallsLabel: 'Daily Calls Cap',
    dailyTokensLabel: 'Daily Token Cap',
    embeddingSectionTitle: 'Remote Embedding Channel (Optional)',
    embeddingSectionBadgeOn: 'Enabled',
    embeddingSectionBadgeOff: 'Local 128D',
    embeddingProviderLabel: 'Embedding Provider',
    embeddingProviderNone: 'Local 128D inline vectors only (default, offline)',
    embeddingProviderOpenai: 'OpenAI-compatible API (auto-fallback to local)',
    embeddingBaseUrlLabel: 'Embedding Base URL',
    embeddingBaseUrlPlaceholder: 'https://api.openai.com/v1/embeddings',
    embeddingModelLabel: 'Embedding Model',
    embeddingModelPlaceholder: 'text-embedding-3-small',
    embeddingDimLabel: 'Vector Dim (0 = auto)',
    embeddingApiKeyLabel: 'Embedding API Key',
    embeddingApiKeyEnvLabel: 'Embedding Env Var',
    saveAndTestBtn: 'Save & Test',
    saveBtn: 'Save',
    savingBtn: 'Saving...',
    statusReady: 'Click Save or press Enter to apply changes',
    statusSaving: 'Saving configuration...',
    statusTesting: 'Saved · verifying connectivity...',
    statusSavedOk: 'Saved and activated background evolution',
    statusSavedLocalOnly: 'Saved (offline egress disabled; local-only mode)',
    statusSavedDsh: 'Saved and enabled DSH host model channel',
    statusTestOk: (latencyMs, model) =>
      model
        ? `Saved · connected (${latencyMs}ms · ${model})`
        : `Saved · connected (${latencyMs}ms)`,
    statusTestWarn: (error) => `Saved · connectivity notice: ${error}`,
    statusSaveErr: (error) => `Save failed: ${error}`,
    validationInvalidCalls: 'Daily calls cap must be an integer between 1 and 10000',
    validationInvalidTokens: 'Daily token cap must be an integer between 1000 and 100000000',
    validationInvalidDim: 'Vector dimension must be an integer between 0 and 8192',
    footerHint: 'Esc or click outside to close',
  },
  time: {
    justNow: 'just now',
    minutesAgo: (n) => `${n}m ago`,
    hoursAgo: (n) => `${n}h ago`,
    daysAgo: (n) => `${n}d ago`,
  },
};

export const UI_DICTIONARIES: Record<UiLocale, UiMessages> = {
  zh: ZH_MESSAGES,
  en: EN_MESSAGES,
};

export function resolveUiLocale(raw?: unknown): UiLocale {
  const candidate = extractLocaleString(raw);
  if (candidate) {
    const lower = candidate.toLowerCase();
    if (lower.startsWith('zh')) return 'zh';
    if (lower.startsWith('en')) return 'en';
  }
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    if (navigator.language.toLowerCase().startsWith('zh')) return 'zh';
    if (navigator.language.toLowerCase().startsWith('en')) return 'en';
  }
  if (typeof document !== 'undefined' && typeof document.documentElement?.lang === 'string') {
    if (document.documentElement.lang.toLowerCase().startsWith('zh')) return 'zh';
  }
  return 'en';
}

function extractLocaleString(raw: unknown): string {
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['current', 'locale', 'lang', 'language', 'value']) {
      if (typeof obj[key] === 'string' && obj[key].trim()) {
        return obj[key].trim();
      }
    }
    if (typeof obj.get === 'function') {
      try {
        const res = (obj.get as () => unknown)();
        if (typeof res === 'string' && res.trim()) return res.trim();
      } catch {
        // ignore host getter error
      }
    }
  }
  return '';
}

export function getMessages(locale: UiLocale): UiMessages {
  return UI_DICTIONARIES[locale] ?? EN_MESSAGES;
}

export function formatRelativeTime(ts: number | null | undefined, locale: UiLocale): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const t = getMessages(locale);
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return t.time.justNow;

  const langTag = locale === 'zh' ? 'zh-CN' : 'en';
  const minutes = Math.floor(diffSec / 60);
  const hours = Math.floor(diffSec / 3600);
  const days = Math.floor(diffSec / 86400);

  if (days >= 30) {
    try {
      return new Date(ts).toLocaleDateString(langTag);
    } catch {
      return new Date(ts).toISOString().slice(0, 10);
    }
  }

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function') {
      const rtf = new Intl.RelativeTimeFormat(langTag, {
        numeric: 'auto',
        style: 'narrow',
      });
      if (diffSec < 3600) return rtf.format(-minutes, 'minute');
      if (diffSec < 86400) return rtf.format(-hours, 'hour');
      return rtf.format(-days, 'day');
    }
  } catch {
    // fallback below
  }

  if (diffSec < 3600) return t.time.minutesAgo(minutes);
  if (diffSec < 86400) return t.time.hoursAgo(hours);
  return t.time.daysAgo(days);
}
