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
  type HeaderRules,
  buildResponseHeaders,
  cookieFor,
  corsHeaders,
  parseHeaderRules,
  stripAuthCookie,
  stripTokenParam,
  validateAuth,
  validateWsAuth,
} from './auth';
import { CREDIT_WEIGHTS, hashToken, parseToken, type UsageDelta } from './credits';
import { envNum, reservationDecision } from './metering-types';
import type { AuthorizeResult, LeaseResult, RateSnapshot, Reservation } from './metering-types';

interface CtlAttach {
  role: 'ctl';
  registered: boolean;
  authRequired: boolean;
  tunnelId: string;
  /** Account this tunnel meters against — set at register, survives hibernation. */
  slug?: string;
  /** Credits granted per lease top-up (from the account config). */
  leaseChunk?: number;
  /** Date.now() at register — tunnel-seconds are billed from here on close. */
  openedAt?: number;
  /** Registration nonce — disambiguates this socket's account entry from a
   *  replacement's, so a superseded socket's close can't clobber the new owner. */
  regId?: string;
  /** Re-authorize inputs (so a reaped-but-live tunnel can re-register its entry). */
  legacy?: boolean;
  tokenHash?: string;
  /** SHA-256 of "user:pass" when the tunnel is gated by HTTP Basic Auth (#6). */
  basicAuthHash?: string;
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
  /** RateLimit-* headers captured at request time, applied to the response. */
  rate: Record<string, string>;
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

/** One captured request for the live inspector (#5). Metadata only — no bodies
 *  or headers; persistence/replay is the paid #10. In-memory, so the buffer is
 *  lost on hibernation (fine for a live view of an actively-used tunnel). */
interface InspectEntry {
  t: number;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  bytes: number | null;
}

/** Charge relayed messages (stream chunks / WS frames) in batches of this many,
 *  keeping the per-frame path cheap. Caps unmetered overshoot at one batch. */
const MSG_FLUSH_EVERY = 32;

/** Max requests retained in the live inspector ring (#5). */
const INSPECT_CAP = 50;

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

  /** Operator response-header rewrite rules (parsed once from env). */
  private _headerRules: HeaderRules | null = null;
  private get headerRules(): HeaderRules {
    return (this._headerRules ??= parseHeaderRules(this.env.RESPONSE_HEADER_RULES));
  }

  /** Live request inspector ring (#5; in-memory, lost on hibernation). */
  private inspect: InspectEntry[] = [];
  private inspectByReq = new Map<string, InspectEntry>();

  /** Record a request as it starts; trims the ring to INSPECT_CAP. */
  private pushInspect(reqId: string, method: string, path: string): void {
    const e: InspectEntry = { t: Date.now(), method, path, status: null, ms: null, bytes: null };
    this.inspect.push(e);
    if (this.inspect.length > INSPECT_CAP) this.inspect.shift();
    this.inspectByReq.set(reqId, e);
  }
  /** Fill in a request's outcome (status, latency, response size) on completion. */
  private finishInspect(reqId: string, status: number, bytes: number | null): void {
    const e = this.inspectByReq.get(reqId);
    if (!e) return;
    e.status = status;
    e.ms = Date.now() - e.t;
    e.bytes = bytes;
    this.inspectByReq.delete(reqId);
  }

  // ── metering state (ephemeral; safe to lose on hibernation) ────────────────
  /** Credits leased from the account but not yet spent. */
  private budget = 0;
  /** Credits spent since the last lease/close flush to the account. */
  private consumedSinceCommit = 0;
  /** Raw usage (for dashboards) accumulated since the last flush. */
  private rawSinceFlush: UsageDelta = { requests: 0, wsUpgrades: 0, bytes: 0, seconds: 0 };
  /** Serializes budget mutations so concurrent requests don't double-lease. */
  private budgetChain: Promise<unknown> = Promise.resolve();
  /** Latest limit snapshot from the account (for RateLimit headers + quota push). */
  private rate: RateSnapshot | null = null;
  /** Last quota level pushed to the client — only re-push on change. */
  private lastQuotaLevel: string | null = null;
  /** Relayed DO messages (response chunks + WS frames) not yet charged. Flushed
   *  in batches so the per-frame path stays cheap; bounds unmetered overshoot. */
  private msgsSinceFlush = 0;

