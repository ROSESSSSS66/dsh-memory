import type { Db } from '../types.js';
import type { PluginConfig } from '../config.js';
import type { LLMTaskKind } from './types.js';
import { reserve, settle, cancel } from './ledger.js';
import { redactSecrets, isOfflineEndpointAllowed, isWorkspaceExcluded } from '../core/privacy.js';
import { estimateTokens } from '../core/tokens.js';

export interface OfflineLLMParams {
  jobKind: LLMTaskKind;
  promptVersion: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
  cwd: string;
  workspaceId: string;
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
  if (isWorkspaceExcluded(params.cwd, cfg.excludeWorkspaces)) {
    return { ok: false, error: 'workspace_excluded' };
  }

  // 检查目标 endpoint 是否明确授权
  const baseURL = (cfg.offlineLLM.baseURL || '').trim();
  if (!baseURL) {
    return { ok: false, error: 'missing_base_url' };
  }

  if (!isOfflineEndpointAllowed(baseURL, cfg.privacy.allowedOfflineEndpoints, cfg.privacy.offlineConsent)) {
    return { ok: false, error: 'endpoint_not_allowed' };
  }

  // 2. 脱敏与路径匿名化
  let sanitizedSystem = redactSecrets(params.systemPrompt).text;
  let sanitizedUser = redactSecrets(params.userPrompt).text;

  // 替换绝对工作区路径为 <workspace>
  if (params.cwd) {
    const escapedCwd = params.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cwdRegex = new RegExp(escapedCwd, 'g');
    sanitizedSystem = sanitizedSystem.replace(cwdRegex, '<workspace>');
    sanitizedUser = sanitizedUser.replace(cwdRegex, '<workspace>');
  }

  // 3. 输入上界计算与校验
  // 覆盖 system + user + provider 包装（约 200 tokens）
  const estimatedInput = estimateTokens(sanitizedSystem + sanitizedUser) + 200;
  if (estimatedInput > cfg.distillMaxInputTokens) {
    return { ok: false, error: 'input_budget_exceeded' };
  }

  const reservedTokens = estimatedInput + params.maxOutputTokens;
  const model = cfg.offlineLLM.model || 'deepseek-ai/deepseek-v4-flash-0731';

  // 读取 API 密钥（只从环境变量读取，不写入日志）
  let apiKey = '';
  if (cfg.offlineLLM.apiKeyEnv && process.env[cfg.offlineLLM.apiKeyEnv]) {
    apiKey = process.env[cfg.offlineLLM.apiKeyEnv]!;
  }

  // 构造标准 /chat/completions URL
  let endpointUrl = baseURL;
  if (!endpointUrl.endsWith('/chat/completions')) {
    endpointUrl = endpointUrl.replace(/\/+$/, '') + '/chat/completions';
  }

  const requestBody = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: sanitizedSystem },
      { role: 'user', content: sanitizedUser },
    ],
    temperature: 0.0,
    max_tokens: params.maxOutputTokens,
    response_format: { type: 'json_object' },
  });

  // 4. 重试循环（最多 3 次发送尝试）
  const maxAttempts = 3;
  let currentAttempt = 0;
  let lastError = 'unknown_error';

  while (currentAttempt < maxAttempts) {
    currentAttempt++;

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
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const res = await fetchImpl(endpointUrl, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: timeoutController.signal,
      });

      clearTimeout(timeoutTimer);
      if (params.signal) {
        params.signal.removeEventListener('abort', onExternalAbort);
      }

      if (!res.ok) {
        // 记录失败账本
        settle(db, {
          ledgerId,
          status: 'failed',
          ok: 0,
          note: `http_${res.status}`,
        });

        // 4xx 不重试
        if (res.status >= 400 && res.status < 500) {
          return { ok: false, error: `http_${res.status}`, ledgerId };
        }

        // 5xx 瞬时错误且还有尝试机会时，重试
        lastError = `http_${res.status}`;
        continue;
      }

      // 请求成功，解析返回内容
      const data: any = await res.json();
      const rawContent = data?.choices?.[0]?.message?.content;
      if (typeof rawContent !== 'string') {
        settle(db, {
          ledgerId,
          status: 'unknown',
          ok: 0,
          note: 'missing_choice_content',
        });
        return { ok: false, error: 'missing_choice_content', ledgerId };
      }

      // 处理使用量结算
      const usage = data?.usage;
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
      clearTimeout(timeoutTimer);
      if (params.signal) {
        params.signal.removeEventListener('abort', onExternalAbort);
      }

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

      // 仅瞬时网络故障重试
      continue;
    }
  }

  return { ok: false, error: lastError };
}
