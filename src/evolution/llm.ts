import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { LLMTaskKind } from './types.js';
import { reserve, settle, cancel } from './ledger.js';
import { redactSecrets, isOfflineEndpointAllowed, isWorkspaceExcluded, isSafeApiKeyEnvName } from '../core/privacy.js';
import { estimateTokens } from '../core/tokens.js';

/** 重试退避：可被外部 signal 打断，且不会超过 jobDeadline */
function backoffDelay(attempt: number, signal?: AbortSignal, jobDeadline?: number): Promise<void> {
  let ms = Math.min(4_000, 400 * 2 ** (attempt - 1));
  if (jobDeadline) ms = Math.min(ms, Math.max(0, jobDeadline - Date.now() - 1_000));
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** 丢弃未读取的响应体，及时释放 undici 连接 */
async function drainResponse(res: any): Promise<void> {
  try {
    if (res?.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    } else if (typeof res?.text === 'function') {
      await res.text();
    }
  } catch {}
}

export interface OfflineLLMParams {
  jobKind: LLMTaskKind;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  cwd: string;
  workspaceId: string;
  dataWorkspaceIds?: string[];
  signal?: AbortSignal;
  jobDeadline?: number;
  fetchFn?: typeof fetch;
}

export interface OfflineLLMSuccess {
  ok: true;
  content: string;
  ledgerId: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface OfflineLLMFailure {
  ok: false;
  error: string;
  ledgerId?: number;
}

export type OfflineLLMResult = OfflineLLMSuccess | OfflineLLMFailure;

export type LLMProtocol = 'chat/completions' | 'responses' | 'messages';

export interface DshHostLlmFallback {
  baseURL: string;
  apiKey: string;
  model?: string;
  protocol?: LLMProtocol;
}

function unquoteScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  // Strip inline YAML comment only when unquoted
  const hashIdx = s.indexOf(' #');
  return (hashIdx >= 0 ? s.slice(0, hashIdx) : s).trim();
}

function mapDshPiAiProtocol(api?: string): LLMProtocol | undefined {
  const norm = (api || '').trim().toLowerCase();
  if (norm === 'openai-responses' || norm === 'responses') return 'responses';
  if (norm === 'anthropic-messages' || norm === 'messages') return 'messages';
  if (norm === 'openai-completions' || norm === 'chat/completions') return 'chat/completions';
  return undefined;
}

function isPlaceholderModel(model?: string): boolean {
  const m = (model || '').trim();
  return !m || m === 'gpt-4o-mini' || m === 'deepseek-ai/deepseek-v4-flash-0731';
}

function normalizeProviderBaseUrl(rawUrl: string, api?: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const proto = (api || '').trim().toLowerCase();
    if (
      (parsed.pathname === '' || parsed.pathname === '/') &&
      (proto === 'openai-responses' || proto === 'openai-completions')
    ) {
      return `${trimmed}/v1`;
    }
  } catch {}
  return trimmed;
}

function parseDotEnvInto(filePath: string, target: Record<string, string>): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
      const eq = cleaned.indexOf('=');
      if (eq <= 0) continue;
      const key = cleaned.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      const val = unquoteScalar(cleaned.slice(eq + 1));
      if (val && !(key in target)) {
        target[key] = val;
      }
    }
  } catch {}
}

function parseCredentialsYamlInto(filePath: string, target: Record<string, string>): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    let inEnvBlock = false;
    let envBlockIndent = 0;
    for (const rawLine of content.split(/\r?\n/)) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      const trimmed = rawLine.trim();
      if (trimmed.startsWith('-')) {
        inEnvBlock = false;
        continue;
      }
      const colon = trimmed.indexOf(':');
      if (colon <= 0) continue;
      const key = unquoteScalar(trimmed.slice(0, colon));
      const rest = trimmed.slice(colon + 1).trim();
      if (key === 'env' && !rest) {
        inEnvBlock = true;
        envBlockIndent = indent;
        continue;
      }
      if (indent <= envBlockIndent) {
        inEnvBlock = false;
      }
      if ((indent === 0 || (inEnvBlock && indent > envBlockIndent)) && rest && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        const val = unquoteScalar(rest);
        if (val && !(key in target)) {
          target[key] = val;
        }
      }
    }
  } catch {}
}

