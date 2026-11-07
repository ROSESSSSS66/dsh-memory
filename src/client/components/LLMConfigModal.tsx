import React, { useState, useEffect, useRef, useCallback } from 'react';

export type LLMProtocolType = 'chat/completions' | 'responses' | 'messages';

export interface LLMConfigData {
  offlineLLM: {
    useDshLlm: boolean;
    baseURL: string;
    model: string;
    apiKeyEnv: string;
    apiKeyMasked: string;
    hasApiKey: boolean;
    protocol?: LLMProtocolType;
  };
  privacy: {
    offlineConsent: boolean;
    allowedOfflineEndpoints: string[];
  };
  dailyLLMCalls: number;
  dailyLLMTokens: number;
}

export interface LLMConfigModalProps {
  open: boolean;
  config: LLMConfigData | null;
  onClose: () => void;
  onSave: (payload: {
    offlineLLM: {
      useDshLlm: boolean;
      baseURL: string;
      model: string;
      apiKeyEnv: string;
      apiKey?: string;
      protocol: LLMProtocolType;
    };
    privacy: {
      offlineConsent: boolean;
    };
    dailyLLMCalls: number;
    dailyLLMTokens: number;
  }) => Promise<void>;
  onTestConnection?: (payload: {
    baseURL: string;
    model: string;
    apiKey?: string;
    apiKeyEnv: string;
    protocol: LLMProtocolType;
  }) => Promise<{ ok: boolean; latencyMs?: number; error?: string; protocol?: string }>;
}

const PRESETS: Array<{
  key: string;
  label: string;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  protocol: LLMProtocolType;
}> = [
  {
    key: 'deepseek',
    label: 'DeepSeek (api.deepseek.com)',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'openai-chat',
    label: 'OpenAI Chat Completions',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'openai-responses',
    label: 'OpenAI Responses API',
    baseURL: 'https://api.openai.com/v1/responses',
    model: 'gpt-4.1-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    protocol: 'responses',
  },
  {
    key: 'anthropic',
    label: 'Anthropic Claude Messages',
    baseURL: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-latest',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    protocol: 'messages',
  },
  {
    key: 'dashscope',
    label: '通义千问 DashScope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'ollama',
    label: 'Ollama 本地模型 (127.0.0.1:11434)',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    apiKeyEnv: '',
    protocol: 'chat/completions',
  },
];

