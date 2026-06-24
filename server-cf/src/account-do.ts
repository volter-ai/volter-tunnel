/**
 * AccountDO — one Durable Object per account slug (idFromName(slug)).
 *
 * The strongly-consistent, sharded authority for an account's *runtime* state:
 * its credit counters (day + month), the hashes of its api tokens (for register
 * validation), the set of open tunnels, and the lease ledger. A TunnelDO calls
 * here to authorize a register, to lease budget before relaying, and to commit
 * actuals + return unused budget on close. Config (limits, status, tokens) is
 * pushed in from the RegistryDO via /configure — this DO never raises its own
 * limits, which is what keeps a leaked service token from uncapping spend.
 *
 * Spend safety: a tunnel may only relay traffic it holds *leased* budget for,
 * and budget exists only as credits this DO has debited from the account's
 * remaining balance. The worst-case overshoot is therefore bounded by
 * leaseChunk × concurrentMax — independent of throughput, by construction.
 */
import { DurableObject } from 'cloudflare:workers';
import { CREDIT_WEIGHTS, creditsToUsd, dayKey, monthKey, toCredits, type UsageDelta } from './credits';
import type {
  AccountConfig,
  AuthorizeResult,
  LeaseResult,
  MeteringEnv,
  RateSnapshot,
  UsageView,
} from './metering-types';
import { envNum } from './metering-types';

interface Usage {
  day: string;
  month: string;
  dayUsed: number;
  monthUsed: number;
  /** Credits handed out as leases but not yet committed (Σ of `open` values). */
  leased: number;
  raw: { requests: number; wsUpgrades: number; bytes: number; seconds: number };
}

function emptyUsage(now: Date): Usage {
  return {
    day: dayKey(now),
    month: monthKey(now),
    dayUsed: 0,
    monthUsed: 0,
    leased: 0,
    raw: { requests: 0, wsUpgrades: 0, bytes: 0, seconds: 0 },
  };
}

export class AccountDO extends DurableObject<MeteringEnv> {
  private config: AccountConfig | null = null;
  private apiHashes = new Set<string>();
  private usage!: Usage;
  /** tunnelId → outstanding leased credits for that tunnel. */
  private open = new Map<string, number>();
  private loaded: Promise<void>;

  constructor(ctx: DurableObjectState, env: MeteringEnv) {
    super(ctx, env);
    this.loaded = ctx.blockConcurrencyWhile(async () => {
      this.config = (await ctx.storage.get<AccountConfig>('config')) ?? null;
      this.apiHashes = new Set((await ctx.storage.get<string[]>('apiHashes')) ?? []);
      this.usage = (await ctx.storage.get<Usage>('usage')) ?? emptyUsage(new Date());
      this.open = new Map(Object.entries((await ctx.storage.get<Record<string, number>>('open')) ?? {}));
    });
  }

  // ── persistence ─────────────────────────────────────────────────────────────
  private async persistUsage(): Promise<void> {
    await this.ctx.storage.put('usage', this.usage);
  }
  private async persistOpen(): Promise<void> {
    await this.ctx.storage.put('open', Object.fromEntries(this.open));
  }

  /** Lazily reset day/month buckets when the wall clock crosses a boundary.
   *  `leased` carries across boundaries — it tracks live outstanding leases. */
  private rollPeriods(now: Date): void {
    // Note: `leased` and `raw` deliberately carry across boundaries — leased
    // tracks live outstanding leases, and raw is a cumulative dashboard counter.
    const d = dayKey(now);
    const m = monthKey(now);
    if (this.usage.day !== d) {
      this.usage.day = d;
      this.usage.dayUsed = 0;
    }
    if (this.usage.month !== m) {
      this.usage.month = m;
      this.usage.monthUsed = 0;
    }
  }

  private dayRemaining(): number {
    if (!this.config) return 0;
    return this.config.dayLimit - this.usage.dayUsed - this.usage.leased;
  }
  private monthRemaining(): number {
    if (!this.config) return 0;
    return this.config.monthLimit - this.usage.monthUsed - this.usage.leased;
  }