interface ParsedPatchProvider {
  baseURL?: string;
  apiKeyEnv?: string;
  api?: string;
}

function parsePatchLlmConfig(
  filePath: string,
  providersOut: Map<string, ParsedPatchProvider>,
  defaultModelOut: { provider?: string; model?: string }
): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    let entryId = '';
    let entryName = '';
    let inConfig = false;
    let configIndent = -1;
    let inProviders = false;
    let providersIndent = -1;
    let currentProvider = '';
    let currentProviderIndent = -1;

    for (const rawLine of content.split(/\r?\n/)) {
      const stripped = rawLine.trimStart();
      if (!stripped || stripped.startsWith('#')) continue;
      const indent = rawLine.length - stripped.length;

      // Top-level YAML list entry resets item context
      if (indent === 0 && stripped.startsWith('-')) {
        entryId = '';
        entryName = '';
        inConfig = false;
        configIndent = -1;
        inProviders = false;
        providersIndent = -1;
        currentProvider = '';
        currentProviderIndent = -1;
        const afterDash = stripped.slice(1).trim();
        if (afterDash.startsWith('id:')) entryId = unquoteScalar(afterDash.slice(3));
        else if (afterDash.startsWith('name:')) entryName = unquoteScalar(afterDash.slice(5));
        continue;
      }

      if (indent <= 2 && !stripped.startsWith('-')) {
        if (stripped.startsWith('id:')) {
          entryId = unquoteScalar(stripped.slice(3));
          continue;
        }
        if (stripped.startsWith('name:')) {
          entryName = unquoteScalar(stripped.slice(5));
          continue;
        }
        if (stripped === 'config:' || stripped.startsWith('config:')) {
          inConfig = true;
          configIndent = indent;
          inProviders = false;
          currentProvider = '';
          continue;
        }
      }

      if (!inConfig || indent <= configIndent) continue;

      const isDefaultModelEntry =
        entryId === 'agent-default-model' || entryName === '@deepseek-ai/dsh-agent-default-model';
      const isPiAiEntry = entryId === 'llm-pi-ai' || entryName === '@deepseek-ai/dsh-llm-pi-ai';

      const colon = stripped.indexOf(':');
      if (colon <= 0) continue;
      const key = unquoteScalar(stripped.slice(0, colon));
      const val = stripped.slice(colon + 1).trim();

      if (isDefaultModelEntry && indent > configIndent) {
        if (key === 'provider' && val) defaultModelOut.provider = unquoteScalar(val);
        else if (key === 'model' && val) defaultModelOut.model = unquoteScalar(val);
        continue;
      }

      if (isPiAiEntry) {
        if (key === 'providers' && !val) {
          inProviders = true;
          providersIndent = indent;
          currentProvider = '';
          currentProviderIndent = -1;
          continue;
        }
        if (!inProviders) continue;
        if (indent <= providersIndent) {
          inProviders = false;
          currentProvider = '';
          continue;
        }
        if (currentProviderIndent === -1 || indent === currentProviderIndent) {
          if (!val && !stripped.startsWith('-')) {
            currentProvider = key;
            currentProviderIndent = indent;
            if (!providersOut.has(currentProvider)) {
              providersOut.set(currentProvider, {});
            }
          }
          continue;
        }
        if (currentProvider && indent > currentProviderIndent) {
          // Only read direct scalar fields under providers.<name> (not nested models[] items)
          if (indent > currentProviderIndent + 4 || stripped.startsWith('-')) continue;
          const p = providersOut.get(currentProvider);
          if (p && val) {
            if (key === 'baseURL') p.baseURL = unquoteScalar(val);
            else if (key === 'apiKeyEnv') p.apiKeyEnv = unquoteScalar(val);
            else if (key === 'api') p.api = unquoteScalar(val);
          }
        }
      }
    }
  } catch {}
}

