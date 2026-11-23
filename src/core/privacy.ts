import dns from 'node:dns/promises';
import net from 'node:net';
import type { Db, MemoryRecord } from '../types.js';
import { normalizeWorkspacePath, workspaceId } from './scope.js';

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
  const mark = (kind: string) => {
    if (!detectedKinds.includes(kind)) detectedKinds.push(kind);
  };

  // 0. Cookie / Set-Cookie 头（支持 HTTP 头、JSON 字符串与 JSON 字符串数组；避免误伤自然语言如 "cookie: always set HttpOnly"）
  const cookieRegex =
    /\b((?:set-)?cookie)(['"]?\s*[:=]\s*)(\[(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\r\n"'])*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\{(?:[^{}\r\n]{0,400}|[\s\S]{0,600}?)\}|[^\r\n]*)/gi;
  text = text.replace(cookieRegex, (match, name, separator, val) => {
    const trimmedVal = String(val || '').trim();
    // 排除纯自然语言规范描述（不含 key=value、引号、数组或大括号）
    if (
      trimmedVal &&
      !trimmedVal.startsWith('[') &&
      !trimmedVal.startsWith('{') &&
      !trimmedVal.startsWith('"') &&
      !trimmedVal.startsWith("'") &&
      !/=/.test(trimmedVal)
    ) {
      return match;
    }
    mark('COOKIE');
    return `${name}${separator}[REDACTED:COOKIE]`;
  });

  // 1. PEM 私钥（支持多词头如 OPENSSH ENCRYPTED PRIVATE KEY，并允许截断后无 END 尾行）
  const pemRegex =
    /-----BEGIN (?:[A-Z0-9_-]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9_-]+ )*PRIVATE KEY(?: BLOCK)?-----|[\s\S]{0,4096})/gi;
  if (pemRegex.test(text)) {
    mark('PEM_KEY');
    pemRegex.lastIndex = 0;
    text = text.replace(pemRegex, '[REDACTED:PEM_KEY]');
  }

  // 2. JWT Token（允许短 payload 如 {"sub":1}，用非空白/非分隔前瞻取代 \b 防尾部 '-' 逃逸）
  const jwtRegex =
    /(?<![a-zA-Z0-9_-])eyJ[a-zA-Z0-9_-]{6,}\.eyJ[a-zA-Z0-9_-]{6,}\.[a-zA-Z0-9_-]{6,}(?=$|[\s'"`,;}\])<>])/g;
  if (jwtRegex.test(text)) {
    mark('JWT');
    jwtRegex.lastIndex = 0;
    text = text.replace(jwtRegex, '[REDACTED:JWT]');
  }

  // 3. 带有账号密码的 URL (覆盖常见应用/数据库/消息队列/代理协议)
  const urlRegex =
    /\b((?:https?|ftp|sftp|ssh|ws|wss|smtp[s]?|ldap[s]?|socks5?h?|postgres(?:ql)?|mysql|mariadb|mssql|mongodb(?:\+srv)?|redis[s]?|amqp[s]?|clickhouse):\/\/)([^\s'"]+)/gi;
  if (urlRegex.test(text)) {
    urlRegex.lastIndex = 0;
    text = text.replace(urlRegex, (fullUrl, scheme, authorityAndPath) => {
      const authority = authorityAndPath.split(/[/?#]/, 1)[0];
      let atIdx = authority.lastIndexOf('@');
      if (atIdx === -1) {
        // 密码含未编码 '/' 时 '@' 会落到路径段：检查首个 '@' 前段是否像 user:pass 而非 host:port/path/@pkg
        const colonIdx = authority.indexOf(':');
        if (colonIdx === -1 || authority.startsWith('[')) {
          return fullUrl;
        }
        const afterColon = authority.slice(colonIdx + 1);
        const rawAtIdx = authorityAndPath.indexOf('@');
        if (rawAtIdx === -1) return fullUrl;
        // 若为纯端口数字，仅当后续仍有 '@' 且路径中紧接的不是 npm scoped path (/package/@scope) 时检查
        if (/^\d+$/.test(afterColon)) {
          const between = authorityAndPath.slice(authority.length, rawAtIdx);
          if (/\/[^/\s]+\/$/.test(between) || between.includes('/@')) {
            return fullUrl;
          }
          // 如 admin:1234/5678@host/db（authority='admin:1234', between='/5678'）
          if (!/^\/[^\s/?#]+$/.test(between)) {
            return fullUrl;
          }
        }
        atIdx = rawAtIdx;
      }

      const userinfo = authorityAndPath.slice(0, atIdx);
      const hostAndPath = authorityAndPath.slice(atIdx + 1);
      if (!userinfo) return fullUrl;

      const colonIdx = userinfo.indexOf(':');
      mark('URL_CREDENTIAL');
      if (colonIdx === -1) {
        return `${scheme}[REDACTED:CREDENTIAL]@${hostAndPath}`;
      }
      const user = userinfo.slice(0, colonIdx);
      return `${scheme}${user}:[REDACTED:CREDENTIAL]@${hostAndPath}`;
    });
  }

  // 4. Authorization 头 / 凭证 (Bearer / Basic，去掉尾部 \b 避免 '=' 填充绕过)
  const authHeaderRegex = /\b(Bearer|Basic)\s+([a-zA-Z0-9_.\-~+/=]{8,})(?=$|[\s'"`,;}\])<>])/gi;
  text = text.replace(authHeaderRegex, (match, scheme, token) => {
    const isBasic = String(scheme).toLowerCase() === 'basic';
    if (!isBasic && token.length < 16) return match;
    // 纯字母长单词不是令牌（如 "basic internationalization"）
    if (!/[0-9+/=_.~-]/.test(token)) {
      // Basic base64 至少 12 位且含大小写混合/典型长度才拦截，避免误杀英文词
      if (!isBasic || token.length < 12 || !(/[A-Z]/.test(token) && /[a-z]/.test(token))) {
        return match;
      }
    }
    mark('AUTH_TOKEN');
    return `${scheme} [REDACTED:TOKEN]`;
  });

  // 5. 常见厂商独立 API Key / Access Token（修复 Slack 连字符分段、结尾前瞻防泄露）
  const standaloneKeyRegex =
    /(?<![a-zA-Z0-9_-])(sk-(?:ant-api\d{2}-|proj-|live-|test-)?[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{50,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[0-9a-zA-Z-]{10,})(?=$|[\s'"`,;}\])<>])/g;
  if (standaloneKeyRegex.test(text)) {
    mark('API_KEY');
    standaloneKeyRegex.lastIndex = 0;
    text = text.replace(standaloneKeyRegex, '[REDACTED:API_KEY]');
  }

  // 5b. 其它主流厂商密钥：Google (AIza...)、Stripe、GitLab、HuggingFace、npm
  const vendorKeyRegex =
    /(?<![a-zA-Z0-9_-])(AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}|glpat-[0-9a-zA-Z_-]{20,}|hf_[a-zA-Z0-9]{30,}|npm_[a-zA-Z0-9]{36})(?=$|[\s'"`,;}\])<>])/g;
  if (vendorKeyRegex.test(text)) {
    mark('API_KEY');
    vendorKeyRegex.lastIndex = 0;
    text = text.replace(vendorKeyRegex, '[REDACTED:API_KEY]');
  }

  // 6. 显式敏感字段赋值（分引号值与非引号值，覆盖带空格密码、AWS_SESSION_TOKEN、REFRESH_TOKEN、DB_PASS、AccountKey 等）
  const secretKeyNames =
    '[a-z0-9_]*?(?:api[_-]?key|secret|password|passwd|db[_-]?pass|mysql[_-]?pwd|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|csrf[_-]?token|bot[_-]?token|auth[_-]?token|github[_-]?token|openai[_-]?key|private[_-]?key|accountkey|sharedaccesssignature)(?:[_-]?(?:access[_-]?)?(?:key|token|value))?';

  // 6a. 引号包裹（允许内部空格、分号、逗号、标点）
  const quotedKeyValRegex = new RegExp(
    `\\b(${secretKeyNames})(['"]?\\s*[:=]\\s*)(['"])((?:\\\\.|(?!\\3)[^\\\\\\r\\n]){6,})\\3`,
    'gi'
  );
  text = text.replace(quotedKeyValRegex, (match, k, sep, quote, val) => {
    if (String(val).includes('[REDACTED:')) return match;
    mark('SECRET_KEY');
    return `${k}${sep}${quote}[REDACTED:SECRET]${quote}`;
  });

  // 6b. 非引号赋值
  const unquotedKeyValRegex = new RegExp(
    `\\b(${secretKeyNames})(['"]?\\s*[:=]\\s*)([^\\s'"\`,;}{]{8,})`,
    'gi'
  );
  text = text.replace(unquotedKeyValRegex, (match, k, sep, val) => {
    if (String(val).startsWith('[REDACTED:')) return match;
    mark('SECRET_KEY');
    return `${k}${sep}[REDACTED:SECRET]`;
  });

  return {
    text,
    hasSensitive: detectedKinds.length > 0,
    detectedKinds,
  };
}

const LLM_API_KEY_ENV_ALLOWLIST =
  /^(?:DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|GEMINI|GOOGLE_AI|OPENROUTER|MOONSHOT|KIMI|ZHIPU|DASHSCOPE|QWEN|SILICONFLOW|VOLC|ARK|DOUBAO|GROQ|MISTRAL|TOGETHER|FIREWORKS|PERPLEXITY|COHERE|OLLAMA|AZURE_OPENAI|DSH_MEMORY|DSH_LLM|DSH_EMBEDDING|LLM|EMBEDDING|MODEL|CUSTOM_LLM)_[A-Z0-9_]*(?:API_?KEY|KEY|TOKEN)$/i;

const FORBIDDEN_SECRET_ENV_PREFIXES =
  /^(?:AWS|AZURE_(?!OPENAI)|GCP|GOOGLE_CLOUD|GITHUB|GH|GITLAB|NPM|DOCKER|SSH|PGP|GPG|STRIPE|TWILIO|SLACK|TELEGRAM|DISCORD|DB|DATABASE|POSTGRES|PG|MYSQL|REDIS|MONGO|AMQP|JWT|SESSION|COOKIE|CSRF|SIGNING|MASTER|ROOT|ADMIN|PRIVATE|KUBE|HELM|TERRAFORM|VAULT|SENTRY|DATADOG)_/i;

/**
 * 仅允许显式 LLM / Embedding 供应商前缀的环境变量作为外部请求凭据来源，
 * 严禁 AWS_SECRET_ACCESS_KEY / GITHUB_TOKEN / SSH_PRIVATE_KEY 等高危凭据外发。
 */
export function isSafeApiKeyEnvName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(trimmed)) return false;
  if (FORBIDDEN_SECRET_ENV_PREFIXES.test(trimmed)) return false;
  return LLM_API_KEY_ENV_ALLOWLIST.test(trimmed);
}

/**
 * 检查工作区是否在排除列表中（支持精确哈希、规范路径以及子目录前缀排除）
 */
export function isWorkspaceExcluded(cwdOrId: string, excludeList: string[] = []): boolean {
  if (!cwdOrId || excludeList.length === 0) return false;
  const trimmedTarget = cwdOrId.trim();
  if (!trimmedTarget) return false;

  const targetWsId = workspaceId(trimmedTarget);
  const targetIsHash = /^[0-9a-f]{16}$/i.test(trimmedTarget);
  const targetNormPath = targetIsHash ? '' : normalizeWorkspacePath(trimmedTarget);

  for (const rawItem of excludeList) {
    if (typeof rawItem !== 'string') continue;
    const item = rawItem.trim();
    if (!item) continue;
    if (item === trimmedTarget || workspaceId(item) === targetWsId) {
      return true;
    }
    if (targetNormPath && !/^[0-9a-f]{16}$/i.test(item)) {
      const excludedNorm = normalizeWorkspacePath(item);
      if (
        excludedNorm &&
        (targetNormPath === excludedNorm || targetNormPath.startsWith(`${excludedNorm}/`))
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Filter before LIMIT so private records cannot starve public batches. */
export function memoryPrivacyFilterSQL(excludeList: string[] = []): {
  sql: string;
  params: string[];
} {
  const excluded = [
    ...new Set(
      excludeList
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .flatMap((item) => {
          const trimmed = item.trim();
          const id = workspaceId(trimmed);
          return id ? [trimmed, id] : [trimmed];
        })
        .filter(Boolean)
    ),
  ];
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

const SQL_IN_CHUNK_SIZE = 400;

/** Shared legacy records without retained provenance cannot bypass workspace exclusions. */
export function canSendMemoriesOffline(
  db: Db,
  memories: MemoryRecord[],
  excludeList: string[]
): boolean {
  if (!excludeList.length || !memories.length) return true;
  const ids = [...new Set(memories.map((m) => m.id))];
  const filter = memoryPrivacyFilterSQL(excludeList);
  if (filter.params.length === 0) return true;

  const chunkSize = Math.max(1, SQL_IN_CHUNK_SIZE - Math.min(200, filter.params.length));
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const count =
      db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM memories WHERE id IN (${chunk.map(() => '?').join(',')}) AND ${filter.sql}`,
        [...chunk, ...filter.params]
      )?.count ?? 0;
    if (count !== chunk.length) return false;
  }
  return true;
}

/** Include source owners for shared memories, which do not have a workspace_id of their own. */
export function memoryWorkspaceIds(db: Db, memories: MemoryRecord[]): string[] {
  const owners = new Set(memories.map((m) => m.workspace_id || '').filter(Boolean));
  const ids = [...new Set(memories.map((m) => m.id))];
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SQL_IN_CHUNK_SIZE);
    const rows = db.all<{ workspace_id: string }>(
      `SELECT DISTINCT e.workspace_id FROM memory_sources s
       JOIN session_workspace_owners e ON e.session_id = s.session_id
       WHERE s.memory_id IN (${chunk.map(() => '?').join(',')})`,
      chunk
    );
    for (const row of rows) if (row.workspace_id) owners.add(row.workspace_id);
  }
  return [...owners];
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

/**
 * 判断 IPv4/IPv6 地址是否属于危险的链路本地/云元数据/未指定/组播段
 */
export function isBlockedOutboundIp(ip: string, allowLoopback = true): boolean {
  const normalized = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!normalized) return true;

  // 解包 IPv4-mapped IPv6 (::ffff:a.b.c.d 或 ::ffff:hex:hex)
  if (normalized.startsWith('::ffff:')) {
    const rest = normalized.slice(7);
    if (net.isIPv4(rest)) {
      return isBlockedOutboundIp(rest, allowLoopback);
    }
    const hexParts = rest.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
        return isBlockedOutboundIp(ipv4, allowLoopback);
      }
    }
  }

  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255))
      return true;
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8 unspecified
    if (a === 169 && b === 254) return true; // AWS/GCP/Azure link-local metadata 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT & Alibaba Cloud metadata 100.100.100.200
    if (a >= 224) return true; // multicast & reserved
    if (a === 127) return !allowLoopback;
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return !allowLoopback;
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true; // fe80::/10 link-local
    }
    if (normalized.startsWith('ff')) return true; // ff00::/8 multicast
    if (normalized.startsWith('fd00:ec2:')) return true; // AWS IMDSv2 IPv6
    return false;
  }

  return true;
}

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface OutboundEndpointCheckResult {
  ok: boolean;
  url?: URL;
  reason?: string;
}

/**
 * 统一 SSRF / URL 规范安全守卫：
 * - 仅允许 http:/https:
 * - 禁止 userinfo (u:p@)、query (?) 与 fragment (#) 以防路径拼接绕过
 * - 校验 IP 字面量与 DNS 解析结果，拦截云元数据/链路本地/未指定/组播段
 */
export async function assertSafeOutboundEndpoint(
  rawUrl: string,
  options: {
    allowLoopback?: boolean;
    skipDnsLookup?: boolean;
    lookupFn?: LookupFn;
  } = {}
): Promise<OutboundEndpointCheckResult> {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return { ok: false, reason: 'empty_url' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }
  if (!parsed.origin || parsed.origin === 'null' || !parsed.hostname) {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'url_credentials_forbidden' };
  }
  if (trimmed.includes('?') || trimmed.includes('#') || parsed.search || parsed.hash) {
    return { ok: false, reason: 'url_query_or_hash_forbidden' };
  }

  const allowLoopback = options.allowLoopback ?? true;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // 直接拦截常见云元数据域名
  if (
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host === 'instance-data' ||
    host === 'metadata.azure.internal'
  ) {
    return { ok: false, reason: 'blocked_metadata_host' };
  }

  if (net.isIP(host)) {
    if (isBlockedOutboundIp(host, allowLoopback)) {
      return { ok: false, reason: 'blocked_ip_range' };
    }
    return { ok: true, url: parsed };
  }

  if (isLoopbackHostname(host)) {
    if (!allowLoopback) return { ok: false, reason: 'loopback_forbidden' };
    return { ok: true, url: parsed };
  }

  if (options.skipDnsLookup) {
    return { ok: true, url: parsed };
  }

  const lookup =
    options.lookupFn || (async (h: string) => dns.lookup(h, { all: true, verbatim: true }));

  try {
    const records = await lookup(host);
    if (!records || records.length === 0) {
      return { ok: false, reason: 'dns_lookup_empty' };
    }
    for (const rec of records) {
      if (isBlockedOutboundIp(rec.address, allowLoopback)) {
        return { ok: false, reason: 'blocked_resolved_ip' };
      }
    }
  } catch {
    return { ok: false, reason: 'dns_lookup_failed' };
  }

  return { ok: true, url: parsed };
}

/**
 * 检查离线 HTTP 目标 endpoint 是否已明确授权（禁止 userinfo、禁止裸域名 HTTPS->HTTP 降级与任意端口、尊重 URL 路径前缀）
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
      targetUrl.origin === 'null' ||
      targetUrl.username ||
      targetUrl.password ||
      targetUrl.search ||
      targetUrl.hash
    ) {
      return false;
    }

    const targetHost = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIP(targetHost) && isBlockedOutboundIp(targetHost, true)) {
      return false;
    }

    const targetPath = targetUrl.pathname.replace(/\/+$/, '') || '/';

    for (const rawAllowed of allowedEndpoints) {
      if (typeof rawAllowed !== 'string') continue;
      const allowed = rawAllowed.trim();
      if (!allowed) continue;

      if (/^https?:\/\//i.test(allowed)) {
        try {
          const allowedUrl = new URL(allowed);
          if (
            !allowedUrl.origin ||
            allowedUrl.origin === 'null' ||
            allowedUrl.username ||
            allowedUrl.password
          ) {
            continue;
          }
          if (targetUrl.origin !== allowedUrl.origin) continue;
          const allowedPath = allowedUrl.pathname.replace(/\/+$/, '') || '/';
          if (
            allowedPath === '/' ||
            targetPath === allowedPath ||
            targetPath.startsWith(`${allowedPath}/`)
          ) {
            return true;
          }
        } catch {}
      } else {
        const lowerAllowed = allowed.toLowerCase();
        const isLocal = isLoopbackHostname(targetHost);
        // 裸域名仅允许 HTTPS（本机回环除外），且禁止非声明端口
        if (!isLocal && targetUrl.protocol !== 'https:') {
          continue;
        }
        if (lowerAllowed === targetUrl.host.toLowerCase()) {
          return true;
        }
        if (
          lowerAllowed === targetHost &&
          (!targetUrl.port || (targetUrl.protocol === 'https:' && targetUrl.port === '443'))
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
