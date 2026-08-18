/**
 * MCP tools unit tests — drive every tool's run() against a stub VolterClient,
 * asserting the SDK call and the rendered text. No MCP transport, no network.
 */
import { describe, expect, test } from 'bun:test';
import type { VolterClient } from '../../../client/api';
import { buildTools, type ToolSpec } from '../src/tools';

const usage = {
  slug: 'gh-1',
  status: 'active' as const,
  day: { used: 0, leased: 0, limit: 1000000, remaining: 1000000, pct: 0 },
  month: { used: 0, leased: 0, limit: 10000000, remaining: 10000000, pct: 0 },
  openTunnels: 1,
  concurrentMax: 100,
  reservedTunnels: ['app'],
  reservedMax: 3,
  resetAt: { day: '2026-06-24', month: '2026-06' },
  usd: { dayUsed: 0, dayLimit: 1, monthUsed: 0, monthLimit: 10 },
};

type Call = { method: string; args: unknown[] };

function stubClient(): { client: VolterClient; calls: Call[] } {
  const calls: Call[] = [];
  const rec =
    (method: string, ret: unknown) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve(ret);
    };
  const client = {
    whoami: rec('whoami', { slug: 'gh-1', name: 'github:octocat', usage }),
    usageSummary: rec('usageSummary', { accounts: [], totals: {} }),
    accountUsage: rec('accountUsage', usage),
    createAccount: rec('createAccount', { slug: 'gh-9' }),
    patchLimits: rec('patchLimits', { ok: true }),
    setStatus: rec('setStatus', { ok: true }),
    reports: rec('reports', { reports: [] }),
    waitlist: rec('waitlist', { waitlist: [] }),
    revokeReservation: rec('revokeReservation', { ok: true }),
    releaseReservation: rec('releaseReservation', { ok: true }),
  } as unknown as VolterClient;
  return { client, calls };
}

const byName = (tools: ToolSpec[], name: string): ToolSpec => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

describe('buildTools', () => {
  test('exposes the expected tool set, each with a description', () => {
    const { client } = stubClient();
    const names = buildTools(client).map((t) => t.name);
    expect(names).toEqual([
      'whoami',
      'usage',
      'reservations',
      'release_reservation',
      'account_list',
      'account_usage',
      'account_create',
      'account_limits',
      'account_suspend',
      'account_resume',
      'reports',
      'waitlist',
      'revoke_reservation',
    ]);
    expect(buildTools(client).every((t) => t.description.length > 0)).toBe(true);
  });

  test('whoami / usage render via the formatters', async () => {
    const { client } = stubClient();
    const tools = buildTools(client);
    expect(await byName(tools, 'whoami').run({})).toContain('Logged in as github:octocat');
    expect(await byName(tools, 'usage').run({})).toContain('Account gh-1 — active');
  });

  test('self-service reservation tools list and release owned ids', async () => {
    const { client, calls } = stubClient();
    const tools = buildTools(client);
    expect(JSON.parse(await byName(tools, 'reservations').run({}))).toEqual({
      reservedTunnels: ['app'],
      reservedMax: 3,
      used: 1,
    });
    await byName(tools, 'release_reservation').run({ tunnelId: 'app' });
    expect(calls).toContainEqual({ method: 'releaseReservation', args: ['app'] });
  });

  test('account_usage passes the slug through', async () => {
    const { client, calls } = stubClient();
    await byName(buildTools(client), 'account_usage').run({ slug: 'gh-7' });
    expect(calls).toContainEqual({ method: 'accountUsage', args: ['gh-7'] });
  });

  test('account_create forwards slug + only the provided usd fields', async () => {
    const { client, calls } = stubClient();
    await byName(buildTools(client), 'account_create').run({ slug: 'gh-9', dayUsd: 10 });
    expect(calls[0]).toEqual({ method: 'createAccount', args: [{ slug: 'gh-9', dayUsd: 10 }] });
  });

  test('account_limits sends only defined usd fields', async () => {
    const { client, calls } = stubClient();
    await byName(buildTools(client), 'account_limits').run({ slug: 'gh-9', monthUsd: 100 });
    expect(calls[0]).toEqual({ method: 'patchLimits', args: ['gh-9', { monthUsd: 100 }] });
  });

  test('suspend / resume map to setStatus', async () => {
    const { client, calls } = stubClient();
    const tools = buildTools(client);
    await byName(tools, 'account_suspend').run({ slug: 'gh-1' });
    await byName(tools, 'account_resume').run({ slug: 'gh-1' });
    expect(calls).toEqual([
      { method: 'setStatus', args: ['gh-1', 'suspended'] },
      { method: 'setStatus', args: ['gh-1', 'active'] },
    ]);
  });

  test('list / reports / waitlist call their endpoints and return JSON', async () => {
    const { client, calls } = stubClient();
    const tools = buildTools(client);
    const out = await byName(tools, 'account_list').run({});
    expect(JSON.parse(out)).toEqual({ accounts: [], totals: {} });
    await byName(tools, 'reports').run({});
    await byName(tools, 'waitlist').run({});
    expect(calls.map((c) => c.method)).toEqual(['usageSummary', 'reports', 'waitlist']);
  });

  test('revoke_reservation passes the tunnel id', async () => {
    const { client, calls } = stubClient();
    await byName(buildTools(client), 'revoke_reservation').run({ tunnelId: 'my-app' });
    expect(calls).toContainEqual({ method: 'revokeReservation', args: ['my-app'] });
  });
});
