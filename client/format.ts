/**
 * Pure presentation helpers for the CLI — turn SDK results into human-readable
 * lines. Kept separate from the bin so they're trivially unit-testable.
 */
import type { AccountUsage, Me } from './api';

/** Format a dollar amount: 2 decimals normally, more precision for tiny values. */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** A one-line-per-window usage summary (used by `usage` and `whoami`). */
export function formatUsage(u: AccountUsage): string {
  const line = (label: string, used: number, limit: number, pct: number) =>
    `  ${label.padEnd(6)} ${usd(used)} / ${usd(limit)}  (${pct}%)`;
  return [
    `Account ${u.slug} — ${u.status}`,
    `${line('Today', u.usd.dayUsed, u.usd.dayLimit, u.day.pct)}   ·  ${u.openTunnels}/${u.concurrentMax} tunnels open`,
    line('Month', u.usd.monthUsed, u.usd.monthLimit, u.month.pct),
    `  Stable ids  ${u.reservedTunnels.length}/${u.reservedMax}: ${u.reservedTunnels.join(', ') || 'none'}`,
  ].join('\n');
}

/** Identity + usage summary for `whoami`. */
export function formatWhoami(me: Me): string {
  const who = me.name ? `${me.name} (account ${me.slug})` : me.slug;
  return `Logged in as ${who}\n${formatUsage(me.usage)}`;
}
