/**
 * RegistryDO — a single Durable Object (idFromName('registry')) that owns the
 * management plane: the root credential, the account directory, the global
 * spend ceiling, and the canonical token records.
 *
 * The global ceiling is enforced as an *administrative invariant*: Σ(account
 * limits) may never exceed GLOBAL_*_LIMIT. Because every account is independently
 * hard-capped at its own limit (AccountDO) and the registry refuses to allocate
 * past the global budget, total spend across all accounts is provably ≤ global —
 * no runtime cross-account metering needed.
 *
 * Auth tiers (the "standard system", plus one safety rule):
 *   - root token    → create accounts, raise limits, anything
 *   - service token → mint/revoke that account's api tokens, suspend/resume,
 *                     read usage — but NEVER raise its own limits (so a leaked
 *                     service token cannot uncap spend)
 */
import { DurableObject } from 'cloudflare:workers';
import {
  hashToken,
  last4 as last4Of,
  mintToken,
  isValidSlug,
  randomBase62,
  safeEqualHex,
  usdToCredits,
} from './credits';
import {
  type AccountConfig,
  type MeteringEnv,
  type TokenRecord,
  envNum,
} from './metering-types';

interface DirEntry {
  name: string;
  status: 'active' | 'suspended';
  dayLimit: number;
  monthLimit: number;
  concurrentMax: number;
  leaseChunk: number;
  reservedMax: number;
}

type Auth = { kind: 'root' } | { kind: 'service'; slug: string } | null;

function json(data: unknown, status = 200): Response {
  return Response.json(data as Record<string, unknown>, { status });
}

export class RegistryDO extends DurableObject<MeteringEnv> {
  /** Hash of the current ROOT_TOKEN env secret, memoized per instance. The CF
   *  secret is the single source of truth — NOT persisted — so rotating root is
   *  just `wrangler secret put ROOT_TOKEN` + redeploy, and losing the local copy
   *  never locks anyone out (set a new secret and it takes effect immediately). */
  private rootHash: string | null = null;
  private accounts = new Map<string, DirEntry>();
  private tokens = new Map<string, TokenRecord>();
  private loaded: Promise<void>;

