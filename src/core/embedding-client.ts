import type { EmbeddingProviderMeta } from '../types.js';
import type { PluginConfig } from '../config.js';
import {
  assertSafeOutboundEndpoint,
  isOfflineEndpointAllowed,
  isSafeApiKeyEnvName,
  redactSecrets,
  type LookupFn,
} from './privacy.js';
import { computeLocalEmbedding, DEFAULT_LOCAL_VECTOR_DIM } from './vector.js';

const MAX_EMBEDDING_DIM = 8192;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000;
const MAX_EMBEDDING_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB hard cap
const LOCAL_EMBEDDING_MODEL = 'local-fnv1a-hash-v2';

export interface RemoteEmbeddingOptions {
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  skipDnsLookup?: boolean;
}

export type RemoteEmbeddingResult =
  | { ok: true; vectors: Float32Array[]; dim: number }
  | { ok: false; reason: string };

export interface EmbedQueryOptions extends RemoteEmbeddingOptions {
  allowRemote?: boolean;
}

export interface EmbedQueryResult {
  vec: Float32Array;
  source: 'remote' | 'local';
  dim: number;
}

/**
 * 规范化 OpenAI-compatible Embeddings 端点 URL：
 * - 若路径已以 /embeddings 结尾则保持不变
 * - 若为根路径 `/` 则补齐 `/v1/embeddings`
 * - 否则拼接 `/embeddings`
 */
export function resolveEmbeddingsEndpointUrl(rawBaseUrl: string): URL | null {
  const trimmed = (rawBaseUrl || '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const cleanPath = url.pathname.replace(/\/+$/, '');
    if (cleanPath.endsWith('/embeddings')) {
      url.pathname = cleanPath;
    } else if (!cleanPath || cleanPath === '/') {
      url.pathname = '/v1/embeddings';
    } else {
      url.pathname = `${cleanPath}/embeddings`;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * 判断远程 OpenAI-compatible Embedding 是否已启用并通过基础隐私/端点白名单检查。
 */
export function isRemoteEmbeddingEnabled(cfg: PluginConfig): boolean {
  if (!cfg || !cfg.embedding || cfg.embedding.provider !== 'openai-compatible') {
    return false;
  }
  const baseURL = (cfg.embedding.baseURL || '').trim();
  const model = (cfg.embedding.model || '').trim();
  const dim = cfg.embedding.dim;

  if (!baseURL || !model) return false;
  if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_EMBEDDING_DIM) return false;
  if (!cfg.privacy?.offlineConsent) return false;

  const endpointUrl = resolveEmbeddingsEndpointUrl(baseURL);
  if (!endpointUrl) return false;

  if (
    !isOfflineEndpointAllowed(
      baseURL,
      cfg.privacy.allowedOfflineEndpoints,
      cfg.privacy.offlineConsent
    )
  ) {
    return false;
  }

  return isOfflineEndpointAllowed(
    endpointUrl.toString(),
    cfg.privacy.allowedOfflineEndpoints,
    cfg.privacy.offlineConsent
  );
}

/**
 * 返回当前生效的 Embedding 提供方元信息及稳定签名（用于检测模型/维度切换与增量迁移）。
 */
export function getActiveEmbeddingMeta(cfg: PluginConfig): EmbeddingProviderMeta {
  if (isRemoteEmbeddingEnabled(cfg)) {
    const endpointUrl = resolveEmbeddingsEndpointUrl(cfg.embedding.baseURL)!;
    const normalizedEndpoint = `${endpointUrl.origin}${endpointUrl.pathname}`;
    const model = cfg.embedding.model.trim();
    const dim = cfg.embedding.dim;
    return {
      provider: 'openai-compatible',
      model,
      dim,
      signature: `openai-compatible|${normalizedEndpoint}|${model}|${dim}`,
    };
  }

  return {
    provider: 'local',
    model: LOCAL_EMBEDDING_MODEL,
    dim: DEFAULT_LOCAL_VECTOR_DIM,
    signature: `local|${LOCAL_EMBEDDING_MODEL}|${DEFAULT_LOCAL_VECTOR_DIM}`,
  };
}

function resolveEmbeddingApiKey(cfg: PluginConfig, endpointUrl: URL): string {
  const directKey = (cfg.embedding.apiKey || '').trim();
  if (directKey) return directKey;

  const keyEnv = (cfg.embedding.apiKeyEnv || '').trim();
  if (keyEnv && isSafeApiKeyEnvName(keyEnv)) {
    const envVal = (process.env[keyEnv] || '').trim();
    if (envVal) return envVal;
  }

  // 仅当 embedding 与 offlineLLM 严格同源 (same origin) 时，才允许回退复用 offlineLLM 凭据
  const llmBase = (cfg.offlineLLM?.baseURL || '').trim();
  if (llmBase) {
    try {
      const llmUrl = new URL(llmBase);
      if (llmUrl.origin === endpointUrl.origin) {
        const llmDirect = (cfg.offlineLLM.apiKey || '').trim();
        if (llmDirect) return llmDirect;

        const llmEnv = (cfg.offlineLLM.apiKeyEnv || '').trim();
        if (llmEnv && isSafeApiKeyEnvName(llmEnv)) {
          const envVal = (process.env[llmEnv] || '').trim();
          if (envVal) return envVal;
        }
      }
    } catch {}
  }

  return '';
}

async function drainResponse(res: Response): Promise<void> {
  try {
    if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    } else if (typeof res.text === 'function') {
      await res.text();
    }
  } catch {}
}

async function readResponseTextWithCap(
  res: Response,
  maxBytes: number
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const contentLengthHeader = res.headers?.get?.('content-length');
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await drainResponse(res);
      return { ok: false, reason: 'response_too_large' };
    }
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk =
          value instanceof Uint8Array
            ? value
            : new Uint8Array(value as ArrayBufferLike);
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

  if (typeof res.text === 'function') {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'response_too_large' };
    }
    return { ok: true, text };
  }

  if (typeof res.json === 'function') {
    const data = await res.json();
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'response_too_large' };
    }
    return { ok: true, text };
  }

  return { ok: false, reason: 'unreadable_response' };
}

