#!/usr/bin/env bun
/**
 * WebSocket-based HTTP tunnel client.
 *
 * Connects to the tunnel server via WebSocket, receives HTTP requests,
 * forwards them to a local port, and sends responses back.
 *
 * Also handles WebSocket relay: the server sends ws-upgrade messages,
 * the client connects to the local WebSocket server using the `ws` library
 * and relays WebSocket messages bidirectionally through the control channel.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import WebSocket from 'ws';

/**
 * Force HTTP/1.1 for the (TLS) control WebSocket — HTTP/2 breaks the Upgrade
 * handshake. Only applies to wss:// (an https.Agent rejects a plain ws:// URL),
 * so it's used conditionally; plain ws:// (e.g. a local relay) needs no agent.
 */
const http1Agent = new https.Agent({ ALPNProtocols: ['http/1.1'] });

/** Minimal logger interface for tunnel client — compatible with pino, console, etc. */
export interface TunnelLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

const defaultLogger: TunnelLogger = {
  info(obj, msg) {
    console.log(msg, obj);
  },
  warn(obj, msg) {
    console.warn(msg, obj);
  },
  debug(obj, msg) {
    console.debug(msg, obj);
  },
};

export interface TunnelOptions {
  /** Local port to expose */
  port: number;
  /** Tunnel server URL (e.g., "https://vgit-tunnels.volterapp.com") */
  host: string;
  /** Requested tunnel ID (optional — server generates one if omitted) */
  tunnelId?: string;
  /** Shared secret for tunnel server authentication */
  secret?: string;
  /** Whether the tunnel requires JWT auth for incoming requests (default: true) */
  authRequired?: boolean;
  /** Optional HTTP Basic Auth gate: every inbound request must present these
   *  credentials (independent of the JWT layer). Handy for protecting a shared
   *  dev tunnel without wiring JWTs. */
  basicAuth?: { user: string; pass: string };
  /** Logger instance (defaults to console-based logger) */
  logger?: TunnelLogger;
}

export interface TunnelHandle {
  /** Public tunnel URL (e.g., "https://quick-fox-123.vgit-tunnels.volterapp.com") */
  url: string;
  /** Assigned tunnel ID */
  tunnelId: string;
  /** Close the tunnel connection */
  close: () => void;
}

interface TunnelRequest {
  type: 'request';
  reqId: number;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
}

interface RateWindow {
  limit: number;
  remaining: number;
  reset: number;
}

interface TunnelRegistered {
  type: 'registered';
  tunnelId: string;
  url: string;
  /** Metering snapshot for this account (present when the relay meters usage). */
  account?: { slug: string; day: RateWindow; month: RateWindow; level: 'ok' | 'warn' | 'exceeded' };
}

/** Pushed by the relay when the account's usage level changes (ok→warn→exceeded). */
interface TunnelQuota {
  type: 'quota';
  level: 'ok' | 'warn' | 'exceeded';
  day: RateWindow;
  month: RateWindow;
}