/**
 * 解析 DSH 宿主 LLM 兜底通道：
 * 1) 优先读取当前进程环境（含 DSH_LLM / DEEPSEEK / OPENAI / ANTHROPIC）
 * 2) 若进程环境未直接给出，读取 ~/.dsh/.env、~/.dsh/.credentials.yaml（不修改 process.env）
 *    与 cordis.patch.yml 中的 agent-default-model + llm-pi-ai provider 配置
 */
export function resolveDshHostLlmFallback(
  currentModel?: string,
  options?: { dshHome?: string; env?: Record<string, string | undefined> }
): DshHostLlmFallback | null {
  const procEnv = options?.env ?? process.env;

  // Tier 1: Direct process environment variables
  for (const prefix of ['DSH_LLM', 'DEEPSEEK', 'OPENAI', 'ANTHROPIC'] as const) {
    const url = (procEnv[`${prefix}_BASE_URL`] || '').trim();
    if (url) {
      const apiKey = (procEnv[`${prefix}_API_KEY`] || '').trim();
      return {
        baseURL: url,
        apiKey,
        ...(prefix === 'ANTHROPIC' ? { protocol: 'messages' as const } : {}),
      };
    }
  }

  const procDeepSeekKey = (procEnv.DEEPSEEK_API_KEY || '').trim();
  if (procDeepSeekKey) {
    const preferredModel = (currentModel || '').trim();
    const envModel = (procEnv.DEEPSEEK_MODEL || '').trim();
    return {
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: procDeepSeekKey,
      model: !isPlaceholderModel(preferredModel)
        ? preferredModel
        : envModel || 'deepseek-chat',
      protocol: 'chat/completions',
    };
  }

  // Tier 2: DSH home disk config (.env, .credentials.yaml, cordis.patch.yml)
  const dshHome = (options?.dshHome || procEnv.DSH_HOME || path.join(os.homedir(), '.dsh')).trim();
  const diskEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(procEnv)) {
    if (typeof v === 'string' && v.trim()) diskEnv[k] = v;
  }
  parseDotEnvInto(path.join(dshHome, '.env'), diskEnv);
  parseCredentialsYamlInto(path.join(dshHome, '.credentials.yaml'), diskEnv);

  const providers = new Map<string, ParsedPatchProvider>();
  const defaultModelInfo: { provider?: string; model?: string } = {};
  parsePatchLlmConfig(path.join(dshHome, 'cordis.patch.yml'), providers, defaultModelInfo);
  parsePatchLlmConfig(path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'), providers, defaultModelInfo);

  const pickProvider = (name: string): DshHostLlmFallback | null => {
    const p = providers.get(name);
    if (!p?.baseURL) return null;
    const keyEnv = p.apiKeyEnv?.trim() || '';
    const apiKey = keyEnv && isSafeApiKeyEnvName(keyEnv) ? (diskEnv[keyEnv] || '').trim() : '';
    if (!apiKey) return null;
    const protocol = mapDshPiAiProtocol(p.api);
    const normalizedUrl = normalizeProviderBaseUrl(p.baseURL, p.api);
    const preferredModel = (currentModel || '').trim();
    return {
      baseURL: normalizedUrl,
      apiKey,
      model: !isPlaceholderModel(preferredModel)
        ? preferredModel
        : defaultModelInfo.model || undefined,
      ...(protocol ? { protocol } : {}),
    };
  };

  if (defaultModelInfo.provider) {
    const picked = pickProvider(defaultModelInfo.provider);
    if (picked) return picked;
  }
  for (const providerName of providers.keys()) {
    const picked = pickProvider(providerName);
    if (picked) return picked;
  }

  // Tier 3: Disk env fallback for DSH_LLM / DEEPSEEK / OPENAI / ANTHROPIC
  for (const prefix of ['DSH_LLM', 'DEEPSEEK', 'OPENAI', 'ANTHROPIC'] as const) {
    const url = (diskEnv[`${prefix}_BASE_URL`] || '').trim();
    if (url) {
      return {
        baseURL: url,
        apiKey: (diskEnv[`${prefix}_API_KEY`] || '').trim(),
        ...(prefix === 'ANTHROPIC' ? { protocol: 'messages' as const } : {}),
      };
    }
  }
  const diskDeepSeekKey = (diskEnv.DEEPSEEK_API_KEY || '').trim();
  if (diskDeepSeekKey) {
    const preferredModel = (currentModel || '').trim();
    return {
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: diskDeepSeekKey,
      model: !isPlaceholderModel(preferredModel)
        ? preferredModel
        : (diskEnv.DEEPSEEK_MODEL || '').trim() || 'deepseek-chat',
      protocol: 'chat/completions',
    };
  }

  return null;
}

