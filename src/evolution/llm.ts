import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PluginConfig } from '../config.js';
import {
  assertSafeOutboundEndpoint,
  isOfflineEndpointAllowed,
  isSafeApiKeyEnvName,
  isWorkspaceExcluded,
  type LookupFn,
  redactSecrets,
} from '../core/privacy.js';
import { estimateTokens } from '../core/tokens.js';
import type { Db } from '../types.js';
import { cancel, reserve, settle } from './ledger.js';
import type { LLMTaskKind } from './types.js';

const MAX_LLM_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB hard cap
const MAX_ERROR_BODY_BYTES = 16 * 1024; // 16 KB cap for diagnostic error inspection
const MAX_RETRY_AFTER_MS = 60_000;
const HOST_FALLBACK_CACHE_TTL_MS = 30_000;
const CIRCUIT_BREAKER_OPEN_MS = 5 * 60 * 1000; // 5 minutes
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;

interface CircuitBreakerState {
  consecutiveFailures: number;
  openUntil: number;
}

const endpointCircuitBreakers = new Map<string, CircuitBreakerState>();

export function resetLlmCircuitBreaker(): void {
  endpointCircuitBreakers.clear();
}

function getBreakerKey(endpointUrl: string): string {
  try {
    const u = new URL(endpointUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return endpointUrl;
  }
}

function isCircuitBreakerOpen(endpointUrl: string, now: number = Date.now()): boolean {
  const key = getBreakerKey(endpointUrl);
  const state = endpointCircuitBreakers.get(key);
  if (!state) return false;
  if (state.openUntil > now) {
    return true;
  }
  if (state.openUntil > 0 && state.openUntil <= now) {
    // Half-open recovery window: reset failure counter so a fresh probe can run
    endpointCircuitBreakers.delete(key);
  }
  return false;
}

function recordCircuitSuccess(endpointUrl: string): void {
  endpointCircuitBreakers.delete(getBreakerKey(endpointUrl));
}

function recordCircuitFailure(
  endpointUrl: string,
  options: { immediateOpen?: boolean; now?: number } = {}
): void {
  const now = options.now ?? Date.now();
  const key = getBreakerKey(endpointUrl);
  const prev = endpointCircuitBreakers.get(key) ?? { consecutiveFailures: 0, openUntil: 0 };
  const nextFailures = prev.consecutiveFailures + 1;
  const shouldOpen =
    Boolean(options.immediateOpen) || nextFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD;
  endpointCircuitBreakers.set(key, {
    consecutiveFailures: nextFailures,
    openUntil: shouldOpen ? now + CIRCUIT_BREAKER_OPEN_MS : prev.openUntil,
  });
}

/**
 * 解析 HTTP Retry-After 头（支持非负秒数与 HTTP-date），上限 60s
 */
export function parseRetryAfterMs(
  headerVal: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (!headerVal) return null;
  const trimmed = headerVal.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
    }
  }

  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    const delta = Math.max(0, parsedDate - now);
    return Math.min(MAX_RETRY_AFTER_MS, delta);
  }

  return null;
}

