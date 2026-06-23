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
      return this.acceptControl();
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

  private acceptControl(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    const attach: CtlAttach = { role: 'ctl', registered: false, authRequired: true, tunnelId: '' };
    server.serializeAttachment(attach);
    this.ctx.acceptWebSocket(server, ['ctl']);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── inbound HTTP ──────────────────────────────────────────────────────────
  private async handleHttpRequest(request: Request, url: URL): Promise<Response> {
    const ctl = this.ctl();
    const attach = this.ctlAttach();
    if (!ctl || !attach?.registered) {
      return new Response('Tunnel not connected', { status: 502 });
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
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

    const reqId = crypto.randomUUID();
    return await new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(reqId);
        this.streaming.delete(reqId);
        resolve(new Response('Tunnel timeout', { status: 504 }));
      }, 30000);
      this.pendingHttp.set(reqId, { resolve, timer, request, bootstrapCookie });
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
      if (ctl) ctl.send(JSON.stringify({ type: 'ws-close', connId: attach.connId }));
      return;
    }
    // Control socket gone → tear down all browser relays.
    for (const b of this.ctx.getWebSockets('browser')) {
      try {
        (b as WebSocket).close(1001, 'Tunnel disconnected');
      } catch {
        /* ignore */
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  // ── control protocol ──────────────────────────────────────────────────────
  private onControlMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'register') {
      if (this.env.TUNNEL_SECRET && msg.secret !== this.env.TUNNEL_SECRET) {
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

      const tunnelId = (msg.tunnelId as string) || crypto.randomUUID().slice(0, 8);
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
          self.streaming.set(reqId, { controller });
        },
        cancel() {
          self.streaming.delete(reqId);
          const ctl = self.ctl();
          if (ctl) ctl.send(JSON.stringify({ type: 'request-abort', reqId }));
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
        } catch {
          this.streaming.delete(msg.reqId as string);
        }
      }
      return;
    }

    if (type === 'response-end') {
      const s = this.streaming.get(msg.reqId as string);
      if (s) {
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
        const bytes = b64decode(msg.data as string);
        browser.send(msg.binary ? bytes : new TextDecoder().decode(bytes));
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
          browser.close(code, (msg.reason as string) || '');
        } catch {
          /* ignore */
        }
      }
      return;
    }
  }
}