interface TunnelWsUpgrade {
  type: 'ws-upgrade';
  connId: number;
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

interface TunnelWsMessage {
  type: 'ws-message';
  connId: number;
  data: string; // base64
  binary: boolean;
}

interface TunnelWsClose {
  type: 'ws-close';
  connId: number;
  code?: number;
  reason?: string;
}

interface TunnelRequestAbort {
  type: 'request-abort';
  reqId: number;
}

interface TunnelError {
  type: 'error';
  message: string;
}

type TunnelMessage =
  | TunnelRequest
  | TunnelRegistered
  | TunnelWsUpgrade
  | TunnelWsMessage
  | TunnelWsClose
  | TunnelRequestAbort
  | TunnelError
  | TunnelQuota;

// ============================================================================
// Safe WebSocket close helpers
//
// The `ws` library calls socket.destroy() (TCP RST) in two cases:
// 1. .close() in CONNECTING state → abortHandshake() → stream.socket.destroy()
// 2. Close timeout (30s after sending close frame) → socket.destroy()
//
// TCP RST causes ECONNRESET on the local server, crashing it. These helpers
// replace .close() with state-aware logic that sends FIN instead of RST.
// ============================================================================

/**
 * Add a no-op error handler to the underlying net.Socket if none exists.
 * Prevents unhandled ECONNRESET from crashing the tunnel client process.
 */
function patchSocketErrorHandler(ws: WebSocket): void {
  const internal = ws as unknown as Record<string, unknown>;
  const socket = internal._socket;
  if (socket instanceof net.Socket && socket.listenerCount('error') === 0) {
    socket.on('error', () => {
      // Intentional no-op — the WebSocket 'error' and 'close' events
      // handle cleanup. This just prevents the socket error from being
      // unhandled and crashing the process.
    });
  }
}

/**
 * Close an OPEN WebSocket gracefully, replacing the ws library's 30s
 * destroy timer with one that calls socket.end() (FIN) instead of
 * socket.destroy() (RST).
 */
function safeCloseOpen(ws: WebSocket, code: number, reason: string): void {
  patchSocketErrorHandler(ws);

  // Send the close frame normally
  ws.close(code, reason);

  // Replace the ws library's internal close timer.
  // ws sets _closeTimer after calling close() — it fires socket.destroy()
  // after 30s if the peer doesn't respond with a close frame.
  const internal = ws as unknown as Record<string, unknown>;
  const existingTimer = internal._closeTimer;
  if (existingTimer) {
    clearTimeout(existingTimer as ReturnType<typeof setTimeout>);
    internal._closeTimer = null;
  }

  // Set our own timer that sends FIN instead of RST
  const socket = internal._socket;
  if (socket instanceof net.Socket) {
    const finTimer = setTimeout(() => {
      if (!socket.destroyed) {
        socket.end(); // FIN, not RST
      }
    }, 30000);
    // Don't let this timer keep the process alive
    finTimer.unref();
    internal._closeTimer = finTimer;
  }
}

/**
 * State-aware close that never sends TCP RST to the local server.
 *
 * - CONNECTING: Don't call .close() (which triggers abortHandshake → destroy).
 *   Instead, remove relay listeners and let the connection either open
 *   (then close gracefully) or fail naturally.
 * - OPEN: Use safeCloseOpen() to replace the destroy timer.
 * - CLOSING: Already closing, just patch the error handler.
 * - CLOSED: No-op.
 */
function safeClose(ws: WebSocket, code?: number, reason?: string): void {
  const closeCode = code ?? 1000;
  const closeReason = reason ?? '';

  switch (ws.readyState) {
    case WebSocket.CONNECTING: {
      // Don't call .close() — it would call abortHandshake() → socket.destroy()
      // Remove message relay listeners so no data flows if the connection opens
      ws.removeAllListeners('message');
      ws.removeAllListeners('open');

      // If it eventually opens, close it gracefully then
      ws.on('open', () => {
        safeCloseOpen(ws, closeCode, closeReason);
      });
      // If it errors (ECONNREFUSED, etc.), that's fine — natural teardown

      // Fallback: if neither open nor error fires within 5s (e.g. TCP connects
      // but HTTP upgrade hangs), terminate to prevent zombie accumulation.
      const zombieTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.terminate();
        }
      }, 5000);
      ws.on('open', () => clearTimeout(zombieTimer));
      ws.on('error', () => clearTimeout(zombieTimer));
      break;
    }
    case WebSocket.OPEN: {
      safeCloseOpen(ws, closeCode, closeReason);
      break;
    }
    case WebSocket.CLOSING: {
      // Already closing — just make sure the socket error handler is patched
      patchSocketErrorHandler(ws);
      break;
    }
    case WebSocket.CLOSED: {
      // Nothing to do
      break;
    }
  }
}

/**
 * Create a tunnel to expose a local port via the tunnel server.
 */
/**
 * Resolve which loopback address can reach a given port.
 * Tries 127.0.0.1 (IPv4) first, then ::1 (IPv6).
 * Returns the working address, or '127.0.0.1' as default.
 */
async function resolveLocalHost(port: number): Promise<string> {
  for (const addr of ['127.0.0.1', '::1']) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: addr, port }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(500, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return addr;
  }
  return '127.0.0.1';
}

