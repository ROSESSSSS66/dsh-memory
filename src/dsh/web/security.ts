import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

const LOOPBACK_DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/i;
const SAFE_HOST_CHARS_RE = /^[a-zA-Z0-9.:\[\]-]+$/;
const PORT_DIGITS_RE = /^\d{1,5}$/;

export function getHeader(req: IncomingMessage | undefined, name: string): string | undefined {
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const lower = name.toLowerCase();
  const direct = headers[lower];
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct) && typeof direct[0] === 'string') return direct[0];

  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (typeof v === 'string') return v;
      if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    }
  }
  return undefined;
}

function isValidPort(portStr: string): boolean {
  if (!PORT_DIGITS_RE.test(portStr)) return false;
  const port = Number(portStr);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function isLoopbackDomain(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || (h.endsWith('.localhost') && LOOPBACK_DOMAIN_RE.test(h));
}

function isLoopbackIp(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (net.isIPv4(normalized)) {
    return normalized.startsWith('127.');
  }
  if (net.isIPv6(normalized)) {
    try {
      const parsed = new URL(`http://[${normalized}]`);
      return parsed.hostname === '[::1]';
    } catch {
      return false;
    }
  }
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  return isLoopbackDomain(h) || isLoopbackIp(h);
}

/**
 * 标准安全响应头：每次 JSON / 预检 / 错误响应统一附加
 */
export function securityHeaders(origin?: string): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    Vary: 'Origin',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': origin || 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/**
 * DNS Rebinding 防护：校验 Host 请求头，仅允许回环域名与严格合法 IPv4/IPv6 字面量。
 * 通过 node:net.isIPv4 / isIPv6 严格校验八位组 (0..255)，拒绝 999.999.999.999 或外部域名。
 */
export function isAllowedHostHeader(hostHeader?: string): boolean {
  if (hostHeader === undefined) return true;
  const trimmed = hostHeader.trim();
  if (!trimmed || !SAFE_HOST_CHARS_RE.test(trimmed)) return false;

  // Bracketed IPv6 literal: [::1] or [::1]:8080
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx <= 1) return false;
    const ipv6 = trimmed.slice(1, closeIdx);
    if (!net.isIPv6(ipv6)) return false;
    const rest = trimmed.slice(closeIdx + 1);
    if (rest.length === 0) return true;
    if (!rest.startsWith(':')) return false;
    return isValidPort(rest.slice(1));
  }

  const colonIdx = trimmed.indexOf(':');
  let hostPart = trimmed;
  if (colonIdx !== -1) {
    // Unbracketed IPv6 in Host header is invalid per RFC 3986
    if (trimmed.indexOf(':', colonIdx + 1) !== -1) return false;
    hostPart = trimmed.slice(0, colonIdx);
    const portPart = trimmed.slice(colonIdx + 1);
    if (!isValidPort(portPart)) return false;
  }

  if (!hostPart) return false;
  if (isLoopbackDomain(hostPart)) return true;
  if (net.isIPv4(hostPart)) return true;
  return false;
}

function parseStrictHttpOrigin(origin: string): URL | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  const afterScheme = origin.slice(u.protocol.length + 2);
  if (!afterScheme || afterScheme.includes('/')) return null;

  // 对 IP 字面量按原始主机名复检，阻止非标准 IPv4 简写（如 127.1）绕过
  const rawHostPort = afterScheme;
  if (rawHostPort.startsWith('[')) {
    const closeIdx = rawHostPort.indexOf(']');
    if (closeIdx <= 1) return null;
    const rawIpv6 = rawHostPort.slice(1, closeIdx);
    if (!net.isIPv6(rawIpv6)) return null;
    const rest = rawHostPort.slice(closeIdx + 1);
    if (rest && (!rest.startsWith(':') || !isValidPort(rest.slice(1)))) return null;
  } else {
    const cIdx = rawHostPort.indexOf(':');
    const rawHost = cIdx === -1 ? rawHostPort : rawHostPort.slice(0, cIdx);
    if (cIdx !== -1 && !isValidPort(rawHostPort.slice(cIdx + 1))) return null;
    if (/^\d+(?:\.\d+)*$/.test(rawHost) && !net.isIPv4(rawHost)) {
      return null;
    }
  }

  return u;
}

/**
 * 跨源校验：
 * - 移除宽泛的 file://、app://、dsh://、dsh-app://* 前缀通配；仅精确信任 'dsh-app://app'
 * - 若提供了 reqHost，仅信任与合法 reqHost 同源的 HTTP(S) Origin
 * - 若省略 reqHost（兼容单参调用与历史单测），允许本机回环 HTTP(S) Origin
 */
