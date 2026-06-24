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
  /** Per relayed DO message (response chunk or WebSocket frame). */
  message: number;
  byte: number;
  second: number;
}

/**
 * Credits are denominated in **ops** — the universal Cloudflare billable unit.
 * Every event that wakes/charges the relay's Durable Object counts as 1 op:
 * an HTTP request, a WS upgrade, and each relayed message (a streamed response
 * chunk or a WebSocket frame). Metering messages — not just the opening request
 * — is what makes a dollar cap actually hold for streaming/WS-heavy tunnels.
 *
 * Dollars = credits × COST_PER_OP_USD. Bytes/seconds are 0 (egress is free on
 * Workers; idle duration is ~0 under hibernation and bounded by the concurrency
 * cap), but the message weight captures the per-frame DO cost that does bill.
 */
export const CREDIT_WEIGHTS: CreditWeights = {
  request: 1,
  wsUpgrade: 1,
  message: 1,
  byte: 0,
  second: 0,
};

/**
 * Conservative estimate of the Cloudflare cost of one op (a DO request +
 * sometimes a Worker request + a slice of DO duration), in USD. Real DO/Worker
 * request prices are ~$0.15–0.45 per million; $1/million here leaves margin for
 * duration. Tune as real invoices land — it's the only money↔ops knob.
 */
export const COST_PER_OP_USD = 0.000001;

/** Dollar amount → integer op-credits (for setting limits in money). */
export function usdToCredits(usd: number): number {
  return Math.round(usd / COST_PER_OP_USD);
}
/** Op-credits → dollars, rounded to cents (for display). */
export function creditsToUsd(credits: number): number {
  return Math.round(credits * COST_PER_OP_USD * 100) / 100;
}

export interface UsageDelta {
  requests?: number;
  wsUpgrades?: number;
  messages?: number;
  bytes?: number;
  seconds?: number;
}

/** Convert a raw usage delta into integer credits using the given weights. */
export function toCredits(d: UsageDelta, w: CreditWeights = CREDIT_WEIGHTS): number {
  const raw =
    (d.requests ?? 0) * w.request +
    (d.wsUpgrades ?? 0) * w.wsUpgrade +
    (d.messages ?? 0) * w.message +
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
