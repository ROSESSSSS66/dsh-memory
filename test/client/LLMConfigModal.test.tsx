// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMConfigModal } from '../../src/client/components/LLMConfigModal.js';
import type {
  ConfigSavePayload,
  LLMConfigData,
  LLMTestPayload,
  LLMTestResult,
} from '../../src/client/types.js';

function createConfig(overrides: Partial<LLMConfigData> = {}): LLMConfigData {
  return {
    offlineLLM: {
      useDshLlm: false,
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      apiKeyMasked: 'sk-***8899',
      hasApiKey: true,
      protocol: 'chat/completions',
      ...(overrides.offlineLLM ?? {}),
    },
    privacy: {
      offlineConsent: false,
      allowedOfflineEndpoints: [],
      ...(overrides.privacy ?? {}),
    },
    embedding: {
      provider: 'none',
      baseURL: '',
      model: '',
      apiKeyEnv: '',
      apiKeyMasked: '',
      hasApiKey: false,
      dim: 0,
      ...(overrides.embedding ?? {}),
    },
    dailyLLMCalls: overrides.dailyLLMCalls ?? 40,
    dailyLLMTokens: overrides.dailyLLMTokens ?? 200000,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LLMConfigModal', () => {
  it('P0 API Key Leak Prevention: clears apiKey after save, on preset switch, and on Base URL origin change', async () => {
    const savedPayloads: ConfigSavePayload[] = [];
    const onSave = vi.fn(async (payload: ConfigSavePayload) => {
      savedPayloads.push(payload);
    });
    const onClose = vi.fn();

    render(
      <LLMConfigModal
        open={true}
        config={createConfig({
          privacy: { offlineConsent: true, allowedOfflineEndpoints: [] },
        })}
        locale="en"
        onClose={onClose}
        onSave={onSave}
      />
    );

    const apiKeyInput = screen.getByLabelText('API Key') as HTMLInputElement;
    const presetSelect = screen.getByLabelText(
      'Provider Preset'
    ) as HTMLSelectElement;
    const baseUrlInput = screen.getByLabelText('Base URL') as HTMLInputElement;

    // 1. Typing an API key and saving immediately clears local input to ''
    fireEvent.change(apiKeyInput, {
      target: { value: 'sk-deepseek-secret-111' },
    });
    expect(apiKeyInput.value).toBe('sk-deepseek-secret-111');

    fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(savedPayloads[0]?.offlineLLM?.apiKey).toBe('sk-deepseek-secret-111');
    await waitFor(() => {
      expect(apiKeyInput.value).toBe('');
    });

    // 2. Switching provider preset clears any unsaved apiKey
    fireEvent.change(apiKeyInput, {
      target: { value: 'sk-unsaved-preset-222' },
    });
    expect(apiKeyInput.value).toBe('sk-unsaved-preset-222');

    fireEvent.change(presetSelect, { target: { value: 'openai-chat' } });
    expect(apiKeyInput.value).toBe('');
    expect(baseUrlInput.value).toBe('https://api.openai.com/v1');

    // 3. Changing Base URL to a different origin clears any unsaved apiKey so old secret is NEVER sent to new endpoint
    fireEvent.change(apiKeyInput, {
      target: { value: 'sk-openai-secret-333' },
    });
    expect(apiKeyInput.value).toBe('sk-openai-secret-333');

    fireEvent.change(baseUrlInput, {
      target: { value: 'https://api.anthropic.com/v1/messages' },
    });
    expect(apiKeyInput.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
    expect(savedPayloads[1]?.offlineLLM?.baseURL).toBe(
      'https://api.anthropic.com/v1/messages'
    );
    expect(savedPayloads[1]?.offlineLLM?.apiKey).toBeUndefined();
  });

  it('P1 Explicit Privacy Consent: starts from config.privacy.offlineConsent (false), quota save preserves false, explicit toggle sends true/false', async () => {
    const savedPayloads: ConfigSavePayload[] = [];
    const onSave = vi.fn(async (payload: ConfigSavePayload) => {
      savedPayloads.push(payload);
    });
    const onTestConnection = vi.fn(
      async (): Promise<LLMTestResult> => ({ ok: true, latencyMs: 12 })
    );

    render(
      <LLMConfigModal
        open={true}
        config={createConfig({
          privacy: { offlineConsent: false, allowedOfflineEndpoints: [] },
        })}
        locale="en"
        onClose={vi.fn()}
        onSave={onSave}
        onTestConnection={onTestConnection}
      />
    );

    const consentCheckbox = screen.getByLabelText(
      'Allow background model egress'
    ) as HTMLInputElement;
    expect(consentCheckbox.checked).toBe(false);

    // Edit quota only and save -> offlineConsent must stay false (never auto-flipped to true)
    const callsInput = screen.getByLabelText(
      'Daily Calls Cap'
    ) as HTMLInputElement;
    fireEvent.change(callsInput, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(savedPayloads[0]?.dailyLLMCalls).toBe(75);
    expect(savedPayloads[0]?.privacy).toEqual({ offlineConsent: false });
    expect(onTestConnection).not.toHaveBeenCalled();

    // Explicitly toggle consent ON -> sends offlineConsent: true
    fireEvent.click(consentCheckbox);
    expect(consentCheckbox.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
    expect(savedPayloads[1]?.privacy).toEqual({ offlineConsent: true });

    // Explicitly revoke consent OFF -> sends offlineConsent: false
    fireEvent.click(consentCheckbox);
    expect(consentCheckbox.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(3);
    });
    expect(savedPayloads[2]?.privacy).toEqual({ offlineConsent: false });
  });

  it('P1 Save Error Retention: keeps modal open on onSave rejection and displays error inside role="status" aria-live="polite"', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('EACCES: config file is read-only');
    });
    const onClose = vi.fn();

    render(
      <LLMConfigModal
        open={true}
        config={createConfig()}
        locale="en"
        onClose={onClose}
        onSave={onSave}
      />
    );

    const callsInput = screen.getByLabelText(
      'Daily Calls Cap'
    ) as HTMLInputElement;
    fireEvent.change(callsInput, { target: { value: '60' } });

    // Attempt save via submit button
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    await waitFor(() => {
      expect(status.textContent).toContain(
        'Save failed: EACCES: config file is read-only'
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Even when dirty and user clicks Close, failed flushSave keeps modal open
    fireEvent.change(callsInput, { target: { value: '65' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Close model settings' })
    );

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(2);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(status.textContent).toContain('EACCES: config file is read-only');
  });

  it('P1 dsh-host Preset: sets useDshLlm=true, model="", and allows connection testing', async () => {
    const savedPayloads: ConfigSavePayload[] = [];
    const testPayloads: LLMTestPayload[] = [];
    const onSave = vi.fn(async (payload: ConfigSavePayload) => {
      savedPayloads.push(payload);
    });
    const onTestConnection = vi.fn(
      async (payload: LLMTestPayload): Promise<LLMTestResult> => {
        testPayloads.push(payload);
        return {
          ok: true,
          latencyMs: 37,
          model: 'deepseek-host-v3',
        };
      }
    );

    render(
      <LLMConfigModal
        open={true}
        config={createConfig({
          privacy: { offlineConsent: true, allowedOfflineEndpoints: [] },
        })}
        locale="en"
        onClose={vi.fn()}
        onSave={onSave}
        onTestConnection={onTestConnection}
      />
    );

    const presetSelect = screen.getByLabelText(
      'Provider Preset'
    ) as HTMLSelectElement;
    const baseUrlInput = screen.getByLabelText('Base URL') as HTMLInputElement;
    const modelInput = screen.getByLabelText('Model ID') as HTMLInputElement;

    fireEvent.change(presetSelect, { target: { value: 'dsh-host' } });
    expect(baseUrlInput.value).toBe('');
    expect(modelInput.value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onTestConnection).toHaveBeenCalledTimes(1);
    });

    expect(savedPayloads[0]?.offlineLLM).toMatchObject({
      useDshLlm: true,
      baseURL: '',
      model: '',
    });
    expect(testPayloads[0]).toEqual({
      useDshLlm: true,
      model: undefined,
    });

    const status = screen.getByRole('status');
    await waitFor(() => {
      expect(status.textContent).toContain(
        'Saved · connected (37ms · deepseek-host-v3)'
      );
    });
  });

  it('P1 WCAG AA Accessibility: portal dialog, real buttons, linked labels, Escape close, Tab/Shift+Tab focus trap, and collapsible remote embedding save', async () => {
    const savedPayloads: ConfigSavePayload[] = [];
    const onSave = vi.fn(async (payload: ConfigSavePayload) => {
      savedPayloads.push(payload);
    });
    const onClose = vi.fn();

    const { container } = render(
      <LLMConfigModal
        open={true}
        config={createConfig()}
        locale="en"
        onClose={onClose}
        onSave={onSave}
      />
    );

    // 1. Portal root rendered directly inside document.body (outside mount container) with accessible dialog attributes
    expect(container.querySelector('.dshm-portal-root')).toBeNull();
    const portalRoot = document.body.querySelector('.dshm-portal-root');
    expect(portalRoot).not.toBeNull();
    expect(portalRoot?.parentElement).toBe(document.body);

    const dialog = screen.getByRole('dialog');
    expect(portalRoot?.contains(dialog)).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const titleEl = labelledBy ? document.getElementById(labelledBy) : null;
    expect(titleEl?.textContent).toBe('Model Settings');

    // 2. Close button and Clear Key button are real <button type="button"> elements
    const closeBtn = screen.getByRole('button', {
      name: 'Close model settings',
    });
    expect(closeBtn.tagName).toBe('BUTTON');
    expect(closeBtn.getAttribute('type')).toBe('button');

    const clearKeyBtn = screen.getByRole('button', {
      name: 'Clear saved API key',
    });
    expect(clearKeyBtn.tagName).toBe('BUTTON');
    expect(clearKeyBtn.getAttribute('type')).toBe('button');

    // 3. Pressing Escape closes modal (when clean)
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    // 4. Tab / Shift+Tab focus trap keeps focus inside modal
    // Provide non-empty client rects in headless happy-dom so focusable visibility check matches real browser layout
    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'summary',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ');
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>(focusableSelector)
    );
    expect(focusables.length).toBeGreaterThanOrEqual(4);
    for (const el of focusables) {
      vi.spyOn(el, 'getClientRects').mockReturnValue([
        { width: 100, height: 24 },
      ] as unknown as DOMRectList);
    }

    const firstFocusable = focusables[0];
    const lastFocusable = focusables[focusables.length - 1];

    lastFocusable.focus();
    expect(document.activeElement).toBe(lastFocusable);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(firstFocusable);

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastFocusable);

    // 5. Collapsible Remote Embedding section toggles and saves provider/baseURL/model/dim/apiKeyEnv
    const embDetails = dialog.querySelector(
      'details.dshm-modal-details'
    ) as HTMLDetailsElement;
    expect(embDetails).not.toBeNull();
    const embSummary = embDetails.querySelector('summary') as HTMLElement;
    expect(embSummary.textContent).toContain(
      'Remote Embedding Channel (Optional)'
    );
    fireEvent.click(embSummary);
    embDetails.open = true;

    const embProviderSelect = screen.getByLabelText(
      'Embedding Provider'
    ) as HTMLSelectElement;
    fireEvent.change(embProviderSelect, {
      target: { value: 'openai-compatible' },
    });

    const embBaseUrlInput = screen.getByLabelText(
      'Embedding Base URL'
    ) as HTMLInputElement;
    const embModelInput = screen.getByLabelText(
      'Embedding Model'
    ) as HTMLInputElement;
    const embDimInput = screen.getByLabelText(
      'Vector Dim (0 = auto)'
    ) as HTMLInputElement;
    const embApiKeyInput = screen.getByLabelText(
      'Embedding API Key'
    ) as HTMLInputElement;
    const embApiKeyEnvInput = screen.getByLabelText(
      'Embedding Env Var'
    ) as HTMLInputElement;

    // 6. Verify EVERY <input> and <select> in the dialog (including embedding controls) has a linked <label htmlFor>
    const allControls = Array.from(
      dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        'input, select'
      )
    );
    expect(allControls.length).toBeGreaterThanOrEqual(12);
    for (const control of allControls) {
      expect(control.id).toBeTruthy();
      const label = dialog.querySelector(`label[for="${control.id}"]`);
      expect(label).not.toBeNull();
      expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    }

    fireEvent.change(embBaseUrlInput, {
      target: { value: 'https://api.openai.com/v1/embeddings' },
    });
    fireEvent.change(embModelInput, {
      target: { value: 'text-embedding-3-small' },
    });
    fireEvent.change(embDimInput, { target: { value: '1536' } });
    fireEvent.change(embApiKeyInput, { target: { value: 'sk-emb-key-999' } });
    fireEvent.change(embApiKeyEnvInput, {
      target: { value: 'OPENAI_EMBEDDING_KEY' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(savedPayloads[0]?.embedding).toEqual({
      provider: 'openai-compatible',
      baseURL: 'https://api.openai.com/v1/embeddings',
      model: 'text-embedding-3-small',
      dim: 1536,
      apiKey: 'sk-emb-key-999',
      apiKeyEnv: 'OPENAI_EMBEDDING_KEY',
      clearApiKey: undefined,
    });
  });
});
