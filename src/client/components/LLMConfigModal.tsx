import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getMessages } from '../i18n.js';
import type {
  ConfigSavePayload,
  EmbeddingProviderType,
  LLMConfigData,
  LLMProtocolType,
  LLMTestPayload,
  LLMTestResult,
  UiLocale,
} from '../types.js';

export type {
  ConfigSavePayload,
  EmbeddingProviderType,
  LLMConfigData,
  LLMProtocolType,
  LLMTestPayload,
  LLMTestResult,
};

type CreatePortalFn = (
  children: React.ReactNode,
  container: Element | DocumentFragment
) => React.ReactPortal;

declare const require: ((id: string) => unknown) | undefined;

let cachedCreatePortal: CreatePortalFn | null | undefined;
function getCreatePortal(): CreatePortalFn | null {
  if (cachedCreatePortal !== undefined) return cachedCreatePortal;
  try {
    if (typeof require === 'function') {
      const mod = require('react-dom') as { createPortal?: unknown } | null | undefined;
      if (mod && typeof mod.createPortal === 'function') {
        cachedCreatePortal = mod.createPortal as CreatePortalFn;
        return cachedCreatePortal;
      }
    }
  } catch {
    // Graceful fallback when react-dom is unavailable (e.g., SSR/tests)
  }
  cachedCreatePortal = null;
  return null;
}

function getOrigin(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return '';
  }
}