  /** Current limit windows + a coarse warn/exceeded level, for surfacing on the
   *  data plane (RateLimit headers) and control plane (registered + quota push). */
  private snapshot(): RateSnapshot {
    const now = new Date();
    const dayReset = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000
    );
    const monthReset = Math.floor(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000
    );
    const dayLimit = this.config?.dayLimit ?? 0;
    const monthLimit = this.config?.monthLimit ?? 0;
    const dayRem = Math.max(0, this.dayRemaining());
    const monthRem = Math.max(0, this.monthRemaining());
    const dayPct = dayLimit ? (dayLimit - dayRem) / dayLimit : 0;
    const monthPct = monthLimit ? (monthLimit - monthRem) / monthLimit : 0;
    const pct = Math.max(dayPct, monthPct);
    const level: RateSnapshot['level'] =
      dayRem <= 0 || monthRem <= 0 ? 'exceeded' : pct >= 0.8 ? 'warn' : 'ok';
    return {
      day: { limit: dayLimit, remaining: dayRem, reset: dayReset },
      month: { limit: monthLimit, remaining: monthRem, reset: monthReset },
      level,
    };
  }

  /** Move `consumed` credits for a tunnel from leased → used. */
  private applyCommit(tunnelId: string, consumed: number): void {
    if (consumed <= 0) return;
    const outstanding = this.open.get(tunnelId) ?? 0;
    const c = Math.min(consumed, outstanding);
    if (c <= 0) return;
    this.open.set(tunnelId, outstanding - c);
    this.usage.leased = Math.max(0, this.usage.leased - c);
    this.usage.dayUsed += c;
    this.usage.monthUsed += c;
  }

  private addRaw(raw: UsageDelta | undefined): void {
    if (!raw) return;
    this.usage.raw.requests += raw.requests ?? 0;
    this.usage.raw.wsUpgrades += raw.wsUpgrades ?? 0;
    this.usage.raw.bytes += raw.bytes ?? 0;
    this.usage.raw.seconds += raw.seconds ?? 0;
  }

  /** Self-provision the privileged built-in account on first use (legacy
   *  TUNNEL_SECRET + INTERNAL_ACCOUNT map here). Reserves its allocation with
   *  the registry one-way (no callback) so the global invariant stays honest. */
  private async ensureBootstrap(slug: string): Promise<void> {
    if (this.config) return;
    const internal = this.env.INTERNAL_ACCOUNT || 'volter-internal';
    if (slug !== internal) return;
    this.config = {
      slug: internal,
      name: 'Volter (internal)',
      status: 'active',
      dayLimit: envNum(this.env.INTERNAL_DAY_LIMIT, 5_000_000),
      monthLimit: envNum(this.env.INTERNAL_MONTH_LIMIT, 100_000_000),
      concurrentMax: envNum(this.env.INTERNAL_CONCURRENT, 1000),
      leaseChunk: envNum(this.env.DEFAULT_LEASE_CHUNK, 50),
    };
    await this.ctx.storage.put('config', this.config);
    try {
      const id = this.env.REGISTRY.idFromName('registry');
      await this.env.REGISTRY.get(id).fetch('https://registry/reserve-internal', {
        method: 'POST',
        body: JSON.stringify({
          slug: internal,
          name: this.config.name,
          dayLimit: this.config.dayLimit,
          monthLimit: this.config.monthLimit,
        }),
      });
    } catch {
      // Registry unreachable at bootstrap — internal still works locally; the
      // reservation reconciles on the next admin touch.
    }
  }

  // ── RPC ─────────────────────────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);
    const body =
      request.method === 'POST'
        ? ((await request.json().catch(() => ({}))) as Record<string, unknown>)
        : {};

    switch (url.pathname) {
      case '/authorize':
        return Response.json(await this.authorize(body));
      case '/lease':
        return Response.json(await this.lease(body));
      case '/close':
        return Response.json(await this.close(body));
      case '/configure':
        return Response.json(await this.configure(body));
      case '/usage':
        return Response.json(this.usageView());
      default:
        return new Response('not found', { status: 404 });
    }
  }

  private async authorize(body: Record<string, unknown>): Promise<AuthorizeResult> {
    const slug = String(body.slug ?? '');
    const tunnelId = String(body.tunnelId ?? '');
    await this.ensureBootstrap(slug);
    if (!this.config) return { ok: false, reason: 'noAccount' };
    if (this.config.status !== 'active') return { ok: false, reason: 'suspended' };

    if (!body.legacy) {
      const hash = String(body.tokenHash ?? '');
      if (!hash || !this.apiHashes.has(hash)) return { ok: false, reason: 'badToken' };
    }

    const now = new Date();
    this.rollPeriods(now);

    const alreadyOpen = this.open.has(tunnelId);
    if (!alreadyOpen && this.open.size >= this.config.concurrentMax) {
      return { ok: false, reason: 'concurrency' };
    }
    if (this.dayRemaining() <= 0 || this.monthRemaining() <= 0) {
      return { ok: false, reason: 'overQuota' };
    }

    if (!alreadyOpen) {
      this.open.set(tunnelId, 0);
      await this.persistOpen();
    }
    return { ok: true, slug: this.config.slug, leaseChunk: this.config.leaseChunk, rate: this.snapshot() };
  }

  private async lease(body: Record<string, unknown>): Promise<LeaseResult> {
    const tunnelId = String(body.tunnelId ?? '');
    const want = Math.max(0, Number(body.want ?? 0));
    const commit = Math.max(0, Number(body.commit ?? 0));
    this.rollPeriods(new Date());
    this.addRaw(body.raw as UsageDelta | undefined);
    if (commit > 0) this.applyCommit(tunnelId, commit);

    if (!this.config || !this.open.has(tunnelId)) {
      await this.persistUsage();
      return { grant: 0, over: true, rate: this.snapshot() };
    }

    const headroom = Math.min(this.dayRemaining(), this.monthRemaining());
    const grant = Math.max(0, Math.min(want, this.config.leaseChunk, headroom));
    if (grant > 0) {
      this.open.set(tunnelId, (this.open.get(tunnelId) ?? 0) + grant);
      this.usage.leased += grant;
      await this.persistOpen();
    }
    await this.persistUsage();
    const rate = this.snapshot();
    return { grant, over: rate.day.remaining <= 0 || rate.month.remaining <= 0, rate };
  }

  private async close(body: Record<string, unknown>): Promise<{ ok: true }> {
    const tunnelId = String(body.tunnelId ?? '');
    const consumed = Math.max(0, Number(body.consumed ?? 0));
    const seconds = Math.max(0, Number(body.seconds ?? 0));
    this.rollPeriods(new Date());
    this.addRaw(body.raw as UsageDelta | undefined);

    this.applyCommit(tunnelId, consumed);
    if (seconds > 0) {
      const cost = toCredits({ seconds }, CREDIT_WEIGHTS);
      this.usage.dayUsed += cost;
      this.usage.monthUsed += cost;
    }
    // Return any lease the tunnel never consumed (recovers stranded budget after
    // a hibernation that lost the tunnel's local counter).
    const rem = this.open.get(tunnelId) ?? 0;
    this.usage.leased = Math.max(0, this.usage.leased - rem);
    this.open.delete(tunnelId);
    await this.persistOpen();
    await this.persistUsage();
    return { ok: true };
  }

  /** Apply config + token changes pushed from the RegistryDO. */
  private async configure(body: Record<string, unknown>): Promise<{ ok: true }> {
    if (body.config) {
      this.config = body.config as AccountConfig;
      await this.ctx.storage.put('config', this.config);
    }
    if (Array.isArray(body.apiHashes)) {
      this.apiHashes = new Set(body.apiHashes as string[]);
      await this.ctx.storage.put('apiHashes', [...this.apiHashes]);
    }
    return { ok: true };
  }

  private usageView(): UsageView {
    this.rollPeriods(new Date());
    const c = this.config;
    const dayLimit = c?.dayLimit ?? 0;
    const monthLimit = c?.monthLimit ?? 0;
    const dayRem = Math.max(0, this.dayRemaining());
    const monthRem = Math.max(0, this.monthRemaining());
    return {
      slug: c?.slug ?? '',
      status: c?.status ?? 'suspended',
      day: {
        used: this.usage.dayUsed,
        leased: this.usage.leased,
        limit: dayLimit,
        remaining: dayRem,
        pct: dayLimit ? Math.round(((this.usage.dayUsed + this.usage.leased) / dayLimit) * 100) : 0,
      },
      month: {
        used: this.usage.monthUsed,
        leased: this.usage.leased,
        limit: monthLimit,
        remaining: monthRem,
        pct: monthLimit ? Math.round(((this.usage.monthUsed + this.usage.leased) / monthLimit) * 100) : 0,
      },
      openTunnels: this.open.size,
      concurrentMax: c?.concurrentMax ?? 0,
      raw: { ...this.usage.raw },
      resetAt: { day: this.usage.day, month: this.usage.month },
      usd: {
        dayUsed: creditsToUsd(this.usage.dayUsed + this.usage.leased),
        dayLimit: creditsToUsd(dayLimit),
        monthUsed: creditsToUsd(this.usage.monthUsed + this.usage.leased),
        monthLimit: creditsToUsd(monthLimit),
      },
    };
  }
}
