/**
 * Auth + header helpers for the Cloudflare tunnel relay.
 *
 * Ports server/server.mjs's JWT/cookie/CORS/CSP logic to the Fetch API and
 * `jose` (WebCrypto-based; `jsonwebtoken` does not run on Workers).
 */
import { jwtVerify } from 'jose';
import type { MeteringEnv } from './metering-types';

export interface Env extends MeteringEnv {
  TUNNEL: DurableObjectNamespace;
  TUNNEL_DOMAIN: string;
  TUNNEL_SECRET: string;
  JWT_SECRET: string;
}

/** Extract the tunnelId from a Host header: `<id>.<domain>` → `<id>`. Port-tolerant. */
export function getTunnelIdFromHost(host: string | null, domain: string): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const suffix = '.' + domain;
  if (hostname.endsWith(suffix)) {
    return hostname.slice(0, -suffix.length);
  }
  return null;
}

export function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return cookies;
}

async function verify(token: string, secret: string): Promise<boolean> {
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    return true;
  } catch {
    return false;
  }
}

export interface AuthResult {
  token: string;
  source: 'header' | 'query' | 'cookie';
}

/** Validate auth from an HTTP request: Bearer header → ?__volter_token= → __volter_auth cookie. */
export async function validateAuth(
  request: Request,
  url: URL,
  jwtSecret: string
): Promise<AuthResult | null> {
  if (!jwtSecret) return null;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return (await verify(token, jwtSecret)) ? { token, source: 'header' } : null;
  }

  const queryToken = url.searchParams.get('__volter_token');
  if (queryToken) {
    return (await verify(queryToken, jwtSecret)) ? { token: queryToken, source: 'query' } : null;
  }

  const cookieToken = parseCookies(request.headers.get('cookie')).get('__volter_auth');
  if (cookieToken) {
    return (await verify(cookieToken, jwtSecret)) ? { token: cookieToken, source: 'cookie' } : null;
  }

  return null;
}

/** Validate auth for a WebSocket upgrade: ?__volter_token= query param → cookie. */
export async function validateWsAuth(
  request: Request,
  url: URL,
  jwtSecret: string
): Promise<boolean> {
  if (!jwtSecret) return false;
  const queryToken = url.searchParams.get('__volter_token');
  if (queryToken) return verify(queryToken, jwtSecret);
  const cookieToken = parseCookies(request.headers.get('cookie')).get('__volter_auth');
  if (cookieToken) return verify(cookieToken, jwtSecret);
  return false;
}

/** Remove `?__volter_token=` from a path+query string (don't leak the token downstream). */
export function stripTokenParam(pathWithQuery: string): string {
  try {
    const u = new URL(pathWithQuery, 'http://placeholder');
    u.searchParams.delete('__volter_token');
    u.searchParams.delete('__tunnel');
    const search = u.searchParams.toString();
    return u.pathname + (search ? '?' + search : '');
  } catch {
    return pathWithQuery;
  }
}

/** Strip the __volter_auth cookie from a headers object before forwarding downstream. */
export function stripAuthCookie(headers: Record<string, string>): Record<string, string> {
  const cookie = headers.cookie;
  if (!cookie) return headers;
  const cleaned = cookie
    .split(';')
    .filter((pair) => pair.trim().split('=')[0]?.trim() !== '__volter_auth')
    .join(';')
    .trim();
  const result = { ...headers };
  if (cleaned) result.cookie = cleaned;
  else delete result.cookie;
  return result;
}

/** CORS headers for a tunneled response (all tunnel traffic is cross-origin). */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Authorization, X-Sandbox-Id',
    'access-control-allow-credentials': 'true',
  };
}

/**
 * Build the downstream response headers: drop hop-by-hop + downstream CORS,
 * strip CSP frame-ancestors / X-Frame-Options, then re-apply our CORS + cookie.
 * Mirrors server/server.mjs response handling.
 */
export function buildResponseHeaders(
  downstream: Record<string, string>,
  request: Request,
  bootstrapCookie: string | null
): Headers {
  const headers = { ...downstream };
  for (const k of [
    'transfer-encoding',
    'connection',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-allow-credentials',
  ]) {
    delete headers[k];
  }

  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    if (headers[key]) {
      headers[key] = headers[key]
        .split(';')
        .filter((d) => !d.trim().startsWith('frame-ancestors'))
        .join(';')
        .trim();
      if (!headers[key]) delete headers[key];
    }
  }
  delete headers['x-frame-options'];

  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) out.set(k, v);
  }
  for (const [k, v] of Object.entries(corsHeaders(request))) out.set(k, v);
  if (bootstrapCookie) out.append('set-cookie', bootstrapCookie);
  return out;
}

export function cookieFor(token: string, domain: string): string {
  return `__volter_auth=${token}; Domain=.${domain}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=3600`;
}

/** GET /__volter_auth?__volter_token=<jwt> → set the cross-iframe auth cookie. */
export async function handleCookieBootstrap(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  const token = url.searchParams.get('__volter_token');
  if (!token || !env.JWT_SECRET) {
    return Response.json({ error: 'Missing token parameter' }, { status: 400, headers: cors });
  }
  if (!(await verify(token, env.JWT_SECRET))) {
    return Response.json({ error: 'Invalid token' }, { status: 401, headers: cors });
  }
  return Response.json(
    { ok: true },
    { status: 200, headers: { ...cors, 'set-cookie': cookieFor(token, env.TUNNEL_DOMAIN) } }
  );
}