/** 重试退避：支持 Retry-After、429 提高基础退避与全抖动 (full jitter)，受 external signal 与 jobDeadline 约束 */
function backoffDelay(
  attempt: number,
  signal?: AbortSignal,
  jobDeadline?: number,
  options: { isRateLimit?: boolean; retryAfterMs?: number | null } = {}
): Promise<void> {
  let ms: number;
  if (typeof options.retryAfterMs === 'number' && options.retryAfterMs > 0) {
    // 对 Retry-After 增加极小抖动（+/- 10%，不超过上限），避免并发客户端同步惊群
    const jittered = Math.round(options.retryAfterMs * (0.9 + Math.random() * 0.2));
    ms = Math.min(MAX_RETRY_AFTER_MS, jittered);
  } else {
    const capMs = options.isRateLimit
      ? Math.min(15_000, 1_500 * 2 ** (attempt - 1))
      : Math.min(4_000, 400 * 2 ** (attempt - 1));
    // Full jitter: uniform in [0, capMs]
    ms = Math.floor(Math.random() * capMs);
  }

  if (jobDeadline) {
    ms = Math.min(ms, Math.max(0, jobDeadline - Date.now() - 1_000));
  }
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

type BoundedReadResult =
  | { ok: true; text: string; parsedData?: unknown }
  | { ok: false; reason: 'response_too_large' | 'unreadable_response' | 'invalid_json_response' };

/**
 * 流式有界读取 HTTP 响应体（默认上限 2 MB），杜绝恶意或失控端点造成 OOM。
 */
export async function readBoundedText(
  res: any,
  maxBytes: number = MAX_LLM_RESPONSE_BYTES
): Promise<BoundedReadResult> {
  const contentLengthHeader = res?.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainResponse(res);
      return { ok: false, reason: 'response_too_large' };
    }
  }

  if (res?.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk =
          value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          return { ok: false, reason: 'response_too_large' };
        }
        chunks.push(chunk);
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const decoder = new TextDecoder('utf-8');
    return { ok: true, text: decoder.decode(merged) };
  }

  if (typeof res?.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'response_too_large' };
    }
    return { ok: true, text };
  }

  if (typeof res?.json === 'function') {
    try {
      const data = await res.json();
      const text = JSON.stringify(data);
      if (Buffer.byteLength(text, 'utf8') > maxBytes) {
        return { ok: false, reason: 'response_too_large' };
      }
      return { ok: true, text, parsedData: data };
    } catch (err) {
      if (err instanceof SyntaxError) {
        return { ok: false, reason: 'invalid_json_response' };
      }
      throw err;
    }
  }

  return { ok: false, reason: 'unreadable_response' };
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
  lookupFn?: LookupFn;
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

/**
 * 标量反引号解析：优先提取带引号的字符串（忽略其后的行内 # 注释），
 * 未加引号时才剥离行内 # 注释。
 */
export function unquoteScalar(raw: string): string {
  const s = raw.trim();
  if (!s) return '';

  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        const next = s[i + 1];
        if (next === '"' || next === '\\') {
          out += next;
          i++;
          continue;
        }
      }
      if (ch === '"') {
        return out;
      }
      out += ch;
    }
    return s.slice(1);
  }

  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    if (end >= 1) {
      return s.slice(1, end);
    }
    return s.slice(1);
  }

  // Strip inline comment only when unquoted
  const hashIdx = s.indexOf(' #');
  const tabHashIdx = s.indexOf('\t#');
  const commentIdx =
    hashIdx >= 0 && tabHashIdx >= 0 ? Math.min(hashIdx, tabHashIdx) : Math.max(hashIdx, tabHashIdx);
  return (commentIdx >= 0 ? s.slice(0, commentIdx) : s).trim();
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

export function isOpenAIReasoningModel(model: string): boolean {
  const m = (model || '').trim();
  if (!m) return false;
  return /(?:^|\/)(?:o1|o3|o4)(?:$|[-._])/i.test(m) || /(?:^|\/)gpt-5(?:$|[-._])/i.test(m);
}

export function isReasoningModel(model: string): boolean {
  const m = (model || '').trim();
  if (!m) return false;
  return (
    isOpenAIReasoningModel(m) ||
    /(?:^|\/|-)deepseek-(?:r1|reasoner|v4)(?:$|[-._])/i.test(m) ||
    /(?:^|\/|-)qwq(?:$|[-._])/i.test(m) ||
    /(?:^|[-_/])(?:reasoner|thinking)(?:$|[-._])/i.test(m)
  );
}

