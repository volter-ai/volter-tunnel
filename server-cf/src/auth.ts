/**
 * Auth + header helpers for the Cloudflare tunnel relay.
 *
 * Implements the JWT/cookie/CORS/CSP logic on the Fetch API + `jose` (WebCrypto-based; `jsonwebtoken` does not run on Workers).
 */
import { type JWTPayload, jwtVerify } from 'jose';
import type { MeteringEnv } from './metering-types';

export interface Env extends MeteringEnv {
  TUNNEL: DurableObjectNamespace;
  TUNNEL_DOMAIN: string;
  TUNNEL_SECRET: string;
  JWT_SECRET: string;
  /** When 'true', a data-plane JWT MUST carry a `tid` claim matching the tunnel
   *  (full per-tunnel isolation). Default: a JWT with a `tid` is still bound to
   *  that tunnel, but a JWT without one is accepted on any tunnel (shared SSO). */
  REQUIRE_TID?: string;
  /** Idle days before a reserved tunnelId may be reclaimed by another account on
   *  contention (DECISIONS D5). Default 60. */
  RESERVATION_IDLE_TTL_DAYS?: string;
  /** Optional JSON response-header rewrite rules, applied on top of the built-in
   *  iframe strip: `{"set":{"x-foo":"bar"},"remove":["x-baz"]}`. */
  RESPONSE_HEADER_RULES?: string;
  /** Per-tunnel request-rate burst limit (#4): sustained requests/sec. 0/unset =
   *  disabled. The daily/monthly credit caps remain the primary fair-use limit. */
  BURST_RPS?: string;
  /** Token-bucket capacity for BURST_RPS (max instantaneous burst). Default 2×RPS. */
  BURST_SIZE?: string;
  /** Inspector replay + persisted history (#10): 'true'/'1' captures request
   *  detail to DO storage (survives hibernation) and enables /__volter_replay. */
  INSPECT_REPLAY?: string;
  /** Max captured requests retained for replay (default 50). */
  INSPECT_MAX?: string;
  /** Max captured request-body bytes stored per request (default 65536). */
  INSPECT_BODY_MAX?: string;
  /** Comma-separated subdomain labels that serve the apex front door / management
   *  plane instead of being tunnels (e.g. `www`). Default: `www`. */
  RESERVED_HOSTS?: string;
}

/**
 * Extract the tunnelId from a Host header. Port-tolerant.
 *
 * `<id>.<domain>` → `<id>`, and — wildcard support (P1 #9) — `*.<id>.<domain>`
 * also → `<id>`: every label under a reserved id routes to that id's tunnel.
 * Tunnel ids are single DNS labels (no dots), so the id is always the label
 * adjacent to the base domain (the rightmost label of the subdomain portion);
 * the leading labels are the wildcard prefix, left intact on the forwarded Host
 * so the tunneled app can sub-route on them.
 */
export function getTunnelIdFromHost(host: string | null, domain: string): string | null {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const suffix = '.' + domain;
  if (hostname.endsWith(suffix)) {
    const sub = hostname.slice(0, -suffix.length);
    return sub.slice(sub.lastIndexOf('.') + 1) || null;
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

/** Verify a JWT signature; return its payload (or null on failure). */
async function verifyToken(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ['HS256'] });
    return payload;
  } catch {
    return null;
  }
}

/** Boolean wrapper (the cookie-bootstrap path doesn't need the payload). */
async function verify(token: string, secret: string): Promise<boolean> {
  return (await verifyToken(token, secret)) !== null;
}

/** Per-tunnel binding check. A token with a `tid` claim is bound to that tunnel;
 *  a token without one is accepted on any tunnel unless `requireTid`. */
function tidOk(payload: JWTPayload, tunnelId: string | undefined, requireTid: boolean): boolean {
  const tid = typeof payload.tid === 'string' ? payload.tid : undefined;
  if (tid !== undefined) return !tunnelId || tid === tunnelId;
  return !requireTid;
}

