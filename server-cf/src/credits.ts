/**
 * Metering primitives shared across the Worker, RegistryDO, AccountDO and TunnelDO.
 *
 * Tokens are opaque, prefixed, and carry the account slug so the data plane can
 * route straight to the strongly-consistent AccountDO without a global index —
 * the same trick Cloudflare Tunnel's own connector token uses (it embeds the
 * account + tunnel id). Only the SHA-256 of a token is ever persisted; the
 * plaintext is shown once at creation.
 *
 *   vtr_<rand>            root token   (global; manages accounts + limits)
 *   vts_<slug>_<rand>     service token (per account; mints/revokes api tokens)
 *   vta_<slug>_<rand>     api token     (per account; the "tunnel secret")
 *
 * "Credits" are the single blended spend unit. requests / ws-upgrades / bytes /
 * tunnel-seconds each convert to credits via CREDIT_WEIGHTS, and daily+monthly
 * limits are enforced on credits. Defaults charge per request/upgrade only —
 * bytes are free egress on Workers, and tunnel-seconds are gated by the
 * concurrent-tunnel cap rather than priced — but every weight is tunable.
 */

export type TokenKind = 'root' | 'service' | 'api';

export interface ParsedToken {
  kind: TokenKind;
  /** Account slug — present for service/api tokens, undefined for root. */
  slug?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Whether a string is a valid account slug (DNS-label-ish, no underscores). */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Parse a token string into its kind + slug. Returns null for anything that
 * doesn't match the `vt*` grammar (e.g. a legacy shared secret). Underscore is
 * the field separator and never appears inside a slug or random part, so the
 * split is unambiguous.
 */
export function parseToken(token: string): ParsedToken | null {
  if (typeof token !== 'string' || token.length < 8) return null;
  const parts = token.split('_');
  if (parts[0] === 'vtr') {
    return parts.length === 2 && parts[1] ? { kind: 'root' } : null;
  }
  if (parts[0] === 'vts' || parts[0] === 'vta') {
    if (parts.length !== 3) return null;
    const slug = parts[1]!;
    if (!isValidSlug(slug) || !parts[2]) return null;
    return { kind: parts[0] === 'vts' ? 'service' : 'api', slug };
  }
  return null;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Cryptographically-random base62 string of `len` chars. */
export function randomBase62(len = 40): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += BASE62[bytes[i]! % 62];
  return s;
}

/** Mint a fresh token of the given kind (root tokens carry no slug). */
export function mintToken(kind: TokenKind, slug?: string): string {
  if (kind === 'root') return `vtr_${randomBase62()}`;
  const prefix = kind === 'service' ? 'vts' : 'vta';
  return `${prefix}_${slug}_${randomBase62()}`;
}

/** SHA-256 hex digest — the only form of a token we persist. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return hex;
}

/** Constant-time hex-string compare (both are fixed-length SHA-256 hex). */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Last 4 chars of a token — stored for display ("…aB3x") without the secret. */
export function last4(token: string): string {
  return token.slice(-4);
}

// ── credit accounting ────────────────────────────────────────────────────────

export interface CreditWeights {
  request: number;
  wsUpgrade: number;
  byte: number;
  second: number;
}

/**
 * Default weights. Charge 1 credit per HTTP request and per WS upgrade; bytes
 * and tunnel-seconds are free by default (egress is free on Workers; idle-tunnel
 * duration is bounded by the concurrent cap, not priced). Raise `byte`/`second`
 * to price bandwidth or long-lived tunnels.
 */
export const CREDIT_WEIGHTS: CreditWeights = {
  request: 1,
  wsUpgrade: 1,
  byte: 0,
  second: 0,
};

export interface UsageDelta {
  requests?: number;
  wsUpgrades?: number;
  bytes?: number;
  seconds?: number;
}

/** Convert a raw usage delta into integer credits using the given weights. */
export function toCredits(d: UsageDelta, w: CreditWeights = CREDIT_WEIGHTS): number {
  const raw =
    (d.requests ?? 0) * w.request +
    (d.wsUpgrades ?? 0) * w.wsUpgrade +
    (d.bytes ?? 0) * w.byte +
    (d.seconds ?? 0) * w.second;
  return Math.ceil(raw);
}

// ── period keys (UTC) ────────────────────────────────────────────────────────

/** UTC day bucket, e.g. "2026-06-23". */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}
/** UTC month bucket, e.g. "2026-06". */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}