function normalizeProviderBaseUrl(rawUrl: string, api?: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    const proto = (api || '').trim().toLowerCase();
    if (
      (parsed.pathname === '' || parsed.pathname === '/') &&
      (proto === 'openai-responses' ||
        proto === 'openai-completions' ||
        proto === 'chat/completions' ||
        proto === 'responses' ||
        proto === 'anthropic-messages' ||
        proto === 'messages')
    ) {
      parsed.pathname = '/v1';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {}
  return trimmed;
}

interface FileCacheEntry<T> {
  mtimeMs: number;
  size: number;
  expiresAt: number;
  data: T;
}

const dotEnvFileCache = new Map<string, FileCacheEntry<Record<string, string>>>();
const patchConfigFileCache = new Map<
  string,
  FileCacheEntry<{
    providers: Array<[string, ParsedPatchProvider]>;
    defaultModel: { provider?: string; model?: string };
  }>
>();

export function clearHostLlmFallbackCache(): void {
  dotEnvFileCache.clear();
  patchConfigFileCache.clear();
}

function parseDotEnvFile(filePath: string): Record<string, string> {
  const now = Date.now();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    dotEnvFileCache.delete(filePath);
    return {};
  }

  const cached = dotEnvFileCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    now < cached.expiresAt
  ) {
    return cached.data;
  }

  const parsed: Record<string, string> = {};
  try {
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
      if (val && !(key in parsed)) {
        parsed[key] = val;
      }
    }
  } catch {}

  dotEnvFileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    expiresAt: now + HOST_FALLBACK_CACHE_TTL_MS,
    data: parsed,
  });
  return parsed;
}

function parseDotEnvInto(filePath: string, target: Record<string, string>): void {
  const entries = parseDotEnvFile(filePath);
  for (const [k, v] of Object.entries(entries)) {
    if (v && !(k in target)) {
      target[k] = v;
    }
  }
}

interface ParsedPatchProvider {
  baseURL?: string;
  apiKeyEnv?: string;
  api?: string;
}

function parsePatchLlmConfigFile(filePath: string): {
  providers: Array<[string, ParsedPatchProvider]>;
  defaultModel: { provider?: string; model?: string };
} {
  const now = Date.now();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    patchConfigFileCache.delete(filePath);
    return { providers: [], defaultModel: {} };
  }

  const cached = patchConfigFileCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    now < cached.expiresAt
  ) {
    return cached.data;
  }

  const providersOut = new Map<string, ParsedPatchProvider>();
  const defaultModelOut: { provider?: string; model?: string } = {};

  try {
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

  const data = {
    providers: Array.from(providersOut.entries()),
    defaultModel: defaultModelOut,
  };
  patchConfigFileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    expiresAt: now + HOST_FALLBACK_CACHE_TTL_MS,
    data,
  });
  return data;
}

function parsePatchLlmConfig(
  filePath: string,
  providersOut: Map<string, ParsedPatchProvider>,
  defaultModelOut: { provider?: string; model?: string }
): void {
  const parsed = parsePatchLlmConfigFile(filePath);
  for (const [name, p] of parsed.providers) {
    const existing = providersOut.get(name) || {};
    providersOut.set(name, {
      baseURL: p.baseURL ?? existing.baseURL,
      apiKeyEnv: p.apiKeyEnv ?? existing.apiKeyEnv,
      api: p.api ?? existing.api,
    });
  }
  if (parsed.defaultModel.provider) defaultModelOut.provider = parsed.defaultModel.provider;
  if (parsed.defaultModel.model) defaultModelOut.model = parsed.defaultModel.model;
}

