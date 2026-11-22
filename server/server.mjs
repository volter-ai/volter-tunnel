/**
 * WebSocket-based HTTP tunnel server.
 *
 * - Accepts tunnel client connections via WebSocket at /ws
 * - Routes incoming HTTP requests by subdomain to the right client
 * - Serializes request/response over WebSocket (JSON + base64 for bodies)
 * - Proxies WebSocket connections through the tunnel (message-level relay)
 * - Supports per-tunnel auth (JWT via Bearer header, cookie, or WS query param)
 */

import crypto from 'node:crypto';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';

const PORT = parseInt(process.env.PORT || '3500');
const EXTERNAL_PORT = parseInt(process.env.EXTERNAL_PORT || process.env.PORT || '3500');
const DOMAIN = process.env.TUNNEL_DOMAIN || 'localhost';
const SECURE = process.env.TUNNEL_SECURE === 'true';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || '';

// This one process relays every tenant's tunnel, so a single uncaught error must
// never take the whole server down (it did: an oversized close reason threw a
// RangeError out of a WS handler, crash-looping the machine to Fly's max-restart
// cap and dropping every tunnel at once). Log loudly and keep serving — one bad
// frame on one connection is never worth disconnecting everyone else.
process.on('uncaughtException', (err) => {
  console.error(`[tunnel] uncaught exception (kept alive): ${err?.stack || err?.message || err}`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[tunnel] unhandled rejection (kept alive): ${reason instanceof Error ? reason.stack : reason}`);
});

// tunnelId → { ws, authRequired }
const clients = new Map();
// reqId → { res, timer, tunnelId } for pending HTTP responses
const pendingRequests = new Map();
// reqId → { res, tunnelId } for active streaming responses
const streamingResponses = new Map();
// connId → { timer, tunnelId } for pending WS upgrades (waiting for ws-ready)
const pendingUpgrades = new Map();
// connId → { browserWs, tunnelId, clientWs } for active WS relay connections
const wsConnections = new Map();

let reqIdCounter = 0;

// A WebSocket close frame's reason is capped at 123 bytes (a 125-byte control
// frame minus the 2-byte close code). The `ws` library throws a RangeError if
// the reason exceeds that. Every tenant's relay runs in this single process, so
// one oversized reason — e.g. a relayed ws-error string like "WebSocket
// connection to 'ws://…/ws?terminalId=…' failed: Expected 101 status code" —
// would throw out of the message handler and crash the WHOLE tunnel server,
// dropping every tunnel and crash-looping until Fly's max-restart cap. Truncate
// on a UTF-8 boundary and never let close() throw.
function truncateUtf8(value, maxBytes) {
  const buf = Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length <= maxBytes) return String(value ?? '');
  // Decode the byte-truncated prefix, then drop a trailing replacement char left
  // by a severed multibyte sequence so the re-encoded string stays within maxBytes.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
}

function closeWsSafely(ws, code, reason) {
  try {
    ws.close(code, truncateUtf8(reason, 123));
  } catch (err) {
    console.error(`[ws-relay] close(code=${code}) failed: ${err?.message}`);
    try {
      ws.terminate();
    } catch {
      // Already gone — nothing left to do.
    }
  }
}

function generateId() {
  const adjectives = ['quick', 'bright', 'calm', 'bold', 'cool', 'fast', 'keen', 'warm'];
  const nouns = ['fox', 'owl', 'elk', 'bee', 'cat', 'dog', 'ray', 'ant'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = crypto.randomInt(100, 999);
  return `${adj}-${noun}-${num}`;
}

function getTunnelIdFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  if (hostname.endsWith('.' + DOMAIN)) {
    return hostname.slice(0, -(DOMAIN.length + 1));
  }
  return null;
}

// ============================================================================
// JWT Auth helpers
// ============================================================================

/**
 * Parse a cookie header string and return a Map of name → value.
 */
function parseCookies(cookieHeader) {
  const cookies = new Map();
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies.set(name, value);
  }
  return cookies;
}

/** Every value of one cookie name in a Cookie header, in the browser's order. A tunnel host can receive two
 *  __volter_auth cookies (its own host-only one and the apex endpoint's parent-domain one); a Map keeps only one. */
function cookieValues(cookieHeader, name) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.slice(0, pair.indexOf('=')).trim() === name)
    .map((pair) => pair.slice(pair.indexOf('=') + 1).trim());
}

/**
 * A data-plane token's payload when it is signed with JWT_SECRET and bound to this tunnel, else null. The binding is
 * the token's `tid` claim, the claim minimal-claude's gateway puts on its per-tunnel tokens (POST /api/tunnel/token)
 * and server-cf checks: a token without one, or for another tunnel, opens nothing here.
 */
function verifyForTunnel(token, tunnelId) {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return payload && typeof payload === 'object' && payload.tid === tunnelId ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Validate auth from a request. Checks (in order):
 * 1. Authorization: Bearer <jwt> header
 * 2. ?token= query parameter
 * 3. __volter_auth cookie
 *
 * The first token bound to `tunnelId` (verifyForTunnel) authenticates; one bound elsewhere, or to nothing, does not.
 * Returns { payload, token, source } or null.
 * `source` is 'header' | 'query' | 'cookie' — used to decide whether to bootstrap a cookie.
 */
function validateAuth(req, tunnelId) {
  if (!JWT_SECRET) return null;

  // 1. Bearer token. An Authorization header can be the app's own credential (it is forwarded to the app), so one
  // not bound to this tunnel is not a refusal: the next source is tried.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyForTunnel(token, tunnelId);
    if (payload) return { payload, token, source: 'header' };
  }

  // 2. ?__volter_token= query param (used by iframes that can't set headers, and by a caller whose Authorization
  // belongs to the app)
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('__volter_token');
    if (queryToken) {
      const payload = verifyForTunnel(queryToken, tunnelId);
      if (payload) return { payload, token: queryToken, source: 'query' };
    }
  } catch {
    // URL parse failed — fall through to cookie
  }

  // 3. Cookie: the first __volter_auth bound to this tunnel
  for (const cookieToken of cookieValues(req.headers.cookie, '__volter_auth')) {
    const payload = verifyForTunnel(cookieToken, tunnelId);
    if (payload) return { payload, token: cookieToken, source: 'cookie' };
  }

  return null;
}

/**
 * An app's Set-Cookie headers as the relay passes them: every tunnel shares the parent domain, and registration is
 * open, so a cookie an app scopes to it (Domain=<DOMAIN> or any parent of it) would reach, and could shadow, every
 * other tunnel's cookies. Such a Domain attribute is removed, which leaves the cookie host-only on the app's own
 * tunnel. A cookie named __volter_auth is dropped: that name is the relay's. The relay's own bootstrap cookie is
 * appended after them.
 */
function appSetCookies(value, bootstrapCookie) {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const shared = DOMAIN.toLowerCase();
  const out = [];
  for (const cookie of list) {
    const parts = String(cookie).split(';');
    if (parts[0].slice(0, parts[0].indexOf('=')).trim() === '__volter_auth') continue;
    out.push(
      parts
        .filter((part, i) => {
          if (i === 0) return true;
          const [name, ...rest] = part.split('=');
          if (name.trim().toLowerCase() !== 'domain') return true;
          const domain = rest.join('=').trim().toLowerCase().replace(/^\./, '');
          return !(domain === shared || shared.endsWith(`.${domain}`));
        })
        .join(';')
    );
  }
  if (bootstrapCookie) out.push(bootstrapCookie);
  return out;
}

/**
 * Strip the __volter_auth cookie from request headers before forwarding to
 * tunnel clients. Prevents downstream services from seeing auth credentials.
 */
function stripAuthCookie(headers) {
  if (!headers.cookie) return headers;
  const cleaned = headers.cookie
    .split(';')
    .filter((pair) => pair.trim().split('=')[0]?.trim() !== '__volter_auth')
    .join(';')
    .trim();
  const result = { ...headers };
  if (cleaned) {
    result.cookie = cleaned;
  } else {
    delete result.cookie;
  }
  return result;
}

/**
 * Validate auth from a WebSocket upgrade request.
 * Checks ?__volter_token=<jwt> query parameter (browsers can't set headers on WS upgrades).
 * Falls back to cookie. Returns the payload and where the token came from (`query` or `cookie`).
 */
function validateWsAuth(req, tunnelId) {
  if (!JWT_SECRET) return null;

  // 1. ?__volter_token= query param
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('__volter_token');
    if (token) {
      const payload = verifyForTunnel(token, tunnelId);
      if (payload) return { payload, source: 'query' };
    }
  } catch {
    // URL parse failed — fall through to cookie
  }

  // 2. Cookie: the first __volter_auth bound to this tunnel
  for (const cookieToken of cookieValues(req.headers.cookie, '__volter_auth')) {
    const payload = verifyForTunnel(cookieToken, tunnelId);
    if (payload) return { payload, source: 'cookie' };
  }

  return null;
}

/** The public origin of a tunnel, as its registration reports it. */
function tunnelOrigin(tunnelId) {
  const scheme = SECURE ? 'https' : 'http';
  const portSuffix =
    (!SECURE && EXTERNAL_PORT !== 80) || (SECURE && EXTERNAL_PORT !== 443)
      ? `:${EXTERNAL_PORT}`
      : '';
  return `${scheme}://${tunnelId}.${DOMAIN}${portSuffix}`;
}

/**
 * Strip the ?__volter_token= query parameter from a URL path before forwarding
 * to the tunnel client (don't leak auth tokens to downstream services).
 */
function stripTokenParam(urlPath) {
  try {
    const url = new URL(urlPath, 'http://placeholder');
    url.searchParams.delete('__volter_token');
    const search = url.searchParams.toString();
    return url.pathname + (search ? '?' + search : '');
  } catch {
    return urlPath;
  }
}

// Origins (exact, comma-separated) the relay grants credentialed CORS to: the operator's own consoles that call
// tunnels with the __volter_auth cookie. Every other origin gets the credential-free grant.
const CORS_CREDENTIALED_ORIGINS = new Set(
  (process.env.CORS_CREDENTIALED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
);

/** Set the relay's CORS grant on a tunneled response. All tunnel traffic is cross-origin.
 *
 * The relay owns the policy: the tunnel client rewrites a visitor's Origin to the app's own localhost origin before
 * forwarding, so a tunneled app never sees who is calling and its own CORS headers (stripped from its responses)
 * could only name localhost. The tunnel answers preflight itself (OPTIONS never reaches the origin app).
 *
 * Any origin may read a tunnel credential-free: `Access-Control-Allow-Origin: *`, which browsers never pair with
 * cookies, so no website can read a tunnel with a visitor's SameSite=None __volter_auth cookie. Only an origin in
 * CORS_CREDENTIALED_ORIGINS is reflected with credentials. The preflight's Access-Control-Request-Headers are
 * reflected because the relay cannot know the app's clients' custom headers in advance (PeakHealth EMR's
 * multi-tenant surfaces send X-Active-Tenant-Id with a bearer Authorization header and no cookies; the fixed list
 * failed every such preflight). The fixed list remains for non-preflight responses, which carry no hint. */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  const credentialed = CORS_CREDENTIALED_ORIGINS.has(origin);
  res.setHeader('Access-Control-Allow-Origin', credentialed ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  const requested = req.headers['access-control-request-headers'];
  res.setHeader('Access-Control-Allow-Headers', requested || 'Content-Type, Authorization, X-Sandbox-Id');
  if (credentialed) res.setHeader('Access-Control-Allow-Credentials', 'true');
  // The grant depends on the Origin (credentialed or not), so a cache must key on it.
  res.setHeader('Vary', 'Origin');
}

/** Merge the relay's Vary (set by setCorsHeaders) into an app's response headers, which writeHead would otherwise let
 *  replace it: the union of both lists, or `*` when the app varies on everything. */
function mergeVary(res, headers) {
  const relay = res.getHeader('vary');
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'vary');
  if (!relay || !key) return;
  const app = String(headers[key]);
  if (app.trim() === '*') return;
  const names = [...app.split(','), ...String(relay).split(',')].map((n) => n.trim()).filter(Boolean);
  const seen = new Set();
  headers[key] = names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).join(', ');
}

/**
 * Strip frame-ancestors from CSP headers in proxied responses.
 * Downstream apps may set frame-ancestors 'none' or 'self', but the tunnel
 * server controls the framing context — extension iframes need to load.
 */
function stripFrameAncestors(headers) {
  for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
    if (headers[key]) {
      headers[key] = headers[key]
        .split(';')
        .filter((d) => !d.trim().startsWith('frame-ancestors'))
        .join(';')
        .trim();
      // Remove header entirely if empty after stripping
      if (!headers[key]) delete headers[key];
    }
  }
  // Also remove X-Frame-Options (superseded by CSP, but browsers still respect it)
  delete headers['x-frame-options'];
}

