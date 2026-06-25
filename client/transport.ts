/**
 * Client transport — the relay/local-socket mechanics behind createTunnel: HTTP
 * request forwarding, browser-WebSocket bridging, loopback resolution, and
 * graceful socket close (never RST the local server). Pure plumbing; the SDK
 * (./tunnel-client) orchestrates these over the control connection.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import WebSocket from 'ws';
import type { CorrelationId, RequestMsg, WsUpgradeMsg } from '@volter/tunnel-core';
import type { TunnelLogger } from './types';

/**
 * Force HTTP/1.1 for the (TLS) control WebSocket — HTTP/2 breaks the Upgrade
 * handshake. Only applies to wss:// (an https.Agent rejects a plain ws:// URL),
 * so it's used conditionally; plain ws:// (e.g. a local relay) needs no agent.
 */
export const http1Agent = new https.Agent({ ALPNProtocols: ['http/1.1'] });

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
export function safeClose(ws: WebSocket, code?: number, reason?: string): void {
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

/**
 * Resolve which loopback address can reach a given port.
 * Tries 127.0.0.1 (IPv4) first, then ::1 (IPv6).
 * Returns the working address, or '127.0.0.1' as default.
 */
export async function resolveLocalHost(port: number): Promise<string> {
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

/**
 * Handle a WebSocket upgrade request from the tunnel server.
 * Uses the `ws` library to connect to the local server (avoids Bun segfault
 * with raw http.request() upgrade to self).
 */
export function handleWsUpgrade(
  port: number,
  localAddr: string,
  controlWs: WebSocket,
  msg: WsUpgradeMsg,
  localWsConnections: Map<CorrelationId, WebSocket>,
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

function send502(ws: WebSocket, reqId: CorrelationId, message: string): void {
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
export function forwardRequest(
  port: number,
  localAddr: string,
  msg: RequestMsg,
  ws: WebSocket,
  activeRequests: Map<CorrelationId, http.ClientRequest>,
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
