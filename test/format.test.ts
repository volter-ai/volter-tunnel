/**
 * CLI formatter unit tests — pure functions, full coverage.
 */
import { describe, expect, test } from 'bun:test';
import { formatUsage, formatWhoami, usd } from '../client/format.ts';
import type { AccountUsage, Me } from '../client/api.ts';

const usage: AccountUsage = {
  slug: 'gh-1',
  status: 'active',
  day: { used: 50000, leased: 0, limit: 1000000, remaining: 950000, pct: 5 },
  month: { used: 500000, leased: 0, limit: 10000000, remaining: 9500000, pct: 5 },
  openTunnels: 2,
  concurrentMax: 100,
  resetAt: { day: '2026-06-24', month: '2026-06' },
  usd: { dayUsed: 0.05, dayLimit: 1, monthUsed: 0.5, monthLimit: 10 },
};

describe('usd', () => {
  test('2 decimals for normal amounts', () => {
    expect(usd(1)).toBe('$1.00');
    expect(usd(10.5)).toBe('$10.50');
    expect(usd(0)).toBe('$0.00');
  });
  test('extra precision for sub-cent amounts', () => {
    expect(usd(0.0005)).toBe('$0.0005');
  });
});

describe('formatUsage', () => {
  test('renders account, status, both windows, and tunnel count', () => {
    const out = formatUsage(usage);
    expect(out).toContain('Account gh-1 — active');
    expect(out).toContain('Today');
    expect(out).toContain('$0.05 / $1.00  (5%)');
    expect(out).toContain('2/100 tunnels open');
    expect(out).toContain('Month');
    expect(out).toContain('$0.50 / $10.00  (5%)');
  });
});

describe('formatWhoami', () => {
  test('includes name when present', () => {
    const me: Me = { slug: 'gh-1', name: 'github:octocat', usage };
    expect(formatWhoami(me)).toContain('Logged in as github:octocat (account gh-1)');
  });
  test('falls back to slug when no name', () => {
    const me: Me = { slug: 'gh-1', usage };
    expect(formatWhoami(me)).toContain('Logged in as gh-1');
  });
});