export function createTunnel({
  port,
  host,
  tunnelId,
  secret,
  authRequired,
  basicAuth,
  logger,
}: TunnelOptions): Promise<TunnelHandle> {
  const log = logger ?? defaultLogger;
  // Include the tunnelId in the control URL so a routing relay (e.g. the
  // Cloudflare Workers + Durable Objects relay) can pick the right backend at
  // upgrade time, before the `register` message is sent. The Fly relay ignores
  // the query param and reads tunnelId from `register`, so one client works
  // against both servers.
  const wsUrl =
    `${host.replace(/^http/, 'ws')}/ws` +
    (tunnelId ? `?id=${encodeURIComponent(tunnelId)}` : '');

  // Resolved loopback address for this port (set before first connection)
  let localHost = '127.0.0.1';

  // Shared state across reconnections
  let closed = false;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30000;
  // Set to true on any successful registration. Once true, reconnect attempts that
  // fail (close without receiving 'registered') will still retry instead of giving up.
  let everRegistered = false;

  function connect(
    onRegistered: (handle: TunnelHandle) => void,
    onFirstError: ((err: Error) => void) | null
  ): void {
    if (closed) return;

    const ws = new WebSocket(wsUrl, wsUrl.startsWith('wss:') ? { agent: http1Agent } : {});
    let registered = false;
    // Hoisted so every teardown path (a reconnect via the 'close' handler, or an
    // explicit handle.close()) can clear it. It used to be declared inside the
    // 'registered' handler and cleared only on explicit close — so each reconnect
    // leaked an interval that kept firing ws.ping() on a dead socket forever, and
    // when the control connection flaps (reconnecting every second) those pile up
    // fast.
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
    // Resets the reconnect backoff once the link has proven stable (see the
    // 'registered' handler). Cleared on close so a connection that drops before
    // proving stable keeps — and keeps growing — its backoff instead of snapping
    // back to a 1s retry.
    let stableTimer: ReturnType<typeof setTimeout> | null = null;

    // Track local WebSocket connections: connId → WebSocket
    const localWsConnections = new Map<number, WebSocket>();
    // Track active HTTP requests for abort support: reqId → http.ClientRequest
    const activeRequests = new Map<number, http.ClientRequest>();

    const timeout = setTimeout(() => {
      ws.close();
      if (onFirstError) {
        onFirstError(new Error('Tunnel connection timeout'));
        onFirstError = null;
      }
    }, 10000);

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'register',
          tunnelId,
          secret,
          replace: true,
          authRequired: authRequired !== false,
          ...(basicAuth ? { basicAuth } : {}),
        })
      );
    });

    ws.on('message', async (data: WebSocket.RawData) => {
      let msg: TunnelMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        log.warn(
          { component: 'tunnel_client', action: 'message_parse_error', error: String(err) },
          `Failed to parse tunnel message: ${err}`
        );
        return;
      }

      log.info(
        { component: 'tunnel_client', action: 'message_received', port, type: msg.type },
        `[MSG] Received: ${msg.type}`
      );

      if (msg.type === 'error') {
        clearTimeout(timeout);
        if (onFirstError) {
          onFirstError(new Error(`Tunnel server rejected connection: ${msg.message}`));
          onFirstError = null;
        }
        return;
      }

      if (msg.type === 'registered') {
        clearTimeout(timeout);
        registered = true;
        everRegistered = true;
        // Reset backoff only once the connection proves stable — NOT the instant
        // we register. A server that accepts the registration then drops us a
        // second later (infra cycling) would otherwise keep resetting us to a 1s
        // retry, and we'd reconnect every second forever, hammering an already
        // struggling server. Letting the backoff grow until the link holds for
        // 30s eases off instead; a healthy link clears the timer well within it.
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          reconnectDelay = 1000;
        }, 30000);
        stableTimer.unref();

        // Send keepalive every 25 seconds to prevent Fly.io idle timeout (30s)
        keepaliveInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          }
        }, 25000);

        log.info(
          {
            component: 'tunnel_client',
            action: 'registered',
            port,
            tunnelId: msg.tunnelId,
            url: msg.url,
            account: msg.account?.slug,
            dayRemaining: msg.account?.day.remaining,
            dayLimit: msg.account?.day.limit,
          },
          msg.account
            ? `Tunnel registered: localhost:${port} → ${msg.url} (${msg.account.slug}: ${msg.account.day.remaining}/${msg.account.day.limit} credits today)`
            : `Tunnel registered: localhost:${port} → ${msg.url}`
        );
        onRegistered({
          url: msg.url,
          tunnelId: msg.tunnelId,
          close: () => {
            closed = true;
            if (keepaliveInterval) clearInterval(keepaliveInterval);
            if (stableTimer) clearTimeout(stableTimer);
            for (const [, localWs] of localWsConnections) {
              safeClose(localWs);
            }
            localWsConnections.clear();
            ws.close();
          },
        });
      }

      if (msg.type === 'quota') {
        const line = `Tunnel quota ${msg.level}: ${msg.day.remaining}/${msg.day.limit} credits remaining today`;
        const ctx = {
          component: 'tunnel_client',
          action: 'quota',
          level: msg.level,
          dayRemaining: msg.day.remaining,
          dayLimit: msg.day.limit,
          monthRemaining: msg.month.remaining,
        };
        if (msg.level === 'ok') log.info(ctx, line);
        else log.warn(ctx, line);
        return;
      }

      if (msg.type === 'request') {
        const localReq = forwardRequest(port, localHost, msg, ws, activeRequests, async (err) => {
          // On ECONNREFUSED, re-resolve loopback and retry once
          if (err.code === 'ECONNREFUSED') {
            const newAddr = await resolveLocalHost(port);
            if (newAddr !== localHost) {
              log.info(
                {
                  component: 'tunnel_client',
                  action: 're_resolved_local_host',
                  port,
                  from: localHost,
                  to: newAddr,
                },
                `Loopback changed from ${localHost} to ${newAddr} for port ${port}`
              );
              localHost = newAddr;
              const retryReq = forwardRequest(port, localHost, msg, ws, activeRequests);
              activeRequests.set(msg.reqId, retryReq);
              return true; // suppressed the error
            }
          }
          return false;
        });
        activeRequests.set(msg.reqId, localReq);
      }

      if (msg.type === 'request-abort') {
        const localReq = activeRequests.get(msg.reqId);
        if (localReq) {
          localReq.destroy();
          activeRequests.delete(msg.reqId);
        }
      }

      // === WebSocket relay handling (message-level) ===

      if (msg.type === 'ws-upgrade') {
        log.info(
          {
            component: 'tunnel_client',
            action: 'ws_upgrade_received',
            connId: msg.connId,
            path: msg.path,
          },
          `[WS-RELAY] Received ws-upgrade connId=${msg.connId}`
        );
        handleWsUpgrade(port, localHost, ws, msg, localWsConnections, log);
      }

      if (msg.type === 'ws-message') {
        const localWs = localWsConnections.get(msg.connId);
        if (localWs && localWs.readyState === WebSocket.OPEN) {
          const buf = Buffer.from(msg.data, 'base64');
          localWs.send(buf, { binary: msg.binary });
        }
      }

      if (msg.type === 'ws-close') {
        const localWs = localWsConnections.get(msg.connId);
        if (localWs) {
          const code =
            msg.code &&
            msg.code >= 1000 &&
            msg.code <= 4999 &&
            msg.code !== 1005 &&
            msg.code !== 1006
              ? msg.code
              : 1000;
          safeClose(localWs, code, msg.reason || '');
          localWsConnections.delete(msg.connId);
        }
      }
    });

    ws.on('error', (err: Error) => {
      clearTimeout(timeout);
      log.warn(
        { component: 'tunnel_client', action: 'ws_error', port, error: err.message },
        `[ERROR] WebSocket error: ${err.message}`
      );
      if (onFirstError) {
        onFirstError(err);
        onFirstError = null;
      }
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
      }
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      for (const [, localWs] of localWsConnections) {
        safeClose(localWs);
      }
      localWsConnections.clear();

      if (closed) return;

      // Reconnect with exponential backoff
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);

      if (!registered && !everRegistered) {
        // This connect attempt never registered and we've never had a successful
        // registration — caller got the error via onFirstError, don't retry.
        log.warn(
          { component: 'tunnel_client', action: 'close_before_registration', port },
          `Tunnel closed before registration completed`
        );
        return;
      }

      log.info(
        { component: 'tunnel_client', action: 'reconnecting', port, delay, registered },
        `Tunnel disconnected, reconnecting in ${delay}ms`
      );
      setTimeout(() => connect(onRegistered, null), delay);
    });
  }

  return new Promise((resolve, reject) => {
    // Resolve which loopback address works before connecting
    resolveLocalHost(port).then((addr) => {
      localHost = addr;
      if (addr !== '127.0.0.1') {
        log.info(
          { component: 'tunnel_client', action: 'resolved_local_host', port, address: addr },
          `Using ${addr} for localhost:${port}`
        );
      }
      connect(
        (handle) => resolve(handle),
        (err) => reject(err)
      );
    });
  });
}