export function isTrustedOrigin(originHeader?: string, reqHost?: string): boolean {
  if (!originHeader) return true;
  const trimmed = originHeader.trim();
  if (!trimmed) return false;
  if (trimmed === 'dsh-app://app') return true;

  const parsedOrigin = parseStrictHttpOrigin(trimmed);
  if (!parsedOrigin) return false;

  const trimmedHost = typeof reqHost === 'string' ? reqHost.trim() : '';
  if (trimmedHost) {
    if (!isAllowedHostHeader(trimmedHost)) return false;
    try {
      const hostUrl = new URL(`${parsedOrigin.protocol}//${trimmedHost}`);
      return parsedOrigin.host.toLowerCase() === hostUrl.host.toLowerCase();
    } catch {
      return false;
    }
  }

  return isLoopbackHostname(parsedOrigin.hostname);
}

export type SecurityCheckOutcome =
  | { ok: true; reqOrigin?: string; preflightHandled?: boolean }
  | { ok: false; status: number; code: string; error: string };

/**
 * 请求级安全闸门：
 * 1. Peer 校验（owner peer 直接置 connectionAdmitted=true，修复 owner+自定义 Host 被误拒）
 * 2. Host connection.requestRejection 守卫（ctx.get('connection') 意外异常时 fail-closed 返回 403）
 * 3. Sec-Fetch-Site: cross-site 直接 403
 * 4. DNS Rebinding Host 头校验
 * 5. Origin 校验（支持已放行自定义 Host 同源）
 * 6. OPTIONS 预检直接 204
 * 7. 所有非 GET/HEAD/OPTIONS 方法强制精确 MIME: application/json
 */
export function enforceRequestSecurity(
  ctx: any,
  req: IncomingMessage,
  res: ServerResponse,
  peer?: any
): SecurityCheckOutcome {
  let connectionAdmitted = false;

  if (peer !== undefined) {
    if (
      !peer ||
      typeof peer !== 'object' ||
      peer.signal?.aborted === true ||
      peer.principal?.kind !== 'owner'
    ) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden_peer',
        error: 'Forbidden: untrusted peer scope',
      };
    }
    connectionAdmitted = true;
  } else {
    let connection: any;
    if (typeof ctx?.get === 'function') {
      try {
        connection = ctx.get('connection');
      } catch (err) {
        console.error('[dsh-memory] ctx.get("connection") failed unexpectedly:', err);
        return {
          ok: false,
          status: 403,
          code: 'connection_guard_error',
          error: 'Forbidden: host connection guard unavailable',
        };
      }
    } else {
      connection = ctx?.connection;
    }

    if (typeof connection?.requestRejection === 'function') {
      let rejection: number | undefined;
      try {
        rejection = connection.requestRejection(req);
      } catch (err) {
        console.error('[dsh-memory] connection.requestRejection threw:', err);
        return {
          ok: false,
          status: 403,
          code: 'connection_guard_error',
          error: 'Forbidden: host connection guard failed',
        };
      }
      if (rejection !== undefined) {
        const status = rejection === 401 ? 401 : 403;
        return {
          ok: false,
          status,
          code: status === 401 ? 'unauthorized' : 'forbidden_connection',
          error: status === 401 ? 'Unauthorized' : 'Forbidden: rejected by host connection guard',
        };
      }
      connectionAdmitted = true;
    }
  }

  const secFetchSite = (getHeader(req, 'sec-fetch-site') || '').trim().toLowerCase();
  if (secFetchSite === 'cross-site') {
    return {
      ok: false,
      status: 403,
      code: 'cross_site_denied',
      error: 'Cross-site request denied',
    };
  }

  const reqHost = getHeader(req, 'host');
  const reqOrigin = getHeader(req, 'origin');

  if (!connectionAdmitted && !isAllowedHostHeader(reqHost)) {
    return {
      ok: false,
      status: 403,
      code: 'host_not_allowed',
      error: 'Host not allowed',
    };
  }

  const sameAdmittedOrigin = (() => {
    if (!connectionAdmitted || !reqOrigin || !reqHost) return false;
    const parsedOrigin = parseStrictHttpOrigin(reqOrigin.trim());
    if (!parsedOrigin) return false;
    const trimmedHost = reqHost.trim();
    if (!trimmedHost || !SAFE_HOST_CHARS_RE.test(trimmedHost)) return false;
    try {
      const hostUrl = new URL(`${parsedOrigin.protocol}//${trimmedHost}`);
      return parsedOrigin.host.toLowerCase() === hostUrl.host.toLowerCase();
    } catch {
      return false;
    }
  })();

  if (reqOrigin && !isTrustedOrigin(reqOrigin, reqHost) && !sameAdmittedOrigin) {
    return {
      ok: false,
      status: 403,
      code: 'origin_denied',
      error: 'Cross-origin request denied',
    };
  }

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    res.writeHead(204, securityHeaders(reqOrigin));
    res.end();
    return { ok: true, reqOrigin, preflightHandled: true };
  }

  if (method !== 'GET' && method !== 'HEAD' && req.headers) {
    const rawCtype = getHeader(req, 'content-type') || '';
    const mime = rawCtype.split(';')[0].trim().toLowerCase();
    if (mime !== 'application/json') {
      return {
        ok: false,
        status: 415,
        code: 'unsupported_media_type',
        error: 'Content-Type must be application/json',
      };
    }
  }

  return { ok: true, reqOrigin };
}