/**
 * 解析 DSH 宿主 LLM 兜底通道：
 * 1) 优先读取当前进程环境（含 DSH_LLM / DEEPSEEK / OPENAI / ANTHROPIC）
 * 2) 若进程环境未直接给出，读取 ~/.dsh/.env（绝不读取 ~/.dsh/.credentials.yaml，遵循 APPENDIX-A）
 *    与 cordis.patch.yml 中的 agent-default-model + llm-pi-ai provider 配置（带 mtimeMs/30s 缓存）
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
      const protocol: LLMProtocol | undefined = prefix === 'ANTHROPIC' ? 'messages' : undefined;
      return {
        baseURL: normalizeProviderBaseUrl(url, protocol ?? 'openai-completions'),
        apiKey,
        ...(protocol ? { protocol } : {}),
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
      model: !isPlaceholderModel(preferredModel) ? preferredModel : envModel || 'deepseek-chat',
      protocol: 'chat/completions',
    };
  }

  // Tier 2: DSH home disk config (.env + cordis.patch.yml; NEVER reads .credentials.yaml)
  const dshHome = (options?.dshHome || procEnv.DSH_HOME || path.join(os.homedir(), '.dsh')).trim();
  const diskEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(procEnv)) {
    if (typeof v === 'string' && v.trim()) diskEnv[k] = v;
  }
  parseDotEnvInto(path.join(dshHome, '.env'), diskEnv);

  const providers = new Map<string, ParsedPatchProvider>();
  const defaultModelInfo: { provider?: string; model?: string } = {};
  parsePatchLlmConfig(path.join(dshHome, 'cordis.patch.yml'), providers, defaultModelInfo);
  parsePatchLlmConfig(
    path.join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml'),
    providers,
    defaultModelInfo
  );

  const pickProvider = (name: string): DshHostLlmFallback | null => {
    const p = providers.get(name);
    if (!p?.baseURL) return null;
    const keyEnv = p.apiKeyEnv?.trim() || '';
    const apiKey = keyEnv && isSafeApiKeyEnvName(keyEnv) ? (diskEnv[keyEnv] || '').trim() : '';
    if (!apiKey) return null;
    const protocol = mapDshPiAiProtocol(p.api);
    const normalizedUrl = normalizeProviderBaseUrl(
      p.baseURL,
      p.api || protocol || 'openai-completions'
    );
    const preferredModel = (currentModel || '').trim();
    // 仅当 provider 与 defaultModelInfo.provider 一致时才附带默认模型名，防止跨厂商张冠李戴
    const matchedDefaultModel =
      defaultModelInfo.provider && name === defaultModelInfo.provider
        ? defaultModelInfo.model
        : undefined;
    return {
      baseURL: normalizedUrl,
      apiKey,
      model: !isPlaceholderModel(preferredModel)
        ? preferredModel
        : matchedDefaultModel || undefined,
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
      const protocol: LLMProtocol | undefined = prefix === 'ANTHROPIC' ? 'messages' : undefined;
      return {
        baseURL: normalizeProviderBaseUrl(url, protocol ?? 'openai-completions'),
        apiKey: (diskEnv[`${prefix}_API_KEY`] || '').trim(),
        ...(protocol ? { protocol } : {}),
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

/**
 * 严格基于 WHATWG URL 解析与路径规范化构造最终端点，
 * 拒绝非 http(s)、内嵌凭据、query 与 fragment，防止路径拼接绕过与 SSRF。
 */