export function resolveEndpointAndProtocol(
  baseURL: string,
  configuredProtocol: LLMProtocol = 'chat/completions'
): { endpointUrl: string; protocol: LLMProtocol } {
  const trimmed = (baseURL || '').trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/responses')) {
    return { endpointUrl: trimmed, protocol: 'responses' };
  }
  if (trimmed.endsWith('/messages')) {
    return { endpointUrl: trimmed, protocol: 'messages' };
  }
  if (trimmed.endsWith('/chat/completions')) {
    return { endpointUrl: trimmed, protocol: 'chat/completions' };
  }

  const protocol = configuredProtocol || 'chat/completions';
  return {
    endpointUrl: `${trimmed}/${protocol}`,
    protocol,
  };
}

export function buildProtocolPayload(
  protocol: LLMProtocol,
  model: string,
  sanitizedSystem: string,
  sanitizedUser: string,
  maxOutputTokens: number
): { requestBody: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (protocol === 'messages') {
    headers['anthropic-version'] = '2023-06-01';
    const body = {
      model,
      system: sanitizedSystem,
      messages: [{ role: 'user', content: sanitizedUser }],
      max_tokens: maxOutputTokens,
      temperature: 0.0,
    };
    return { requestBody: JSON.stringify(body), headers };
  }

  if (protocol === 'responses') {
    const body = {
      model,
      input: [
        { role: 'system', content: sanitizedSystem },
        { role: 'user', content: sanitizedUser },
      ],
      temperature: 0.0,
      max_output_tokens: maxOutputTokens,
    };
    return { requestBody: JSON.stringify(body), headers };
  }

  // Default: chat/completions
  const body = {
    model,
    messages: [
      { role: 'system', content: sanitizedSystem },
      { role: 'user', content: sanitizedUser },
    ],
    temperature: 0.0,
    max_tokens: maxOutputTokens,
    response_format: { type: 'json_object' },
  };
  return { requestBody: JSON.stringify(body), headers };
}

export function extractResponseContent(data: any): string | null {
  if (!data) return null;

  // 1. OpenAI chat/completions: choices[0].message.content
  const choiceMsg = data?.choices?.[0]?.message;
  if (typeof choiceMsg?.content === 'string' && choiceMsg.content.trim().length > 0) {
    return choiceMsg.content;
  }
  if (Array.isArray(choiceMsg?.content)) {
    const joined = choiceMsg.content
      .filter((c: any) => c?.type !== 'reasoning' && c?.type !== 'thinking')
      .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
      .join('');
    if (joined.trim().length > 0) {
      return joined;
    }
  }

  // 2. OpenAI responses: output_text or output array
  if (typeof data?.output_text === 'string' && data.output_text.trim().length > 0) {
    return data.output_text;
  }
  if (Array.isArray(data?.output)) {
    let text = '';
    for (const item of data.output) {
      if (typeof item === 'string') {
        text += item;
      } else if (item?.type !== 'reasoning' && item?.content) {
        if (Array.isArray(item.content)) {
          text += item.content
            .filter((c: any) => c?.type !== 'reasoning_text' && c?.type !== 'thinking')
            .map((c: any) => c?.text || '')
            .join('');
        } else if (typeof item.content === 'string') {
          text += item.content;
        }
      }
    }
    if (text) return text;
  }

  // 3. Anthropic messages: content array of text blocks
  if (Array.isArray(data?.content)) {
    const text = data.content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b?.text || '')
      .join('');
    if (text) return text;
  } else if (typeof data?.content === 'string') {
    return data.content;
  }

  // 4. Fallback direct text
  if (typeof data?.text === 'string') {
    return data.text;
  }

  return null;
}