function parseBoundedInt(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export interface LLMConfigModalProps {
  open: boolean;
  config: LLMConfigData | null;
  locale: UiLocale;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSave: (payload: ConfigSavePayload) => Promise<void>;
  onTestConnection?: (payload: LLMTestPayload, signal?: AbortSignal) => Promise<LLMTestResult>;
}

const PRESETS: Array<{
  key: string;
  useDshLlm?: boolean;
  baseURL: string;
  model: string;
  apiKeyEnv: string;
  protocol: LLMProtocolType;
}> = [
  {
    key: 'dsh-host',
    useDshLlm: true,
    baseURL: '',
    model: '',
    apiKeyEnv: '',
    protocol: 'chat/completions',
  },
  {
    key: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'openai-chat',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'openai-responses',
    baseURL: 'https://api.openai.com/v1/responses',
    model: 'gpt-4.1-mini',
    apiKeyEnv: 'OPENAI_API_KEY',
    protocol: 'responses',
  },
  {
    key: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1/messages',
    model: 'claude-3-5-haiku-latest',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    protocol: 'messages',
  },
  {
    key: 'dashscope',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    protocol: 'chat/completions',
  },
  {
    key: 'ollama',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    apiKeyEnv: '',
    protocol: 'chat/completions',
  },
];

interface FormSnapshot {
  useDshLlm: boolean;
  offlineConsent: boolean;
  baseURL: string;
  model: string;
  protocol: LLMProtocolType;
  apiKey: string;
  clearKeyRequested: boolean;
  apiKeyEnv: string;
  dailyCalls: string;
  dailyTokens: string;
  embeddingProvider: EmbeddingProviderType;
  embeddingBaseURL: string;
  embeddingModel: string;
  embeddingDim: string;
  embeddingApiKey: string;
  clearEmbeddingKeyRequested: boolean;
  embeddingApiKeyEnv: string;
  dirty: boolean;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function LLMConfigModal({
  open,
  config,
  locale,
  returnFocusRef,
  onClose,
  onSave,
  onTestConnection,
}: LLMConfigModalProps) {
  const t = getMessages(locale);
  const idPrefix = useId();
  const titleId = `${idPrefix}-title`;
  const presetId = `${idPrefix}-preset`;
  const consentId = `${idPrefix}-consent`;
  const consentDescId = `${idPrefix}-consent-desc`;
  const baseUrlId = `${idPrefix}-baseurl`;
  const protocolId = `${idPrefix}-protocol`;
  const modelId = `${idPrefix}-model`;
  const apiKeyId = `${idPrefix}-apikey`;
  const apiKeyEnvId = `${idPrefix}-apikey-env`;
  const dailyCallsId = `${idPrefix}-daily-calls`;
  const dailyTokensId = `${idPrefix}-daily-tokens`;
  const embProviderId = `${idPrefix}-emb-provider`;
  const embBaseUrlId = `${idPrefix}-emb-baseurl`;
  const embModelId = `${idPrefix}-emb-model`;
  const embDimId = `${idPrefix}-emb-dim`;
  const embApiKeyId = `${idPrefix}-emb-apikey`;
  const embApiKeyEnvId = `${idPrefix}-emb-apikey-env`;

  const [useDshLlm, setUseDshLlm] = useState(true);
  const [offlineConsent, setOfflineConsent] = useState(false);
  const [baseURL, setBaseURL] = useState('');
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState<LLMProtocolType>('chat/completions');
  const [apiKey, setApiKey] = useState('');
  const [clearKeyRequested, setClearKeyRequested] = useState(false);
  const [apiKeyEnv, setApiKeyEnv] = useState('');
  const [dailyCalls, setDailyCalls] = useState('40');
  const [dailyTokens, setDailyTokens] = useState('200000');

  const [embeddingProvider, setEmbeddingProvider] = useState<EmbeddingProviderType>('none');
  const [embeddingBaseURL, setEmbeddingBaseURL] = useState('');
  const [embeddingModel, setEmbeddingModel] = useState('');
  const [embeddingDim, setEmbeddingDim] = useState('0');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');
  const [clearEmbeddingKeyRequested, setClearEmbeddingKeyRequested] = useState(false);
  const [embeddingApiKeyEnv, setEmbeddingApiKeyEnv] = useState('');

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState(t.modal.statusReady);
  const [statusTone, setStatusTone] = useState<'muted' | 'ok' | 'err'>('muted');

  const sheetRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const lastHydratedConfigRef = useRef<LLMConfigData | null>(null);
  const lastOriginRef = useRef<string>('');
  const lastEmbOriginRef = useRef<string>('');
  const saveSeqRef = useRef(0);
  const testAbortRef = useRef<AbortController | null>(null);

  const latestRef = useRef<FormSnapshot>({
    useDshLlm,
    offlineConsent,
    baseURL,
    model,
    protocol,
    apiKey,
    clearKeyRequested,
    apiKeyEnv,
    dailyCalls,
    dailyTokens,
    embeddingProvider,
    embeddingBaseURL,
    embeddingModel,
    embeddingDim,
    embeddingApiKey,
    clearEmbeddingKeyRequested,
    embeddingApiKeyEnv,
    dirty,
  });

  // Update ref inside effect (React 19 strict render purity — never mutate refs during render)
  useEffect(() => {
    latestRef.current = {
      useDshLlm,
      offlineConsent,
      baseURL,
      model,
      protocol,
      apiKey,
      clearKeyRequested,
      apiKeyEnv,
      dailyCalls,
      dailyTokens,
      embeddingProvider,
      embeddingBaseURL,
      embeddingModel,
      embeddingDim,
      embeddingApiKey,
      clearEmbeddingKeyRequested,
      embeddingApiKeyEnv,
      dirty,
    };
  }, [
    useDshLlm,
    offlineConsent,
    baseURL,
    model,
    protocol,
    apiKey,
    clearKeyRequested,
    apiKeyEnv,
    dailyCalls,
    dailyTokens,
    embeddingProvider,
    embeddingBaseURL,
    embeddingModel,
    embeddingDim,
    embeddingApiKey,
    clearEmbeddingKeyRequested,
    embeddingApiKeyEnv,
    dirty,
  ]);

  const abortInFlightTest = useCallback(() => {
    if (testAbortRef.current) {
      testAbortRef.current.abort();
      testAbortRef.current = null;
    }
  }, []);

  const markDirty = useCallback(() => {
    saveSeqRef.current += 1;
    abortInFlightTest();
    setDirty(true);
  }, [abortInFlightTest]);

  // Reset status & focus capture when modal opens/closes
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      lastHydratedConfigRef.current = null;
      setStatusText(t.modal.statusReady);
      setStatusTone('muted');
      if (typeof document !== 'undefined') {
        previouslyFocusedRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }
      const frame =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(() => {
              const sheet = sheetRef.current;
              if (!sheet) return;
              const firstFocusable = sheet.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
              if (firstFocusable) {
                firstFocusable.focus();
              } else {
                sheet.focus();
              }
            })
          : 0;
      return () => {
        if (frame && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(frame);
        }
      };
    }

    if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
      saveSeqRef.current += 1;
      abortInFlightTest();
      setApiKey('');
      setClearKeyRequested(false);
      setEmbeddingApiKey('');
      setClearEmbeddingKeyRequested(false);
      setDirty(false);
      const target = returnFocusRef?.current ?? previouslyFocusedRef.current;
      if (target && target.isConnected) {
        target.focus();
      }
      previouslyFocusedRef.current = null;
    }
    return undefined;
  }, [open, abortInFlightTest, returnFocusRef, t.modal.statusReady]);

  // Abort any in-flight connection test on unmount
  useEffect(() => {
    return () => {
      saveSeqRef.current += 1;
      abortInFlightTest();
    };
  }, [abortInFlightTest]);

  // Hydrate from server config when opened or refreshed while !dirty
  useEffect(() => {
    if (!open || !config || dirty) return;
    if (lastHydratedConfigRef.current === config) return;
    lastHydratedConfigRef.current = config;

    const isDsh = Boolean(config.offlineLLM.useDshLlm);
    const nextBaseUrl = config.offlineLLM.baseURL || '';
    setUseDshLlm(isDsh);
    setOfflineConsent(Boolean(config.privacy?.offlineConsent));
    setBaseURL(nextBaseUrl);
    lastOriginRef.current = getOrigin(nextBaseUrl);
    setModel(config.offlineLLM.model || '');
    setProtocol(config.offlineLLM.protocol || 'chat/completions');
    setApiKeyEnv(config.offlineLLM.apiKeyEnv ?? '');
    setApiKey('');
    setClearKeyRequested(false);
    setDailyCalls(String(config.dailyLLMCalls || 40));
    setDailyTokens(String(config.dailyLLMTokens || 200000));

    const emb = config.embedding;
    const nextEmbBaseUrl = emb?.baseURL || '';
    setEmbeddingProvider(emb?.provider === 'openai-compatible' ? 'openai-compatible' : 'none');
    setEmbeddingBaseURL(nextEmbBaseUrl);
    lastEmbOriginRef.current = getOrigin(nextEmbBaseUrl);
    setEmbeddingModel(emb?.model || '');
    setEmbeddingDim(String(emb?.dim ?? 0));
    setEmbeddingApiKey('');
    setClearEmbeddingKeyRequested(false);
    setEmbeddingApiKeyEnv(emb?.apiKeyEnv || '');
  }, [open, config, dirty]);

  const flushSave = useCallback(
    async (verifyAfter = false): Promise<boolean> => {
      const cur = latestRef.current;
      const callsVal = parseBoundedInt(cur.dailyCalls, 1, 10000);
      if (callsVal === null) {
        latestRef.current.dirty = false;
        setDirty(false);
        setStatusText(t.modal.validationInvalidCalls);
        setStatusTone('err');
        return false;
      }
      const tokensVal = parseBoundedInt(cur.dailyTokens, 1000, 100000000);
      if (tokensVal === null) {
        latestRef.current.dirty = false;
        setDirty(false);
        setStatusText(t.modal.validationInvalidTokens);
        setStatusTone('err');
        return false;
      }
      const dimVal = parseBoundedInt(cur.embeddingDim, 0, 8192);
      if (dimVal === null) {
        latestRef.current.dirty = false;
        setDirty(false);
        setStatusText(t.modal.validationInvalidDim);
        setStatusTone('err');
        return false;
      }

      const seq = ++saveSeqRef.current;
      abortInFlightTest();

      latestRef.current.dirty = false;
      setDirty(false);
      setSaving(true);
      setStatusText(t.modal.statusSaving);
      setStatusTone('muted');

      const trimmedBaseUrl = cur.baseURL.trim();
      const trimmedModel = cur.model.trim();
      const trimmedApiKeyEnv = cur.apiKeyEnv.trim();
      const trimmedApiKey = cur.apiKey.trim();
      const trimmedEmbBaseUrl = cur.embeddingBaseURL.trim();
      const trimmedEmbModel = cur.embeddingModel.trim();
      const trimmedEmbApiKeyEnv = cur.embeddingApiKeyEnv.trim();
      const trimmedEmbApiKey = cur.embeddingApiKey.trim();

      try {
        await onSave({
          offlineLLM: {
            useDshLlm: cur.useDshLlm,
            baseURL: trimmedBaseUrl,
            model: cur.useDshLlm ? trimmedModel : trimmedModel || 'deepseek-chat',
            apiKeyEnv: trimmedApiKeyEnv,
            apiKey: trimmedApiKey !== '' ? trimmedApiKey : undefined,
            clearApiKey: cur.clearKeyRequested && trimmedApiKey === '' ? true : undefined,
            protocol: cur.protocol,
          },
          privacy: {
            offlineConsent: cur.offlineConsent,
          },
          embedding: {
            provider: cur.embeddingProvider,
            baseURL: trimmedEmbBaseUrl,
            model: trimmedEmbModel,
            apiKeyEnv: trimmedEmbApiKeyEnv,
            apiKey: trimmedEmbApiKey !== '' ? trimmedEmbApiKey : undefined,
            clearApiKey:
              cur.clearEmbeddingKeyRequested && trimmedEmbApiKey === '' ? true : undefined,
            dim: dimVal,
          },
          dailyLLMCalls: callsVal,
          dailyLLMTokens: tokensVal,
        });
      } catch (err: unknown) {
        if (seq !== saveSeqRef.current) return false;
        setSaving(false);
        const msg = err instanceof Error && err.message ? err.message : String(err ?? '');
        setStatusText(t.modal.statusSaveErr(msg));
        setStatusTone('err');
        return false;
      }

      // Immediately wipe transient raw API keys after successful save (P0 leak fix)
      setApiKey('');
      setClearKeyRequested(false);
      setEmbeddingApiKey('');
      setClearEmbeddingKeyRequested(false);
      lastOriginRef.current = getOrigin(trimmedBaseUrl);
      lastEmbOriginRef.current = getOrigin(trimmedEmbBaseUrl);

      if (seq !== saveSeqRef.current) {
        setSaving(false);
        return true;
      }

      setSaving(false);

      if (!cur.offlineConsent) {
        setStatusText(t.modal.statusSavedLocalOnly);
        setStatusTone('ok');
        return true;
      }

      const canVerify =
        verifyAfter && Boolean(onTestConnection) && (cur.useDshLlm || Boolean(trimmedBaseUrl));

      if (canVerify && onTestConnection) {
        const controller = new AbortController();
        testAbortRef.current = controller;
        setStatusText(t.modal.statusTesting);
        setStatusTone('muted');

        // Separate try/catch so connectivity test errors NEVER report "Save failed"
        try {
          const testPayload: LLMTestPayload = cur.useDshLlm
            ? {
                useDshLlm: true,
                model: trimmedModel || undefined,
              }
            : {
                useDshLlm: false,
                baseURL: trimmedBaseUrl,
                model: trimmedModel || 'deepseek-chat',
                // Omit apiKey: onSave() just persisted it on the server for this endpoint
                apiKeyEnv: trimmedApiKeyEnv,
                protocol: cur.protocol,
              };

          const testRes = await onTestConnection(testPayload, controller.signal);
          if (seq !== saveSeqRef.current || controller.signal.aborted) {
            return true;
          }
          if (testRes.ok) {
            setStatusText(t.modal.statusTestOk(testRes.latencyMs ?? 0, testRes.model));
            setStatusTone('ok');
            return true;
          }
          if (testRes.error) {
            setStatusText(t.modal.statusTestWarn(testRes.error));
            setStatusTone('err');
            return true;
          }
        } catch (err: unknown) {
          if (
            seq !== saveSeqRef.current ||
            controller.signal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            return true;
          }
          const msg = err instanceof Error && err.message ? err.message : String(err ?? '');
          setStatusText(t.modal.statusTestWarn(msg));
          setStatusTone('err');
          return true;
        } finally {
          if (testAbortRef.current === controller) {
            testAbortRef.current = null;
          }
        }
      }

      setStatusText(cur.useDshLlm ? t.modal.statusSavedDsh : t.modal.statusSavedOk);
      setStatusTone('ok');
      return true;
    },
    [abortInFlightTest, onSave, onTestConnection, t]
  );

  const handleClose = useCallback(async () => {
    if (latestRef.current.dirty) {
      const ok = await flushSave(false);
      if (!ok) {
        // Keep modal open so the user sees why the save failed
        return;
      }
    }
    onClose();
  }, [flushSave, onClose]);

  // Keyboard handling: Esc to save & close, Tab / Shift+Tab focus trap
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void handleClose();
        return;
      }

      if (e.key === 'Tab') {
        const sheet = sheetRef.current;
        if (!sheet) return;
        const focusables = Array.from(
          sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
        if (focusables.length === 0) {
          e.preventDefault();
          sheet.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !sheet.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !sheet.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, handleClose]);

  if (!open) return null;

  const handlePresetSelect = (key: string) => {
    const found = PRESETS.find((p) => p.key === key);
    if (!found) return;
    setUseDshLlm(Boolean(found.useDshLlm));
    setBaseURL(found.baseURL);
    lastOriginRef.current = getOrigin(found.baseURL);
    setApiKeyEnv(found.apiKeyEnv);
    setModel(found.model);
    setProtocol(found.protocol);
    // P0 Leak Fix: wipe any staged API key when switching presets
    setApiKey('');
    setClearKeyRequested(false);
    markDirty();
  };

  const handleBaseUrlChange = (nextVal: string) => {
    const nextOrigin = getOrigin(nextVal);
    if (lastOriginRef.current && nextOrigin && nextOrigin !== lastOriginRef.current) {
      // P0 Leak Fix: wipe staged API key whenever endpoint origin changes
      setApiKey('');
      setClearKeyRequested(false);
    }
    if (nextOrigin) {
      lastOriginRef.current = nextOrigin;
    }
    setUseDshLlm(false);
    setBaseURL(nextVal);
    markDirty();
  };

  const handleEmbeddingBaseUrlChange = (nextVal: string) => {
    const nextOrigin = getOrigin(nextVal);
    if (lastEmbOriginRef.current && nextOrigin && nextOrigin !== lastEmbOriginRef.current) {
      setEmbeddingApiKey('');
      setClearEmbeddingKeyRequested(false);
    }
    if (nextOrigin) {
      lastEmbOriginRef.current = nextOrigin;
    }
    setEmbeddingBaseURL(nextVal);
    markDirty();
  };

  const modalContent = (
    <div className="dshm-portal-root" data-dsh-claude-quiet="">
      <div className="dshm-backdrop" data-dsh-claude-quiet="" onClick={() => void handleClose()}>
        <div
          ref={sheetRef}
          className="dshm-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dshm-sheet-head">
            <h2 id={titleId} className="dshm-sheet-title">
              {t.modal.title}
            </h2>
            <button
              type="button"
              className="dshm-sheet-close"
              aria-label={t.modal.closeAria}
              title={t.modal.closeAria}
              onClick={() => void handleClose()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>

          <form
            className="dshm-sheet-form"
            onSubmit={(e) => {
              e.preventDefault();
              void flushSave(true);
            }}
          >
            {/* Row 0: Explicit Privacy Egress Consent */}
            <div className="dshm-settings-row">
              <div className="dshm-consent-row">
                <div className="dshm-consent-text">
                  <label htmlFor={consentId} className="dshm-settings-label">
                    {t.modal.consentLabel}
                  </label>
                  <span id={consentDescId} className="dshm-settings-desc">
                    {t.modal.consentDesc}
                  </span>
                </div>
                <input
                  id={consentId}
                  type="checkbox"
                  className="dshm-consent-checkbox"
                  checked={offlineConsent}
                  aria-describedby={consentDescId}
                  onChange={(e) => {
                    setOfflineConsent(e.target.checked);
                    markDirty();
                  }}
                />
              </div>
            </div>

            {/* Row 1: Provider Preset */}
            <div className="dshm-settings-row">
              <div className="dshm-settings-label-row">
                <label htmlFor={presetId} className="dshm-settings-label">
                  {t.modal.presetLabel}
                </label>
                <span className="dshm-settings-desc">{t.modal.presetDesc}</span>
              </div>
              <select
                id={presetId}
                className="dshm-field-select"
                value=""
                onChange={(e) => handlePresetSelect(e.target.value)}
              >
                <option value="" disabled>
                  {t.modal.presetPlaceholder}
                </option>
                {PRESETS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {t.modal.presets[p.key] || p.key} · {p.model || t.modal.dshHostDefaultModel}
                  </option>
                ))}
              </select>
            </div>

            {/* Row 2: Base URL & Protocol */}
            <div className="dshm-settings-row">
              <div className="dshm-field-grid-ratio">
                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={baseUrlId} className="dshm-settings-label">
                      {t.modal.baseUrlLabel}
                    </label>
                  </div>
                  <input
                    id={baseUrlId}
                    type="text"
                    className="dshm-field-input dshm-field-input--mono"
                    value={baseURL}
                    spellCheck={false}
                    onChange={(e) => handleBaseUrlChange(e.target.value)}
                    placeholder={
                      useDshLlm ? t.modal.baseUrlPlaceholderDsh : t.modal.baseUrlPlaceholderCustom
                    }
                  />
                </div>

                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={protocolId} className="dshm-settings-label">
                      {t.modal.protocolLabel}
                    </label>
                  </div>
                  <select
                    id={protocolId}
                    className="dshm-field-select"
                    value={protocol}
                    onChange={(e) => {
                      setProtocol(e.target.value as LLMProtocolType);
                      markDirty();
                    }}
                  >
                    <option value="chat/completions">{t.modal.protocols.chatCompletions}</option>
                    <option value="responses">{t.modal.protocols.responses}</option>
                    <option value="messages">{t.modal.protocols.messages}</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Row 3: Model ID */}
            <div className="dshm-settings-row">
              <div className="dshm-settings-label-row">
                <label htmlFor={modelId} className="dshm-settings-label">
                  {t.modal.modelLabel}
                </label>
              </div>
              <input
                id={modelId}
                type="text"
                className="dshm-field-input dshm-field-input--mono"
                value={model}
                spellCheck={false}
                onChange={(e) => {
                  setModel(e.target.value);
                  markDirty();
                }}
                placeholder={
                  useDshLlm ? t.modal.modelPlaceholderDsh : t.modal.modelPlaceholderCustom
                }
              />
            </div>

            {/* Row 4: API Key & Env Fallback */}
            <div className="dshm-settings-row">
              <div className="dshm-field-grid-key">
                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={apiKeyId} className="dshm-settings-label">
                      {t.modal.apiKeyLabel}
                    </label>
                    {config?.offlineLLM.hasApiKey ? (
                      <span
                        className={
                          clearKeyRequested
                            ? 'dshm-key-status dshm-key-status--clearing'
                            : 'dshm-key-status'
                        }
                      >
                        <span>
                          {clearKeyRequested
                            ? t.modal.apiKeyClearing
                            : t.modal.apiKeySaved(config.offlineLLM.apiKeyMasked || '****')}
                        </span>
                        <button
                          type="button"
                          className="dshm-key-action-btn"
                          aria-label={
                            clearKeyRequested ? t.modal.apiKeyUndoBtn : t.modal.apiKeyClearAria
                          }
                          onClick={() => {
                            setClearKeyRequested((prev) => !prev);
                            setApiKey('');
                            markDirty();
                          }}
                        >
                          {clearKeyRequested ? t.modal.apiKeyUndoBtn : t.modal.apiKeyClearBtn}
                        </button>
                      </span>
                    ) : null}
                  </div>
                  <input
                    id={apiKeyId}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    className="dshm-field-input dshm-field-input--mono"
                    value={apiKey}
                    onChange={(e) => {
                      setClearKeyRequested(false);
                      setApiKey(e.target.value);
                      markDirty();
                    }}
                    placeholder={
                      config?.offlineLLM.hasApiKey
                        ? t.modal.apiKeyPlaceholderSaved
                        : t.modal.apiKeyPlaceholderEmpty
                    }
                  />
                </div>

                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={apiKeyEnvId} className="dshm-settings-label">
                      {t.modal.apiKeyEnvLabel}
                    </label>
                  </div>
                  <input
                    id={apiKeyEnvId}
                    type="text"
                    spellCheck={false}
                    className="dshm-field-input dshm-field-input--mono"
                    value={apiKeyEnv}
                    onChange={(e) => {
                      setApiKeyEnv(e.target.value);
                      markDirty();
                    }}
                    placeholder="DEEPSEEK_API_KEY"
                  />
                </div>
              </div>
            </div>

            {/* Row 5: Daily Guardrail Quotas */}
            <div className="dshm-settings-row">
              <div className="dshm-field-grid-2">
                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={dailyCallsId} className="dshm-settings-label">
                      {t.modal.dailyCallsLabel}
                    </label>
                  </div>
                  <input
                    id={dailyCallsId}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10000}
                    className="dshm-field-input dshm-field-input--mono"
                    value={dailyCalls}
                    onChange={(e) => {
                      setDailyCalls(e.target.value);
                      markDirty();
                    }}
                  />
                </div>

                <div className="dshm-field-col">
                  <div className="dshm-settings-label-row">
                    <label htmlFor={dailyTokensId} className="dshm-settings-label">
                      {t.modal.dailyTokensLabel}
                    </label>
                  </div>
                  <input
                    id={dailyTokensId}
                    type="number"
                    inputMode="numeric"
                    min={1000}
                    max={100000000}
                    step={10000}
                    className="dshm-field-input dshm-field-input--mono"
                    value={dailyTokens}
                    onChange={(e) => {
                      setDailyTokens(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Row 6: Collapsible Optional Remote Embedding Channel */}
            <details
              className="dshm-modal-details"
              open={embeddingProvider === 'openai-compatible' || undefined}
            >
              <summary className="dshm-modal-details-summary">
                <span>{t.modal.embeddingSectionTitle}</span>
                <span className="dshm-modal-details-badge">
                  {embeddingProvider === 'openai-compatible'
                    ? t.modal.embeddingSectionBadgeOn
                    : t.modal.embeddingSectionBadgeOff}{' '}
                  <span className="dshm-process-chevron" aria-hidden="true">
                    ›
                  </span>
                </span>
              </summary>

              <div className="dshm-modal-details-body">
                <div className="dshm-field-col">
                  <label htmlFor={embProviderId} className="dshm-settings-label">
                    {t.modal.embeddingProviderLabel}
                  </label>
                  <select
                    id={embProviderId}
                    className="dshm-field-select"
                    value={embeddingProvider}
                    onChange={(e) => {
                      const next =
                        e.target.value === 'openai-compatible' ? 'openai-compatible' : 'none';
                      setEmbeddingProvider(next);
                      markDirty();
                    }}
                  >
                    <option value="none">{t.modal.embeddingProviderNone}</option>
                    <option value="openai-compatible">{t.modal.embeddingProviderOpenai}</option>
                  </select>
                </div>

                {embeddingProvider === 'openai-compatible' ? (
                  <>
                    <div className="dshm-field-col">
                      <label htmlFor={embBaseUrlId} className="dshm-settings-label">
                        {t.modal.embeddingBaseUrlLabel}
                      </label>
                      <input
                        id={embBaseUrlId}
                        type="text"
                        spellCheck={false}
                        className="dshm-field-input dshm-field-input--mono"
                        value={embeddingBaseURL}
                        onChange={(e) => handleEmbeddingBaseUrlChange(e.target.value)}
                        placeholder={t.modal.embeddingBaseUrlPlaceholder}
                      />
                    </div>

                    <div className="dshm-field-grid-ratio">
                      <div className="dshm-field-col">
                        <label htmlFor={embModelId} className="dshm-settings-label">
                          {t.modal.embeddingModelLabel}
                        </label>
                        <input
                          id={embModelId}
                          type="text"
                          spellCheck={false}
                          className="dshm-field-input dshm-field-input--mono"
                          value={embeddingModel}
                          onChange={(e) => {
                            setEmbeddingModel(e.target.value);
                            markDirty();
                          }}
                          placeholder={t.modal.embeddingModelPlaceholder}
                        />
                      </div>

                      <div className="dshm-field-col">
                        <label htmlFor={embDimId} className="dshm-settings-label">
                          {t.modal.embeddingDimLabel}
                        </label>
                        <input
                          id={embDimId}
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={8192}
                          className="dshm-field-input dshm-field-input--mono"
                          value={embeddingDim}
                          onChange={(e) => {
                            setEmbeddingDim(e.target.value);
                            markDirty();
                          }}
                        />
                      </div>
                    </div>

                    <div className="dshm-field-grid-key">
                      <div className="dshm-field-col">
                        <div className="dshm-settings-label-row">
                          <label htmlFor={embApiKeyId} className="dshm-settings-label">
                            {t.modal.embeddingApiKeyLabel}
                          </label>
                          {config?.embedding?.hasApiKey ? (
                            <span
                              className={
                                clearEmbeddingKeyRequested
                                  ? 'dshm-key-status dshm-key-status--clearing'
                                  : 'dshm-key-status'
                              }
                            >
                              <span>
                                {clearEmbeddingKeyRequested
                                  ? t.modal.apiKeyClearing
                                  : t.modal.apiKeySaved(config.embedding.apiKeyMasked || '****')}
                              </span>
                              <button
                                type="button"
                                className="dshm-key-action-btn"
                                aria-label={
                                  clearEmbeddingKeyRequested
                                    ? t.modal.apiKeyUndoBtn
                                    : t.modal.apiKeyClearAria
                                }
                                onClick={() => {
                                  setClearEmbeddingKeyRequested((prev) => !prev);
                                  setEmbeddingApiKey('');
                                  markDirty();
                                }}
                              >
                                {clearEmbeddingKeyRequested
                                  ? t.modal.apiKeyUndoBtn
                                  : t.modal.apiKeyClearBtn}
                              </button>
                            </span>
                          ) : null}
                        </div>
                        <input
                          id={embApiKeyId}
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          className="dshm-field-input dshm-field-input--mono"
                          value={embeddingApiKey}
                          onChange={(e) => {
                            setClearEmbeddingKeyRequested(false);
                            setEmbeddingApiKey(e.target.value);
                            markDirty();
                          }}
                          placeholder={
                            config?.embedding?.hasApiKey
                              ? t.modal.apiKeyPlaceholderSaved
                              : t.modal.apiKeyPlaceholderEmpty
                          }
                        />
                      </div>

                      <div className="dshm-field-col">
                        <label htmlFor={embApiKeyEnvId} className="dshm-settings-label">
                          {t.modal.embeddingApiKeyEnvLabel}
                        </label>
                        <input
                          id={embApiKeyEnvId}
                          type="text"
                          spellCheck={false}
                          className="dshm-field-input dshm-field-input--mono"
                          value={embeddingApiKeyEnv}
                          onChange={(e) => {
                            setEmbeddingApiKeyEnv(e.target.value);
                            markDirty();
                          }}
                          placeholder="OPENAI_API_KEY"
                        />
                      </div>
                    </div>
                  </>
                ) : null}
              </div>
            </details>

            <div className="dshm-sheet-foot">
              <div
                className="dshm-sheet-status"
                role="status"
                aria-live="polite"
                style={{
                  color:
                    statusTone === 'ok'
                      ? 'var(--dshm-valley-green)'
                      : statusTone === 'err'
                        ? 'var(--dshm-danger)'
                        : 'var(--dshm-ink-3)',
                }}
              >
                <span aria-hidden="true">● </span>
                {statusText}
              </div>

              <div className="dshm-sheet-foot-right">
                <span className="dshm-sheet-hint">{t.modal.footerHint}</span>
                <button
                  type="submit"
                  className="dshm-sheet-save-btn"
                  disabled={saving || (!config && !dirty)}
                >
                  {saving
                    ? t.modal.savingBtn
                    : offlineConsent
                      ? t.modal.saveAndTestBtn
                      : t.modal.saveBtn}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );

  const portal = getCreatePortal();
  if (portal && typeof document !== 'undefined' && document.body) {
    return portal(modalContent, document.body);
  }
  return modalContent;
}
