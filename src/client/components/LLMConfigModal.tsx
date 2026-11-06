import * as React from 'react';
import type { LLMConfigUI, LLMTestResponse } from '../types.js';
import { saveLLMConfig, testLLMConnection } from '../api.js';
import { GlassModal, GlassButton, GlassInput } from './GlassUI.js';
import {
  EyeIcon,
  EyeOffIcon,
  ZapIcon,
  CheckCircleIcon,
  XCircleIcon,
  ShieldIcon,
  SettingsIcon,
} from './Icons.js';

interface LLMConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: LLMConfigUI | null;
  onSaved: (updated: LLMConfigUI) => void;
  onToast: (msg: string) => void;
}

const PRESETS = [
  {
    name: 'DeepSeek 官方',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    protocol: 'chat/completions' as const,
    tag: '官方',
  },
  {
    name: 'dorodoro-api',
    baseURL: 'https://www.dorodoro.xyz/v1',
    model: 'deepseek-chat',
    protocol: 'chat/completions' as const,
    tag: '推荐',
  },
];

export const LLMConfigModal: React.FC<LLMConfigModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaved,
  onToast,
}) => {
  const [baseURL, setBaseURL] = React.useState('');
  const [model, setModel] = React.useState('');
  const [protocol, setProtocol] = React.useState<'chat/completions' | 'responses' | 'messages'>('chat/completions');
  const [apiKey, setApiKey] = React.useState('');
  const [apiKeyEnv, setApiKeyEnv] = React.useState('');
  const [offlineConsent, setOfflineConsent] = React.useState(false);
  const [dailyLLMCalls, setDailyLLMCalls] = React.useState(40);
  const [dailyLLMTokens, setDailyLLMTokens] = React.useState(200000);
  const [distillMaxInputTokens, setDistillMaxInputTokens] = React.useState(6000);

  const [showApiKey, setShowApiKey] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<LLMTestResponse | null>(null);
  const [isSaving, setIsSaving] = React.useState(false);

  // Sync state when config loads or modal opens
  React.useEffect(() => {
    if (config) {
      setBaseURL(config.offlineLLM.baseURL || '');
      setModel(config.offlineLLM.model || 'deepseek-chat');
      setProtocol(config.offlineLLM.protocol || 'chat/completions');
      setApiKey(''); // never pre-fill raw key; keep blank unless user changes it
      setApiKeyEnv(config.offlineLLM.apiKeyEnv || '');
      setOfflineConsent(!!config.privacy.offlineConsent);
      setDailyLLMCalls(config.dailyLLMCalls || 40);
      setDailyLLMTokens(config.dailyLLMTokens || 200000);
      setDistillMaxInputTokens(config.distillMaxInputTokens || 6000);
      setTestResult(null);
    }
  }, [config, isOpen]);

  if (!isOpen) return null;

  const handleApplyPreset = (p: (typeof PRESETS)[0]) => {
    setBaseURL(p.baseURL);
    setModel(p.model);
    if ((p as any).protocol) {
      setProtocol((p as any).protocol);
    }
    setTestResult(null);
  };

  const handleTest = async () => {
    if (!baseURL.trim()) {
      onToast('请先填写接口 Base URL');
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await testLLMConnection({
        baseURL: baseURL.trim(),
        model: model.trim() || 'deepseek-chat',
        apiKey: apiKey.trim() || undefined,
        apiKeyEnv: apiKeyEnv.trim() || undefined,
        protocol,
      });
      setTestResult(res);
    } catch (err: any) {
      setTestResult({ ok: false, error: err?.message || '测试连接异常' });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!baseURL.trim()) {
      onToast('请填写接口 Base URL');
      return;
    }

    setIsSaving(true);
    try {
      const payload: any = {
        offlineLLM: {
          baseURL: baseURL.trim(),
          model: model.trim() || 'deepseek-chat',
          apiKeyEnv: apiKeyEnv.trim(),
          protocol,
        },
        privacy: {
          offlineConsent,
        },
        dailyLLMCalls: Number(dailyLLMCalls) || 40,
        dailyLLMTokens: Number(dailyLLMTokens) || 200000,
        distillMaxInputTokens: Number(distillMaxInputTokens) || 6000,
      };

      if (apiKey.trim()) {
        payload.offlineLLM.apiKey = apiKey.trim();
      }

      const res = await saveLLMConfig(payload);
      onSaved(res.config);
      onToast('LLM 配置已成功保存并立即生效');
      onClose();
    } catch (err: any) {
      onToast(err?.message || '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <GlassModal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      headerLeft={
        <div className="dshm-config-title-group">
          <div className="dshm-config-icon-badge">
            <SettingsIcon size={18} />
          </div>
          <div>
            <h2 className="dshm-modal-title">模型与进化配置</h2>
            <span className="dshm-config-header-desc">
              配置离线后台蒸馏、自主反思所使用的模型及安全风控配额
            </span>
          </div>
        </div>
      }
      footer={
        <>
          <GlassButton onClick={onClose} disabled={isSaving}>
            取消
          </GlassButton>
          <GlassButton
            intent="primary"
            onClick={() => handleSave()}
            disabled={isSaving}
          >
            <span>{isSaving ? '正在保存…' : '保存配置'}</span>
          </GlassButton>
        </>
      }
    >
      <form onSubmit={handleSave} className="dshm-detail-stack">
        {/* Quick Presets */}
        <div className="dshm-config-section">
          <div className="dshm-config-section-title">快捷预设提供商</div>
          <div className="dshm-presets-grid">
            {PRESETS.map((p) => {
              const isActive = baseURL === p.baseURL && model === p.model;
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`dshm-preset-card ${isActive ? 'dshm-preset-card-active' : ''}`}
                  onClick={() => handleApplyPreset(p)}
                >
                  <span className="dshm-preset-name">{p.name}</span>
                  {p.tag && <span className="dshm-preset-tag">{p.tag}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* Core LLM Settings */}
        <div className="dshm-config-section">
          <div className="dshm-config-section-title">接口连接参数</div>

          <div className="dshm-form-group">
            <label className="dshm-form-label">
              接口基础地址 (Base URL) <span className="dshm-required">*</span>
            </label>
            <GlassInput
              type="text"
              placeholder="https://api.deepseek.com/v1 或 https://www.dorodoro.xyz/v1"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              required
            />
          </div>

          <div className="dshm-form-group">
            <label className="dshm-form-label">调用协议模式 (Protocol)</label>
            <div className="dshm-protocol-tabs">
              <button
                type="button"
                className={`dshm-protocol-tab ${
                  protocol === 'chat/completions' ? 'dshm-protocol-tab-active' : ''
                }`}
                onClick={() => setProtocol('chat/completions')}
              >
                <span className="dshm-proto-code">/chat/completions</span>
                <span className="dshm-proto-desc">OpenAI 经典协议</span>
              </button>
              <button
                type="button"
                className={`dshm-protocol-tab ${
                  protocol === 'responses' ? 'dshm-protocol-tab-active' : ''
                }`}
                onClick={() => setProtocol('responses')}
              >
                <span className="dshm-proto-code">/responses</span>
                <span className="dshm-proto-desc">OpenAI Responses</span>
              </button>
              <button
                type="button"
                className={`dshm-protocol-tab ${
                  protocol === 'messages' ? 'dshm-protocol-tab-active' : ''
                }`}
                onClick={() => setProtocol('messages')}
              >
                <span className="dshm-proto-code">/messages</span>
                <span className="dshm-proto-desc">Claude Messages</span>
              </button>
            </div>
            <span className="dshm-form-hint">
              {protocol === 'chat/completions' && (
                <>标准 OpenAI 兼容协议（自动调用 <code>/chat/completions</code>）</>
              )}
              {protocol === 'responses' && (
                <>OpenAI 新版 Responses 协议（自动调用 <code>/responses</code>）</>
              )}
              {protocol === 'messages' && (
                <>Anthropic Claude 协议（自动调用 <code>/messages</code>，附带 x-api-key 与 2023-06-01 版本头）</>
              )}
            </span>
          </div>

          <div className="dshm-form-row">
            <div className="dshm-form-group dshm-col-half">
              <label className="dshm-form-label">
                模型标识 (Model) <span className="dshm-required">*</span>
              </label>
              <GlassInput
                type="text"
                placeholder="deepseek-chat / deepseek-r1"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                required
              />
            </div>

            <div className="dshm-form-group dshm-col-half">
              <label className="dshm-form-label">或环境变量名称</label>
              <GlassInput
                type="text"
                placeholder="例如 DEEPSEEK_API_KEY"
                value={apiKeyEnv}
                onChange={(e) => setApiKeyEnv(e.target.value)}
              />
            </div>
          </div>

          <div className="dshm-form-group">
            <label className="dshm-form-label">
              API 密钥 (API Key)
              {config?.offlineLLM.hasApiKey && (
                <span className="dshm-badge-has-key">
                  ✓ 当前已有密钥: {config.offlineLLM.apiKeyMasked}
                </span>
              )}
            </label>
            <div className="dshm-input-with-action">
              <GlassInput
                type={showApiKey ? 'text' : 'password'}
                placeholder={
                  config?.offlineLLM.hasApiKey
                    ? '保持现有密钥不变（如需更换请重新输入）'
                    : 'sk-… (输入站点 API 密钥)'
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <button
                type="button"
                className="dshm-input-action-btn"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? '隐藏密钥' : '显示密钥'}
              >
                {showApiKey ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
              </button>
            </div>
            <span className="dshm-form-hint">
              本地安全存储在 SQLite，不随日志或代码外泄；优先使用填写的密钥，若为空则读取上方环境变量。
            </span>
          </div>
        </div>

        {/* Test Connection Banner */}
        <div className="dshm-config-test-box">
          <div className="dshm-test-box-left">
            <GlassButton onClick={handleTest} disabled={isTesting}>
              <ZapIcon size={14} />
              <span>{isTesting ? '连通性测试中…' : '测试连通性'}</span>
            </GlassButton>
            <span className="dshm-test-hint">发送极简 ping 探测端点延迟与权限有效性</span>
          </div>

          {testResult && (
            <div
              className={`dshm-test-badge ${
                testResult.ok ? 'dshm-test-badge-ok' : 'dshm-test-badge-err'
              }`}
            >
              {testResult.ok ? (
                <>
                  <CheckCircleIcon size={14} />
                  <span>
                    连接成功 · 延迟 <strong>{testResult.latencyMs}ms</strong> · 协议{' '}
                    <strong>/{testResult.protocol || protocol}</strong> · 模型{' '}
                    <strong>{testResult.model}</strong>
                  </span>
                </>
              ) : (
                <>
                  <XCircleIcon size={14} />
                  <span>{testResult.error || '连接失败'}</span>
                </>
              )}
            </div>
          )}
        </div>

        {/* Privacy & Sentinel Gate */}
        <div className="dshm-config-section">
          <div className="dshm-config-section-title">自主进化与风控闸门</div>

          <div className="dshm-consent-card">
            <div className="dshm-consent-content">
              <div className="dshm-consent-title-row">
                <ShieldIcon size={16} />
                <span className="dshm-consent-title">
                  开启离线自主进化 (后台提炼与模式学习)
                </span>
              </div>
              <p className="dshm-consent-desc">
                开启后，插件将在空闲时使用上述模型对会话历史提炼长期规律与编程习惯。
                <strong>系统默认执行严格脱敏与黑名单闸门</strong>：自动抹除任何 PEM 密钥、JWT、带密 URL 及排他工作区路径。
              </p>
            </div>
            <label className="dshm-switch">
              <input
                type="checkbox"
                checked={offlineConsent}
                onChange={(e) => setOfflineConsent(e.target.checked)}
              />
              <span className="dshm-slider" />
            </label>
          </div>
        </div>

        {/* Daily Quotas & Token Budget */}
        <div className="dshm-config-section">
          <div className="dshm-config-section-title">每日调用额度与 Token 预算</div>
          <div className="dshm-form-row">
            <div className="dshm-form-group dshm-col-third">
              <label className="dshm-form-label">每日最大请求数</label>
              <GlassInput
                type="number"
                min="1"
                max="1000"
                value={dailyLLMCalls}
                onChange={(e) => setDailyLLMCalls(parseInt(e.target.value, 10) || 40)}
              />
              <span className="dshm-form-hint">次 / 天 (默认 40)</span>
            </div>

            <div className="dshm-form-group dshm-col-third">
              <label className="dshm-form-label">每日 Token 上限</label>
              <GlassInput
                type="number"
                min="1000"
                step="10000"
                max="5000000"
                value={dailyLLMTokens}
                onChange={(e) =>
                  setDailyLLMTokens(parseInt(e.target.value, 10) || 200000)
                }
              />
              <span className="dshm-form-hint">Tokens (默认 200k)</span>
            </div>

            <div className="dshm-form-group dshm-col-third">
              <label className="dshm-form-label">单次蒸馏最大输入</label>
              <GlassInput
                type="number"
                min="500"
                step="500"
                max="32000"
                value={distillMaxInputTokens}
                onChange={(e) =>
                  setDistillMaxInputTokens(parseInt(e.target.value, 10) || 6000)
                }
              />
              <span className="dshm-form-hint">Tokens (默认 6,000)</span>
            </div>
          </div>
        </div>
      </form>
    </GlassModal>
  );
};
