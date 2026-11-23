import net from 'node:net';
import * as z from 'zod';
import { type PluginConfig, saveConfigToDb } from '../../../config.js';
import {
  assertSafeOutboundEndpoint,
  isBlockedOutboundIp,
  isSafeApiKeyEnvName,
} from '../../../core/privacy.js';
import { type LlmProbeResult, probeOfflineLLM } from '../../../service/index.js';
import {
  HttpError,
  isSameOriginUrl,
  readBodyJson,
  sanitizeConfigForClient,
  sendJson,
} from '../http.js';
import type { RouteEntry } from '../router.js';

const PROTOCOL_VALUES = ['chat/completions', 'responses', 'messages'] as const;
const EMBEDDING_PROVIDERS = ['none', 'openai-compatible'] as const;
const HOST_PORT_ENTRY_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

const OfflineLLMPatchSchema = z
  .object({
    useDshLlm: z.boolean().optional(),
    baseURL: z.string().max(2048).optional(),
    model: z.string().max(200).optional(),
    apiKeyEnv: z.string().max(128).optional(),
    apiKey: z.string().max(2048).optional(),
    clearApiKey: z.boolean().optional(),
    protocol: z.enum(PROTOCOL_VALUES).optional(),
  })
  .strip();

const EmbeddingPatchSchema = z
  .object({
    provider: z.enum(EMBEDDING_PROVIDERS).optional(),
    baseURL: z.string().max(2048).optional(),
    model: z.string().max(200).optional(),
    apiKeyEnv: z.string().max(128).optional(),
    apiKey: z.string().max(2048).optional(),
    clearApiKey: z.boolean().optional(),
    dim: z.number().int().min(0).max(8192).optional(),
    batchSize: z.number().int().min(1).max(256).optional(),
    timeoutMs: z.number().int().min(500).max(120_000).optional(),
  })
  .strip();

const PrivacyPatchSchema = z
  .object({
    offlineConsent: z.boolean().optional(),
    allowedOfflineEndpoints: z.array(z.string().max(2048)).max(50).optional(),
  })
  .strip();

const ConfigPostSchema = z
  .object({
    offlineLLM: OfflineLLMPatchSchema.optional(),
    embedding: EmbeddingPatchSchema.optional(),
    privacy: PrivacyPatchSchema.optional(),
    dailyLLMCalls: z.number().finite().positive().optional(),
    dailyLLMTokens: z.number().finite().positive().optional(),
    distillMaxInputTokens: z.number().finite().positive().optional(),
  })
  .strip();

const LlmTestBodySchema = z
  .object({
    baseURL: z.string().max(2048).optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(2048).optional(),
    apiKeyEnv: z.string().max(128).optional(),
    protocol: z.enum(PROTOCOL_VALUES).optional(),
    useDshLlm: z.boolean().optional(),
  })
  .strip();

async function assertValidConfigBaseUrl(rawUrl: string, label: string): Promise<string> {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  const check = await assertSafeOutboundEndpoint(trimmed, {
    allowLoopback: true,
    skipDnsLookup: true,
  });
  if (!check.ok) {
    throw new HttpError(
      400,
      'invalid_base_url',
      `${label} 不合法或不安全 (${check.reason || 'invalid_url'})`
    );
  }
  return trimmed;
}

async function isValidAllowlistEntry(raw: string): Promise<boolean> {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) {
    const check = await assertSafeOutboundEndpoint(trimmed, {
      allowLoopback: true,
      skipDnsLookup: true,
    });
    return check.ok;
  }
  if (!HOST_PORT_ENTRY_RE.test(trimmed)) return false;
  const hostOnly = trimmed.split(':')[0].toLowerCase();
  if (
    hostOnly === 'metadata.google.internal' ||
    hostOnly === 'metadata' ||
    hostOnly === 'instance-data' ||
    hostOnly === 'metadata.azure.internal'
  ) {
    return false;
  }
  if (net.isIP(hostOnly) && isBlockedOutboundIp(hostOnly, true)) {
    return false;
  }
  return true;
}

