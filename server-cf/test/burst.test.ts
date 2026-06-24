/**
 * Unit tests for burstStep — the token-bucket request-rate limiter (#4). Pure,
 * so the rate math + refill is deterministic without a DO or real time.
 */
import { describe, expect, test } from 'vitest';
import { burstStep, type BurstState } from '../src/metering-types';

const fresh = (): BurstState => ({ tokens: 0, last: 0, init: false });

describe('burstStep', () => {
  test('rps <= 0 disables the limiter (always 0)', () => {
    const s = fresh();
    for (let i = 0; i < 100; i++) expect(burstStep(s, i, 0, 10)).toBe(0);
  });

  test('allows up to the bucket size, then limits', () => {
    const s = fresh();
    // size 2 → first two requests at t=0 pass, third is limited.
    expect(burstStep(s, 0, 2, 2)).toBe(0);
    expect(burstStep(s, 0, 2, 2)).toBe(0);
    const retry = burstStep(s, 0, 2, 2);
    expect(retry).toBeGreaterThan(0);
  });

  test('refills over time at rps', () => {
    const s = fresh();
    burstStep(s, 0, 2, 2); // spend
    burstStep(s, 0, 2, 2); // spend → empty
    expect(burstStep(s, 0, 2, 2)).toBeGreaterThan(0); // limited at t=0
    // 1s later at 2 rps → ~2 tokens refilled.
    expect(burstStep(s, 1000, 2, 2)).toBe(0);
    expect(burstStep(s, 1000, 2, 2)).toBe(0);
    expect(burstStep(s, 1000, 2, 2)).toBeGreaterThan(0);
  });

  test('never exceeds the bucket size on long idle', () => {
    const s = fresh();
    burstStep(s, 0, 5, 5); // init + spend 1 → 4 tokens
    // long idle shouldn't overflow beyond size 5.
    burstStep(s, 10_000_000, 5, 5);
    expect(s.tokens).toBeLessThanOrEqual(5);
  });
});
