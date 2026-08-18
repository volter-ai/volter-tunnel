/**
 * VolterClient unit tests — drive every method against a stub relay (an injected
 * fetch), asserting the HTTP method/path/body and the error path. Pure; no
 * network, no live worker.
 */
import { describe, expect, test } from 'bun:test';
import { VolterApiError, VolterClient } from '../client/api.ts';

type Recorded = { method: string; path: string; body: string | null; auth: string | null };

/** Build a VolterClient backed by a fake fetch that records calls and replies
 *  from a routing table keyed by "METHOD path". */
function clientWith(
  routes: Record<string, { status?: number; json: unknown }>,
  token = 'vta_test'
): { client: VolterClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: u.pathname,
      body: (init?.body as string) ?? null,
      auth: (init?.headers as Record<string, string>)?.authorization ?? null,
    });
    const route = routes[`${method} ${u.pathname}`];
    const status = route?.status ?? (route ? 200 : 404);
    const payload = route ? route.json : { error: 'not found' };
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { client: new VolterClient({ host: 'https://relay.test/', token, fetch: fakeFetch }), calls };
}

describe('VolterClient self-service', () => {
  test('whoami() GETs /me with the bearer token and returns the body', async () => {
    const { client, calls } = clientWith({
      'GET /me': { json: { slug: 'gh-1', name: 'github:octocat', usage: { day: { used: 5 } } } },
    });
    const me = await client.whoami();
    expect(me.slug).toBe('gh-1');
    expect(me.usage).toEqual({ day: { used: 5 } });
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/me', auth: 'Bearer vta_test' });
  });

  test('usage() returns just the usage portion', async () => {
    const { client } = clientWith({ 'GET /me': { json: { slug: 'gh-1', usage: { credits: 42 } } } });
    expect(await client.usage()).toEqual({ credits: 42 });
  });

  test('releaseReservation() deletes through the caller-owned endpoint', async () => {
    const { client, calls } = clientWith({
      'DELETE /me/reservations/my-app': { json: { ok: true, revoked: true, tunnelId: 'my-app' } },
    });
    await client.releaseReservation('my-app');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/me/reservations/my-app', auth: 'Bearer vta_test' });
  });

  test('a non-2xx response throws VolterApiError with status + message', async () => {
    const { client } = clientWith({ 'GET /me': { status: 401, json: { error: 'unauthorized' } } });
    await expect(client.whoami()).rejects.toThrow(VolterApiError);
    try {
      await client.whoami();
    } catch (e) {
      expect(e).toBeInstanceOf(VolterApiError);
      expect((e as VolterApiError).status).toBe(401);
      expect((e as VolterApiError).message).toBe('unauthorized');
    }
  });

  test('error without a JSON error field falls back to statusText', async () => {
    const { client } = clientWith({ 'GET /me': { status: 500, json: {} } });
    await expect(client.whoami()).rejects.toMatchObject({ status: 500 });
  });
});

describe('VolterClient admin ops', () => {
  test('createAccount POSTs JSON to /admin/accounts', async () => {
    const { client, calls } = clientWith({ 'POST /admin/accounts': { json: { slug: 'x' } } }, 'vtr_root');
    await client.createAccount({ slug: 'x', dayUsd: 10 });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/admin/accounts', auth: 'Bearer vtr_root' });
    expect(JSON.parse(calls[0].body!)).toEqual({ slug: 'x', dayUsd: 10 });
  });

  test('patchLimits PATCHes /admin/accounts/:slug/limits', async () => {
    const { client, calls } = clientWith({ 'PATCH /admin/accounts/gh-1/limits': { json: { ok: true } } });
    await client.patchLimits('gh-1', { dayUsd: 5 });
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/admin/accounts/gh-1/limits' });
  });

  test('setStatus maps suspended→suspend and active→resume', async () => {
    const { client, calls } = clientWith({
      'POST /admin/accounts/gh-1/suspend': { json: { ok: true } },
      'POST /admin/accounts/gh-1/resume': { json: { ok: true } },
    });
    await client.setStatus('gh-1', 'suspended');
    await client.setStatus('gh-1', 'active');
    expect(calls.map((c) => c.path)).toEqual(['/admin/accounts/gh-1/suspend', '/admin/accounts/gh-1/resume']);
  });

  test('read endpoints GET the right paths', async () => {
    const { client, calls } = clientWith({
      'GET /admin/accounts': { json: [] },
      'GET /admin/usage': { json: {} },
      'GET /admin/reports': { json: { reports: [] } },
      'GET /admin/waitlist': { json: { waitlist: [] } },
      'GET /admin/accounts/gh-1/usage': { json: {} },
    });
    await client.listAccounts();
    await client.usageSummary();
    await client.reports();
    await client.waitlist();
    await client.accountUsage('gh-1');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /admin/accounts',
      'GET /admin/usage',
      'GET /admin/reports',
      'GET /admin/waitlist',
      'GET /admin/accounts/gh-1/usage',
    ]);
  });

  test('DELETE endpoints encode their path segment', async () => {
    const { client, calls } = clientWith({
      'DELETE /admin/waitlist/mallory': { json: { removed: 1 } },
      'DELETE /admin/reservations/my-app': { json: { ok: true } },
    });
    await client.removeWaitlistEntry('mallory');
    await client.revokeReservation('my-app');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /admin/waitlist/mallory',
      'DELETE /admin/reservations/my-app',
    ]);
  });
});
