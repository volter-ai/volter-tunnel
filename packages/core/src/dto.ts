/**
 * Data-transfer objects that cross the wire or appear in the relay's HTTP API.
 * Shared by the client SDK and the relay so both sides agree on shape.
 */

/** HTTP header bag as carried over the protocol (Node-style multi-value). */
export type HeaderMap = Record<string, string | string[] | undefined>;

/**
 * Opaque correlation id for an in-flight request or relayed WebSocket. The
 * Cloudflare relay uses UUID strings; the Fly relay uses numeric counters.
 * Clients treat it opaquely (map key + echo back), so the wire type is the union.
 */
export type CorrelationId = string | number;

/** Usage pressure for an account, derived from its day/month windows. */
export type UsageLevel = 'ok' | 'warn' | 'exceeded';

/** A rolling usage/limit window (credits). `reset` is an epoch-ms timestamp. */
export interface RateWindow {
  limit: number;
  remaining: number;
  reset: number;
}

/** Per-account metering snapshot handed to the client at register / on change. */
export interface AccountSnapshot {
  slug: string;
  day: RateWindow;
  month: RateWindow;
  level: UsageLevel;
}

/** One detailed usage/limit window for the GET /usage view (credits). */
export interface UsageWindow {
  used: number;
  leased: number;
  limit: number;
  remaining: number;
  pct: number;
}

/** The detailed per-account usage view returned by GET /me and
 *  GET /admin/accounts/:slug/usage. The single shape both the relay produces and
 *  the SDK consumes. */
export interface AccountUsage {
  slug: string;
  status: 'active' | 'suspended';
  day: UsageWindow;
  month: UsageWindow;
  openTunnels: number;
  concurrentMax: number;
  resetAt: { day: string; month: string };
  usd: { dayUsed: number; dayLimit: number; monthUsed: number; monthLimit: number };
  raw?: { requests: number; wsUpgrades: number; bytes: number; seconds: number };
}