  constructor(ctx: DurableObjectState, env: MeteringEnv) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.accounts = new Map(Object.entries((await ctx.storage.get<Record<string, DirEntry>>('accounts')) ?? {}));
      this.tokens = new Map(Object.entries((await ctx.storage.get<Record<string, TokenRecord>>('tokens')) ?? {}));
    });
  }

  private async persistAccounts(): Promise<void> {
    await this.ctx.storage.put('accounts', Object.fromEntries(this.accounts));
  }
  private async persistTokens(): Promise<void> {
    await this.ctx.storage.put('tokens', Object.fromEntries(this.tokens));
  }

  /** Hash of the live ROOT_TOKEN env secret (memoized). Derived from env, never
   *  stored, so a redeploy with a new secret rotates root immediately. */
  private async currentRootHash(): Promise<string | null> {
    if (this.rootHash) return this.rootHash;
    if (!this.env.ROOT_TOKEN) return null;
    this.rootHash = await hashToken(this.env.ROOT_TOKEN);
    return this.rootHash;
  }

  private bearer(request: Request): string | null {
    const h = request.headers.get('authorization');
    if (h?.startsWith('Bearer ')) return h.slice(7);
    return null;
  }

  private async authenticate(request: Request): Promise<Auth> {
    const token = this.bearer(request);
    if (!token) return null;
    const hash = await hashToken(token);
    const rootHash = await this.currentRootHash();
    if (rootHash && safeEqualHex(hash, rootHash)) return { kind: 'root' };
    for (const rec of this.tokens.values()) {
      if (rec.kind === 'service' && !rec.revokedAt && safeEqualHex(rec.hash, hash)) {
        return { kind: 'service', slug: rec.slug };
      }
    }
    return null;
  }

  /** Σ of account limits, optionally excluding one slug (for in-place edits). */
  private allocated(exclude?: string): { day: number; month: number } {
    let day = 0;
    let month = 0;
    for (const [slug, e] of this.accounts) {
      if (slug === exclude) continue;
      day += e.dayLimit;
      month += e.monthLimit;
    }
    return { day, month };
  }

  private fitsGlobal(slug: string, dayLimit: number, monthLimit: number): boolean {
    const globalDay = envNum(this.env.GLOBAL_DAY_LIMIT, 10_000_000);
    const globalMonth = envNum(this.env.GLOBAL_MONTH_LIMIT, 200_000_000);
    const a = this.allocated(slug);
    return a.day + dayLimit <= globalDay && a.month + monthLimit <= globalMonth;
  }

  private configFor(slug: string): AccountConfig | null {
    const e = this.accounts.get(slug);
    if (!e) return null;
    return {
      slug,
      name: e.name,
      status: e.status,
      dayLimit: e.dayLimit,
      monthLimit: e.monthLimit,
      concurrentMax: e.concurrentMax,
      leaseChunk: e.leaseChunk,
      reservedMax: e.reservedMax ?? envNum(this.env.DEFAULT_RESERVED_MAX, 3),
    };
  }

  /** Push the current config + live api-token hashes for a slug to its AccountDO. */
  private async pushConfig(slug: string): Promise<void> {
    const config = this.configFor(slug);
    if (!config) return;
    const apiHashes: string[] = [];
    for (const rec of this.tokens.values()) {
      if (rec.slug === slug && rec.kind === 'api' && !rec.revokedAt) apiHashes.push(rec.hash);
    }
    const id = this.env.ACCOUNTS.idFromName(slug);
    await this.env.ACCOUNTS.get(id).fetch('https://account/configure', {
      method: 'POST',
      body: JSON.stringify({ config, apiHashes }),
    });
  }

  private async accountUsage(slug: string): Promise<unknown> {
    const id = this.env.ACCOUNTS.idFromName(slug);
    const res = await this.env.ACCOUNTS.get(id).fetch('https://account/usage');
    return res.json();
  }

  /** Live usage for every account + fleet totals, in dollars (operator view). */
  private async usageSummary(): Promise<unknown> {
    interface U {
      slug: string;
      status: string;
      openTunnels: number;
      usd: { dayUsed: number; dayLimit: number; monthUsed: number; monthLimit: number };
      day: { pct: number };
      month: { pct: number };
    }
    const slugs = [...this.accounts.keys()];
    const usages = (await Promise.all(
      slugs.map((slug) => this.accountUsage(slug).catch(() => null))
    )) as (U | null)[];
    const accounts = usages.filter((u): u is U => !!u);
    const totals = accounts.reduce(
      (t, a) => ({
        dayUsed: t.dayUsed + a.usd.dayUsed,
        dayLimit: t.dayLimit + a.usd.dayLimit,
        monthUsed: t.monthUsed + a.usd.monthUsed,
        monthLimit: t.monthLimit + a.usd.monthLimit,
      }),
      { dayUsed: 0, dayLimit: 0, monthUsed: 0, monthLimit: 0 }
    );
    accounts.sort((a, b) => b.usd.monthUsed - a.usd.monthUsed);
    return {
      accounts: accounts.map((a) => ({
        slug: a.slug,
        status: a.status,
        openTunnels: a.openTunnels,
        usd: a.usd,
        dayPct: a.day.pct,
        monthPct: a.month.pct,
      })),
      totals: { usd: totals, accounts: accounts.length },
    };
  }

  // ── routing ──────────────────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['admin','accounts','slug','tokens']

    // Internal, unauthenticated (DO-to-DO only): the internal account reserving
    // its allocation against the global budget at self-bootstrap.
    if (url.pathname === '/reserve-internal') {
      return this.reserveInternal((await request.json().catch(() => ({}))) as Record<string, unknown>);
    }

    // Self-serve signup (#2) — unauthenticated; identity is proven via GitHub.
    if (url.pathname.startsWith('/signup/')) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      switch (url.pathname) {
        case '/signup/github':
          return this.signupGithubToken(body);
        case '/signup/github/gist/start':
          return this.gistStart();
        case '/signup/github/gist/verify':
          return this.gistVerify(body);
        default:
          return json({ error: 'not found' }, 404);
      }
    }

    // Fleet usage summary (root): every account's live usage + dollars in one call.
    if (parts[0] === 'admin' && parts[1] === 'usage' && request.method === 'GET') {
      const auth = await this.authenticate(request);
      if (auth?.kind !== 'root') return json({ error: 'root token required' }, 403);
      return json(await this.usageSummary());
    }

    if (parts[0] !== 'admin' || parts[1] !== 'accounts') {
      return new Response('not found', { status: 404 });
    }

    // Drain the body before auth — returning a response while the request body
    // is still unread trips workerd's "read after response sent" guard.
    const body =
      request.method === 'POST' || request.method === 'PATCH'
        ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
        : {};

    const auth = await this.authenticate(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const slug = parts[2];
    const sub = parts[3];
    const tokenId = parts[4];

    try {
      // /admin/accounts
      if (!slug) {
        if (request.method === 'POST') return await this.createAccount(auth, body);
        if (request.method === 'GET') return this.listAccounts(auth);
        return json({ error: 'method not allowed' }, 405);
      }
      // /admin/accounts/:slug/...
      if (!this.accounts.has(slug)) return json({ error: 'no such account' }, 404);

      if (sub === 'tokens' && !tokenId) {
        if (request.method === 'POST') return await this.createToken(auth, slug, body);
        if (request.method === 'GET') return this.listTokens(auth, slug);
      }
      if (sub === 'tokens' && tokenId && request.method === 'DELETE') {
        return await this.revokeToken(auth, slug, tokenId);
      }
      if (sub === 'limits' && request.method === 'PATCH') {
        return await this.patchLimits(auth, slug, body);
      }
      if ((sub === 'suspend' || sub === 'resume') && request.method === 'POST') {
        return await this.setStatus(auth, slug, sub === 'suspend' ? 'suspended' : 'active');
      }
      if (sub === 'usage' && request.method === 'GET') {
        if (auth.kind === 'service' && auth.slug !== slug) return json({ error: 'forbidden' }, 403);
        return json(await this.accountUsage(slug));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'error' }, 400);
    }
  }

  // ── signup (#2) ────────────────────────────────────────────────────────────────
  private githubBase(): string {
    return (this.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
  }

  /** Verify a GitHub token by asking the API who it belongs to. The token is used
   *  here and nowhere else — never stored or logged. */
  private async githubUser(token: string): Promise<{ id: number; login: string } | null> {
    try {
      const r = await fetch(`${this.githubBase()}/user`, {
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'volter-tunnel',
          accept: 'application/vnd.github+json',
        },
      });
      if (!r.ok) return null;
      const u = (await r.json()) as { id?: number; login?: string };
      return u && typeof u.id === 'number' && u.login ? { id: u.id, login: u.login } : null;
    } catch {
      return null;
    }
  }

  /** Provision a free-tier account for a slug if absent. Returns false if the
   *  global ceiling has no room. */
  private async provisionAccount(slug: string, name: string): Promise<boolean> {
    if (this.accounts.has(slug)) return true;
    const dayLimit = envNum(this.env.SIGNUP_DAY_LIMIT, 1000);
    const monthLimit = envNum(this.env.SIGNUP_MONTH_LIMIT, 20_000);
    if (!this.fitsGlobal(slug, dayLimit, monthLimit)) return false;
    this.accounts.set(slug, {
      name,
      status: 'active',
      dayLimit,
      monthLimit,
      concurrentMax: envNum(this.env.DEFAULT_CONCURRENT, 100),
      leaseChunk: envNum(this.env.DEFAULT_LEASE_CHUNK, 50),
      reservedMax: envNum(this.env.DEFAULT_RESERVED_MAX, 3),
    });
    await this.persistAccounts();
    return true;
  }

  /** Whether a GitHub login may sign up. Empty/unset allowlist = open signup;
   *  a set allowlist restricts to those logins (case-insensitive). Gates account
   *  creation only — existing secrets/tokens are unaffected. */
  private signupAllowed(login: string): boolean {
    const raw = this.env.SIGNUP_ALLOWED_USERS;
    if (!raw || !raw.trim()) return true;
    const allow = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return allow.includes(login.toLowerCase());
  }

  /** Resolve a verified GitHub identity to an account + a fresh CLI api token.
   *  Logging in again rotates the prior github-cli token so creds don't pile up. */
  private async finalizeSignup(githubId: number, login: string): Promise<Response> {
    if (!this.signupAllowed(login)) {
      return json({ error: `signup not permitted for github:${login}` }, 403);
    }
    const slug = `gh-${githubId}`;
    if (!(await this.provisionAccount(slug, `github:${login}`))) {
      return json({ error: 'at capacity — global ceiling reached' }, 503);
    }
    let rotated = false;
    for (const rec of this.tokens.values()) {
      if (rec.slug === slug && rec.kind === 'api' && rec.label === 'github-cli' && !rec.revokedAt) {
        rec.revokedAt = new Date().toISOString();
        rotated = true;
      }
    }
    if (rotated) await this.persistTokens();
    const minted = await this.mint(slug, 'api', 'github-cli');
    await this.pushConfig(slug);
    return json({ slug, login, token: minted.token }, 200);
  }

  private async signupGithubToken(body: Record<string, unknown>): Promise<Response> {
    const token = String(body.token ?? '');
    if (!token) return json({ error: 'missing token' }, 400);
    const user = await this.githubUser(token);
    if (!user) return json({ error: 'github verification failed' }, 401);
    return this.finalizeSignup(user.id, user.login);
  }

  // ── gist-proof signup: prove GitHub ownership without sending us any token ─────
  private nonceSecret(): string {
    return this.env.SIGNUP_NONCE_SECRET || this.env.ROOT_TOKEN || 'volter-signup';
  }
  private async hmacHex(input: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.nonceSecret()),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  /** Issue a signed, self-expiring nonce — stateless (no server storage). */
  private async gistStart(): Promise<Response> {
    const payload = `${randomBase62(24)}.${Date.now() + 10 * 60_000}`;
    const nonce = `volter-verify-${payload}.${await this.hmacHex(payload)}`;
    return json({
      nonce,
      instructions:
        'Create a PUBLIC gist whose content is exactly this nonce, then POST { gistId } to /signup/github/gist/verify.',
    });
  }
  private async validNonce(nonce: string): Promise<boolean> {
    const m = /^volter-verify-(.+)\.([0-9a-f]{64})$/.exec(nonce);
    if (!m) return false;
    const [, payload, sig] = m;
    if (!safeEqualHex(await this.hmacHex(payload!), sig!)) return false;
    const exp = Number(payload!.split('.')[1]);
    return Number.isFinite(exp) && Date.now() < exp;
  }
  private async gistVerify(body: Record<string, unknown>): Promise<Response> {
    const gistId = String(body.gistId ?? '');
    if (!gistId) return json({ error: 'missing gistId' }, 400);
    let gist: { owner?: { id?: number; login?: string }; files?: Record<string, { content?: string }> };
    try {
      const r = await fetch(`${this.githubBase()}/gists/${encodeURIComponent(gistId)}`, {
        headers: { 'user-agent': 'volter-tunnel', accept: 'application/vnd.github+json' },
      });
      if (!r.ok) return json({ error: 'gist not found' }, 404);
      gist = (await r.json()) as typeof gist;
    } catch {
      return json({ error: 'github unreachable' }, 502);
    }
    const owner = gist.owner;
    if (!owner || typeof owner.id !== 'number' || !owner.login) {
      return json({ error: 'gist has no owner' }, 401);
    }
    const contents = Object.values(gist.files ?? {}).map((f) => (f?.content ?? '').trim());
    let ok = false;
    for (const c of contents) if (await this.validNonce(c)) ok = true;
    if (!ok) return json({ error: 'no valid verification nonce in gist' }, 401);
    return this.finalizeSignup(owner.id, owner.login);
  }

  // ── handlers ──────────────────────────────────────────────────────────────────
  private async reserveInternal(body: Record<string, unknown>): Promise<Response> {
    const slug = String(body.slug ?? '');
    if (!isValidSlug(slug)) return json({ error: 'bad slug' }, 400);
    if (!this.accounts.has(slug)) {
      this.accounts.set(slug, {
        name: String(body.name ?? slug),
        status: 'active',
        dayLimit: Number(body.dayLimit ?? 0),
        monthLimit: Number(body.monthLimit ?? 0),
        concurrentMax: envNum(this.env.INTERNAL_CONCURRENT, 1000),
        leaseChunk: envNum(this.env.DEFAULT_LEASE_CHUNK, 50),
        reservedMax: envNum(this.env.INTERNAL_RESERVED_MAX, 1_000_000),
      });
      await this.persistAccounts();
    }
    return json({ ok: true });
  }

  private async createAccount(auth: Auth, body: Record<string, unknown>): Promise<Response> {
    if (auth?.kind !== 'root') return json({ error: 'root token required' }, 403);
    const slug = String(body.slug ?? '');
    if (!isValidSlug(slug)) return json({ error: 'invalid slug (use a-z0-9-)' }, 400);
    if (this.accounts.has(slug)) return json({ error: 'account already exists' }, 409);

    // Accept limits as dollars (dayUsd/monthUsd) or raw op-credits (dayLimit/…).
    const dayLimit = body.dayUsd !== undefined ? usdToCredits(Number(body.dayUsd)) : Number(body.dayLimit ?? 0);
    const monthLimit =
      body.monthUsd !== undefined ? usdToCredits(Number(body.monthUsd)) : Number(body.monthLimit ?? 0);
    if (!(dayLimit > 0) || !(monthLimit > 0)) return json({ error: 'dayLimit/dayUsd and monthLimit/monthUsd required' }, 400);
    if (!this.fitsGlobal(slug, dayLimit, monthLimit)) {
      return json({ error: 'exceeds global ceiling — raise GLOBAL_*_LIMIT or lower this account' }, 409);
    }

    const entry: DirEntry = {
      name: String(body.name ?? slug),
      status: 'active',
      dayLimit,
      monthLimit,
      concurrentMax: envNum(body.concurrentMax as string | undefined, envNum(this.env.DEFAULT_CONCURRENT, 100)),
      leaseChunk: envNum(body.leaseChunk as string | undefined, envNum(this.env.DEFAULT_LEASE_CHUNK, 50)),
      reservedMax: envNum(body.reservedMax as string | undefined, envNum(this.env.DEFAULT_RESERVED_MAX, 3)),
    };
    this.accounts.set(slug, entry);
    await this.persistAccounts();

    // Mint the account's first service token (shown once).
    const svc = await this.mint(slug, 'service', 'initial service token');
    await this.pushConfig(slug);
    return json({ account: { slug, ...entry }, serviceToken: svc.token, tokenId: svc.id }, 201);
  }

  private listAccounts(auth: Auth): Response {
    if (auth?.kind !== 'root') return json({ error: 'root token required' }, 403);
    const out = [...this.accounts.entries()].map(([slug, e]) => ({ slug, ...e }));
    const globalDay = envNum(this.env.GLOBAL_DAY_LIMIT, 10_000_000);
    const globalMonth = envNum(this.env.GLOBAL_MONTH_LIMIT, 200_000_000);
    const a = this.allocated();
    return json({ accounts: out, global: { day: globalDay, month: globalMonth, allocated: a } });
  }

  private async mint(slug: string, kind: 'api' | 'service', label: string): Promise<{ token: string; id: string }> {
    const token = mintToken(kind, slug);
    const id = randomBase62(16);
    const rec: TokenRecord = {
      id,
      slug,
      kind,
      hash: await hashToken(token),
      last4: last4Of(token),
      label,
      createdAt: new Date().toISOString(),
      revokedAt: null,
    };
    this.tokens.set(id, rec);
    await this.persistTokens();
    return { token, id };
  }

  private async createToken(auth: Auth, slug: string, body: Record<string, unknown>): Promise<Response> {
    if (auth?.kind === 'service' && auth.slug !== slug) return json({ error: 'forbidden' }, 403);
    const kind = body.kind === 'service' ? 'service' : 'api';
    // Only root may mint additional service tokens (privilege escalation guard).
    if (kind === 'service' && auth?.kind !== 'root') return json({ error: 'root token required to mint service tokens' }, 403);
    const minted = await this.mint(slug, kind, String(body.label ?? `${kind} token`));
    if (kind === 'api') await this.pushConfig(slug);
    const rec = this.tokens.get(minted.id)!;
    return json({ token: minted.token, id: minted.id, kind, last4: rec.last4 }, 201);
  }

  private listTokens(auth: Auth, slug: string): Response {
    if (auth?.kind === 'service' && auth.slug !== slug) return json({ error: 'forbidden' }, 403);
    const out = [...this.tokens.values()]
      .filter((r) => r.slug === slug)
      .map((r) => ({ id: r.id, kind: r.kind, last4: r.last4, label: r.label, createdAt: r.createdAt, revokedAt: r.revokedAt }));
    return json({ tokens: out });
  }

  private async revokeToken(auth: Auth, slug: string, tokenId: string): Promise<Response> {
    if (auth?.kind === 'service' && auth.slug !== slug) return json({ error: 'forbidden' }, 403);
    const rec = this.tokens.get(tokenId);
    if (!rec || rec.slug !== slug) return json({ error: 'no such token' }, 404);
    if (!rec.revokedAt) {
      rec.revokedAt = new Date().toISOString();
      this.tokens.set(tokenId, rec);
      await this.persistTokens();
      if (rec.kind === 'api') await this.pushConfig(slug);
    }
    return json({ ok: true, id: tokenId });
  }

  private async patchLimits(auth: Auth, slug: string, body: Record<string, unknown>): Promise<Response> {
    // Raising limits is the one thing a service token must never do.
    if (auth?.kind !== 'root') return json({ error: 'root token required to change limits' }, 403);
    const e = this.accounts.get(slug)!;
    const dayLimit =
      body.dayUsd !== undefined
        ? usdToCredits(Number(body.dayUsd))
        : body.dayLimit !== undefined
          ? Number(body.dayLimit)
          : e.dayLimit;
    const monthLimit =
      body.monthUsd !== undefined
        ? usdToCredits(Number(body.monthUsd))
        : body.monthLimit !== undefined
          ? Number(body.monthLimit)
          : e.monthLimit;
    if (!(dayLimit > 0) || !(monthLimit > 0)) return json({ error: 'limits must be positive' }, 400);
    if (!this.fitsGlobal(slug, dayLimit, monthLimit)) {
      return json({ error: 'exceeds global ceiling' }, 409);
    }
    e.dayLimit = dayLimit;
    e.monthLimit = monthLimit;
    if (body.concurrentMax !== undefined) e.concurrentMax = Number(body.concurrentMax);
    if (body.leaseChunk !== undefined) e.leaseChunk = Number(body.leaseChunk);
    if (body.reservedMax !== undefined) e.reservedMax = Number(body.reservedMax);
    this.accounts.set(slug, e);
    await this.persistAccounts();
    await this.pushConfig(slug);
    return json({ ok: true, account: { slug, ...e } });
  }

  private async setStatus(auth: Auth, slug: string, status: 'active' | 'suspended'): Promise<Response> {
    if (auth?.kind === 'service' && auth.slug !== slug) return json({ error: 'forbidden' }, 403);
    const e = this.accounts.get(slug)!;
    e.status = status;
    this.accounts.set(slug, e);
    await this.persistAccounts();
    await this.pushConfig(slug);
    return json({ ok: true, slug, status });
  }
}