export function LLMConfigModal({
  open,
  config,
  onClose,
  onSave,
  onTestConnection,
}: LLMConfigModalProps) {
  const [baseURL, setBaseURL] = useState('https://api.deepseek.com/v1');
  const [model, setModel] = useState('deepseek-chat');
  const [protocol, setProtocol] = useState<LLMProtocolType>('chat/completions');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyEnv, setApiKeyEnv] = useState('DEEPSEEK_API_KEY');
  const [dailyCalls, setDailyCalls] = useState(40);
  const [dailyTokens, setDailyTokens] = useState(200000);

  const [dirty, setDirty] = useState(false);
  const [statusText, setStatusText] = useState('修改将自动保存并即时热生效');
  const [statusTone, setStatusTone] = useState<'muted' | 'ok' | 'err'>('muted');

  const latestRef = useRef({
    baseURL,
    model,
    protocol,
    apiKey,
    apiKeyEnv,
    dailyCalls,
    dailyTokens,
    dirty,
  });
  latestRef.current = {
    baseURL,
    model,
    protocol,
    apiKey,
    apiKeyEnv,
    dailyCalls,
    dailyTokens,
    dirty,
  };

  useEffect(() => {
    if (config && open) {
      setBaseURL(config.offlineLLM.baseURL || 'https://api.deepseek.com/v1');
      setModel(config.offlineLLM.model || 'deepseek-chat');
      setProtocol(config.offlineLLM.protocol || 'chat/completions');
      setApiKeyEnv(config.offlineLLM.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
      setApiKey('');
      setDailyCalls(config.dailyLLMCalls || 40);
      setDailyTokens(config.dailyLLMTokens || 200000);
      setDirty(false);
      setStatusText('修改将自动保存并即时热生效');
      setStatusTone('muted');
    }
  }, [config, open]);

  const flushSave = useCallback(
    async (verifyAfter = false) => {
      const cur = latestRef.current;
      if (!cur.dirty) return;
      setDirty(false);
      setStatusText('正在自动保存...');
      setStatusTone('muted');
      try {
        await onSave({
          offlineLLM: {
            useDshLlm: false,
            baseURL: cur.baseURL.trim(),
            model: cur.model.trim() || 'deepseek-chat',
            apiKeyEnv: cur.apiKeyEnv.trim(),
            apiKey: cur.apiKey.trim() !== '' ? cur.apiKey.trim() : undefined,
            protocol: cur.protocol,
          },
          privacy: {
            offlineConsent: true,
          },
          dailyLLMCalls: Math.max(1, Number(cur.dailyCalls) || 40),
          dailyLLMTokens: Math.max(1000, Number(cur.dailyTokens) || 200000),
        });

        if (verifyAfter && onTestConnection && cur.baseURL.trim()) {
          const testRes = await onTestConnection({
            baseURL: cur.baseURL.trim(),
            model: cur.model.trim() || 'deepseek-chat',
            apiKey: cur.apiKey.trim() || undefined,
            apiKeyEnv: cur.apiKeyEnv.trim(),
            protocol: cur.protocol,
          });
          if (testRes.ok) {
            setStatusText(
              `已自动保存 · 连通正常 (${testRes.latencyMs ?? 0}ms)`
            );
            setStatusTone('ok');
            return;
          } else if (testRes.error) {
            setStatusText(`已保存配置 · 连通提示: ${testRes.error}`);
            setStatusTone('err');
            return;
          }
        }

        setStatusText('已自动保存并激活全自动后台进化');
        setStatusTone('ok');
      } catch {
        setStatusText('保存失败，请检查网络连接');
        setStatusTone('err');
      }
    },
    [onSave, onTestConnection]
  );

  // Debounced auto-save when any field changes
  useEffect(() => {
    if (!open || !dirty) return;
    const t = setTimeout(() => {
      flushSave(true);
    }, 550);
    return () => clearTimeout(t);
  }, [open, dirty, baseURL, model, protocol, apiKey, apiKeyEnv, dailyCalls, dailyTokens, flushSave]);

  const handleClose = useCallback(async () => {
    if (latestRef.current.dirty) {
      await flushSave(false);
    }
    onClose();
  }, [flushSave, onClose]);

  // Esc key to save & close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  if (!open) return null;

  const handlePresetSelect = (key: string) => {
    const found = PRESETS.find((p) => p.key === key);
    if (!found) return;
    setBaseURL(found.baseURL);
    setModel(found.model);
    setApiKeyEnv(found.apiKeyEnv);
    setProtocol(found.protocol);
    setDirty(true);
  };

  return (
    <div className="dshm-backdrop" onClick={handleClose}>
      <div
        className="dshm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="模型配置"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dshm-sheet-head">
          <h2 className="dshm-sheet-title">模型配置</h2>
          <span
            className="dshm-sheet-close"
            role="presentation"
            title="保存并关闭 (Esc)"
            onClick={handleClose}
          >
            ×
          </span>
        </div>

        <form
          onSubmit={async (e) => {
            e.preventDefault();
            await flushSave(true);
            onClose();
          }}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          {/* Row 1: Provider Preset */}
          <div className="dshm-settings-row">
            <div className="dshm-settings-label-row">
              <label className="dshm-settings-label">服务商预设</label>
              <span className="dshm-settings-desc">仅用于后台慢环进化，0 热路径阻塞</span>
            </div>
            <select
              className="dshm-field-select"
              defaultValue=""
              onChange={(e) => handlePresetSelect(e.target.value)}
            >
              <option value="" disabled>
                选择主流模型服务商快速填充...
              </option>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} · {p.model}
                </option>
              ))}
            </select>
          </div>

          {/* Row 2: Base URL & Protocol */}
          <div className="dshm-settings-row">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label className="dshm-settings-label">接口地址 (Base URL)</label>
                <input
                  className="dshm-field-input dshm-field-input--mono"
                  value={baseURL}
                  onChange={(e) => {
                    setBaseURL(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="https://api.deepseek.com/v1"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label className="dshm-settings-label">协议类型</label>
                <select
                  className="dshm-field-select"
                  value={protocol}
                  onChange={(e) => {
                    setProtocol(e.target.value as LLMProtocolType);
                    setDirty(true);
                  }}
                >
                  <option value="chat/completions">Chat Completions</option>
                  <option value="responses">Responses API</option>
                  <option value="messages">Anthropic Messages</option>
                </select>
              </div>
            </div>
          </div>

          {/* Row 3: Model ID */}
          <div className="dshm-settings-row">
            <label className="dshm-settings-label">模型名称 (Model ID)</label>
            <input
              className="dshm-field-input dshm-field-input--mono"
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                setDirty(true);
              }}
              placeholder="deepseek-chat / gpt-4o-mini / claude-3-5-haiku-latest"
            />
          </div>

          {/* Row 4: API Key & Env Fallback */}
          <div className="dshm-settings-row">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.3fr 1fr',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div className="dshm-settings-label-row">
                  <label className="dshm-settings-label">API Key</label>
                  {config?.offlineLLM.hasApiKey && (
                    <span
                      style={{
                        fontSize: 11,
                        fontFamily: 'var(--dshm-font-code)',
                        color: 'var(--dshm-valley-green)',
                      }}
                    >
                      已保存 ({config.offlineLLM.apiKeyMasked})
                    </span>
                  )}
                </div>
                <input
                  type="password"
                  className="dshm-field-input dshm-field-input--mono"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    setDirty(true);
                  }}
                  placeholder={
                    config?.offlineLLM.hasApiKey
                      ? '留空保持不变，输入新密钥自动覆盖'
                      : 'sk-...'
                  }
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label className="dshm-settings-label">环境变量兜底</label>
                <input
                  className="dshm-field-input dshm-field-input--mono"
                  value={apiKeyEnv}
                  onChange={(e) => {
                    setApiKeyEnv(e.target.value);
                    setDirty(true);
                  }}
                  placeholder="DEEPSEEK_API_KEY"
                />
              </div>
            </div>
          </div>

          {/* Row 5: Daily Guardrail Quotas */}
          <div className="dshm-settings-row">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label className="dshm-settings-label">每日调用上限 (次)</label>
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className="dshm-field-input dshm-field-input--mono"
                  value={dailyCalls}
                  onChange={(e) => {
                    setDailyCalls(Number(e.target.value));
                    setDirty(true);
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label className="dshm-settings-label">每日 Token 上限</label>
                <input
                  type="number"
                  min={1000}
                  step={10000}
                  className="dshm-field-input dshm-field-input--mono"
                  value={dailyTokens}
                  onChange={(e) => {
                    setDailyTokens(Number(e.target.value));
                    setDirty(true);
                  }}
                />
              </div>
            </div>
          </div>
        </form>

        <div className="dshm-sheet-foot">
          <span
            style={{
              color:
                statusTone === 'ok'
                  ? 'var(--dshm-valley-green)'
                  : statusTone === 'err'
                    ? 'var(--dshm-danger)'
                    : 'var(--dshm-ink-3)',
            }}
          >
            ● {statusText}
          </span>
          <span>点击外部或按 Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
