/**
 * TunnelDO — one Durable Object per tunnelId.
 *
 * Holds the tunnel client's control WebSocket (hibernatable) and relays inbound
 * HTTP requests and browser WebSocket connections over it, using the same wire
 * protocol as server/server.mjs. Because there is exactly one DO per tunnelId
 * (Worker routes via idFromName(tunnelId)), the multi-tenant `clients` Map from
 * server.mjs collapses to "the one control socket this DO holds".
 *
 * Hibernation model: WebSockets + their serialized attachments survive eviction
 * (re-fetched via ctx.getWebSockets(tag)). In-memory correlation maps only need
 * to live for the duration of a single awaited fetch (the DO stays resident while
 * a request is in flight), so request/upgrade correlation uses instance maps.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  type Env,
  buildResponseHeaders,
  cookieFor,
  corsHeaders,
  stripAuthCookie,
  stripTokenParam,
  validateAuth,
  validateWsAuth,
} from './auth';

interface CtlAttach {
  role: 'ctl';
  registered: boolean;
  authRequired: boolean;
  tunnelId: string;
}
interface BrowserAttach {
  role: 'browser';
  connId: string;
}

interface PendingHttp {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  request: Request;
  bootstrapCookie: string | null;
}
interface Streaming {
  controller: ReadableStreamDefaultController<Uint8Array>;
  idle: ReturnType<typeof setTimeout>;
}
interface PendingUpgrade {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64decode(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * Clamp a WebSocket close reason to 123 UTF-8 bytes (a control frame's reason is
 * capped at 125 bytes minus the 2-byte code). close() throws RangeError otherwise
 * — server.mjs added this guard after one oversized relayed reason crash-looped
 * the whole relay. Drops a trailing replacement char from a severed sequence.
 */
function truncateReason(value: unknown): string {
  const s = String(value ?? '');
  const enc = new TextEncoder().encode(s);
  if (enc.length <= 123) return s;
  return new TextDecoder().decode(enc.subarray(0, 123)).replace(/�+$/, '');
}

