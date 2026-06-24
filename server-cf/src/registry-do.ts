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