export interface AuthResult {
  token: string;
  source: 'header' | 'query' | 'cookie';
}

export interface AuthOpts {
  /** Tunnel this request is for — a `tid`-bound token must match it. */
  tunnelId?: string;
  /** Reject tokens that carry no `tid` claim (full per-tunnel isolation). */
  requireTid?: boolean;
}

/** Validate auth from an HTTP request: Bearer header → ?__volter_token= → __volter_auth cookie. */
export async function validateAuth(
  request: Request,
  url: URL,
  jwtSecret: string,
  opts: AuthOpts = {}
): Promise<AuthResult | null> {
  if (!jwtSecret) return null;
  const ok = (p: JWTPayload | null) => !!p && tidOk(p, opts.tunnelId, !!opts.requireTid);

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return ok(await verifyToken(token, jwtSecret)) ? { token, source: 'header' } : null;
  }

  const queryToken = url.searchParams.get('__volter_token');
  if (queryToken) {
    return ok(await verifyToken(queryToken, jwtSecret)) ? { token: queryToken, source: 'query' } : null;
  }

  const cookieToken = parseCookies(request.headers.get('cookie')).get('__volter_auth');
  if (cookieToken) {
    return ok(await verifyToken(cookieToken, jwtSecret)) ? { token: cookieToken, source: 'cookie' } : null;
  }

  return null;
}

/** Validate auth for a WebSocket upgrade: ?__volter_token= query param → cookie. */
export async function validateWsAuth(
  request: Request,
  url: URL,
  jwtSecret: string,
  opts: AuthOpts = {}
): Promise<boolean> {
  if (!jwtSecret) return false;
  const ok = (p: JWTPayload | null) => !!p && tidOk(p, opts.tunnelId, !!opts.requireTid);
  const queryToken = url.searchParams.get('__volter_token');
  if (queryToken) return ok(await verifyToken(queryToken, jwtSecret));
  const cookieToken = parseCookies(request.headers.get('cookie')).get('__volter_auth');
  if (cookieToken) return ok(await verifyToken(cookieToken, jwtSecret));
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

/** CORS headers for a tunneled response (all tunnel traffic is cross-origin).
 *
 *  The relay answers preflight itself (it never forwards OPTIONS to the
 *  origin app), so the allow-headers grant must cover whatever custom headers
 *  the tunneled app's clients send — which the relay cannot know in advance.
 *  Reflect the browser's Access-Control-Request-Headers verbatim: the browser
 *  lists exactly the headers the real request will carry, and a wildcard is
 *  not an option because allow-credentials is true (spec ignores `*` there).
 *  The fixed list remains as a fallback for non-preflight responses, which
 *  carry no request-headers hint. */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  const requested = request.headers.get('access-control-request-headers');
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': requested || 'Content-Type, Authorization, X-Sandbox-Id',
    'access-control-allow-credentials': 'true',
  };
}

/** Operator-configurable response-header rewrite rules, applied on top of the
 *  built-in iframe strip. Keys are lower-cased to match Workers' header casing. */
export interface HeaderRules {
  /** Force-set these response headers (override whatever downstream returned). */
  set?: Record<string, string>;
  /** Remove these response headers. */
  remove?: string[];
}

/** Parse RESPONSE_HEADER_RULES (JSON) into HeaderRules. Tolerant: malformed JSON
 *  or unexpected shape yields no extra rules — the built-in iframe strip always
 *  still applies, so a bad config can never un-strip frame-ancestors. */
export function parseHeaderRules(raw: string | undefined): HeaderRules {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { set?: unknown; remove?: unknown };
    const rules: HeaderRules = {};
    if (parsed && typeof parsed.set === 'object' && parsed.set) {
      const set: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.set as Record<string, unknown>)) {
        if (typeof v === 'string') set[k.toLowerCase()] = v;
      }
      if (Object.keys(set).length) rules.set = set;
    }
    if (Array.isArray(parsed.remove)) {
      const remove = (parsed.remove as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.toLowerCase());
      if (remove.length) rules.remove = remove;
    }
    return rules;
  } catch {
    return {};
  }
}