function validateAndNormalizeVector(
  raw: unknown,
  expectedDim: number
): Float32Array | null {
  if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) {
    return null;
  }
  const arr = raw as ArrayLike<unknown>;
  const len = arr.length;
  if (!Number.isInteger(len) || len <= 0 || len > MAX_EMBEDDING_DIM) {
    return null;
  }
  if (expectedDim > 0 && len !== expectedDim) {
    return null;
  }

  const vec = new Float32Array(len);
  let normSq = 0;
  for (let i = 0; i < len; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
    vec[i] = v;
    normSq += v * v;
  }

  if (normSq <= 1e-12) {
    return null;
  }

  const invNorm = 1 / Math.sqrt(normSq);
  for (let i = 0; i < len; i++) {
    vec[i] *= invNorm;
  }
  return vec;
}

/**
 * 调用 OpenAI-compatible Embeddings HTTP API 批量计算向量，严格校验隐私授权、SSRF、响应上限、维度与有限数值，并做 L2 归一化。
 */
export async function fetchRemoteEmbeddings(
  texts: string[],
  cfg: PluginConfig,
  options: RemoteEmbeddingOptions = {}
): Promise<RemoteEmbeddingResult> {
  if (!cfg || !cfg.embedding || cfg.embedding.provider !== 'openai-compatible') {
    return { ok: false, reason: 'provider_disabled' };
  }

  const baseURL = (cfg.embedding.baseURL || '').trim();
  const model = (cfg.embedding.model || '').trim();
  const expectedDim = cfg.embedding.dim;

  if (!baseURL) return { ok: false, reason: 'missing_base_url' };
  if (!model) return { ok: false, reason: 'missing_model' };
  if (!Number.isInteger(expectedDim) || expectedDim <= 0 || expectedDim > MAX_EMBEDDING_DIM) {
    return { ok: false, reason: 'invalid_embedding_dim' };
  }

  if (!cfg.privacy?.offlineConsent) {
    return { ok: false, reason: 'offline_consent_required' };
  }

  if (
    !isOfflineEndpointAllowed(
      baseURL,
      cfg.privacy.allowedOfflineEndpoints,
      cfg.privacy.offlineConsent
    )
  ) {
    return { ok: false, reason: 'endpoint_not_allowed' };
  }

  const skipDnsLookup =
    options.skipDnsLookup !== undefined
      ? options.skipDnsLookup
      : Boolean(options.fetchFn && !options.lookupFn);

  const safeCheck = await assertSafeOutboundEndpoint(baseURL, {
    allowLoopback: true,
    lookupFn: options.lookupFn,
    skipDnsLookup,
  });
  if (!safeCheck.ok || !safeCheck.url) {
    return { ok: false, reason: safeCheck.reason || 'unsafe_endpoint' };
  }

  const endpointUrl = resolveEmbeddingsEndpointUrl(safeCheck.url.toString());
  if (!endpointUrl) {
    return { ok: false, reason: 'invalid_endpoint_url' };
  }

  if (
    !isOfflineEndpointAllowed(
      endpointUrl.toString(),
      cfg.privacy.allowedOfflineEndpoints,
      cfg.privacy.offlineConsent
    )
  ) {
    return { ok: false, reason: 'endpoint_not_allowed' };
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: true, vectors: [], dim: expectedDim };
  }

  if (options.signal?.aborted) {
    return { ok: false, reason: 'aborted' };
  }

  const sanitizedTexts = texts.map((t) => {
    const cleaned = redactSecrets(String(t ?? '')).text.trim();
    return cleaned || ' ';
  });

  const apiKey = resolveEmbeddingApiKey(cfg, endpointUrl);
  const timeoutMs = Math.max(
    500,
    Math.min(120_000, cfg.embedding.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS)
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const payload: Record<string, unknown> = {
    model,
    input: sanitizedTexts,
  };
  if (expectedDim > 0) {
    payload.dimensions = expectedDim;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const fetchImpl = options.fetchFn || globalThis.fetch;

  try {
    const res = await fetchImpl(endpointUrl.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: combinedSignal,
      redirect: 'manual',
    });

    if (res.status >= 300 && res.status < 400) {
      await drainResponse(res);
      return { ok: false, reason: 'redirect_not_allowed' };
    }

    if (!res.ok) {
      await drainResponse(res);
      return { ok: false, reason: `http_${res.status}` };
    }

    const bodyRead = await readResponseTextWithCap(res, MAX_EMBEDDING_RESPONSE_BYTES);
    if (!bodyRead.ok) {
      return bodyRead;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyRead.text);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }

    const data = (parsed as { data?: unknown })?.data;
    if (!Array.isArray(data) || data.length !== sanitizedTexts.length) {
      return { ok: false, reason: 'invalid_response_count' };
    }

    const ordered: Array<Float32Array | undefined> = new Array(sanitizedTexts.length);
    let resolvedDim = expectedDim;

    for (let i = 0; i < data.length; i++) {
      const item = data[i] as { index?: unknown; embedding?: unknown } | null;
      if (!item || typeof item !== 'object') {
        return { ok: false, reason: 'invalid_embedding_item' };
      }
      const targetIdx =
        typeof item.index === 'number' && Number.isInteger(item.index) ? item.index : i;
      if (targetIdx < 0 || targetIdx >= sanitizedTexts.length || ordered[targetIdx] !== undefined) {
        return { ok: false, reason: 'invalid_embedding_index' };
      }
      const vec = validateAndNormalizeVector(item.embedding, resolvedDim);
      if (!vec) {
        return { ok: false, reason: 'invalid_embedding_vector' };
      }
      if (resolvedDim <= 0) {
        resolvedDim = vec.length;
      }
      ordered[targetIdx] = vec;
    }

    const vectors: Float32Array[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const vec = ordered[i];
      if (!vec) {
        return { ok: false, reason: 'missing_embedding_vector' };
      }
      vectors.push(vec);
    }

    return { ok: true, vectors, dim: resolvedDim };
  } catch (err: unknown) {
    const errName =
      err && typeof err === 'object' && 'name' in err
        ? String((err as { name?: unknown }).name)
        : '';
    if (
      errName === 'AbortError' ||
      errName === 'TimeoutError' ||
      combinedSignal.aborted
    ) {
      return { ok: false, reason: options.signal?.aborted ? 'aborted' : 'timeout' };
    }
    return { ok: false, reason: 'network_error' };
  }
}

/**
 * 在线查询向量化：优先尝试远程 OpenAI-compatible Embedding，离线/未启用/异常时无缝回退本地 128D 特征哈希向量。
 */
export async function embedQueryWithFallback(
  queryText: string,
  cfg: PluginConfig,
  options: EmbedQueryOptions = {}
): Promise<EmbedQueryResult> {
  const trimmed = (queryText || '').trim();
  if (
    trimmed &&
    options.allowRemote !== false &&
    isRemoteEmbeddingEnabled(cfg)
  ) {
    const remoteRes = await fetchRemoteEmbeddings([trimmed], cfg, {
      signal: options.signal,
      fetchFn: options.fetchFn,
      lookupFn: options.lookupFn,
      skipDnsLookup: options.skipDnsLookup,
    });
    if (remoteRes.ok && remoteRes.vectors.length === 1) {
      return {
        vec: remoteRes.vectors[0],
        source: 'remote',
        dim: remoteRes.dim,
      };
    }
  }

  const localVec = computeLocalEmbedding(queryText, DEFAULT_LOCAL_VECTOR_DIM);
  return {
    vec: localVec,
    source: 'local',
    dim: DEFAULT_LOCAL_VECTOR_DIM,
  };
}