/**
 * Handle a WebSocket upgrade request from the tunnel server.
 * Uses the `ws` library to connect to the local server (avoids Bun segfault
 * with raw http.request() upgrade to self).
 */
function handleWsUpgrade(
  port: number,
  localAddr: string,
  controlWs: WebSocket,
  msg: TunnelWsUpgrade,
  localWsConnections: Map<number, WebSocket>,
  log: TunnelLogger
): void {
  const wsHost = localAddr.includes(':') ? `[${localAddr}]` : localAddr;
  const localWsUrl = `ws://${wsHost}:${port}${msg.path}`;

  // Forward the WebSocket subprotocol from the original browser request.
  // Vite 6.x requires "vite-hmr" — without it, the upgrade is silently ignored.
  const rawProtocol = msg.headers['sec-websocket-protocol'];
  const protocols = rawProtocol
    ? typeof rawProtocol === 'string'
      ? rawProtocol.split(',').map((p) => p.trim())
      : rawProtocol
    : [];

  log.info(
    { component: 'tunnel_client', action: 'ws_upgrade_start', connId: msg.connId, port, protocols },
    `[WS-RELAY] Connecting WebSocket to localhost:${port}`
  );

  // Mirror the HTTP relay: forward the browser's headers (notably the auth
  // cookie) and stamp x-forwarded-* so the local app can both authenticate the
  // upgrade and tell it arrived through the tunnel rather than from a genuine
  // loopback client. Strip the hop-by-hop handshake headers the ws library
  // sets itself (and sec-websocket-protocol, which is passed via `protocols`).
  const headers: Record<string, string | string[] | undefined> = { ...msg.headers };
  if (headers.host) {
    headers['x-forwarded-host'] = headers.host;
  }
  headers['x-forwarded-proto'] = 'https';
  headers.host = `localhost:${port}`;
  headers.origin = `http://localhost:${port}`;
  for (const hopByHop of [
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol',
  ]) {
    delete headers[hopByHop];
  }

  const localWs = new WebSocket(localWsUrl, protocols, { headers });

  const connectTimeout = setTimeout(() => {
    log.warn(
      { component: 'tunnel_client', action: 'ws_upgrade_timeout', connId: msg.connId },
      `[WS-RELAY] Connection timeout for connId=${msg.connId}`
    );
    safeClose(localWs);
    if (controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(
        JSON.stringify({
          type: 'ws-error',
          connId: msg.connId,
          error: 'Connection timeout',
        })
      );
    }
  }, 15000);

  localWs.on('open', () => {
    clearTimeout(connectTimeout);
    localWsConnections.set(msg.connId, localWs);

    log.info(
      { component: 'tunnel_client', action: 'ws_upgrade_success', connId: msg.connId },
      `[WS-RELAY] Connected, sending ws-ready for connId=${msg.connId}`
    );

    controlWs.send(
      JSON.stringify({
        type: 'ws-ready',
        connId: msg.connId,
      })
    );
  });

  localWs.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
    if (controlWs.readyState === WebSocket.OPEN) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      controlWs.send(
        JSON.stringify({
          type: 'ws-message',
          connId: msg.connId,
          data: buf.toString('base64'),
          binary: isBinary,
        })
      );
    }
  });

  localWs.on('close', (code: number, reason: Buffer) => {
    log.info(
      { component: 'tunnel_client', action: 'ws_relay_local_close', connId: msg.connId, code },
      `[WS-RELAY] Local WS closed connId=${msg.connId} code=${code}`
    );
    if (controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(
        JSON.stringify({
          type: 'ws-close',
          connId: msg.connId,
          code,
          reason: reason?.toString() || '',
        })
      );
    }
    localWsConnections.delete(msg.connId);
  });

  localWs.on('error', (err: Error) => {
    clearTimeout(connectTimeout);
    log.warn(
      {
        component: 'tunnel_client',
        action: 'ws_relay_error',
        connId: msg.connId,
        error: err.message,
      },
      `[WS-RELAY] Local WS error connId=${msg.connId}: ${err.message}`
    );
    if (controlWs.readyState === WebSocket.OPEN) {
      controlWs.send(
        JSON.stringify({
          type: 'ws-error',
          connId: msg.connId,
          error: err.message,
        })
      );
    }
    localWsConnections.delete(msg.connId);
  });
}