  private accountStub(slug?: string): DurableObjectStub | null {
    const s = slug ?? this.ctlAttach()?.slug;
    if (!s) return null;
    return this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName(s));
  }

  /** RPC to the account DO. `slug` is required at register (before the slug is in
   *  the attachment); afterwards it's read from the attachment. */
  private async accountRpc<T>(
    path: string,
    payload: Record<string, unknown>,
    slug?: string
  ): Promise<T | null> {
    const stub = this.accountStub(slug ?? (payload.slug as string | undefined));
    if (!stub) return null;
    try {
      const res = await stub.fetch(`https://account${path}`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private takeRaw(): UsageDelta {
    const r = this.rawSinceFlush;
    this.rawSinceFlush = { requests: 0, wsUpgrades: 0, bytes: 0, seconds: 0 };
    return r;
  }

  /** Record the latest account snapshot and, on a level change, push a `quota`
   *  frame to the client so the CLI/gateway can warn before the hard cutoff. */
  private applyRate(rate: RateSnapshot | undefined): void {
    if (!rate) return;
    this.rate = rate;
    if (rate.level !== this.lastQuotaLevel) {
      this.lastQuotaLevel = rate.level;
      const ctl = this.ctl();
      if (ctl) {
        try {
          ctl.send(JSON.stringify({ type: 'quota', level: rate.level, day: rate.day, month: rate.month }));
        } catch {
          /* control gone */
        }
      }
    }
  }

  /** IETF RateLimit-* headers (draft-ietf-httpapi-ratelimit-headers) for the
   *  binding daily window. `reset` is seconds until refill. */
  private rateHeaders(): Record<string, string> {
    if (!this.rate) return {};
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      'ratelimit-limit': String(this.rate.day.limit),
      'ratelimit-remaining': String(Math.max(0, this.rate.day.remaining)),
      'ratelimit-reset': String(Math.max(1, this.rate.day.reset - nowSec)),
    };
  }

  /** Seconds until the binding window refills — for Retry-After on a 429. */
  private retryAfterSeconds(): number {
    if (!this.rate) return 60;
    const nowSec = Math.floor(Date.now() / 1000);
    const dayOut = this.rate.day.remaining <= 0;
    const reset = dayOut ? this.rate.day.reset : this.rate.month.reset;
    return Math.max(1, reset - nowSec);
  }

  /**
   * Pre-authorize `cost` credits before relaying. Spends from the local lease;
   * tops the lease up from the account when short. Returns false (→ 429) when the
   * account has no budget left — the hard cutoff that bounds spend. Fail-closed:
   * an unreachable account yields no grant, so traffic stops rather than runs free.
   */
  private ensureBudget(cost: number): Promise<boolean> {
    const run = this.budgetChain.then(async () => {
      if (this.budget >= cost) {
        this.budget -= cost;
        this.consumedSinceCommit += cost;
        return true;
      }
      const attach = this.ctlAttach();
      const tunnelId = attach?.tunnelId ?? '';
      const want = Math.max(attach?.leaseChunk ?? 50, cost);
      let res = await this.accountRpc<LeaseResult>('/lease', {
        tunnelId,
        regId: attach?.regId,
        want,
        commit: this.consumedSinceCommit,
        raw: this.takeRaw(),
      });
      this.consumedSinceCommit = 0;
      // The account reaped our (idle) entry → re-register it and retry once so a
      // still-connected tunnel self-heals instead of getting wedged at 0 budget.
      if (res?.notOpen && (await this.reauthorize())) {
        res = await this.accountRpc<LeaseResult>('/lease', {
          tunnelId,
          regId: this.ctlAttach()?.regId,
          want,
          commit: 0,
          raw: this.takeRaw(),
        });
      }
      this.applyRate(res?.rate);
      this.budget += res?.grant ?? 0;
      if (this.budget >= cost) {
        this.budget -= cost;
        this.consumedSinceCommit += cost;
        return true;
      }
      return false;
    });
    this.budgetChain = run.catch(() => {});
    return run;
  }

  /** Re-authorize this tunnel's account entry after a reap. Runs inside the budget
   *  chain (callers already hold it). True if the account re-accepted the tunnel. */
  private async reauthorize(): Promise<boolean> {
    const a = this.ctlAttach();
    if (!a?.slug || !a.regId) return false;
    const auth = await this.accountRpc<AuthorizeResult>('/authorize', {
      slug: a.slug,
      legacy: a.legacy,
      tokenHash: a.tokenHash,
      tunnelId: a.tunnelId,
      regId: a.regId,
    });
    return !!auth?.ok;
  }

  /** Charge one relayed-message op. Fast path: spend from the locally-held lease
   *  synchronously (no await, atomic in the single-threaded DO). Slow path (local
   *  budget exhausted): await a top-up from the account. Returns false when the
   *  account is out of budget — the caller must then cut the traffic off. This is
   *  the synchronous gate the floodable browser-frame path needs so it can never
   *  relay unmetered while an async charge is in flight. */
  private async chargeMessage(): Promise<boolean> {
    const cost = CREDIT_WEIGHTS.message;
    if (this.budget >= cost) {
      this.budget -= cost;
      this.consumedSinceCommit += cost;
      return true;
    }
    return this.ensureBudget(cost);
  }

  /** Charge the batch of relayed CONTROL messages accrued since the last flush. On
   *  exhaustion, cut the chatty traffic off by closing the browser sockets
   *  (the control socket stays so the client can re-auth after the reset). */
  private async flushMessages(): Promise<void> {
    const n = this.msgsSinceFlush;
    if (n <= 0) return;
    this.msgsSinceFlush = 0;
    const ok = await this.ensureBudget(n * CREDIT_WEIGHTS.message);
    if (!ok) {
      this.applyRate(this.rate ?? undefined); // ensure an 'exceeded' quota push
      for (const b of this.ctx.getWebSockets('browser')) {
        try {
          (b as WebSocket).close(1011, 'Account quota exceeded');
        } catch {
          /* already gone */
        }
      }
    }
  }

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

  /** Validate an Authorization: Basic header against the stored "user:pass" hash
   *  (#6). Constant-time on the hash; returns false on any missing/malformed input. */
  private async checkBasicAuth(request: Request, expectedHash: string): Promise<boolean> {
    const h = request.headers.get('authorization');
    if (!h || !h.startsWith('Basic ')) return false;
    let decoded: string;
    try {
      decoded = atob(h.slice(6).trim());
    } catch {
      return false;
    }
    return safeEqual(await hashToken(decoded), expectedHash);
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

    // Basic-auth gate (#6): if the tunnel was registered with credentials, every
    // inbound request must present a matching Authorization: Basic header before
    // anything is served or forwarded (independent of the JWT layer below).
    if (attach.basicAuthHash && !(await this.checkBasicAuth(request, attach.basicAuthHash))) {
      return new Response('Authentication required', {
        status: 401,
        headers: {
          ...corsHeaders(request),
          'www-authenticate': 'Basic realm="volter-tunnel"',
        },
      });
    }

    let bootstrapCookie: string | null = null;
    if (attach.authRequired && this.env.JWT_SECRET) {
      const auth = await validateAuth(request, url, this.env.JWT_SECRET, {
        tunnelId: attach.tunnelId,
        requireTid: this.env.REQUIRE_TID === 'true',
      });
      if (!auth) {
        return Response.json(
          { error: 'Authentication required' },
          { status: 401, headers: corsHeaders(request) }
        );
      }
      if (auth.source === 'query') bootstrapCookie = cookieFor(auth.token, this.env.TUNNEL_DOMAIN);
    }

    // Live request inspector (#5): recent request metadata, served on a reserved
    // path (never forwarded) and gated by the same auth as the tunnel above.
    if (url.pathname === '/__volter_inspect') {
      return Response.json(
        { tunnelId: attach.tunnelId, entries: this.inspect },
        { headers: corsHeaders(request) }
      );
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

    // Meter + hard-cutoff: a request only relays if the account has budget.
    this.rawSinceFlush.requests = (this.rawSinceFlush.requests ?? 0) + 1;
    this.rawSinceFlush.bytes = (this.rawSinceFlush.bytes ?? 0) + (bodyBytes?.length ?? 0);
    if (!(await this.ensureBudget(CREDIT_WEIGHTS.request))) {
      const retry = this.retryAfterSeconds();
      const scope = this.rate && this.rate.day.remaining <= 0 ? 'day' : 'month';
      return Response.json(
        { error: 'quota_exceeded', scope, retryAfter: retry },
        {
          status: 429,
          headers: {
            ...corsHeaders(request),
            ...this.rateHeaders(),
            'retry-after': String(retry),
          },
        }
      );
    }
    const rateHeaders = this.rateHeaders();

    const reqId = crypto.randomUUID();
    this.pushInspect(reqId, request.method, url.pathname);
    return await new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(reqId);
        this.streaming.delete(reqId);
        this.finishInspect(reqId, 504, null);
        resolve(new Response('Tunnel timeout', { status: 504, headers: corsHeaders(request) }));
      }, 30000);
      this.pendingHttp.set(reqId, { resolve, timer, request, bootstrapCookie, rate: rateHeaders });
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
      const okWs = await validateWsAuth(request, url, this.env.JWT_SECRET, {
        tunnelId: attach.tunnelId,
        requireTid: this.env.REQUIRE_TID === 'true',
      });
      if (!okWs) {
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // Meter + hard-cutoff (one charge per upgrade; relayed frames are not priced).
    this.rawSinceFlush.wsUpgrades = (this.rawSinceFlush.wsUpgrades ?? 0) + 1;
    if (!(await this.ensureBudget(CREDIT_WEIGHTS.wsUpgrade))) {
      return new Response('Account quota exceeded', {
        status: 429,
        headers: { ...this.rateHeaders(), 'retry-after': String(this.retryAfterSeconds()) },
      });
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

    // Raw browser frame → the untrusted, floodable direction. Meter it
    // SYNCHRONOUSLY (gate per frame on locally-held budget; only await a top-up
    // when exhausted) so an over-quota flood is cut off (1011) within a bounded
    // overshoot instead of being relayed unmetered while an async charge lands.
    if (attach?.role === 'browser') {
      const ctl = this.ctl();
      if (!ctl) return;
      if (!(await this.chargeMessage())) {
        try {
          ws.close(1011, 'Account quota exceeded');
        } catch {
          /* already gone */
        }
        return;
      }
      const binary = typeof data !== 'string';
      const bytes = binary
        ? new Uint8Array(data as ArrayBuffer)
        : new TextEncoder().encode(data as string);
      // A DO WS frame is capped at 1 MiB and base64 inflates ~33%; an oversized
      // browser frame would throw on ctl.send and escape the hibernation handler.
      if (bytes.length > 750_000) {
        try {
          ws.close(1009, 'frame too large to tunnel');
        } catch {
          /* already gone */
        }
        return;
      }
      try {
        ctl.send(JSON.stringify({ type: 'ws-message', connId: attach.connId, data: b64encode(bytes), binary }));
      } catch {
        try {
          ws.close(1011, 'relay error');
        } catch {
          /* already gone */
        }
      }
      return;
    }

    // Control-channel message (responses, chunks, ws relays from the tunnel
    // client) → count for batch metering (fire-and-forget, so the lease round-trip
    // never convoys response delivery under concurrency), then dispatch.
    this.msgsSinceFlush++;
    if (this.msgsSinceFlush >= MSG_FLUSH_EVERY) void this.flushMessages().catch(() => {});
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      return;
    }
    await this.onControlMessage(ws, msg);
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
    // Settle metering: commit unflushed usage + tunnel-seconds and return any
    // unconsumed lease to the account (recovers budget stranded by hibernation).
    if (attach?.slug) {
      // Fold any unflushed relayed-message ops into the final settlement.
      this.consumedSinceCommit += this.msgsSinceFlush * CREDIT_WEIGHTS.message;
      this.msgsSinceFlush = 0;
      const seconds = attach.openedAt ? Math.max(0, (Date.now() - attach.openedAt) / 1000) : 0;
      await this.accountRpc(
        '/close',
        {
          slug: attach.slug,
          tunnelId: attach.tunnelId,
          regId: attach.regId,
          consumed: this.consumedSinceCommit,
          seconds,
          raw: this.takeRaw(),
        },
        attach.slug
      );
      this.consumedSinceCommit = 0;
      this.budget = 0;

      // Idle clock starts now: stamp lastSeenAt at disconnect so the reclaim TTL
      // counts from when the owner went away, not from when it first connected
      // (DECISIONS D5). Only the current owner may move its own clock.
      const res = await this.ctx.storage.get<Reservation>('reservation');
      if (res && res.ownerSlug === attach.slug) {
        await this.ctx.storage.put('reservation', {
          ownerSlug: res.ownerSlug,
          lastSeenAt: Date.now(),
        } satisfies Reservation);
      }
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
    for (const [rid, p] of this.pendingHttp) {
      clearTimeout(p.timer);
      this.finishInspect(rid, 502, null);
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
  private async onControlMessage(ws: WebSocket, msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    if (type === 'register') {
      // Resolve the metering account from the presented secret. An api token
      // (`vta_<slug>_…`) names + proves its account; the legacy shared
      // TUNNEL_SECRET maps to the built-in internal account for back-compat.
      // FAIL CLOSED: when TUNNEL_SECRET is unset there is no legacy path at all
      // (an api token is required) — an unset secret must never become an open
      // relay that bills the internal account for anyone.
      const secret = String(msg.secret ?? '');
      const internal = this.env.INTERNAL_ACCOUNT || 'volter-internal';
      const parsed = parseToken(secret);
      let slug: string;
      let legacy = false;
      let tokenHash: string | undefined;
      if (parsed?.kind === 'api') {
        slug = parsed.slug!;
        tokenHash = await hashToken(secret);
      } else if (this.env.TUNNEL_SECRET && safeEqual(secret, this.env.TUNNEL_SECRET)) {
        slug = internal;
        legacy = true;
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid tunnel secret' }));
        ws.close(4003, 'Invalid tunnel secret');
        return;
      }

      // ── reserved-id ownership: lazy reclaim-on-contention (DECISIONS D5) ──────
      // This DO *is* the tunnelId, so a single 'reservation' record is its owner.
      // A different account may take a reserved id only once the current owner has
      // been idle past RESERVATION_IDLE_TTL_DAYS; while the owner is active a
      // foreign claim is refused so the id stays stable. lastSeenAt is refreshed
      // on (re)register (below, after authorize) and on disconnect.
      const ttlMs = envNum(this.env.RESERVATION_IDLE_TTL_DAYS, 60) * 86_400_000;
      const reservation = await this.ctx.storage.get<Reservation>('reservation');
      const verdict = reservationDecision(reservation, slug, Date.now(), ttlMs);
      if (verdict === 'reject') {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Tunnel ID '${String(msg.tunnelId ?? '')}' is reserved by another account.`,
          })
        );
        ws.close(4002, 'Tunnel ID reserved');
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

      // Unique registration nonce — lets the account tell this socket's ledger
      // entry apart from a later replacement's (fixes the replace race).
      const regId = crypto.randomUUID();

      // Authorize against the account: valid token, active, under the concurrent
      // cap, and with budget remaining. A rejection closes the control socket.
      const auth = await this.accountRpc<AuthorizeResult>('/authorize', {
        slug,
        legacy,
        tokenHash,
        tunnelId,
        regId,
      });
      if (!auth || !auth.ok) {
        const reason = auth?.reason ?? 'account unavailable';
        const code = reason === 'badToken' ? 4003 : 4029;
        ws.send(JSON.stringify({ type: 'error', message: `Tunnel rejected: ${reason}` }));
        ws.close(code, reason);
        return;
      }

      // Account is authorized → claim/refresh/reclaim this tunnelId for it and
      // (re)start the idle clock. Same write for all three verdicts (the only
      // rejected case already returned above).
      await this.ctx.storage.put('reservation', {
        ownerSlug: slug,
        lastSeenAt: Date.now(),
      } satisfies Reservation);

      // Reclaimed from another account past its idle TTL → free the reserved-id
      // slot on the previous owner so its count reflects the loss (#1/#3).
      if (verdict === 'reclaim' && reservation && reservation.ownerSlug !== slug) {
        await this.accountRpc('/release-id', { tunnelId }, reservation.ownerSlug);
      }

      const authRequired = msg.authRequired !== false;
      const ba = msg.basicAuth as { user?: string; pass?: string } | undefined;
      const basicAuthHash =
        ba && ba.user && ba.pass ? await hashToken(`${ba.user}:${ba.pass}`) : undefined;
      ws.serializeAttachment({
        role: 'ctl',
        registered: true,
        authRequired,
        tunnelId,
        slug,
        leaseChunk: auth.leaseChunk ?? 50,
        openedAt: Date.now(),
        regId,
        legacy,
        tokenHash,
        basicAuthHash,
      } satisfies CtlAttach);
      // Seed the rate snapshot + quota level so headers work from the first
      // request and we don't re-announce the level the client already sees.
      this.rate = auth.rate ?? null;
      this.lastQuotaLevel = auth.rate?.level ?? null;
      const url = `https://${tunnelId}.${this.env.TUNNEL_DOMAIN}`;
      ws.send(
        JSON.stringify({
          type: 'registered',
          tunnelId,
          url,
          account: auth.rate ? { slug, day: auth.rate.day, month: auth.rate.month, level: auth.rate.level } : undefined,
        })
      );
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
        pending.bootstrapCookie,
        this.headerRules
      );
      for (const [k, v] of Object.entries(pending.rate)) headers.set(k, v);
      // A malformed body must resolve the request (502), not throw out of the
      // hibernation handler and leave it hung (timer already cleared above).
      let body: Uint8Array | null;
      try {
        body = msg.body ? b64decode(msg.body as string) : null;
      } catch {
        this.finishInspect(msg.reqId as string, 502, null);
        pending.resolve(new Response('Malformed tunnel response', { status: 502, headers }));
        return;
      }
      this.finishInspect(msg.reqId as string, (msg.status as number) || 200, body ? body.length : 0);
      pending.resolve(new Response(body, { status: (msg.status as number) || 200, headers }));
      return;
    }

    if (type === 'response-start') {
      const pending = this.pendingHttp.get(msg.reqId as string);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingHttp.delete(msg.reqId as string);
      const reqId = msg.reqId as string;
      // Streamed: record status + latency-to-first-byte now; body size is unknown
      // (chunks stream out), so leave bytes null.
      this.finishInspect(reqId, (msg.status as number) || 200, null);
      const headers = buildResponseHeaders(
        (msg.headers as Record<string, string>) || {},
        pending.request,
        pending.bootstrapCookie,
        this.headerRules
      );
      for (const [k, v] of Object.entries(pending.rate)) headers.set(k, v);
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