function mapProbeStatusCode(result: LlmProbeResult): number {
  if (result.ok) return 200;
  switch (result.code) {
    case 'probe_in_flight':
    case 'rate_limited':
      return 429;
    case 'privacy_offline_consent_required':
    case 'endpoint_not_allowed':
    case 'blocked_metadata_host':
    case 'blocked_ip_range':
    case 'blocked_resolved_ip':
    case 'loopback_forbidden':
      return 403;
    case 'missing_base_url':
    case 'empty_url':
    case 'invalid_url':
    case 'invalid_base_url':
    case 'unsupported_protocol':
    case 'invalid_origin':
    case 'url_credentials_forbidden':
    case 'url_query_or_hash_forbidden':
    case 'dns_lookup_empty':
    case 'dns_lookup_failed':
      return 400;
    case 'aborted':
      return 499;
    default:
      return 200;
  }
}

export function createConfigRoutes(): RouteEntry[] {
  const handleGetConfig = (rctx: Parameters<NonNullable<RouteEntry['methods']['GET']>>[0]) => {
    sendJson(
      rctx.res,
      200,
      { ok: true, config: sanitizeConfigForClient(rctx.cfg) },
      rctx.reqOrigin
    );
  };

  const handlePostConfig = async (
    rctx: Parameters<NonNullable<RouteEntry['methods']['POST']>>[0]
  ) => {
    const rawBody = await readBodyJson(rctx.req);
    const body = ConfigPostSchema.parse(rawBody);
    const cfg = rctx.cfg;

    const patch: Partial<PluginConfig> = {};

    // 1. offlineLLM patch + P0 两步法密钥防泄漏规则
    if (body.offlineLLM) {
      const incoming = body.offlineLLM;
      const nextOffline = { ...cfg.offlineLLM };

      const prevBaseUrl = (cfg.offlineLLM.baseURL || '').trim();
      const hasBaseUrlInReq = incoming.baseURL !== undefined;
      const nextBaseUrl = hasBaseUrlInReq
        ? await assertValidConfigBaseUrl(incoming.baseURL!, 'offlineLLM.baseURL')
        : prevBaseUrl;

      const hasFreshApiKey =
        typeof incoming.apiKey === 'string' && incoming.apiKey.trim().length > 0;
      const hasExplicitApiKeyEnv = incoming.apiKeyEnv !== undefined;

      const baseUrlCleared = hasBaseUrlInReq && !nextBaseUrl;
      const setFromEmptyWithoutKey =
        !prevBaseUrl && Boolean(nextBaseUrl) && hasBaseUrlInReq && !hasFreshApiKey;
      const originChanged =
        Boolean(prevBaseUrl) && Boolean(nextBaseUrl) && !isSameOriginUrl(prevBaseUrl, nextBaseUrl);
      const transitioningToDshLlm = incoming.useDshLlm === true && !cfg.offlineLLM.useDshLlm;

      if (typeof incoming.useDshLlm === 'boolean') {
        nextOffline.useDshLlm = incoming.useDshLlm;
      }

      if (hasBaseUrlInReq) {
        nextOffline.baseURL = nextBaseUrl;
        if (nextBaseUrl && incoming.useDshLlm === undefined) {
          nextOffline.useDshLlm = false;
        }
      }

      if (incoming.model !== undefined) {
        nextOffline.model = incoming.model.trim().slice(0, 200);
      }

      if (incoming.protocol !== undefined) {
        nextOffline.protocol = incoming.protocol;
      }

      // 只要发生 (a) baseURL 清空、(b) 空 baseURL 切向新端点且未同请求提供新密钥、(c) 跨源变更、(d) 切换至 useDshLlm=true，一律先清空旧密钥
      if (baseUrlCleared || setFromEmptyWithoutKey || originChanged || transitioningToDshLlm) {
        nextOffline.apiKey = '';
        if (!hasExplicitApiKeyEnv) {
          nextOffline.apiKeyEnv = '';
        }
      }

      if (hasExplicitApiKeyEnv) {
        const envName = incoming.apiKeyEnv!.trim();
        if (envName && !isSafeApiKeyEnvName(envName)) {
          throw new HttpError(
            400,
            'invalid_api_key_env',
            '密钥环境变量名不合法：仅允许显式 LLM/Embedding 供应商前缀的 _API_KEY / _KEY / _TOKEN 变量名'
          );
        }
        nextOffline.apiKeyEnv = envName;
      }

      if (incoming.clearApiKey === true) {
        nextOffline.apiKey = '';
      } else if (hasFreshApiKey) {
        // 移除有缺陷的 !apiKey.includes('****') 启发式：仅当未切回宿主 useDshLlm 时保存显式提交的密钥
        if (!transitioningToDshLlm && !(incoming.useDshLlm === true && !nextBaseUrl)) {
          nextOffline.apiKey = incoming.apiKey!.trim();
        }
      }

      if (!nextOffline.baseURL && nextOffline.useDshLlm) {
        nextOffline.apiKey = '';
      }

      patch.offlineLLM = nextOffline;
    }

    // 2. embedding patch + 同款跨源/两步法密钥清除规则
    if (body.embedding) {
      const incoming = body.embedding;
      const nextEmb = { ...cfg.embedding };

      const prevEmbUrl = (cfg.embedding.baseURL || '').trim();
      const hasEmbUrlInReq = incoming.baseURL !== undefined;
      const nextEmbUrl = hasEmbUrlInReq
        ? await assertValidConfigBaseUrl(incoming.baseURL!, 'embedding.baseURL')
        : prevEmbUrl;

      const hasFreshEmbKey =
        typeof incoming.apiKey === 'string' && incoming.apiKey.trim().length > 0;
      const hasExplicitEmbEnv = incoming.apiKeyEnv !== undefined;

      const embUrlCleared = hasEmbUrlInReq && !nextEmbUrl;
      const embSetFromEmptyWithoutKey =
        !prevEmbUrl && Boolean(nextEmbUrl) && hasEmbUrlInReq && !hasFreshEmbKey;
      const embOriginChanged =
        Boolean(prevEmbUrl) && Boolean(nextEmbUrl) && !isSameOriginUrl(prevEmbUrl, nextEmbUrl);
      const switchedToNone = incoming.provider === 'none' && cfg.embedding.provider !== 'none';

      if (incoming.provider !== undefined) {
        nextEmb.provider = incoming.provider;
      }
      if (hasEmbUrlInReq) {
        nextEmb.baseURL = nextEmbUrl;
      }
      if (incoming.model !== undefined) {
        nextEmb.model = incoming.model.trim().slice(0, 200);
      }
      if (incoming.dim !== undefined) {
        nextEmb.dim = incoming.dim;
      }
      if (incoming.batchSize !== undefined) {
        nextEmb.batchSize = incoming.batchSize;
      }
      if (incoming.timeoutMs !== undefined) {
        nextEmb.timeoutMs = incoming.timeoutMs;
      }

      if (embUrlCleared || embSetFromEmptyWithoutKey || embOriginChanged || switchedToNone) {
        nextEmb.apiKey = '';
        if (!hasExplicitEmbEnv) {
          nextEmb.apiKeyEnv = '';
        }
      }

      if (hasExplicitEmbEnv) {
        const envName = incoming.apiKeyEnv!.trim();
        if (envName && !isSafeApiKeyEnvName(envName)) {
          throw new HttpError(
            400,
            'invalid_api_key_env',
            'Embedding 密钥环境变量名不合法：仅允许显式 LLM/Embedding 供应商前缀的 _API_KEY / _KEY / _TOKEN 变量名'
          );
        }
        nextEmb.apiKeyEnv = envName;
      }

      if (incoming.clearApiKey === true) {
        nextEmb.apiKey = '';
      } else if (hasFreshEmbKey && !switchedToNone) {
        nextEmb.apiKey = incoming.apiKey!.trim();
      }

      patch.embedding = nextEmb;
    }

    // 3. privacy patch + 端点白名单联动维护
    if (body.privacy) {
      const nextPrivacy = {
        offlineConsent: cfg.privacy.offlineConsent,
        allowedOfflineEndpoints: [...(cfg.privacy.allowedOfflineEndpoints || [])],
      };
      if (typeof body.privacy.offlineConsent === 'boolean') {
        nextPrivacy.offlineConsent = body.privacy.offlineConsent;
      }
      if (body.privacy.allowedOfflineEndpoints !== undefined) {
        const validEntries: string[] = [];
        for (const rawEntry of body.privacy.allowedOfflineEndpoints) {
          const trimmed = rawEntry.trim();
          if (trimmed && (await isValidAllowlistEntry(trimmed))) {
            validEntries.push(trimmed);
          }
        }
        nextPrivacy.allowedOfflineEndpoints = validEntries.slice(0, 50);
      }
      patch.privacy = nextPrivacy;
    }

    const effectiveConsent =
      patch.privacy?.offlineConsent !== undefined
        ? patch.privacy.offlineConsent
        : cfg.privacy.offlineConsent;
    const prevBaseURL = (cfg.offlineLLM.baseURL || '').trim();
    const targetBaseURL = (patch.offlineLLM?.baseURL ?? cfg.offlineLLM.baseURL ?? '').trim();
    const endpointChanged =
      Boolean(prevBaseURL) && (!targetBaseURL || !isSameOriginUrl(prevBaseURL, targetBaseURL));
    const explicitAllowList = body.privacy?.allowedOfflineEndpoints !== undefined;

    if (endpointChanged && !explicitAllowList) {
      if (!patch.privacy) {
        patch.privacy = {
          offlineConsent: cfg.privacy.offlineConsent,
          allowedOfflineEndpoints: [...(cfg.privacy.allowedOfflineEndpoints || [])],
        };
      }
      const stale = new Set<string>([prevBaseURL]);
      try {
        stale.add(new URL(prevBaseURL).origin);
      } catch {}
      patch.privacy.allowedOfflineEndpoints = patch.privacy.allowedOfflineEndpoints.filter(
        (e) => !stale.has(e)
      );
    }

    if (effectiveConsent) {
      const urlsToAllow: string[] = [];
      if (targetBaseURL) urlsToAllow.push(targetBaseURL);
      const embProvider = patch.embedding?.provider ?? cfg.embedding.provider;
      const embUrl = (patch.embedding?.baseURL ?? cfg.embedding.baseURL ?? '').trim();
      if (embProvider === 'openai-compatible' && embUrl) {
        urlsToAllow.push(embUrl);
      }
      if (urlsToAllow.length > 0) {
        if (!patch.privacy) {
          patch.privacy = {
            offlineConsent: cfg.privacy.offlineConsent,
            allowedOfflineEndpoints: [...(cfg.privacy.allowedOfflineEndpoints || [])],
          };
        }
        const allowed = new Set(patch.privacy.allowedOfflineEndpoints);
        for (const uStr of urlsToAllow) {
          allowed.add(uStr);
          try {
            allowed.add(new URL(uStr).origin);
          } catch {}
        }
        patch.privacy.allowedOfflineEndpoints = Array.from(allowed).slice(0, 50);
      }
    }

    if (body.dailyLLMCalls !== undefined) {
      patch.dailyLLMCalls = Math.max(1, Math.min(10_000, Math.floor(body.dailyLLMCalls)));
    }
    if (body.dailyLLMTokens !== undefined) {
      patch.dailyLLMTokens = Math.max(1, Math.min(100_000_000, Math.floor(body.dailyLLMTokens)));
    }
    if (body.distillMaxInputTokens !== undefined) {
      patch.distillMaxInputTokens = Math.max(
        1,
        Math.min(1_000_000, Math.floor(body.distillMaxInputTokens))
      );
    }

    // 传入不可变 initialCfg（而非已被覆盖的 live cfg），防止持久化快照漂移
    const updated = saveConfigToDb(rctx.db, patch, rctx.initialCfg);
    Object.assign(cfg, updated);
    rctx.options?.onConfigUpdated?.(updated);
    rctx.onConfigMutated();

    sendJson(rctx.res, 200, { ok: true, config: sanitizeConfigForClient(updated) }, rctx.reqOrigin);
  };

  const handleLlmTest = async (rctx: Parameters<NonNullable<RouteEntry['methods']['POST']>>[0]) => {
    const rawBody = await readBodyJson(rctx.req);
    const body = LlmTestBodySchema.parse(rawBody);

    const result = await probeOfflineLLM(body, rctx.cfg, {
      signal: rctx.signal,
      fetchFn: rctx.options?.fetchFn,
      lookupFn: rctx.options?.lookupFn,
    });

    const status = mapProbeStatusCode(result);
    sendJson(rctx.res, status, result, rctx.reqOrigin);
  };

  return [
    { path: '/config', methods: { GET: handleGetConfig, POST: handlePostConfig } },
    { path: '/llm/test', methods: { POST: handleLlmTest } },
  ];
}
