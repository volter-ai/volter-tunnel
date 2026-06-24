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
  rate: RateSnapshot;
}

/** Read a numeric env var with a fallback. */
export function envNum(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
