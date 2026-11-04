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
    text = text.replace(pemRegex, '[REDACTED:PEM_KEY]');
  }

  // 2. JWT Token
  const jwtRegex = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g;
  if (jwtRegex.test(text)) {
    detectedKinds.push('JWT');
    text = text.replace(jwtRegex, '[REDACTED:JWT]');
  }

  // 3. 带有账号密码的 URL (例如 postgres://user:pass@host:5432/db)
  const urlCredRegex = /((?:https?|postgres|postgresql|mysql|mongodb|redis):\/\/[^:\s\/]+):([^@\s\/]+)(@[^\s\/]+)/gi;
  if (urlCredRegex.test(text)) {
    detectedKinds.push('URL_CREDENTIAL');
    text = text.replace(urlCredRegex, '$1:[REDACTED:CREDENTIAL]$3');
  }

  // 4. Authorization 头 / 凭证 (Bearer / Basic)
  const authHeaderRegex = /\b(Bearer|Basic)\s+([a-zA-Z0-9_.\-~+/=]{16,})\b/gi;
  if (authHeaderRegex.test(text)) {
    detectedKinds.push('AUTH_TOKEN');
    text = text.replace(authHeaderRegex, '$1 [REDACTED:TOKEN]');
  }

  // 5. 显式敏感字段赋值 (例如 api_key = "...", password: "...")
  const keyValRegex = /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*([:=])\s*(['"]?)([a-zA-Z0-9_.\-]{8,})\3/gi;
  if (keyValRegex.test(text)) {
    detectedKinds.push('SECRET_KEY');
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
    for (const allowed of allowedEndpoints) {
      try {
        const allowedUrl = new URL(allowed);
        if (targetUrl.origin === allowedUrl.origin) {
          return true;
        }
      } catch {
        if (allowed === endpoint || allowed === targetUrl.host) {
          return true;
        }
      }
    }
  } catch {
    return allowedEndpoints.includes(endpoint);
  }

  return false;
}