export function resolveEndpointAndProtocol(
  baseURL: string,
  configuredProtocol: LLMProtocol = 'chat/completions'
): { endpointUrl: string; protocol: LLMProtocol } {
  const trimmed = (baseURL || '').trim();
  if (!trimmed) {
    throw new Error('missing_base_url');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('invalid_base_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('unsupported_protocol');
  }
  if (!parsed.origin || parsed.origin === 'null' || !parsed.hostname) {
    throw new Error('invalid_origin');
  }
  if (parsed.username || parsed.password) {
    throw new Error('url_credentials_forbidden');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('url_query_or_hash_forbidden');
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  if (cleanPath.endsWith('/responses')) {
    parsed.pathname = cleanPath;
    return { endpointUrl: parsed.toString(), protocol: 'responses' };
  }
  if (cleanPath.endsWith('/messages')) {
    parsed.pathname = cleanPath;
    return { endpointUrl: parsed.toString(), protocol: 'messages' };
  }
  if (cleanPath.endsWith('/chat/completions')) {
    parsed.pathname = cleanPath;
    return { endpointUrl: parsed.toString(), protocol: 'chat/completions' };
  }

  const protocol: LLMProtocol = configuredProtocol || 'chat/completions';
  parsed.pathname = `${cleanPath}/${protocol}`;
  return {
    endpointUrl: parsed.toString(),
    protocol,
  };
}

export interface BuildPayloadOptions {
  omitResponseFormat?: boolean;
  omitTemperature?: boolean;
}

export function buildProtocolPayload(
  protocol: LLMProtocol,
  model: string,
  sanitizedSystem: string,
  sanitizedUser: string,
  maxOutputTokens: number,
  options: BuildPayloadOptions = {}
): { requestBody: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const openaiReasoning = isOpenAIReasoningModel(model);
  const omitTemp = Boolean(options.omitTemperature) || openaiReasoning;
  const omitFormat = Boolean(options.omitResponseFormat);

  if (protocol === 'messages') {
    headers['anthropic-version'] = '2023-06-01';
    const body: Record<string, unknown> = {
      model,
      system: sanitizedSystem,
      messages: [{ role: 'user', content: sanitizedUser }],
      max_tokens: maxOutputTokens,
    };
    if (!omitTemp) {
      body.temperature = 0.0;
    }
    return { requestBody: JSON.stringify(body), headers };
  }

  if (protocol === 'responses') {
    const body: Record<string, unknown> = {
      model,
      input: [
        { role: 'system', content: sanitizedSystem },
        { role: 'user', content: sanitizedUser },
      ],
      max_output_tokens: maxOutputTokens,
    };
    if (!omitTemp) {
      body.temperature = 0.0;
    }
    if (!omitFormat) {
      body.text = { format: { type: 'json_object' } };
    }
    return { requestBody: JSON.stringify(body), headers };
  }

  // Default: chat/completions
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: sanitizedSystem },
      { role: 'user', content: sanitizedUser },
    ],
  };
  if (openaiReasoning) {
    body.max_completion_tokens = maxOutputTokens;
  } else {
    body.max_tokens = maxOutputTokens;
  }
  if (!omitTemp) {
    body.temperature = 0.0;
  }
  if (!omitFormat) {
    body.response_format = { type: 'json_object' };
  }
  return { requestBody: JSON.stringify(body), headers };
}

/**
 * 路径边界敏感的工作区与主目录匿名化：
 * - 跳过过短或根路径（< 3 字符）防止误伤普通英文单词
 * - 先匿名化 cwd -> <workspace>，再匿名化 os.homedir() -> <home>
 */
