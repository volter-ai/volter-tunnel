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

/**
 * Validate auth from a request. Checks (in order):
 * 1. Authorization: Bearer <jwt> header
 * 2. ?token= query parameter
 * 3. __volter_auth cookie
 *
 * Returns { payload, token, source } or null.
 * `source` is 'header' | 'query' | 'cookie' — used to decide whether to bootstrap a cookie.
 */
function validateAuth(req) {
  if (!JWT_SECRET) return null;

  // 1. Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      return { payload: jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }), token, source: 'header' };
    } catch {
      return null;
    }
  }

  // 2. ?__volter_token= query param (used by iframes that can't set headers)
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const queryToken = url.searchParams.get('__volter_token');
    if (queryToken) {
      try {
        return { payload: jwt.verify(queryToken, JWT_SECRET, { algorithms: ['HS256'] }), token: queryToken, source: 'query' };
      } catch {
        return null;
      }
    }
  } catch {
    // URL parse failed — fall through to cookie
  }

  // 3. Cookie
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.get('__volter_auth');
  if (cookieToken) {
    try {
      return { payload: jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] }), token: cookieToken, source: 'cookie' };
    } catch {
      return null;
    }
  }

  return null;
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
 * Falls back to cookie.
 */
function validateWsAuth(req) {
  if (!JWT_SECRET) return null;

  // 1. ?__volter_token= query param
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('__volter_token');
    if (token) {
      try {
        return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      } catch {
        return null;
      }
    }
  } catch {
    // URL parse failed — fall through to cookie
  }

  // 2. Cookie
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies.get('__volter_auth');
  if (cookieToken) {
    try {
      return jwt.verify(cookieToken, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return null;
    }
  }

  return null;
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

/** Set CORS headers on a tunneled response. All tunnel traffic is cross-origin. */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sandbox-Id');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
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
    const auth = validateAuth(req);
    if (!auth) {
      send401(res);
      return;
    }
    // When auth came from ?token= query param (iframe initial load),
    // bootstrap a cookie so subsequent requests auth via cookie automatically.
    if (auth.source === 'query') {
      const cookieDomain = '.' + DOMAIN;
      const maxAge = 3600; // 1 hour
      bootstrapCookie = `__volter_auth=${auth.token}; Domain=${cookieDomain}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=${maxAge}`;
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

    pendingRequests.set(reqId, { res, timer, tunnelId, bootstrapCookie });

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
      const payload = validateWsAuth(req);
      if (!payload) {
        console.log(`[ws-relay] auth failed for tunnel ${tunnelId}, rejecting upgrade`);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
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

      pendingUpgrades.set(connId, { browserWs, timer, tunnelId });

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
  let tunnelId = null;

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === 'register') {
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

      const scheme = SECURE ? 'https' : 'http';
      const portSuffix =
        (!SECURE && EXTERNAL_PORT !== 80) || (SECURE && EXTERNAL_PORT !== 443)
          ? `:${EXTERNAL_PORT}`
          : '';
      const url = `${scheme}://${tunnelId}.${DOMAIN}${portSuffix}`;

      ws.send(JSON.stringify({ type: 'registered', tunnelId, url }));
      console.log(`[tunnel] registered: ${tunnelId} (${clients.size} active, auth=${authRequired})`);
    }

    if (msg.type === 'response') {
      const pending = pendingRequests.get(msg.reqId);
      if (!pending) return;

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

      // Bootstrap cookie on first request (when auth came from ?token= query param)
      if (pending.bootstrapCookie) {
        headers['set-cookie'] = pending.bootstrapCookie;
      }

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
      if (!pending) return;
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

      // Bootstrap cookie on first request (when auth came from ?token= query param)
      if (pending.bootstrapCookie) {
        headers['set-cookie'] = pending.bootstrapCookie;
      }

      res.writeHead(msg.status || 200, headers);

      streamingResponses.set(msg.reqId, { res, tunnelId });

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
      if (streaming) {
        streaming.res.write(Buffer.from(msg.data, 'base64'));
      }
    }

    if (msg.type === 'response-end') {
      const streaming = streamingResponses.get(msg.reqId);
      if (streaming) {
        streamingResponses.delete(msg.reqId);
        streaming.res.end();
      }
    }

    // === WebSocket relay messages (message-level) ===

    if (msg.type === 'ws-ready') {
      const pending = pendingUpgrades.get(msg.connId);
      if (!pending) {
        console.log(`[ws-relay] WARNING: no pending upgrade for connId=${msg.connId}`);
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
      if (pending) {
        clearTimeout(pending.timer);
        pendingUpgrades.delete(msg.connId);
        closeWsSafely(pending.browserWs, 1001, msg.error || 'Tunnel error');
      }
    }

    // Relay: tunnel client → browser
    if (msg.type === 'ws-message') {
      const conn = wsConnections.get(msg.connId);
      if (conn && conn.browserWs.readyState === 1) {
        const buf = Buffer.from(msg.data, 'base64');
        conn.browserWs.send(buf, { binary: msg.binary });
      }
    }

    if (msg.type === 'ws-close') {
      const conn = wsConnections.get(msg.connId);
      if (conn) {
        const code =
          msg.code >= 1000 && msg.code <= 4999 && msg.code !== 1005 && msg.code !== 1006
            ? msg.code
            : 1000;
        closeWsSafely(conn.browserWs, code, msg.reason || '');
        wsConnections.delete(msg.connId);
      }
    }
  });

  ws.on('close', () => {
    if (tunnelId) {
      clients.delete(tunnelId);

      // Close all proxied WebSocket connections for this tunnel client
      for (const [connId, conn] of wsConnections) {
        if (conn.tunnelId === tunnelId) {
          conn.browserWs.close(1001, 'Tunnel disconnected');
          wsConnections.delete(connId);
        }
      }

      // End any active streaming responses for this tunnel
      for (const [reqId, streaming] of streamingResponses) {
        if (streaming.tunnelId === tunnelId) {
          streaming.res.end();
          streamingResponses.delete(reqId);
        }
      }

      // Clean up pending requests for this tunnel
      for (const [reqId, pending] of pendingRequests) {
        if (pending.tunnelId === tunnelId) {
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
        if (pending.tunnelId === tunnelId) {
          clearTimeout(pending.timer);
          pending.browserWs.close(1001, 'Tunnel disconnected');
          pendingUpgrades.delete(connId);
        }
      }

      console.log(`[tunnel] disconnected: ${tunnelId} (${clients.size} active)`);
    }
  });

  ws.on('error', () => {
    if (tunnelId) {
      clients.delete(tunnelId);
    }
  });
});

server.on('error', (err) => {
  console.error(`[server] HTTP server error: ${err.message}`);
});

server.listen(PORT, () => {
  console.log(`ws-tunnel server on port ${PORT}, domain=${DOMAIN}, auth=${JWT_SECRET ? 'enabled' : 'disabled'}`);
});
