/**
 * Shared shapes for the metering control plane (RegistryDO) and data plane
 * (AccountDO), plus the extended Worker `Env`.
 */
import type { TokenKind } from './credits';

export interface MeteringEnv {
  /** AccountDO namespace — one instance per account slug (idFromName(slug)). */
  ACCOUNTS: DurableObjectNamespace;
  /** RegistryDO namespace — a single instance (idFromName('registry')). */
  REGISTRY: DurableObjectNamespace;

  /** Bootstrap root token (plaintext). Hashed into the registry on first touch. */
  ROOT_TOKEN?: string;

  /** Global ceilings: Σ(account limits) may never exceed these. */
  GLOBAL_DAY_LIMIT?: string;
  GLOBAL_MONTH_LIMIT?: string;

  /** The privileged built-in account that legacy TUNNEL_SECRET maps to. */
  INTERNAL_ACCOUNT?: string;
  INTERNAL_DAY_LIMIT?: string;
  INTERNAL_MONTH_LIMIT?: string;
  INTERNAL_CONCURRENT?: string;

  /** Default per-account caps applied when an account is created without them. */
  DEFAULT_CONCURRENT?: string;
  /** Default lease chunk (credits handed to a tunnel per top-up). */
  DEFAULT_LEASE_CHUNK?: string;
  /** Default reserved-id cap for new accounts (#3). Default 3. */
  DEFAULT_RESERVED_MAX?: string;
  /** Reserved-id cap for the privileged internal account (effectively unlimited). */
  INTERNAL_RESERVED_MAX?: string;

  /** Optional Analytics Engine dataset for durable per-account usage time-series.
   *  Absent in local/test → rollups are skipped (best-effort). */
  USAGE_AE?: AnalyticsEngineDataset;

  /** GitHub API base for signup identity verification (#2). Default
   *  https://api.github.com; tests point it at a local stub. */
  GITHUB_API_BASE?: string;
  /** Free-tier limits applied to a self-provisioned GitHub-signup account. */
  SIGNUP_DAY_LIMIT?: string;
  SIGNUP_MONTH_LIMIT?: string;
  /** Comma-separated GitHub logins allowed to sign up (#2/#3). Unset/empty = open
   *  signup; set = only these accounts may self-provision. */
  SIGNUP_ALLOWED_USERS?: string;
  /** HMAC secret for stateless gist-proof nonces (#2). Falls back to ROOT_TOKEN. */
  SIGNUP_NONCE_SECRET?: string;
}

/** Authoritative per-account configuration (lives in the AccountDO). */
export interface AccountConfig {
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  dayLimit: number;
  monthLimit: number;
  concurrentMax: number;
  /** Credits granted per lease top-up. Smaller = tighter overshoot bound. */
  leaseChunk: number;
  /** Max distinct tunnelIds this account may hold reserved at once (#3). Optional
   *  for back-compat with configs written before this field; callers default it. */
  reservedMax?: number;
}

/** Token metadata as stored in the registry (never the plaintext). */
export interface TokenRecord {
  id: string;
  slug: string;
  kind: TokenKind;
  hash: string;
  last4: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

/** A point-in-time usage snapshot returned by GET /admin/accounts/:slug/usage. */
export interface UsageView {
  slug: string;
  status: AccountConfig['status'];
  day: { used: number; leased: number; limit: number; remaining: number; pct: number };
  month: { used: number; leased: number; limit: number; remaining: number; pct: number };
  openTunnels: number;
  concurrentMax: number;
  raw: { requests: number; wsUpgrades: number; bytes: number; seconds: number };
  resetAt: { day: string; month: string };
  /** The same usage/limits expressed in dollars (credits × COST_PER_OP_USD). */
  usd: { dayUsed: number; dayLimit: number; monthUsed: number; monthLimit: number };
}

/** One limit window. `reset` is the UTC epoch-seconds at which it refills. */
export interface RateWindow {
  limit: number;
  remaining: number;
  reset: number;
}

/** A point-in-time rate snapshot, surfaced on the data + control planes. */
export interface RateSnapshot {
  day: RateWindow;
  month: RateWindow;
  /** 'ok' (<80%), 'warn' (≥80%), 'exceeded' (no budget left). */
  level: 'ok' | 'warn' | 'exceeded';
}

/** Result of an authorize() call from a TunnelDO at register time. */
export interface AuthorizeResult {
  ok: boolean;
  /** Present on failure: 'badToken' | 'suspended' | 'overQuota' | 'concurrency' | 'noAccount'. */
  reason?: string;
  slug?: string;
  leaseChunk?: number;
  rate?: RateSnapshot;
}

/** Result of a lease() call. */
export interface LeaseResult {
  grant: number;
  over: boolean;
  /** The tunnel's open entry was missing (reaped/unknown) — caller should
   *  re-authorize and retry once. */
  notOpen?: boolean;
  rate: RateSnapshot;
}

/** Read a numeric env var with a fallback. */
export function envNum(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Persistent per-tunnelId ownership record (lives in the TunnelDO's storage).
 *  There is exactly one per tunnelId, so it is globally consistent by
 *  construction — no central index needed. */
export interface Reservation {
  ownerSlug: string;
  /** Date.now() of the last (re)register or disconnect — the idle clock that the
   *  reclaim TTL is measured against. */
  lastSeenAt: number;
}

export type ReservationVerdict = 'claim' | 'refresh' | 'reclaim' | 'reject';

/**
 * Decide what a register attempt may do to a tunnelId's reservation (DECISIONS
 * D5 — lazy reclaim-on-contention):
 *   - no reservation                         → 'claim'   (first reserver wins)
 *   - owned by this account                  → 'refresh' (reset the idle clock)
 *   - owned by another, idle longer than ttl → 'reclaim' (hand it over)
 *   - owned by another, still within ttl     → 'reject'  (held; stays stable)
 *
 * Pure on purpose: the reclaim math is unit-testable without a Durable Object or
 * time travel. Legacy shared-secret clients all share the internal slug, so they
 * 'refresh' each other rather than contend.
 */
export function reservationDecision(
  reservation: Reservation | undefined | null,
  slug: string,
  now: number,
  ttlMs: number
): ReservationVerdict {
  if (!reservation) return 'claim';
  if (reservation.ownerSlug === slug) return 'refresh';
  return now - reservation.lastSeenAt > ttlMs ? 'reclaim' : 'reject';
}
