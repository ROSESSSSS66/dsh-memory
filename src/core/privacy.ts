import { workspaceId } from './scope.js';

export interface RedactResult {
  text: string;
  hasSensitive: boolean;
  detectedKinds: string[];
}

/**
 * 敏感信息脱敏与检测
 */
export function redactSecrets(input: string): RedactResult {
  if (!input) {
    return { text: '', hasSensitive: false, detectedKinds: [] };
  }

  let text = input;
  const detectedKinds: string[] = [];

  // 1. PEM 私钥
  const pemRegex = /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g;
  if (pemRegex.test(text)) {
    detectedKinds.push('PEM_KEY');
    pemRegex.lastIndex = 0;
    text = text.replace(pemRegex, '[REDACTED:PEM_KEY]');
  }

  // 2. JWT Token
  const jwtRegex = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g;
  if (jwtRegex.test(text)) {
    detectedKinds.push('JWT');
    jwtRegex.lastIndex = 0;
    text = text.replace(jwtRegex, '[REDACTED:JWT]');
  }

  // 3. 带有账号密码的 URL (支持任意复杂密码如含 @ 符号与各类协议)
  const urlRegex = /\b((?:https?|ftp|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis[s]?|amqp[s]?):\/\/)([^\s'"]+)/gi;
  if (urlRegex.test(text)) {
    urlRegex.lastIndex = 0;
    text = text.replace(urlRegex, (fullUrl, scheme, authorityAndPath) => {
      const atIdx = authorityAndPath.lastIndexOf('@');
      if (atIdx === -1) return fullUrl; // 无凭证

      const userinfo = authorityAndPath.slice(0, atIdx);
      const hostAndPath = authorityAndPath.slice(atIdx + 1);

      const colonIdx = userinfo.indexOf(':');
      if (colonIdx === -1) {
        detectedKinds.push('URL_CREDENTIAL');
        return `${scheme}[REDACTED:CREDENTIAL]@${hostAndPath}`;
      } else {
        const user = userinfo.slice(0, colonIdx);
        detectedKinds.push('URL_CREDENTIAL');
        return `${scheme}${user}:[REDACTED:CREDENTIAL]@${hostAndPath}`;
      }
    });
  }

  // 4. Authorization 头 / 凭证 (Bearer / Basic)
  const authHeaderRegex = /\b(Bearer|Basic)\s+([a-zA-Z0-9_.\-~+/=]{16,})\b/gi;
  if (authHeaderRegex.test(text)) {
    detectedKinds.push('AUTH_TOKEN');
    authHeaderRegex.lastIndex = 0;
    text = text.replace(authHeaderRegex, '$1 [REDACTED:TOKEN]');
  }

  // 5. 常见厂商独立 API Key / Access Token (如 sk-..., ghp_..., github_pat_..., AKIA..., xox...)
  const standaloneKeyRegex = /\b(sk-(?:ant-api\d{2}-|proj-|live-|test-)?[a-zA-Z0-9_\-]{20,}|gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{50,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9a-zA-Z]{10,48})\b/g;
  if (standaloneKeyRegex.test(text)) {
    detectedKinds.push('API_KEY');
    standaloneKeyRegex.lastIndex = 0;
    text = text.replace(standaloneKeyRegex, '[REDACTED:API_KEY]');
  }

  // 6. 显式敏感字段赋值 (例如 api_key = "...", password: "...")
  const keyValRegex = /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key)\s*([:=])\s*(['"]?)([^\s'"]{8,})\3/gi;
  if (keyValRegex.test(text)) {
    detectedKinds.push('SECRET_KEY');
    keyValRegex.lastIndex = 0;
    text = text.replace(keyValRegex, '$1$2$3[REDACTED:SECRET]$3');
  }

  return {
    text,
    hasSensitive: detectedKinds.length > 0,
    detectedKinds,
  };
}

/**
 * 检查工作区是否在排除列表中
 */
export function isWorkspaceExcluded(cwdOrId: string, excludeList: string[] = []): boolean {
  if (!cwdOrId || excludeList.length === 0) return false;
  const targetWsId = workspaceId(cwdOrId);

  for (const item of excludeList) {
    if (item === cwdOrId || workspaceId(item) === targetWsId) {
      return true;
    }
  }
  return false;
}

/**
 * 检查离线 HTTP 目标 endpoint 是否已明确授权
 */
export function isOfflineEndpointAllowed(
  endpoint: string,
  allowedEndpoints: string[] = [],
  offlineConsent: boolean = false
): boolean {
  if (!offlineConsent) return false;
  if (!endpoint) return false;

  try {
    const targetUrl = new URL(endpoint);
    if (
      (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') ||
      !targetUrl.origin ||
      targetUrl.origin === 'null'
    ) {
      return false;
    }

    for (const rawAllowed of allowedEndpoints) {
      const allowed = (rawAllowed || '').trim();
      if (!allowed) continue;

      if (/^https?:\/\//i.test(allowed)) {
        try {
          const allowedUrl = new URL(allowed);
          if (allowedUrl.origin && allowedUrl.origin !== 'null' && targetUrl.origin === allowedUrl.origin) {
            return true;
          }
        } catch {}
      } else {
        const lowerAllowed = allowed.toLowerCase();
        if (
          allowed === endpoint ||
          lowerAllowed === targetUrl.host.toLowerCase() ||
          lowerAllowed === targetUrl.hostname.toLowerCase()
        ) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}