export function anonymizeWorkspacePaths(
  text: string,
  cwd?: string,
  homeDir: string = os.homedir()
): string {
  if (!text) return text;
  let result = text;

  const buildVariants = (rawPath?: string): string[] => {
    const trimmed = (rawPath || '').trim().replace(/[\\/]+$/, '');
    if (trimmed.length < 3) return [];
    // 跳过裸盘符（如 C:）或 16 位十六进制 workspaceId
    if (/^[A-Za-z]:$/.test(trimmed) || /^[0-9a-f]{16}$/i.test(trimmed)) return [];
    const variants = Array.from(
      new Set([trimmed, trimmed.replace(/\\/g, '/'), trimmed.replace(/\//g, '\\')])
    ).filter((v) => v.length >= 3);
    variants.sort((a, b) => b.length - a.length);
    return variants;
  };

  const replaceWithBoundaries = (
    input: string,
    variants: string[],
    placeholder: string
  ): string => {
    let out = input;
    for (const v of variants) {
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `(?<![A-Za-z0-9_])${escaped}(?=$|[\\\\/:"'\`,;\\s)\\]}<>]|\\.(?=\\s|$))`,
        'gi'
      );
      out = out.replace(regex, placeholder);
    }
    return out;
  };

  const cwdVariants = buildVariants(cwd);
  if (cwdVariants.length > 0) {
    result = replaceWithBoundaries(result, cwdVariants, '<workspace>');
  }

  const homeVariants = buildVariants(homeDir);
  if (homeVariants.length > 0) {
    result = replaceWithBoundaries(result, homeVariants, '<home>');
  }

  return result;
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
    if (text.trim().length > 0) return text;
  }

  // 3. Anthropic messages: content array of text blocks
  if (Array.isArray(data?.content)) {
    const text = data.content
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b?.text || '')
      .join('');
    if (text.trim().length > 0) return text;
  } else if (typeof data?.content === 'string' && data.content.trim().length > 0) {
    return data.content;
  }

  // 4. Fallback direct text
  if (typeof data?.text === 'string' && data.text.trim().length > 0) {
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

function isOutputLengthTruncated(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (data?.choices?.[0]?.finish_reason === 'length') return true;
  if (data?.stop_reason === 'max_tokens') return true;
  if (data?.status === 'incomplete') return true;
  if (data?.incomplete_details?.reason === 'max_output_tokens') return true;
  return false;
}

/**
 * 离线 LLM 调用客户端
 * 严格执行：隐私闸门 -> 端点规范与 SSRF 守卫 -> 熔断检查 -> 输入上界 -> 账本预留 -> 网络调用/重试 -> 结算
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
  if (
    [params.cwd, params.workspaceId, ...(params.dataWorkspaceIds || [])].some((owner) =>
      isWorkspaceExcluded(owner, cfg.excludeWorkspaces)
    )
  ) {
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
    usingHostFallback &&
    (!cfg.privacy.allowedOfflineEndpoints || cfg.privacy.allowedOfflineEndpoints.length === 0)
      ? [baseURL]
      : cfg.privacy.allowedOfflineEndpoints;

  if (!isOfflineEndpointAllowed(baseURL, effectiveAllowedEndpoints, cfg.privacy.offlineConsent)) {
    return { ok: false, error: 'endpoint_not_allowed' };
  }

  // 构造标准端点 URL 与协议，并再次校验解析后的 endpointUrl
  let endpointUrl: string;
  let protocol: LLMProtocol;
  try {
    const resolved = resolveEndpointAndProtocol(baseURL, configuredProtocol);
    endpointUrl = resolved.endpointUrl;
    protocol = resolved.protocol;
  } catch (err: any) {
    return { ok: false, error: err?.message || 'invalid_base_url' };
  }

  if (
    !isOfflineEndpointAllowed(endpointUrl, effectiveAllowedEndpoints, cfg.privacy.offlineConsent)
  ) {
    return { ok: false, error: 'endpoint_not_allowed' };
  }

  // 熔断器检查（不消耗账本预留）
  if (isCircuitBreakerOpen(endpointUrl)) {
    return { ok: false, error: 'circuit_breaker_open' };
  }

  // 2. 脱敏与路径匿名化（<workspace> & <home>）
  const sanitizedSystem = anonymizeWorkspacePaths(
    redactSecrets(params.systemPrompt).text,
    params.cwd
  );
  const sanitizedUser = anonymizeWorkspacePaths(redactSecrets(params.userPrompt).text, params.cwd);

  // 3. 输入上界计算与校验（覆盖 system + user + provider 包装约 200 tokens）
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

  const reasoningModel = isReasoningModel(model);
  let currentMaxOutputTokens =
    reasoningModel && params.maxOutputTokens >= 1200
      ? Math.max(params.maxOutputTokens, 4096)
      : params.maxOutputTokens;

  // 读取 API 密钥（优先直接配置的 apiKey，其次从安全白名单环境变量读取）
  // 宿主兜底时只用与端点成对的宿主密钥：此前为自定义端点保存的密钥不属于这个端点
  let apiKey = usingHostFallback ? hostFallbackKey : cfg.offlineLLM.apiKey || '';
  const keyEnv = (cfg.offlineLLM.apiKeyEnv || '').trim();
  if (
    !apiKey &&
    !usingHostFallback &&
    keyEnv &&
    isSafeApiKeyEnvName(keyEnv) &&
    process.env[keyEnv]
  ) {
    apiKey = process.env[keyEnv]!;
  }

  let payloadOptions: BuildPayloadOptions = {};
  let { requestBody, headers: protocolHeaders } = buildProtocolPayload(
    protocol,
    model,
    sanitizedSystem,
    sanitizedUser,
    currentMaxOutputTokens,
    payloadOptions
  );

  // 4. 重试循环（最多 3 次发送尝试）
  const maxAttempts = 3;
  let currentAttempt = 0;
  let capabilityDowngraded = false;
  let lastError = 'unknown_error';
  let lastLedgerId: number | undefined;

  while (currentAttempt < maxAttempts) {
    currentAttempt++;

    // 每次实际 fetch 前强制执行 SSRF / DNS 外发安全校验
    const safeCheck = await assertSafeOutboundEndpoint(endpointUrl, {
      allowLoopback: true,
      skipDnsLookup: Boolean(params.fetchFn) && !params.lookupFn,
      lookupFn: params.lookupFn,
    });
    if (!safeCheck.ok) {
      return {
        ok: false,
        error: `unsafe_endpoint:${safeCheck.reason || 'blocked'}`,
        ...(lastLedgerId !== undefined ? { ledgerId: lastLedgerId } : {}),
      };
    }

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
      return {
        ok: false,
        error: reserveRes.reason || 'daily_limit_exceeded',
        ...(lastLedgerId !== undefined ? { ledgerId: lastLedgerId } : {}),
      };
    }

    const ledgerId = reserveRes.ledgerId;
    lastLedgerId = ledgerId;

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
        if (protocol === 'messages') {
          headers['x-api-key'] = apiKey;
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
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
        let errSnippet = '';
        if (res.status === 400 || res.status === 422) {
          const errRead = await readBoundedText(res, MAX_ERROR_BODY_BYTES);
          if (errRead.ok) {
            errSnippet = errRead.text;
          }
        } else {
          await drainResponse(res);
        }

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

        // 认证失败（401/403）立即触发 5 分钟熔断
        if (res.status === 401 || res.status === 403) {
          recordCircuitFailure(endpointUrl, { immediateOpen: true });
          return { ok: false, error: `http_${res.status}`, ledgerId };
        }

        // 400/422 能力协商降级：若错误体提及 response_format/text.format/temperature，自动降级重试 1 次
        if (
          (res.status === 400 || res.status === 422) &&
          !capabilityDowngraded &&
          currentAttempt < maxAttempts &&
          /response_format|text\.format|json_object|temperature/i.test(errSnippet)
        ) {
          capabilityDowngraded = true;
          payloadOptions = {
            omitResponseFormat: true,
            omitTemperature: true,
          };
          const downgraded = buildProtocolPayload(
            protocol,
            model,
            sanitizedSystem,
            sanitizedUser,
            currentMaxOutputTokens,
            payloadOptions
          );
          requestBody = downgraded.requestBody;
          protocolHeaders = downgraded.headers;
          lastError = `http_${res.status}`;
          continue;
        }

        // 其它 4xx 不重试（429 限流除外）
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          return { ok: false, error: `http_${res.status}`, ledgerId };
        }

        if (res.status >= 500) {
          recordCircuitFailure(endpointUrl);
        }

        // 5xx / 429 瞬时错误且还有尝试机会时，尊重 Retry-After 并退避重试
        lastError = `http_${res.status}`;
        if (currentAttempt < maxAttempts) {
          const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
          await backoffDelay(currentAttempt, params.signal, params.jobDeadline, {
            isRateLimit: res.status === 429,
            retryAfterMs,
          });
          if (params.signal?.aborted) {
            return { ok: false, error: 'aborted', ledgerId };
          }
          if (params.jobDeadline && Date.now() >= params.jobDeadline) {
            return { ok: false, error: 'job_deadline_exceeded', ledgerId };
          }
        }
        continue;
      }

      // 请求成功：流式有界读取（2 MB 硬上限）并独立解析 JSON
      const bodyRead = await readBoundedText(res, MAX_LLM_RESPONSE_BYTES);
      if (!bodyRead.ok) {
        settle(db, {
          ledgerId,
          status: 'failed',
          ok: 0,
          note: bodyRead.reason,
        });
        return { ok: false, error: bodyRead.reason, ledgerId };
      }

      let data: any;
      try {
        data = bodyRead.parsedData !== undefined ? bodyRead.parsedData : JSON.parse(bodyRead.text);
      } catch {
        settle(db, {
          ledgerId,
          status: 'failed',
          ok: 0,
          note: 'invalid_json_response',
        });
        return { ok: false, error: 'invalid_json_response', ledgerId };
      }

      const usage = extractResponseUsage(data);

      // 优先检查 200 OK 内嵌错误体（如代理网关返回的 {"error": {...}}）
      if (data?.error) {
        settle(db, {
          ledgerId,
          status: usage ? 'failed' : 'unknown',
          ok: 0,
          ...(usage ? { inTokens: usage.prompt_tokens, outTokens: usage.completion_tokens } : {}),
          note: 'provider_error_body',
        });
        return { ok: false, error: 'provider_error_body', ledgerId };
      }

      const rawContent = extractResponseContent(data);
      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        const truncated = isOutputLengthTruncated(data);
        settle(db, {
          ledgerId,
          status: usage ? 'failed' : 'unknown',
          ok: 0,
          ...(usage ? { inTokens: usage.prompt_tokens, outTokens: usage.completion_tokens } : {}),
          note: truncated ? 'missing_choice_content_truncated' : 'missing_choice_content',
        });

        // 仅当响应明确因输出长度截断（如推理模型耗尽 maxOutputTokens）时才扩容重试
        if (truncated && currentAttempt < maxAttempts) {
          currentMaxOutputTokens = Math.max(currentMaxOutputTokens * 2, 8192);
          const nextPayload = buildProtocolPayload(
            protocol,
            model,
            sanitizedSystem,
            sanitizedUser,
            currentMaxOutputTokens,
            payloadOptions
          );
          requestBody = nextPayload.requestBody;
          protocolHeaders = nextPayload.headers;
          lastError = 'missing_choice_content';
          continue;
        }
        return { ok: false, error: 'missing_choice_content', ledgerId };
      }

      // 成功响应：重置端点熔断状态
      recordCircuitSuccess(endpointUrl);

      // 处理使用量结算
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
      const isExternalAbort = Boolean(params.signal?.aborted);
      const note = isAbort ? 'timeout_or_abort' : 'network_error';

      // 发送后发生网络异常或超时，记 unknown 保留完整预留
      settle(db, {
        ledgerId,
        status: 'unknown',
        ok: 0,
        note,
      });

      if (!isExternalAbort) {
        recordCircuitFailure(endpointUrl);
      }

      lastError = isExternalAbort ? 'aborted' : isAbort ? 'timeout' : 'network_error';

      // 如果是外部取消或总超时，不再重试
      if (isExternalAbort || (params.jobDeadline && Date.now() >= params.jobDeadline)) {
        return { ok: false, error: lastError, ledgerId };
      }

      // 仅瞬时网络故障重试（指数退避 + 全抖动）
      if (currentAttempt < maxAttempts) {
        await backoffDelay(currentAttempt, params.signal, params.jobDeadline);
        if (params.signal?.aborted) {
          return { ok: false, error: 'aborted', ledgerId };
        }
        if (params.jobDeadline && Date.now() >= params.jobDeadline) {
          return { ok: false, error: 'job_deadline_exceeded', ledgerId };
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
      if (params.signal) {
        params.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  return {
    ok: false,
    error: lastError,
    ...(lastLedgerId !== undefined ? { ledgerId: lastLedgerId } : {}),
  };
}
