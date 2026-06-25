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

/** A reserved tunnel id and who holds it (relay-side ownership record). */
export interface Reservation {
  tunnelId: string;
  ownerSlug: string;
  lastSeenAt: number;
}