export function extractResponseUsage(
  data: any
): { prompt_tokens: number; completion_tokens: number } | undefined {
  const usage = data?.usage;
  if (!usage) return undefined;

  const inTokens =
    typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : undefined;

  const outTokens =
    typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : undefined;

  if (typeof inTokens === 'number' && typeof outTokens === 'number') {
    return { prompt_tokens: inTokens, completion_tokens: outTokens };
  }
  return undefined;
}

/**
 * 离线 LLM 调用客户端
 * 严格执行：隐私闸门 -> 输入上界 -> 账本预留 -> 网络调用/重试 -> 结算
 */
export async function callOfflineLLM(
  db: Db,
  params: OfflineLLMParams,
  cfg: PluginConfig
): Promise<OfflineLLMResult> {
  const fetchImpl = params.fetchFn || globalThis.fetch;

  // 1. 隐私与发送闸门：检查用户是否明确同意外发
  if (!cfg.privacy.offlineConsent) {
    return { ok: false, error: 'privacy_offline_consent_required' };
  }

  // 检查工作区排除
  if ([params.cwd, params.workspaceId, ...(params.dataWorkspaceIds || [])]
    .some(owner => isWorkspaceExcluded(owner, cfg.excludeWorkspaces))) {
    return { ok: false, error: 'workspace_excluded' };
  }

  // 检查目标 endpoint 是否明确授权
  let baseURL = (cfg.offlineLLM.baseURL || '').trim();
  const usingHostFallback = !baseURL && !!cfg.offlineLLM.useDshLlm;
  // 宿主兜底按「同一供应商的 URL + 密钥」成对解析：分别取各自第一个非空值会把
  // 一家的密钥发给另一家的端点（如 ANTHROPIC_BASE_URL 配上 OPENAI_API_KEY）
  let hostFallbackKey = '';
  let hostFallbackModel: string | undefined;
  let configuredProtocol = cfg.offlineLLM.protocol;
  if (usingHostFallback) {
    const fallback = resolveDshHostLlmFallback(cfg.offlineLLM.model);
    if (fallback) {
      baseURL = fallback.baseURL;
      hostFallbackKey = fallback.apiKey;
      if (fallback.protocol) configuredProtocol = fallback.protocol;
      if (fallback.model) hostFallbackModel = fallback.model;
    }
  }
  if (!baseURL) {
    return { ok: false, error: 'missing_base_url' };
  }

  const effectiveAllowedEndpoints =
    usingHostFallback && (!cfg.privacy.allowedOfflineEndpoints || cfg.privacy.allowedOfflineEndpoints.length === 0)
      ? [baseURL]
      : cfg.privacy.allowedOfflineEndpoints;

  if (!isOfflineEndpointAllowed(baseURL, effectiveAllowedEndpoints, cfg.privacy.offlineConsent)) {
    return { ok: false, error: 'endpoint_not_allowed' };
  }

  // 2. 脱敏与路径匿名化
  let sanitizedSystem = redactSecrets(params.systemPrompt).text;
  let sanitizedUser = redactSecrets(params.userPrompt).text;

  // 替换绝对工作区路径为 <workspace>
  if (params.cwd) {
    const variants = Array.from(
      new Set([params.cwd, params.cwd.replace(/\\/g, '/'), params.cwd.replace(/\//g, '\\')])
    ).filter((v) => v.length >= 2);
    for (const v of variants) {
      const escapedCwd = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cwdRegex = new RegExp(escapedCwd, 'gi');
      sanitizedSystem = sanitizedSystem.replace(cwdRegex, '<workspace>');
      sanitizedUser = sanitizedUser.replace(cwdRegex, '<workspace>');
    }
  }

  // 3. 输入上界计算与校验
  // 覆盖 system + user + provider 包装（约 200 tokens）
  const estimatedInput = estimateTokens(sanitizedSystem + sanitizedUser) + 200;
  if (estimatedInput > cfg.distillMaxInputTokens) {
    return { ok: false, error: 'input_budget_exceeded' };
  }

  const model =
    usingHostFallback &&
    hostFallbackModel &&
    (!cfg.offlineLLM.model ||
      cfg.offlineLLM.model === 'deepseek-ai/deepseek-v4-flash-0731' ||
      cfg.offlineLLM.model === 'deepseek-chat' ||
      cfg.offlineLLM.model === 'gpt-4o-mini')
      ? hostFallbackModel
      : cfg.offlineLLM.model || 'deepseek-ai/deepseek-v4-flash-0731';
  const isReasoningModel = /v4|r1|reasoner|thinking|qwq|\bo[134]\b/i.test(model);
  let currentMaxOutputTokens =
    isReasoningModel && params.maxOutputTokens >= 1200
      ? Math.max(params.maxOutputTokens, 4096)
      : params.maxOutputTokens;

  // 读取 API 密钥（优先直接配置的 apiKey，其次从环境变量读取）
  // 宿主兜底时只用与端点成对的宿主密钥：此前为自定义端点保存的密钥不属于这个端点
  let apiKey = usingHostFallback ? hostFallbackKey : cfg.offlineLLM.apiKey || '';
  const keyEnv = (cfg.offlineLLM.apiKeyEnv || '').trim();
  if (!apiKey && !usingHostFallback && keyEnv && isSafeApiKeyEnvName(keyEnv) && process.env[keyEnv]) {
    apiKey = process.env[keyEnv]!;
  }

  // 构造标准端点 URL 与协议负载
  let { endpointUrl, protocol } = resolveEndpointAndProtocol(baseURL, configuredProtocol);
  let { requestBody, headers: protocolHeaders } = buildProtocolPayload(
    protocol,
    model,
    sanitizedSystem,
    sanitizedUser,
    currentMaxOutputTokens
  );

  // 4. 重试循环（最多 3 次发送尝试）
  const maxAttempts = 3;
  let currentAttempt = 0;
  let lastError = 'unknown_error';

  while (currentAttempt < maxAttempts) {
    currentAttempt++;
    const reservedTokens = estimatedInput + currentMaxOutputTokens;

    // 每次 HTTP attempt 原子预留独立额度
    const reserveRes = reserve(
      db,
      {
        jobKind: params.jobKind,
        model,
        promptVersion: params.promptVersion,
        reservedTokens,
      },
      cfg
    );

    if (!reserveRes.reserved || !reserveRes.ledgerId) {
      return { ok: false, error: reserveRes.reason || 'daily_limit_exceeded' };
    }

    const ledgerId = reserveRes.ledgerId;

    // 计算本次请求超时时间（单个请求最多 90s，不能超出 jobDeadline）
    const now = Date.now();
    const remainingJobMs = params.jobDeadline ? params.jobDeadline - now : 90_000;
    if (remainingJobMs <= 0) {
      cancel(db, ledgerId, 'job_deadline_exceeded_before_send');
      return { ok: false, error: 'job_deadline_exceeded', ledgerId };
    }

    const attemptTimeoutMs = Math.min(90_000, Math.max(1_000, remainingJobMs));
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), attemptTimeoutMs);

    // 联动外部取消信号
    const onExternalAbort = () => timeoutController.abort();
    if (params.signal) {
      if (params.signal.aborted) {
        clearTimeout(timeoutTimer);
        cancel(db, ledgerId, 'aborted_before_send');
        return { ok: false, error: 'aborted', ledgerId };
      }
      params.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const headers: Record<string, string> = {
        ...protocolHeaders,
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        if (protocol === 'messages') {
          headers['x-api-key'] = apiKey;
        }
      }

      const res = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: timeoutController.signal,
        redirect: 'manual',
      });

      if (!res.ok) {
        await drainResponse(res);
        // 记录失败账本
        settle(db, {
          ledgerId,
          status: 'failed',
          ok: 0,
          note: `http_${res.status}`,
        });

        if (res.status >= 300 && res.status < 400) {
          return { ok: false, error: 'redirect_not_allowed', ledgerId };
        }

        // 4xx 不重试（429 限流除外）
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return { ok: false, error: `http_${res.status}`, ledgerId };
        }

        // 5xx / 429 瞬时错误且还有尝试机会时，退避后重试
        lastError = `http_${res.status}`;
        if (currentAttempt < maxAttempts) {
          await backoffDelay(currentAttempt, params.signal, params.jobDeadline);
          if (params.signal?.aborted) return { ok: false, error: 'aborted', ledgerId };
        }
        continue;
      }

      // 请求成功，解析返回内容（响应体读取仍受超时控制，防止服务端挂起流式输出）
      const data: any = await res.json();
      const rawContent = extractResponseContent(data);
      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        settle(db, {
          ledgerId,
          status: 'unknown',
          ok: 0,
          note: 'missing_choice_content',
        });
        if (currentAttempt < maxAttempts) {
          currentMaxOutputTokens = Math.max(currentMaxOutputTokens * 2, 8192);
          const nextPayload = buildProtocolPayload(
            protocol,
            model,
            sanitizedSystem,
            sanitizedUser,
            currentMaxOutputTokens
          );
          requestBody = nextPayload.requestBody;
          protocolHeaders = nextPayload.headers;
          lastError = 'missing_choice_content';
          continue;
        }
        return { ok: false, error: 'missing_choice_content', ledgerId };
      }

      // 处理使用量结算
      const usage = extractResponseUsage(data);
      if (
        usage &&
        typeof usage.prompt_tokens === 'number' &&
        typeof usage.completion_tokens === 'number'
      ) {
        settle(db, {
          ledgerId,
          status: 'succeeded',
          ok: 1,
          inTokens: usage.prompt_tokens,
          outTokens: usage.completion_tokens,
        });

        return {
          ok: true,
          content: rawContent,
          ledgerId,
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
          },
        };
      } else {
        // 无 usage，按规则记录 unknown 保留完整预留
        settle(db, {
          ledgerId,
          status: 'unknown',
          ok: 1,
          note: 'missing_usage_info',
        });

        return {
          ok: true,
          content: rawContent,
          ledgerId,
        };
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || timeoutController.signal.aborted;
      const note = isAbort ? 'timeout_or_abort' : 'network_error';

      // 发送后发生网络异常或超时，记 unknown 保留完整预留
      settle(db, {
        ledgerId,
        status: 'unknown',
        ok: 0,
        note,
      });

      lastError = isAbort ? 'timeout' : 'network_error';

      // 如果是外部取消或总超时，不再重试
      if (params.signal?.aborted || (params.jobDeadline && Date.now() >= params.jobDeadline)) {
        return { ok: false, error: lastError, ledgerId };
      }

      // 仅瞬时网络故障重试（指数退避）
      if (currentAttempt < maxAttempts) {
        await backoffDelay(currentAttempt, params.signal, params.jobDeadline);
      }
      continue;
    } finally {
      clearTimeout(timeoutTimer);
      if (params.signal) {
        params.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  return { ok: false, error: lastError };
}
