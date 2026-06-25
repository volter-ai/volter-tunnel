/**
 * @volter/tunnel client SDK — createTunnel(), the embeddable library that exposes
 * a local port through the relay. Orchestrates the control WebSocket (register,
 * reconnect/backoff) and delegates request/WS forwarding to ./transport. The CLI
 * bin is ./cli.ts; the wire protocol is @volter/tunnel-core.
 */
import http from 'node:http';
import WebSocket from 'ws';
import type { CorrelationId, RelayToClient } from '@volter/tunnel-core';
import { forwardRequest, handleWsUpgrade, http1Agent, resolveLocalHost, safeClose } from './transport';
import type { TunnelHandle, TunnelLogger, TunnelOptions } from './types';

export type { TunnelHandle, TunnelLogger, TunnelOptions } from './types';
export { VolterApiError, VolterClient, type AccountUsage, type Me, type VolterClientOptions } from './api';

/** Default relay (Cloudflare Workers + Durable Objects). */
export const DEFAULT_HOST = 'https://volter-tunnel.aaron-0ed.workers.dev';

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
    const localWsConnections = new Map<CorrelationId, WebSocket>();
    // Track active HTTP requests for abort support: reqId → http.ClientRequest
    const activeRequests = new Map<CorrelationId, http.ClientRequest>();

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
      let msg: RelayToClient;
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
