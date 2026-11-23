import type { PluginConfig } from '../config.js';
import {
  assertSafeOutboundEndpoint,
  isOfflineEndpointAllowed,
  isSafeApiKeyEnvName,
  type LookupFn,
  redactSecrets,
} from '../core/privacy.js';
import {
  buildProtocolPayload,
  type LLMProtocol,
  resolveDshHostLlmFallback,
  resolveEndpointAndProtocol,
} from '../evolution/llm.js';

export interface LlmProbeRequest {
  baseURL?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  protocol?: 'chat/completions' | 'responses' | 'messages';
  useDshLlm?: boolean;
}

export interface LlmProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model?: string;
  endpoint?: string;
  protocol?: LLMProtocol;
  error?: string;
  code?: string;
}

export interface LlmProbeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  lookupFn?: LookupFn;
  skipDnsLookup?: boolean;
  bypassRateLimit?: boolean;
  requireConsent?: boolean;
  now?: () => number;
  dshHome?: string;
  env?: Record<string, string | undefined>;
}

const MAX_CONCURRENT_PROBES = 1;
const MAX_PROBES_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 4096; // 4 KiB hard cap

let activeProbeCount = 0;
const recentProbeTimestamps: number[] = [];

/**
 * 重置进程内探测限流窗口（仅供单元测试隔离使用）
 */
export function resetLlmProbeRateLimit(): void {
  activeProbeCount = 0;
  recentProbeTimestamps.length = 0;
}

function isSameOriginUrl(urlA?: string, urlB?: string): boolean {
  if (!urlA || !urlB) return false;
  try {
    return new URL(urlA.trim()).origin === new URL(urlB.trim()).origin;
  } catch {
    return false;
  }
}

async function cancelResponseBody(res: Response): Promise<void> {
  try {
    if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    }
  } catch {
    // ignore cancel errors
  }
}

async function readErrorBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk =
          value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
        const remaining = maxBytes - totalBytes;
        if (chunk.byteLength > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          totalBytes += remaining;
          try {
            await reader.cancel();
          } catch {}
          break;
        }
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
        if (totalBytes >= maxBytes) {
          try {
            await reader.cancel();
          } catch {}
          break;
        }
      }
    } catch {
      // return whatever was read cleanly before stream error
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
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
  }

  if (typeof res.text === 'function') {
    try {
      const full = await res.text();
      return Buffer.from(full, 'utf8').subarray(0, maxBytes).toString('utf8');
    } catch {
      return '';
    }
  }

  return '';
}

function sanitizeDiagnosticSnippet(raw: string, apiKey: string): string {
  let msg = raw.trim();
  if (!msg) return '';

  try {
    const parsed = JSON.parse(msg) as { error?: { message?: unknown }; message?: unknown };
    if (typeof parsed?.error?.message === 'string' && parsed.error.message.trim()) {
      msg = parsed.error.message.trim();
    } else if (typeof parsed?.message === 'string' && parsed.message.trim()) {
      msg = parsed.message.trim();
    }
  } catch {
    // non-JSON response body
  }

  if (apiKey && apiKey.length >= 6 && msg.includes(apiKey)) {
    msg = msg.split(apiKey).join('[REDACTED:API_KEY]');
  }

  const redacted = redactSecrets(msg).text.replace(/\s+/g, ' ').trim();
  return redacted.length > 200 ? `${redacted.slice(0, 197)}...` : redacted;
}

/**
 * 安全的离线 LLM 连通性探测服务：
 * - 单飞并发锁（最多 1 个并发探测）+ 滑动窗口限流（每分钟最多 10 次）
 * - 默认强制校验 privacy.offlineConsent 与 allowedOfflineEndpoints 白名单
 * - 强制通过 assertSafeOutboundEndpoint 拦截 SSRF、云元数据/链路本地 IP、userinfo 与 ?/# 路径拼接绕过
 * - 严格按源校验凭据，严禁跨源泄漏已保存的 apiKey 或环境变量
 * - redirect: 'manual'、10s 超时 + 外部 AbortSignal、2xx 立即 cancel body、非 2xx 最多读 4 KiB 并脱敏
 */