function send502(ws: WebSocket, reqId: number, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        type: 'response',
        reqId,
        status: 502,
        headers: { 'content-type': 'text/plain' },
        body: Buffer.from(`Local server error: ${message}`).toString('base64'),
      })
    );
  }
}

/**
 * Forward a tunneled request to the local server, streaming the response
 * back over the WebSocket as response-start / response-chunk / response-end.
 */
function forwardRequest(
  port: number,
  localAddr: string,
  msg: TunnelRequest,
  ws: WebSocket,
  activeRequests: Map<number, http.ClientRequest>,
  onConnRefused?: (err: NodeJS.ErrnoException) => Promise<boolean>
): http.ClientRequest {
  const headers: Record<string, string | string[] | undefined> = { ...msg.headers };
  // Preserve the original Host for apps that build redirect URLs from it (e.g. Clerk/Next.js)
  // Forward the original as X-Forwarded-Host so the app knows the public hostname
  if (headers.host) {
    headers['x-forwarded-host'] = headers.host;
  }
  headers['x-forwarded-proto'] = 'https';
  // Rewrite host so the target server accepts the request
  headers.host = `localhost:${port}`;
  // Rewrite origin and referer to localhost so the local app behaves as if
  // accessed directly. Prevents CSRF rejections from frameworks that check origin.
  const localOrigin = `http://localhost:${port}`;
  if (typeof headers.origin === 'string' && !headers.origin.includes('localhost')) {
    headers.origin = localOrigin;
  }
  if (typeof headers.referer === 'string' && !headers.referer.includes('localhost')) {
    try {
      const ref = new URL(headers.referer);
      headers.referer = `${localOrigin}${ref.pathname}${ref.search}${ref.hash}`;
    } catch {
      headers.referer = localOrigin;
    }
  }
  // Remove headers that shouldn't be forwarded
  delete headers['transfer-encoding'];

  const req = http.request(
    {
      hostname: localAddr,
      port,
      path: msg.path,
      method: msg.method,
      headers: headers as http.OutgoingHttpHeaders,
    },
    (res) => {
      // Send headers immediately
      const responseHeaders: Record<string, string | string[] | undefined> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        responseHeaders[key] = value;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'response-start',
            reqId: msg.reqId,
            status: res.statusCode ?? 200,
            headers: responseHeaders,
          })
        );
      }

      // Stream body chunks
      res.on('data', (chunk: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'response-chunk',
              reqId: msg.reqId,
              data: chunk.toString('base64'),
            })
          );
        }
      });

      // Signal completion
      res.on('end', () => {
        activeRequests.delete(msg.reqId);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'response-end', reqId: msg.reqId }));
        }
      });
    }
  );

  req.on('error', (err: NodeJS.ErrnoException) => {
    activeRequests.delete(msg.reqId);

    // If ECONNREFUSED and caller wants to retry with re-resolved address, let them
    if (onConnRefused && err.code === 'ECONNREFUSED') {
      onConnRefused(err).then((retried) => {
        if (retried) return; // caller handled it
        send502(ws, msg.reqId, err.message);
      });
      return;
    }

    send502(ws, msg.reqId, err.message);
  });

  if (msg.body) {
    req.end(Buffer.from(msg.body, 'base64'));
  } else {
    req.end();
  }

  return req;
}

