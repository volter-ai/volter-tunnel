/**
 * Unit tests for reservationDecision — the pure reclaim-on-contention math
 * (DECISIONS D5). Kept pure so the TTL boundary is testable without a Durable
 * Object or time travel; the TunnelDO wiring is exercised end-to-end in
 * metering.test.ts.
 */
import { describe, expect, test } from 'vitest';
import { reservationDecision, type Reservation } from '../src/metering-types';

const DAY = 86_400_000;
const TTL = 60 * DAY;

describe('reservationDecision', () => {
  test('no reservation → claim (first reserver wins)', () => {
    expect(reservationDecision(null, 'a', 1000, TTL)).toBe('claim');
    expect(reservationDecision(undefined, 'a', 1000, TTL)).toBe('claim');
  });

  test('owned by the same account → refresh, regardless of idle time', () => {
    const r: Reservation = { ownerSlug: 'a', lastSeenAt: 0 };
    expect(reservationDecision(r, 'a', 1000 * DAY, TTL)).toBe('refresh');
  });

  test('owned by another account, idle within TTL → reject (id stays stable)', () => {
    const now = 100 * DAY;
    const r: Reservation = { ownerSlug: 'a', lastSeenAt: now - 59 * DAY };
    expect(reservationDecision(r, 'b', now, TTL)).toBe('reject');
  });

  test('owned by another account, idle past TTL → reclaim', () => {
    const now = 100 * DAY;
    const r: Reservation = { ownerSlug: 'a', lastSeenAt: now - 61 * DAY };
    expect(reservationDecision(r, 'b', now, TTL)).toBe('reclaim');
  });

  test('boundary: idle exactly TTL is still reject (strictly-greater reclaims)', () => {
    const now = 100 * DAY;
    const r: Reservation = { ownerSlug: 'a', lastSeenAt: now - 60 * DAY };
    expect(reservationDecision(r, 'b', now, TTL)).toBe('reject');
  });
});
