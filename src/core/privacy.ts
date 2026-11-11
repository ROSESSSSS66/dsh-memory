import { workspaceId } from './scope.js';
import type { Db, MemoryRecord } from '../types.js';

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

  // Cookie values can contain several credentials; redact the whole header, including JSON arrays.
  const cookieRegex = /\b((?:set-)?cookie)(['"]?\s*[:=]\s*)(\[(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\r\n])*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]*)/gi;
  text = text.replace(cookieRegex, (_match, name, separator) => {
    if (!detectedKinds.includes('COOKIE')) detectedKinds.push('COOKIE');
    return `${name}${separator}[REDACTED:COOKIE]`;
  });

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
  const standaloneKeyRegex = /\b(sk-(?:ant-api\d{2}-|proj-|live-|test-)?[a-zA-Z0-9_\-]{20,}|gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{50,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9a-zA-Z]{10,48})\b/g;
  if (standaloneKeyRegex.test(text)) {
    detectedKinds.push('API_KEY');
    standaloneKeyRegex.lastIndex = 0;
    text = text.replace(standaloneKeyRegex, '[REDACTED:API_KEY]');
  }

  // 5b. 其它主流厂商密钥：Google (AIza...)、Stripe (sk_live_/rk_live_)、GitLab (glpat-)、HuggingFace (hf_)、npm (npm_)
  const vendorKeyRegex = /\b(AIza[0-9A-Za-z_\-]{35}|(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}|glpat-[0-9a-zA-Z_\-]{20,}|hf_[a-zA-Z0-9]{30,}|npm_[a-zA-Z0-9]{36})\b/g;
  if (vendorKeyRegex.test(text)) {
    if (!detectedKinds.includes('API_KEY')) detectedKinds.push('API_KEY');
    vendorKeyRegex.lastIndex = 0;
    text = text.replace(vendorKeyRegex, '[REDACTED:API_KEY]');
  }

  // 6. 显式敏感字段赋值 (例如 api_key = "...", password: "...")
  const keyValRegex = /\b([a-z0-9_]*?(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|private[_-]?key))(['"]?\s*[:=]\s*)(['"]?)([^\s'"`,;}{]{8,})\3/gi;
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
 * 仅允许形如 XXX_API_KEY / XXX_KEY / XXX_TOKEN 的环境变量名作为 LLM 密钥来源，
 * 防止通过配置把任意环境变量（如云凭据、数据库口令）作为 Bearer 发往外部端点。
 */
export function isSafeApiKeyEnvName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) && /(API_?KEY|_KEY|_TOKEN)$/i.test(name);
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

/** Filter before LIMIT so private records cannot starve public batches. */
export function memoryPrivacyFilterSQL(excludeList: string[] = []): { sql: string; params: string[] } {
  const excluded = [...new Set(excludeList.flatMap(item => [item, workspaceId(item)]))];
  if (excluded.length === 0) return { sql: '1 = 1', params: [] };
  const placeholders = excluded.map(() => '?').join(',');
  return {
    sql: `(COALESCE(memories.workspace_id, '') NOT IN (${placeholders})
      AND NOT EXISTS (
        SELECT 1 FROM memory_sources s JOIN session_workspace_owners e ON e.session_id = s.session_id
        WHERE s.memory_id = memories.id AND e.workspace_id IN (${placeholders})
      )
      AND (COALESCE(memories.workspace_id, '') != '' OR (
        EXISTS (SELECT 1 FROM memory_sources s WHERE s.memory_id = memories.id)
        AND NOT EXISTS (
          SELECT 1 FROM memory_sources s WHERE s.memory_id = memories.id
          AND NOT EXISTS (SELECT 1 FROM session_workspace_owners o WHERE o.session_id = s.session_id)
        )
      )))`,
    params: [...excluded, ...excluded],
  };
}

/** Shared legacy records without retained provenance cannot bypass workspace exclusions. */
export function canSendMemoriesOffline(db: Db, memories: MemoryRecord[], excludeList: string[]): boolean {
  if (!excludeList.length || !memories.length) return true;
  const ids = [...new Set(memories.map(m => m.id))];
  const filter = memoryPrivacyFilterSQL(excludeList);
  const count = db.get<{ count: number }>(
    `SELECT COUNT(*) AS count FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) AND ${filter.sql}`,
    [...ids, ...filter.params]
  )?.count;
  return count === ids.length;
}

/** Include source owners for shared memories, which do not have a workspace_id of their own. */
export function memoryWorkspaceIds(db: Db, memories: MemoryRecord[]): string[] {
  const owners = new Set(memories.map(m => m.workspace_id || '').filter(Boolean));
  if (memories.length) {
    const rows = db.all<{ workspace_id: string }>(
      `SELECT DISTINCT e.workspace_id FROM memory_sources s
       JOIN session_workspace_owners e ON e.session_id = s.session_id
       WHERE s.memory_id IN (${memories.map(() => '?').join(',')})`,
      memories.map(m => m.id)
    );
    for (const row of rows) if (row.workspace_id) owners.add(row.workspace_id);
  }
  return [...owners];
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