/**
 * Build the downstream response headers: drop hop-by-hop + downstream CORS,
 * strip CSP frame-ancestors / X-Frame-Options (the built-in iframe embedding —
 * always on), apply any operator-configured `rules`, then re-apply our CORS +
 * cookie.
 */
export function buildResponseHeaders(
  downstream: Record<string, string>,
  request: Request,
  bootstrapCookie: string | null,
  rules?: HeaderRules
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

  // Operator-configured rewrite rules, on top of the built-in strip. Remove
  // before set so a rule can both clear and re-set the same header deliberately.
  if (rules?.remove) for (const k of rules.remove) delete headers[k];
  if (rules?.set) for (const [k, v] of Object.entries(rules.set)) headers[k] = v;

  // Tunnel responses are dynamic and frequently authenticated. Make caching an
  // explicit opt-in: only a downstream response that clearly says `public` may
  // be stored. This defeats zone/cache-rule mistakes that key an authenticated
  // `/api` response only by path while preserving immutable hashed assets.
  const cacheControl = (headers['cache-control'] ?? '').toLowerCase();
  const explicitlyPublic =
    /(?:^|,)\s*public(?:\s|,|$)/.test(cacheControl) &&
    !/(?:^|,)\s*(?:private|no-store|no-cache)(?:\s|,|=|$)/.test(cacheControl);
  const pathname = new URL(request.url).pathname;
  if (!explicitlyPublic || pathname === '/api' || pathname.startsWith('/api/')) {
    headers['cache-control'] = 'private, no-store, max-age=0';
    // Cloudflare-CDN-Cache-Control is the provider-specific override; the
    // standards-track CDN-Cache-Control protects other relay deployments too.
    headers['cloudflare-cdn-cache-control'] = 'no-store';
    headers['cdn-cache-control'] = 'no-store';
    const vary = new Set(
      (headers.vary ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    );
    vary.add('Cookie');
    vary.add('Authorization');
    headers.vary = [...vary].join(', ');
  }

  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (v != null) out.set(k, v);
  }
  for (const [k, v] of Object.entries(corsHeaders(request))) out.set(k, v);
  if (bootstrapCookie) out.append('set-cookie', bootstrapCookie);
  return out;
}

/** Build the auth cookie. `cookieDomain` is the host the cookie is scoped to —
 *  pass `<tunnelId>.<domain>` to isolate one tunnel (the leading dot still covers
 *  its `*.<tunnelId>.<domain>` wildcard subdomains, but NOT other tunnels), or the
 *  bare apex `<domain>` for the legacy shared-SSO scope. */
export function cookieFor(token: string, cookieDomain: string): string {
  return `__volter_auth=${token}; Domain=.${cookieDomain}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=3600`;
}

/** GET /__volter_auth?__volter_token=<jwt> → set the cross-iframe auth cookie. */
export async function handleCookieBootstrap(request: Request, url: URL, env: Env): Promise<Response> {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  const token = url.searchParams.get('__volter_token');
  if (!token || !env.JWT_SECRET) {
    return Response.json({ error: 'Missing token parameter' }, { status: 400, headers: cors });
  }
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload) {
    return Response.json({ error: 'Invalid token' }, { status: 401, headers: cors });
  }
  // A tunnel-bound token scopes its cookie to that tunnel; an unbound token keeps
  // the apex scope (legacy shared SSO).
  const tid = typeof payload.tid === 'string' ? payload.tid : undefined;
  const cookieDomain = tid ? `${tid}.${env.TUNNEL_DOMAIN}` : env.TUNNEL_DOMAIN;
  return Response.json(
    { ok: true },
    { status: 200, headers: { ...cors, 'set-cookie': cookieFor(token, cookieDomain) } }
  );
}