export async function probeOfflineLLM(
  req: LlmProbeRequest,
  cfg: PluginConfig,
  options: LlmProbeOptions = {}
): Promise<LlmProbeResult> {
  const getNow = options.now ?? (() => Date.now());
  const bypassRateLimit = options.bypassRateLimit === true;
  const requireConsent = options.requireConsent !== false;

  if (!bypassRateLimit) {
    if (activeProbeCount >= MAX_CONCURRENT_PROBES) {
      return {
        ok: false,
        latencyMs: 0,
        code: 'probe_in_flight',
        error: 'Another LLM connection probe is already in progress',
      };
    }

    const nowMs = getNow();
    while (
      recentProbeTimestamps.length > 0 &&
      nowMs - recentProbeTimestamps[0] >= RATE_LIMIT_WINDOW_MS
    ) {
      recentProbeTimestamps.shift();
    }

    if (recentProbeTimestamps.length >= MAX_PROBES_PER_MINUTE) {
      return {
        ok: false,
        latencyMs: 0,
        code: 'rate_limited',
        error: `Probe rate limit exceeded (max ${MAX_PROBES_PER_MINUTE} probes per minute)`,
      };
    }

    recentProbeTimestamps.push(nowMs);
    activeProbeCount++;
  }

  try {
    // 1. 外发隐私同意闸门（在任何 DNS 查询前拦断，避免未授权外发侧信道）
    if (requireConsent && !cfg.privacy?.offlineConsent) {
      return {
        ok: false,
        latencyMs: 0,
        code: 'privacy_offline_consent_required',
        error: 'Offline LLM outbound consent is required (privacy.offlineConsent=false)',
      };
    }

    // 2. 解析目标端点、模型与宿主兜底通道
    const reqBaseURL = typeof req.baseURL === 'string' ? req.baseURL.trim() : '';
    const useDshLlm =
      typeof req.useDshLlm === 'boolean' ? req.useDshLlm : Boolean(cfg.offlineLLM.useDshLlm);
    const candidateModel = (
      (typeof req.model === 'string' ? req.model.trim() : '') ||
      cfg.offlineLLM.model ||
      'deepseek-chat'
    ).trim();

    const shouldTryHostFallback =
      !reqBaseURL && (req.useDshLlm === true || (!cfg.offlineLLM.baseURL && useDshLlm));
    const hostFallback = shouldTryHostFallback
      ? resolveDshHostLlmFallback(candidateModel, {
          dshHome: options.dshHome,
          env: options.env,
        })
      : null;
    const usingHostFallback = !reqBaseURL && Boolean(hostFallback);

    const baseURL = (
      reqBaseURL ||
      (req.useDshLlm === true ? '' : cfg.offlineLLM.baseURL) ||
      hostFallback?.baseURL ||
      ''
    ).trim();
    const model = (usingHostFallback && hostFallback?.model) || candidateModel;

    if (!baseURL) {
      return {
        ok: false,
        latencyMs: 0,
        code: 'missing_base_url',
        error: 'Base URL is required',
      };
    }

    // 3. 在拼接协议路径前执行统一 SSRF / URL 安全守卫（显式拦断含裸尾 ?/# 的路径绕过、userinfo、云元数据与私网/链路本地 IP）
    if (baseURL.includes('?') || baseURL.includes('#')) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        code: 'url_query_or_hash_forbidden',
        error: 'Blocked unsafe endpoint: url_query_or_hash_forbidden',
      };
    }

    const skipDnsLookup =
      options.skipDnsLookup !== undefined
        ? options.skipDnsLookup
        : Boolean(options.fetchFn && !options.lookupFn);

    const safeBase = await assertSafeOutboundEndpoint(baseURL, {
      allowLoopback: true,
      lookupFn: options.lookupFn,
      skipDnsLookup,
    });
    if (!safeBase.ok || !safeBase.url) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        code: safeBase.reason || 'unsafe_endpoint',
        error: `Blocked unsafe endpoint: ${safeBase.reason || 'unsafe_endpoint'}`,
      };
    }

    const rawProtocol = typeof req.protocol === 'string' ? req.protocol.trim() : '';
    const chosenProtocol: LLMProtocol =
      rawProtocol === 'chat/completions' ||
      rawProtocol === 'responses' ||
      rawProtocol === 'messages'
        ? rawProtocol
        : (usingHostFallback && hostFallback?.protocol) ||
          cfg.offlineLLM.protocol ||
          'chat/completions';

    let endpointUrl: string;
    let protocol: LLMProtocol;
    try {
      const resolved = resolveEndpointAndProtocol(baseURL, chosenProtocol);
      endpointUrl = resolved.endpointUrl;
      protocol = resolved.protocol;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'invalid_base_url';
      return {
        ok: false,
        latencyMs: 0,
        model,
        code: reason,
        error: `Blocked unsafe endpoint: ${reason}`,
      };
    }

    // 对最终拼接出的 endpointUrl 再做一次同步结构校验
    const safeFinal = await assertSafeOutboundEndpoint(endpointUrl, {
      allowLoopback: true,
      skipDnsLookup: true,
    });
    if (!safeFinal.ok || !safeFinal.url) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        protocol,
        code: safeFinal.reason || 'unsafe_endpoint',
        error: `Blocked unsafe endpoint: ${safeFinal.reason || 'unsafe_endpoint'}`,
      };
    }

    // 4. 端点白名单检查
    if (requireConsent) {
      const effectiveAllowedEndpoints =
        usingHostFallback &&
        (!cfg.privacy.allowedOfflineEndpoints || cfg.privacy.allowedOfflineEndpoints.length === 0)
          ? [baseURL]
          : cfg.privacy.allowedOfflineEndpoints;

      const baseAllowed = isOfflineEndpointAllowed(
        baseURL,
        effectiveAllowedEndpoints,
        cfg.privacy.offlineConsent
      );
      const finalAllowed = isOfflineEndpointAllowed(
        endpointUrl,
        effectiveAllowedEndpoints,
        cfg.privacy.offlineConsent
      );
      if (!baseAllowed || !finalAllowed) {
        return {
          ok: false,
          latencyMs: 0,
          model,
          endpoint: endpointUrl,
          protocol,
          code: 'endpoint_not_allowed',
          error: 'Endpoint is not authorized in privacy.allowedOfflineEndpoints',
        };
      }
    }

    if (options.signal?.aborted) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        endpoint: endpointUrl,
        protocol,
        code: 'aborted',
        error: 'Probe aborted before send',
      };
    }

    // 5. 严格按同源原则解析 API 密钥（防跨源凭据泄漏）
    const isSameConfiguredEndpoint =
      !usingHostFallback &&
      (!reqBaseURL ||
        reqBaseURL === (cfg.offlineLLM.baseURL || '').trim() ||
        isSameOriginUrl(baseURL, cfg.offlineLLM.baseURL));

    let apiKey = '';
    if (typeof req.apiKey === 'string' && req.apiKey.trim() && !req.apiKey.includes('****')) {
      apiKey = req.apiKey.trim();
    } else if (usingHostFallback && hostFallback?.apiKey) {
      apiKey = hostFallback.apiKey;
    } else if (isSameConfiguredEndpoint) {
      apiKey = (cfg.offlineLLM.apiKey || '').trim();
    }

    const envSource = options.env ?? process.env;
    const requestedEnvName =
      typeof req.apiKeyEnv === 'string' && req.apiKeyEnv.trim()
        ? req.apiKeyEnv.trim()
        : (cfg.offlineLLM.apiKeyEnv || '').trim();

    if (
      !apiKey &&
      requestedEnvName &&
      isSameConfiguredEndpoint &&
      isSafeApiKeyEnvName(requestedEnvName)
    ) {
      const envVal = (envSource[requestedEnvName] || '').trim();
      if (envVal) apiKey = envVal;
    }

    const fetchImpl = options.fetchFn || globalThis.fetch;
    if (!fetchImpl) {
      return {
        ok: false,
        latencyMs: 0,
        model,
        endpoint: endpointUrl,
        protocol,
        code: 'missing_fetch',
        error: 'Fetch implementation is unavailable in this runtime',
      };
    }

    const { requestBody, headers: protoHeaders } = buildProtocolPayload(
      protocol,
      model,
      'Reply in valid JSON format.',
      'Return {"ok":true} in json.',
      32
    );

    const headers: Record<string, string> = { ...protoHeaders };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      if (protocol === 'messages') {
        headers['x-api-key'] = apiKey;
      }
    }

    const timeoutMs = Math.max(
      500,
      Math.min(30_000, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    );
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const start = getNow();
    try {
      const response = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: combinedSignal,
        redirect: 'manual',
      });
      const latencyMs = Math.max(0, getNow() - start);

      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        return {
          ok: false,
          status: response.status,
          latencyMs,
          model,
          endpoint: endpointUrl,
          protocol,
          code: 'redirect_not_allowed',
          error: `HTTP ${response.status}: Redirect is not allowed`,
        };
      }

      if (response.ok) {
        await cancelResponseBody(response);
        return {
          ok: true,
          status: response.status,
          latencyMs,
          model,
          endpoint: endpointUrl,
          protocol,
        };
      }

      const rawSnippet = await readErrorBodyCapped(response, MAX_ERROR_BODY_BYTES);
      const safeSnippet = sanitizeDiagnosticSnippet(rawSnippet, apiKey);
      return {
        ok: false,
        status: response.status,
        latencyMs,
        model,
        endpoint: endpointUrl,
        protocol,
        code: `http_${response.status}`,
        error: safeSnippet ? `HTTP ${response.status}: ${safeSnippet}` : `HTTP ${response.status}`,
      };
    } catch (err: unknown) {
      const latencyMs = Math.max(0, getNow() - start);
      const errName =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: unknown }).name)
          : '';
      const rawMessage = err instanceof Error ? err.message : String(err);

      if (options.signal?.aborted) {
        return {
          ok: false,
          latencyMs,
          model,
          endpoint: endpointUrl,
          protocol,
          code: 'aborted',
          error: 'Probe aborted',
        };
      }

      if (
        errName === 'TimeoutError' ||
        errName === 'AbortError' ||
        timeoutSignal.aborted ||
        rawMessage.toLowerCase().includes('timeout')
      ) {
        return {
          ok: false,
          latencyMs,
          model,
          endpoint: endpointUrl,
          protocol,
          code: 'timeout',
          error: `Connection timed out after ${timeoutMs}ms`,
        };
      }

      const safeErr = sanitizeDiagnosticSnippet(rawMessage, apiKey) || 'Network request failed';
      return {
        ok: false,
        latencyMs,
        model,
        endpoint: endpointUrl,
        protocol,
        code: 'network_error',
        error: safeErr,
      };
    }
  } finally {
    if (!bypassRateLimit) {
      activeProbeCount = Math.max(0, activeProbeCount - 1);
    }
  }
}