/** Send a 401 JSON response */
function send401(res) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Authentication required' }));
}

// ============================================================================
// HTTP server
// ============================================================================

const server = http.createServer((req, res) => {
  const tunnelId = getTunnelIdFromHost(req.headers.host);

  // Bare domain requests (no subdomain)
  if (!tunnelId) {
    // Cookie-setting endpoint: GET /__volter_auth?__volter_token=<jwt>
    if (req.url && req.url.startsWith('/__volter_auth')) {
      setCorsHeaders(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('__volter_token');
        if (!token || !JWT_SECRET) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing token parameter' }));
          return;
        }
        // Validate JWT
        try {
          jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        } catch {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid token' }));
          return;
        }
        // Set cookie on the tunnel domain. SameSite=None; Secure so the cookie
        // can be set and sent from within cross-origin iframes. Safe because the
        // tunnel server strips the cookie before forwarding to downstream services.
        const cookieDomain = '.' + DOMAIN;
        const maxAge = 3600; // 1 hour
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `__volter_auth=${token}; Domain=${cookieDomain}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${maxAge}`,
        });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
      return;
    }

    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tunnels: clients.size,
          pending: pendingRequests.size,
          streaming: streamingResponses.size,
          wsRelays: wsConnections.size,
        })
      );
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ws-tunnel server');
    return;
  }

  // All tunneled requests get CORS headers (tunnel traffic is always cross-origin)
  setCorsHeaders(req, res);

  // Handle preflight at tunnel server level (no auth check for OPTIONS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const client = clients.get(tunnelId);
  if (!client || client.ws.readyState !== 1) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Tunnel not connected');
    return;
  }

  // Auth check for auth-required tunnels
  let bootstrapCookie = null;
  if (client.authRequired && JWT_SECRET) {
    const auth = validateAuth(req, tunnelId);
    if (!auth) {
      send401(res);
      return;
    }
    // When auth came from ?token= query param (iframe initial load),
    // bootstrap a cookie so subsequent requests auth via cookie automatically.
    // Host-only (no Domain): the token is bound to this tunnel, so its cookie belongs to this tunnel's host alone and
    // never overwrites another tunnel's.
    if (auth.source === 'query') {
      const maxAge = 3600; // 1 hour
      bootstrapCookie = `__volter_auth=${auth.token}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${maxAge}`;
    }
  }

  // Strip ?token= and __volter_auth cookie before forwarding — don't leak auth to downstream
  const forwardUrl = stripTokenParam(req.url);
  const forwardHeaders = stripAuthCookie(req.headers);

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const reqId = ++reqIdCounter;
    const body = Buffer.concat(chunks);

    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' });
        res.end('Tunnel timeout');
      }
    }, 30000);

    // Bound to the control socket the request is sent on: only that socket may answer it (see the message handler).
    pendingRequests.set(reqId, { res, timer, tunnelId, bootstrapCookie, ctl: client.ws });

    client.ws.send(
      JSON.stringify({
        type: 'request',
        reqId,
        method: req.method,
        path: forwardUrl,
        headers: forwardHeaders,
        body: body.length > 0 ? body.toString('base64') : null,
      })
    );
  });
});