// ============================================================================
// CLI entry point — `bun run tunnel-client.ts --port 3000 [--host URL] [--tunnel-id ID]`
// Prints the public URL to stdout, stays alive until SIGTERM/SIGINT.
// ============================================================================

/** A compact, copy-friendly connection banner for the CLI. Written to stderr so
 *  stdout stays just the URL (scripts pipe it). Exported for testing. */
export function formatConnectBanner(url: string, port: number): string {
  return [
    '',
    '  🚇  Tunnel live',
    `      ${url}`,
    `      → forwarding to localhost:${port}`,
    '      Ctrl+C to stop',
    '',
  ].join('\n');
}

/** Best-effort terminal QR of the URL (handy for opening on a phone). Uses the
 *  optional `qrcode-terminal` dependency; silently skipped if it isn't present.
 *  The non-literal import specifier keeps this typecheck-clean without types. */
async function renderQr(url: string, write: (s: string) => void): Promise<void> {
  try {
    const spec = 'qrcode-terminal';
    const mod = await import(spec);
    const qr = (mod.default ?? mod) as {
      generate: (text: string, opts: { small?: boolean }, cb: (out: string) => void) => void;
    };
    await new Promise<void>((resolve) => {
      qr.generate(url, { small: true }, (out: string) => {
        write('\n' + out + '\n');
        resolve();
      });
    });
  } catch {
    /* optional dep absent → URL banner only */
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  function flag(name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  }

  const port = Number(flag('port'));
  if (!port) {
    console.error(
      'Usage: bun run tunnel-client.ts --port <port> [--host <url>] [--tunnel-id <id>] [--auth-not-required] [--basic-auth user:pass] [--no-qr]'
    );
    process.exit(1);
  }

  // Default to the Cloudflare Workers + Durable Objects relay. The old Fly relay
  // (vgit-tunnels.volterapp.com) returns HTTP 200 instead of 101 on HTTP/2
  // WebSocket upgrades, which breaks browser-based flows (e.g. QA proofs).
  const host =
    flag('host') ||
    process.env.TUNNEL_SERVER_URL ||
    'https://volter-tunnel.aaron-0ed.workers.dev';
  const secret = process.env.TUNNEL_SECRET;
  const tunnelId = flag('tunnel-id');
  const authNotRequired = args.includes('--auth-not-required');

  // CLI logger: send to stderr so only the URL goes to stdout
  const cliLogger: TunnelLogger = {
    info(_obj, msg) {
      console.error(msg);
    },
    warn(_obj, msg) {
      console.error(msg);
    },
    debug(_obj, msg) {
      console.error(msg);
    },
  };

  const opts: TunnelOptions = { port, host, logger: cliLogger };
  if (secret) opts.secret = secret;
  if (tunnelId) opts.tunnelId = tunnelId;
  if (authNotRequired) opts.authRequired = false;
  const basicAuthArg = flag('basic-auth'); // "user:pass"
  if (basicAuthArg) {
    const i = basicAuthArg.indexOf(':');
    if (i > 0) opts.basicAuth = { user: basicAuthArg.slice(0, i), pass: basicAuthArg.slice(i + 1) };
  }
  const handle = await createTunnel(opts);
  console.log(handle.url); // stdout stays machine-readable (just the URL)

  // Human-facing connection banner + optional QR → stderr, only on a real TTY
  // (so piped/non-interactive use stays clean).
  if (process.stderr.isTTY) {
    process.stderr.write(formatConnectBanner(handle.url, port) + '\n');
    if (!args.includes('--no-qr')) await renderQr(handle.url, (s) => process.stderr.write(s));
  }

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
