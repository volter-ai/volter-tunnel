/**
 * CLI command dispatch tests — the whoami/usage/account handlers drive the SDK
 * correctly and render output. Stub VolterClient; no process/network.
 */
import { describe, expect, test } from 'bun:test';
import type { VolterClient } from '../client/api.ts';
import {
  runAccount,
  runReleaseReservation,
  runReservations,
  runTokenAction,
  runTokens,
  runUsage,
  runWhoami,
} from '../client/cli.ts';

const usage = {
  slug: 'gh-1',
  status: 'active' as const,
  day: { used: 0, leased: 0, limit: 1_000_000, remaining: 1_000_000, pct: 0 },
  month: { used: 0, leased: 0, limit: 10_000_000, remaining: 10_000_000, pct: 0 },
  openTunnels: 1,
  concurrentMax: 100,
  reservedTunnels: ['app', 'app-media'],
  reservedMax: 3,
  resetAt: { day: '2026-06-24', month: '2026-06' },
  usd: { dayUsed: 0, dayLimit: 1, monthUsed: 0, monthLimit: 10 },
};

type Call = { method: string; args: unknown[] };
function stub(): { client: VolterClient; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(ret);
    };
  const client = {
    whoami: rec('whoami', { slug: 'gh-1', name: 'github:octocat', usage }),
    usageSummary: rec('usageSummary', { accounts: [] }),
    accountUsage: rec('accountUsage', usage),
    createAccount: rec('createAccount', { slug: 'gh-9' }),
    patchLimits: rec('patchLimits', { ok: true }),
    setStatus: rec('setStatus', { ok: true }),
    releaseReservation: rec('releaseReservation', { ok: true, revoked: true }),
    listDeviceTokens: rec('listDeviceTokens', {
      tokens: [
        {
          id: 'host-1',
          last4: 'aB3x',
          label: 'github-cli:rh2-host',
          createdAt: '2026-08-18T12:00:00Z',
          revokedAt: '2026-08-18T13:00:00Z',
          current: false,
        },
      ],
    }),
    restoreDeviceToken: rec('restoreDeviceToken', { ok: true, restored: true }),
    revokeDeviceToken: rec('revokeDeviceToken', { ok: true }),
  } as unknown as VolterClient;
  return { client, calls };
}

describe('runWhoami / runUsage', () => {
  test('whoami renders the formatted identity by default', async () => {
    const { client } = stub();
    expect(await runWhoami(client)).toContain('Logged in as github:octocat');
  });
  test('whoami --json emits the full Me object', async () => {
    const { client } = stub();
    expect(JSON.parse(await runWhoami(client, true)).slug).toBe('gh-1');
  });
  test('usage renders the usage block; --json emits just usage', async () => {
    const { client } = stub();
    expect(await runUsage(client)).toContain('Account gh-1 — active');
    expect(JSON.parse(await runUsage(client, true)).usd.dayLimit).toBe(1);
  });
  test('reservations shows capacity and release delegates to the SDK', async () => {
    const { client, calls } = stub();
    expect(await runReservations(client)).toContain('Stable ids 2/3: app, app-media');
    expect(JSON.parse(await runReservations(client, true)).reservedMax).toBe(3);
    await runReleaseReservation(client, 'app');
    expect(calls).toContainEqual({ method: 'releaseReservation', args: ['app'] });
    await expect(runReleaseReservation(client, undefined)).rejects.toThrow(/Usage:/);
  });
  test('tokens renders safe metadata and token actions delegate to the SDK', async () => {
    const { client, calls } = stub();
    expect(await runTokens(client)).toContain('host-1  …aB3x  revoked');
    expect(JSON.parse(await runTokens(client, true)).tokens[0].label).toBe('github-cli:rh2-host');
    await runTokenAction(client, 'restore', 'host-1');
    await runTokenAction(client, 'revoke', 'host-1');
    expect(calls).toContainEqual({ method: 'restoreDeviceToken', args: ['host-1'] });
    expect(calls).toContainEqual({ method: 'revokeDeviceToken', args: ['host-1'] });
    await expect(runTokenAction(client, 'bogus', 'host-1')).rejects.toThrow(/Usage:/);
  });
});

describe('runAccount dispatch', () => {
  test('list → usageSummary', async () => {
    const { client, calls } = stub();
    await runAccount(client, 'list', undefined);
    expect(calls[0].method).toBe('usageSummary');
  });
  test('usage <slug> → accountUsage(slug)', async () => {
    const { client, calls } = stub();
    await runAccount(client, 'usage', 'gh-7');
    expect(calls[0]).toEqual({ method: 'accountUsage', args: ['gh-7'] });
  });
  test('create passes slug + only provided usd fields', async () => {
    const { client, calls } = stub();
    await runAccount(client, 'create', 'gh-9', { dayUsd: 10 });
    expect(calls[0]).toEqual({ method: 'createAccount', args: [{ slug: 'gh-9', dayUsd: 10 }] });
  });
  test('limits forwards only provided usd fields', async () => {
    const { client, calls } = stub();
    await runAccount(client, 'limits', 'gh-9', { monthUsd: 100 });
    expect(calls[0]).toEqual({ method: 'patchLimits', args: ['gh-9', { monthUsd: 100 }] });
  });
  test('suspend / resume map to setStatus', async () => {
    const { client, calls } = stub();
    await runAccount(client, 'suspend', 'gh-1');
    await runAccount(client, 'resume', 'gh-1');
    expect(calls).toEqual([
      { method: 'setStatus', args: ['gh-1', 'suspended'] },
      { method: 'setStatus', args: ['gh-1', 'active'] },
    ]);
  });
  test('an unknown subcommand throws a usage error', async () => {
    const { client } = stub();
    await expect(runAccount(client, 'bogus', undefined)).rejects.toThrow(/Usage:/);
  });
  test('a subcommand needing a slug but missing one throws', async () => {
    const { client } = stub();
    await expect(runAccount(client, 'usage', undefined)).rejects.toThrow(/Usage:/);
  });
});