// WebSocket server for control channels AND browser-side WS relay
const wss = new WebSocketServer({ noServer: true });
// Separate WSS for browser-side proxied connections
const proxyWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Raw upgrade sockets have no default error handler — without this,
  // a socket error (e.g. ECONNRESET) would crash the server.
  socket.on('error', (err) => {
    console.log(`[ws-upgrade] socket error: ${err.message}`);
  });

  const tunnelId = getTunnelIdFromHost(req.headers.host);

  // No subdomain + /ws path → control channel for tunnel clients.
  // Tolerate a query string (the client appends ?id=<tunnelId> so a routing
  // relay can pick its backend; this server reads tunnelId from `register`).
  if (!tunnelId && req.url && req.url.split('?')[0] === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  // Subdomain request → proxy WebSocket to tunnel client
  if (tunnelId) {
    const client = clients.get(tunnelId);
    if (!client || client.ws.readyState !== 1) {
      console.log(`[ws-relay] tunnel ${tunnelId} not connected, rejecting upgrade`);
      socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    // Auth check for auth-required tunnels (WS uses ?token= query param or cookie)
    if (client.authRequired && JWT_SECRET) {
      const auth = validateWsAuth(req, tunnelId);
      if (!auth) {
        console.log(`[ws-relay] auth failed for tunnel ${tunnelId}, rejecting upgrade`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // A browser sends the SameSite=None cookie on a cross-site upgrade too, and CORS does not apply to WebSockets,
      // so a cookie authenticates a browser's upgrade only from the tunnel's own origin or a credentialed origin. A
      // browser always names its Origin on an upgrade; a client that names none is not a browser, and a cookie it
      // sends is its own, not one a site borrowed. A token on the URL was handed to the page on purpose and stays
      // accepted from anywhere.
      const origin = req.headers.origin;
      if (
        auth.source === 'cookie' &&
        origin !== undefined &&
        origin !== tunnelOrigin(tunnelId) &&
        !CORS_CREDENTIALED_ORIGINS.has(origin)
      ) {
        console.log(`[ws-relay] cookie-authenticated upgrade from a foreign origin for tunnel ${tunnelId}, refused`);
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    // Strip ?token= from the URL before forwarding to tunnel client
    const cleanUrl = stripTokenParam(req.url);

    // Complete the upgrade with the browser first — get a proper WebSocket object
    proxyWss.handleUpgrade(req, socket, head, (browserWs) => {
      // Error handler for the pending-upgrade phase (before ws-ready wires up
      // the relay error handler). Without this, errors during the gap between
      // upgrade and ws-ready are unhandled.
      browserWs.on('error', (err) => {
        console.log(`[ws-relay] browserWs error (pre-ready): ${err.message}`);
      });

      const connId = ++reqIdCounter;
      console.log(
        `[ws-relay] browser WS upgraded, sending ws-upgrade to tunnel client: connId=${connId} tunnelId=${tunnelId}`
      );

      const timer = setTimeout(() => {
        console.log(`[ws-relay] ws-upgrade TIMEOUT for connId=${connId}`);
        pendingUpgrades.delete(connId);
        browserWs.close(1001, 'Tunnel timeout');
      }, 15000);

      pendingUpgrades.set(connId, { browserWs, timer, tunnelId, ctl: client.ws });

      // Ask tunnel client to connect to its local WebSocket
      client.ws.send(
        JSON.stringify({
          type: 'ws-upgrade',
          connId,
          path: cleanUrl,
          headers: stripAuthCookie(req.headers),
        })
      );

      // Buffer browser messages until tunnel client is ready
      const bufferedMessages = [];
      const bufferHandler = (data, isBinary) => {
        bufferedMessages.push({ data, isBinary });
      };
      browserWs.on('message', bufferHandler);

      // Store buffer info so ws-ready handler can flush and rewire
      pendingUpgrades.get(connId).bufferedMessages = bufferedMessages;
      pendingUpgrades.get(connId).bufferHandler = bufferHandler;
    });
    return;
  }

  socket.destroy();
});

wss.on('connection', (ws) => {
  // The id this socket registered, set once. The socket speaks for it only while it is that id's current client: a
  // replaced socket keeps its id here but owns nothing.
  let tunnelId = null;
  const owns = () => tunnelId !== null && clients.get(tunnelId)?.ws === ws;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    // Before registering, a socket may only register; after, only the id's current client is heard. Every entry a
    // message names (a pending request, a stream, an upgrade, a relayed WebSocket) must also belong to this socket, so
    // no socket can answer, or take over, another tunnel's traffic by guessing its counter.
    if (msg.type !== 'register' && !owns()) return;

    if (msg.type === 'register') {
      // One registration per socket: a second register is refused rather than leaving the first id bound to it.
      if (tunnelId !== null) {
        ws.send(JSON.stringify({ type: 'error', message: 'This connection is already registered' }));
        return;
      }
      // Reject if TUNNEL_SECRET is configured and client didn't provide a matching secret
      if (TUNNEL_SECRET && msg.secret !== TUNNEL_SECRET) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid tunnel secret' }));
        ws.close(4003, 'Invalid tunnel secret');
        return;
      }

      tunnelId = msg.tunnelId || generateId();
      const existing = clients.get(tunnelId);
      if (existing && existing.ws !== ws) {
        if (msg.replace) {
          console.log(`[tunnel] replacing stale client for tunnelId=${tunnelId}`);
          existing.ws.close(4001, 'Replaced by new client');
        } else {
          ws.send(JSON.stringify({
            type: 'error',
            message: `Tunnel ID '${tunnelId}' is already in use by another client. Pass { replace: true } in the register message to take over the existing tunnel.`,
          }));
          ws.close(4002, 'Tunnel ID already in use');
          return;
        }
      }

      // Store tunnel client with auth setting (default: true)
      const authRequired = msg.authRequired !== false;
      clients.set(tunnelId, { ws, authRequired });

      const url = tunnelOrigin(tunnelId);

      ws.send(JSON.stringify({ type: 'registered', tunnelId, url }));
      console.log(`[tunnel] registered: ${tunnelId} (${clients.size} active, auth=${authRequired})`);
    }

    if (msg.type === 'response') {
      const pending = pendingRequests.get(msg.reqId);
      if (!pending || pending.ctl !== ws) return;

      clearTimeout(pending.timer);
      pendingRequests.delete(msg.reqId);

      const { res } = pending;
      if (res.headersSent) return;

      const headers = msg.headers || {};
      delete headers['transfer-encoding'];
      delete headers['connection'];
      // Strip downstream CORS headers — tunnel server manages CORS via setCorsHeaders()
      delete headers['access-control-allow-origin'];
      delete headers['access-control-allow-methods'];
      delete headers['access-control-allow-headers'];
      delete headers['access-control-allow-credentials'];
      stripFrameAncestors(headers);

      // The app's cookies kept to its own host, then the bootstrap cookie (when auth came from ?token= query param)
      const setCookies = appSetCookies(headers['set-cookie'], pending.bootstrapCookie);
      if (setCookies.length) headers['set-cookie'] = setCookies;
      else delete headers['set-cookie'];

      mergeVary(res, headers);
      res.writeHead(msg.status || 200, headers);
      if (msg.body) {
        res.end(Buffer.from(msg.body, 'base64'));
      } else {
        res.end();
      }
    }

    // === Streaming HTTP response messages ===

    if (msg.type === 'response-start') {
      const pending = pendingRequests.get(msg.reqId);
      if (!pending || pending.ctl !== ws) return;
      clearTimeout(pending.timer);
      pendingRequests.delete(msg.reqId);

      const { res } = pending;
      if (res.headersSent) return;

      const headers = msg.headers || {};
      delete headers['transfer-encoding'];
      delete headers['connection'];
      // Strip downstream CORS headers — tunnel server manages CORS via setCorsHeaders()
      delete headers['access-control-allow-origin'];
      delete headers['access-control-allow-methods'];
      delete headers['access-control-allow-headers'];
      delete headers['access-control-allow-credentials'];
      stripFrameAncestors(headers);

      // The app's cookies kept to its own host, then the bootstrap cookie (when auth came from ?token= query param)
      const setCookies = appSetCookies(headers['set-cookie'], pending.bootstrapCookie);
      if (setCookies.length) headers['set-cookie'] = setCookies;
      else delete headers['set-cookie'];

      mergeVary(res, headers);
      res.writeHead(msg.status || 200, headers);

      streamingResponses.set(msg.reqId, { res, tunnelId, ctl: ws });

      // If browser disconnects, tell tunnel client to abort
      res.on('close', () => {
        if (streamingResponses.has(msg.reqId)) {
          streamingResponses.delete(msg.reqId);
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'request-abort', reqId: msg.reqId }));
          }
        }
      });
    }

    if (msg.type === 'response-chunk') {
      const streaming = streamingResponses.get(msg.reqId);
      if (streaming && streaming.ctl === ws) {
        streaming.res.write(Buffer.from(msg.data, 'base64'));
      }
    }

    if (msg.type === 'response-end') {
      const streaming = streamingResponses.get(msg.reqId);
      if (streaming && streaming.ctl === ws) {
        streamingResponses.delete(msg.reqId);
        streaming.res.end();
      }
    }

    // === WebSocket relay messages (message-level) ===

    if (msg.type === 'ws-ready') {
      const pending = pendingUpgrades.get(msg.connId);
      if (!pending || pending.ctl !== ws) {
        console.log(`[ws-relay] WARNING: no pending upgrade for connId=${msg.connId} on this tunnel`);
        return;
      }

      clearTimeout(pending.timer);
      pendingUpgrades.delete(msg.connId);

      const { browserWs, bufferedMessages, bufferHandler } = pending;

      // Store active connection
      wsConnections.set(msg.connId, { browserWs, tunnelId: pending.tunnelId, clientWs: ws });

      // Remove buffer handler and set up real relay
      browserWs.removeListener('message', bufferHandler);

      // Flush buffered messages
      for (const { data, isBinary } of bufferedMessages) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        ws.send(
          JSON.stringify({
            type: 'ws-message',
            connId: msg.connId,
            data: buf.toString('base64'),
            binary: isBinary,
          })
        );
      }

      // Relay: browser → tunnel client
      browserWs.on('message', (data, isBinary) => {
        if (ws.readyState === 1) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          ws.send(
            JSON.stringify({
              type: 'ws-message',
              connId: msg.connId,
              data: buf.toString('base64'),
              binary: isBinary,
            })
          );
        }
      });

      browserWs.on('close', (code, reason) => {
        console.log(`[ws-relay] browser WS closed connId=${msg.connId} code=${code}`);
        if (ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'ws-close',
              connId: msg.connId,
              code,
              reason: reason?.toString() || '',
            })
          );
        }
        wsConnections.delete(msg.connId);
      });

      browserWs.on('error', (err) => {
        console.log(`[ws-relay] browser WS error connId=${msg.connId}: ${err.message}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'ws-close', connId: msg.connId }));
        }
        wsConnections.delete(msg.connId);
      });

      console.log(`[ws-relay] relay started: connId=${msg.connId} tunnel=${pending.tunnelId}`);
    }

    if (msg.type === 'ws-error') {
      console.log(`[ws-relay] received ws-error for connId=${msg.connId}: ${msg.error}`);
      const pending = pendingUpgrades.get(msg.connId);
      if (pending && pending.ctl === ws) {
        clearTimeout(pending.timer);
        pendingUpgrades.delete(msg.connId);
        closeWsSafely(pending.browserWs, 1001, msg.error || 'Tunnel error');
      }
    }

    // Relay: tunnel client → browser
    if (msg.type === 'ws-message') {
      const conn = wsConnections.get(msg.connId);
      if (conn && conn.clientWs === ws && conn.browserWs.readyState === 1) {
        const buf = Buffer.from(msg.data, 'base64');
        conn.browserWs.send(buf, { binary: msg.binary });
      }
    }

    if (msg.type === 'ws-close') {
      const conn = wsConnections.get(msg.connId);
      if (conn && conn.clientWs === ws) {
        const code =
          msg.code >= 1000 && msg.code <= 4999 && msg.code !== 1005 && msg.code !== 1006
            ? msg.code
            : 1000;
        closeWsSafely(conn.browserWs, code, msg.reason || '');
        wsConnections.delete(msg.connId);
      }
    }
  });

  // A socket's end retires only what is its own: the id's binding while it still holds it, and the traffic sent on it.
  // A replaced socket's late close leaves its successor's binding and traffic alone.
  ws.on('close', () => {
    if (tunnelId) {
      if (owns()) clients.delete(tunnelId);

      // Close all proxied WebSocket connections for this tunnel client
      for (const [connId, conn] of wsConnections) {
        if (conn.clientWs === ws) {
          conn.browserWs.close(1001, 'Tunnel disconnected');
          wsConnections.delete(connId);
        }
      }

      // End any active streaming responses for this tunnel
      for (const [reqId, streaming] of streamingResponses) {
        if (streaming.ctl === ws) {
          streaming.res.end();
          streamingResponses.delete(reqId);
        }
      }

      // Clean up pending requests for this tunnel
      for (const [reqId, pending] of pendingRequests) {
        if (pending.ctl === ws) {
          clearTimeout(pending.timer);
          if (!pending.res.headersSent) {
            pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
            pending.res.end('Tunnel disconnected');
          }
          pendingRequests.delete(reqId);
        }
      }

      // Clean up pending upgrades
      for (const [connId, pending] of pendingUpgrades) {
        if (pending.ctl === ws) {
          clearTimeout(pending.timer);
          pending.browserWs.close(1001, 'Tunnel disconnected');
          pendingUpgrades.delete(connId);
        }
      }

      console.log(`[tunnel] disconnected: ${tunnelId} (${clients.size} active)`);
    }
  });

  ws.on('error', () => {
    if (owns()) clients.delete(tunnelId);
  });
});

server.on('error', (err) => {
  console.error(`[server] HTTP server error: ${err.message}`);
});

server.listen(PORT, () => {
  console.log(`ws-tunnel server on port ${PORT}, domain=${DOMAIN}, auth=${JWT_SECRET ? 'enabled' : 'disabled'}`);
});