/** Constant-time string compare for the shared secret (avoids early-exit timing). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class TunnelDO extends DurableObject<Env> {
  private pendingHttp = new Map<string, PendingHttp>();
  private streaming = new Map<string, Streaming>();
  private pendingUpgrades = new Map<string, PendingUpgrade>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    // Control channel: the tunnel client connects to /ws?id=<tunnelId>.
    if (url.pathname === '/ws') {
      if (upgrade !== 'websocket') return new Response('expected websocket', { status: 426 });
      return this.acceptControl(url);
    }

    // Browser-side WebSocket upgrade on a tunnel subdomain.
    if (upgrade === 'websocket') return this.handleBrowserWsUpgrade(request, url);

    // Plain HTTP data request.
    return this.handleHttpRequest(request, url);
  }

  // ── control socket helpers ────────────────────────────────────────────────
  private ctl(): WebSocket | null {
    const arr = this.ctx.getWebSockets('ctl');
    return arr.length ? (arr[0] as WebSocket) : null;
  }
  private ctlAttach(): CtlAttach | null {
    const ws = this.ctl();
    return ws ? (ws.deserializeAttachment() as CtlAttach) : null;
  }

  private acceptControl(url: URL): Response {
    // The Worker routed us via idFromName(?id=), so ?id= is the authoritative
    // tunnelId for this DO — capture it so the registered URL always matches the
    // subdomain the browser actually reaches (don't trust msg.tunnelId blindly).
    const id = url.searchParams.get('id') || '';
    const { 0: client, 1: server } = new WebSocketPair();
    const attach: CtlAttach = { role: 'ctl', registered: false, authRequired: true, tunnelId: id };
    server.serializeAttachment(attach);
    this.ctx.acceptWebSocket(server, ['ctl']);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── inbound HTTP ──────────────────────────────────────────────────────────
  private async handleHttpRequest(request: Request, url: URL): Promise<Response> {
    // Answer CORS preflight BEFORE the connectivity check (mirrors server.mjs) so
    // a momentarily-down tunnel doesn't surface a CORS error to the browser.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const ctl = this.ctl();
    const attach = this.ctlAttach();
    if (!ctl || !attach?.registered) {
      return new Response('Tunnel not connected', { status: 502, headers: corsHeaders(request) });
    }

    let bootstrapCookie: string | null = null;
    if (attach.authRequired && this.env.JWT_SECRET) {
      const auth = await validateAuth(request, url, this.env.JWT_SECRET);
      if (!auth) {
        return Response.json(
          { error: 'Authentication required' },
          { status: 401, headers: corsHeaders(request) }
        );
      }
      if (auth.source === 'query') bootstrapCookie = cookieFor(auth.token, this.env.TUNNEL_DOMAIN);
    }

    const forwardPath = stripTokenParam(url.pathname + url.search);
    const forwardHeaders = stripAuthCookie(headersToObject(request.headers));
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const bodyBytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : null;

    // A DO WebSocket frame is capped at 1 MiB and base64 inflates ~33%; the whole
    // body goes in one `request` frame. Reject oversized bodies fast with 413
    // instead of letting ctl.send throw and the request hang to the 30s timeout.
    if (bodyBytes && bodyBytes.length > 750_000) {
      return new Response('Request body too large to tunnel (limit ~750KB)', {
        status: 413,
        headers: corsHeaders(request),
      });
    }

    const reqId = crypto.randomUUID();
    return await new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(reqId);
        this.streaming.delete(reqId);
        resolve(new Response('Tunnel timeout', { status: 504, headers: corsHeaders(request) }));
      }, 30000);
      this.pendingHttp.set(reqId, { resolve, timer, request, bootstrapCookie });
      try {
        ctl.send(
          JSON.stringify({
            type: 'request',
            reqId,
            method: request.method,
            path: forwardPath,
            headers: forwardHeaders,
            body: bodyBytes && bodyBytes.length ? b64encode(bodyBytes) : null,
          })
        );
      } catch {
        clearTimeout(timer);
        this.pendingHttp.delete(reqId);
        resolve(new Response('Tunnel send failed', { status: 502, headers: corsHeaders(request) }));
      }
    });
  }

  // ── inbound browser WebSocket ─────────────────────────────────────────────
  private async handleBrowserWsUpgrade(request: Request, url: URL): Promise<Response> {
    const ctl = this.ctl();
    const attach = this.ctlAttach();
    if (!ctl || !attach?.registered) return new Response('Tunnel not connected', { status: 502 });

    if (attach.authRequired && this.env.JWT_SECRET) {
      if (!(await validateWsAuth(request, url, this.env.JWT_SECRET))) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const connId = crypto.randomUUID();
    const { 0: client, 1: server } = new WebSocketPair();
    server.serializeAttachment({ role: 'browser', connId } satisfies BrowserAttach);
    this.ctx.acceptWebSocket(server, ['browser', `c:${connId}`]);

    const cleanPath = stripTokenParam(url.pathname + url.search);
    const forwardHeaders = stripAuthCookie(headersToObject(request.headers));

    // Await ws-ready BEFORE returning 101 — so the browser's socket only opens
    // once the local end is connected. This removes the message-buffering dance
    // that server.mjs needs (it can't delay its upgrade).
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingUpgrades.delete(connId);
        reject(new Error('ws-upgrade timeout'));
      }, 15000);
      this.pendingUpgrades.set(connId, { resolve, reject, timer });
    });
    ctl.send(JSON.stringify({ type: 'ws-upgrade', connId, path: cleanPath, headers: forwardHeaders }));
    try {
      await ready;
    } catch {
      try {
        server.close(1011, 'tunnel timeout');
      } catch {
        /* already gone */
      }
      return new Response('tunnel timeout', { status: 504 });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── hibernation handlers ──────────────────────────────────────────────────
  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const attach = ws.deserializeAttachment() as CtlAttach | BrowserAttach | null;

    // Raw browser frame → forward to control as ws-message.
    if (attach?.role === 'browser') {
      const ctl = this.ctl();
      if (!ctl) return;
      const binary = typeof data !== 'string';
      const bytes = binary ? new Uint8Array(data as ArrayBuffer) : new TextEncoder().encode(data as string);
      ctl.send(
        JSON.stringify({ type: 'ws-message', connId: attach.connId, data: b64encode(bytes), binary })
      );
      return;
    }

    // Control channel JSON message.
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    this.onControlMessage(ws, msg);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attach = ws.deserializeAttachment() as CtlAttach | BrowserAttach | null;
    if (attach?.role === 'browser') {
      const ctl = this.ctl();
      if (ctl) {
        try {
          ctl.send(JSON.stringify({ type: 'ws-close', connId: attach.connId }));
        } catch {
          /* control gone */
        }
      }
      return;
    }
    // Control socket gone → tear down EVERYTHING for this tunnel (mirrors
    // server.mjs:751-794): close browser relays, fail pending requests/upgrades,
    // error open streams. Without this, a client disconnect mid-stream leaks hung
    // browser connections and never-resolving responses.
    for (const b of this.ctx.getWebSockets('browser')) {
      try {
        (b as WebSocket).close(1001, 'Tunnel disconnected');
      } catch {
        /* ignore */
      }
    }
    for (const [, p] of this.pendingHttp) {
      clearTimeout(p.timer);
      try {
        p.resolve(new Response('Tunnel disconnected', { status: 502 }));
      } catch {
        /* already resolved */
      }
    }
    this.pendingHttp.clear();
    for (const [, s] of this.streaming) {
      clearTimeout(s.idle);
      try {
        s.controller.error(new Error('Tunnel disconnected'));
      } catch {
        /* already closed */
      }
    }
    this.streaming.clear();
    for (const [, p] of this.pendingUpgrades) {
      clearTimeout(p.timer);
      p.reject(new Error('Tunnel disconnected'));
    }
    this.pendingUpgrades.clear();
  }

  /** Idle watchdog for a streaming response — if the client stalls without sending
   *  response-end, error the stream and tell the client to abort. Reset per chunk. */
  private armStreamIdle(reqId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const s = this.streaming.get(reqId);
      if (!s) return;
      this.streaming.delete(reqId);
      try {
        s.controller.error(new Error('stream idle timeout'));
      } catch {
        /* already closed */
      }
      const ctl = this.ctl();
      if (ctl) {
        try {
          ctl.send(JSON.stringify({ type: 'request-abort', reqId }));
        } catch {
          /* control gone */
        }
      }
    }, 120000);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ── control protocol ──────────────────────────────────────────────────────
  private onControlMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'register') {
      if (this.env.TUNNEL_SECRET && !safeEqual(String(msg.secret ?? ''), this.env.TUNNEL_SECRET)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid tunnel secret' }));
        ws.close(4003, 'Invalid tunnel secret');
        return;
      }
      const others = this.ctx
        .getWebSockets('ctl')
        .filter((w) => w !== ws && (w.deserializeAttachment() as CtlAttach | null)?.registered);
      if (others.length) {
        if (msg.replace) {
          for (const w of others) (w as WebSocket).close(4001, 'Replaced by new client');
        } else {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: `Tunnel ID '${msg.tunnelId}' is already in use by another client. Pass { replace: true } to take over.`,
            })
          );
          ws.close(4002, 'Tunnel ID already in use');
          return;
        }
      }

      // Prefer the ?id= captured at accept (authoritative — it's how the Worker
      // routed to this DO); fall back to msg.tunnelId, then a random id.
      const existing = ws.deserializeAttachment() as CtlAttach | null;
      const tunnelId =
        existing?.tunnelId || (msg.tunnelId as string) || crypto.randomUUID().slice(0, 8);
      const authRequired = msg.authRequired !== false;
      ws.serializeAttachment({ role: 'ctl', registered: true, authRequired, tunnelId } satisfies CtlAttach);
      const url = `https://${tunnelId}.${this.env.TUNNEL_DOMAIN}`;
      ws.send(JSON.stringify({ type: 'registered', tunnelId, url }));
      return;
    }

    if (type === 'response') {
      const pending = this.pendingHttp.get(msg.reqId as string);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingHttp.delete(msg.reqId as string);
      const headers = buildResponseHeaders(
        (msg.headers as Record<string, string>) || {},
        pending.request,
        pending.bootstrapCookie
      );
      const body = msg.body ? b64decode(msg.body as string) : null;
      pending.resolve(new Response(body, { status: (msg.status as number) || 200, headers }));
      return;
    }

    if (type === 'response-start') {
      const pending = this.pendingHttp.get(msg.reqId as string);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingHttp.delete(msg.reqId as string);
      const reqId = msg.reqId as string;
      const headers = buildResponseHeaders(
        (msg.headers as Record<string, string>) || {},
        pending.request,
        pending.bootstrapCookie
      );
      const self = this;
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          self.streaming.set(reqId, { controller, idle: self.armStreamIdle(reqId) });
        },
        cancel() {
          const s = self.streaming.get(reqId);
          if (s) clearTimeout(s.idle);
          self.streaming.delete(reqId);
          const ctl = self.ctl();
          if (ctl) {
            try {
              ctl.send(JSON.stringify({ type: 'request-abort', reqId }));
            } catch {
              /* control gone */
            }
          }
        },
      });
      pending.resolve(new Response(readable, { status: (msg.status as number) || 200, headers }));
      return;
    }

    if (type === 'response-chunk') {
      const s = this.streaming.get(msg.reqId as string);
      if (s) {
        try {
          s.controller.enqueue(b64decode(msg.data as string));
          clearTimeout(s.idle);
          s.idle = this.armStreamIdle(msg.reqId as string);
        } catch {
          clearTimeout(s.idle);
          this.streaming.delete(msg.reqId as string);
        }
      }
      return;
    }

    if (type === 'response-end') {
      const s = this.streaming.get(msg.reqId as string);
      if (s) {
        clearTimeout(s.idle);
        this.streaming.delete(msg.reqId as string);
        try {
          s.controller.close();
        } catch {
          /* already closed */
        }
      }
      return;
    }

    if (type === 'ws-ready') {
      const p = this.pendingUpgrades.get(msg.connId as string);
      if (p) {
        clearTimeout(p.timer);
        this.pendingUpgrades.delete(msg.connId as string);
        p.resolve();
      }
      return;
    }

    if (type === 'ws-error') {
      const p = this.pendingUpgrades.get(msg.connId as string);
      if (p) {
        clearTimeout(p.timer);
        this.pendingUpgrades.delete(msg.connId as string);
        p.reject(new Error((msg.error as string) || 'Tunnel error'));
      }
      return;
    }

    if (type === 'ws-message') {
      // control → browser
      const arr = this.ctx.getWebSockets(`c:${msg.connId}`);
      const browser = arr.length ? (arr[0] as WebSocket) : null;
      if (browser) {
        try {
          const bytes = b64decode(msg.data as string);
          browser.send(msg.binary ? bytes : new TextDecoder().decode(bytes));
        } catch {
          /* malformed frame — drop it, keep the relay alive */
        }
      }
      return;
    }

    if (type === 'ws-close') {
      const arr = this.ctx.getWebSockets(`c:${msg.connId}`);
      const browser = arr.length ? (arr[0] as WebSocket) : null;
      if (browser) {
        const raw = msg.code as number | undefined;
        const code = raw && raw >= 1000 && raw <= 4999 && raw !== 1005 && raw !== 1006 ? raw : 1000;
        try {
          browser.close(code, truncateReason(msg.reason));
        } catch {
          /* ignore */
        }
      }
      return;
    }
  }
}
