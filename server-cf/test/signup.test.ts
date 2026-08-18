/**
 * Self-serve GitHub signup (#2) in real workerd. A local stub stands in for the
 * GitHub API (via GITHUB_API_BASE), so no network or real token is needed.
 *
 * Covers both identity-proof methods:
 *   - token exchange: client sends a gh token, relay verifies via /user
 *   - gist proof:     relay issues a nonce, reads the public gist, never sees a token
 * and asserts the minted api token actually authorizes a tunnel.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { WebSocket } from 'ws';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';

const DOMAIN = 'tunnel.test';

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

// ── configurable GitHub API stub ──────────────────────────────────────────────
let gistContent = ''; // the test sets this to the nonce it received from /gist/start
let stub: http.Server;

function startStub(port: number): Promise<void> {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/user') {
      if (req.headers.authorization === 'Bearer good-token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 4242, login: 'octocat' }));
      } else if (req.headers.authorization === 'Bearer other-token') {
        // A valid GitHub user who is NOT on the allowlist.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 9999, login: 'mallory' }));
      } else {
        res.writeHead(401);
        res.end('{}');
      }
      return;
    }
    if (url.pathname.startsWith('/gists/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ owner: { id: 7777, login: 'gistuser' }, files: { 'v.txt': { content: gistContent } } }));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((r) => stub.listen(port, '127.0.0.1', () => r()));
}

const ROOT = 'vtr_TESTROOT0000000000000000000000000000000';

function post(
  port: number,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...extraHeaders },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: b ? JSON.parse(b) : {} }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; ctype: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: b, ctype: String(res.headers['content-type'] ?? '') })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function del(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'DELETE', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : {} }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Raw control register — resolves ok on `registered`, else {ok:false,code}. */
function rawRegister(port: number, id: string, secret: string): Promise<{ ok: boolean; code?: number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: -1 }), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', tunnelId: id, secret, authRequired: false })));
    ws.on('message', (m) => {
      try {
        if (JSON.parse(m.toString()).type === 'registered') {
          clearTimeout(timer);
          ws.close();
          resolve({ ok: true });
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('close', (c) => {
      clearTimeout(timer);
      resolve({ ok: false, code: c });
    });
    ws.on('error', () => {});
  });
}

let worker: Unstable_DevWorker;
let port: number;
let stubPort: number;

beforeAll(async () => {
  for (const cls of ['AccountDO', 'RegistryDO', 'TunnelDO']) {
    rmSync(`.wrangler/state/v3/do/volter-tunnel-test-${cls}`, { recursive: true, force: true });
  }
  stubPort = await freePort();
  await startStub(stubPort);

  worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.test.jsonc',
    local: true,
    vars: {
      TUNNEL_DOMAIN: DOMAIN,
      TUNNEL_SECRET: 'signup-legacy',
      JWT_SECRET: '',
      ROOT_TOKEN: 'vtr_TESTROOT0000000000000000000000000000000',
      INTERNAL_ACCOUNT: 'volter-internal',
      GLOBAL_DAY_LIMIT: '1000000',
      GLOBAL_MONTH_LIMIT: '20000000',
      DEFAULT_CONCURRENT: '10',
      DEFAULT_LEASE_CHUNK: '50',
      // This suite reuses one GitHub account across independent signup/token
      // scenarios. Reservation-cap behavior is covered in metering.test.ts;
      // keep that unrelated policy from making token recovery order-sensitive.
      DEFAULT_RESERVED_MAX: '50',
      SIGNUP_DAY_LIMIT: '1000',
      SIGNUP_MONTH_LIMIT: '20000',
      SIGNUP_ALLOWED_USERS: 'octocat, gistuser', // allowlist (with spaces, to test trimming)
      SIGNUP_RPS: '1000', // high so the public rate limiter doesn't interfere with tests
      GITHUB_API_BASE: `http://127.0.0.1:${stubPort}`,
    },
    experimental: { disableExperimentalWarning: true },
  });
  port = worker.port;
}, 90000);

afterAll(async () => {
  await worker?.stop();
  await new Promise<void>((r) => stub?.close(() => r()));
});

describe('self-service /me (api token reads its own account + usage)', () => {
  test('GET /me returns the caller account + usage for its api token', async () => {
    const signup = await post(port, '/signup/github', { token: 'good-token' });
    expect(signup.status).toBe(200);
    const apiToken = signup.json.token as string;

    const me = await get(port, '/me', { authorization: `Bearer ${apiToken}` });
    expect(me.status).toBe(200);
    const body = JSON.parse(me.body) as { slug: string; usage: unknown };
    expect(body.slug).toBe('gh-4242');
    expect(body.usage).toBeTruthy();
  }, 20000);

  test('lists stable ids and lets the owner release one without root', async () => {
    const signup = await post(port, '/signup/github', { token: 'good-token' });
    const apiToken = signup.json.token as string;
    expect((await rawRegister(port, 'owner-release', apiToken)).ok).toBe(true);

    const me = await get(port, '/me', { authorization: `Bearer ${apiToken}` });
    const usage = (JSON.parse(me.body) as { usage: { reservedTunnels: string[]; reservedMax: number } }).usage;
    expect(usage.reservedTunnels).toContain('owner-release');
    expect(usage.reservedMax).toBe(50);

    const released = await del(port, '/me/reservations/owner-release', {
      authorization: `Bearer ${apiToken}`,
    });
    expect(released.status).toBe(200);
    expect(released.json.revoked).toBe(true);

    const missing = await del(port, '/me/reservations/not-mine', {
      authorization: `Bearer ${apiToken}`,
    });
    expect(missing.status).toBe(404);
  }, 20000);

  test('GET /me without a token is 401', async () => {
    const res = await get(port, '/me');
    expect(res.status).toBe(401);
  });

  test('GET /me with a bogus token is 401', async () => {
    const res = await get(port, '/me', { authorization: 'Bearer vta_not_a_real_token' });
    expect(res.status).toBe(401);
  });

  test('GET /me is 403 while the account is suspended', async () => {
    const signup = await post(port, '/signup/github', { token: 'good-token' });
    const apiToken = signup.json.token as string;
    const root = { authorization: `Bearer ${ROOT}` };
    // suspend → 403, then resume → 200 (leave the account active for later tests)
    await post(port, '/admin/accounts/gh-4242/suspend', {}, root);
    const suspended = await get(port, '/me', { authorization: `Bearer ${apiToken}` });
    expect(suspended.status).toBe(403);
    await post(port, '/admin/accounts/gh-4242/resume', {}, root);
    const resumed = await get(port, '/me', { authorization: `Bearer ${apiToken}` });
    expect(resumed.status).toBe(200);
  }, 20000);

  test('logging in on another device does not revoke a persistent host token', async () => {
    const first = await post(port, '/signup/github', { token: 'good-token' });
    const oldToken = first.json.token as string;
    await post(port, '/signup/github', { token: 'good-token', device: 'operator-laptop' });
    const res = await get(port, '/me', { authorization: `Bearer ${oldToken}` });
    expect(res.status).toBe(200);
  }, 20000);

  test('owner can inspect, revoke, and restore a selected device token', async () => {
    const host = await post(port, '/signup/github', { token: 'good-token', device: 'rh2-host' });
    const hostToken = host.json.token as string;
    const owner = await post(port, '/signup/github', { token: 'good-token', device: 'operator-laptop' });
    const ownerToken = owner.json.token as string;

    const listed = await get(port, '/me/tokens', { authorization: `Bearer ${ownerToken}` });
    expect(listed.status).toBe(200);
    const tokens = (JSON.parse(listed.body) as { tokens: Array<Record<string, unknown>> }).tokens;
    const hostMeta = tokens.find((t) => t.last4 === hostToken.slice(-4));
    expect(hostMeta?.label).toBe('github-cli:rh2-host');
    expect(hostMeta?.current).toBe(false);
    expect(tokens.find((t) => t.last4 === ownerToken.slice(-4))?.current).toBe(true);

    const revoked = await del(port, `/me/tokens/${hostMeta?.id}`, {
      authorization: `Bearer ${ownerToken}`,
    });
    expect(revoked.status).toBe(200);
    expect((await get(port, '/me', { authorization: `Bearer ${hostToken}` })).status).toBe(401);

    const restored = await post(
      port,
      `/me/tokens/${hostMeta?.id}/restore`,
      {},
      {
        authorization: `Bearer ${ownerToken}`,
      }
    );
    expect(restored.status).toBe(200);
    expect(restored.json.restored).toBe(true);
    expect((await rawRegister(port, 'restored-host', hostToken)).ok).toBe(true);
  }, 30000);
});

describe('GitHub token-exchange signup', () => {
  test('a valid token provisions a gh-<id> account and returns a usable api token', async () => {
    const res = await post(port, '/signup/github', { token: 'good-token' });
    expect(res.status).toBe(200);
    expect(res.json.slug).toBe('gh-4242');
    expect(res.json.login).toBe('octocat');
    const token = res.json.token as string;
    expect(token.startsWith('vta_')).toBe(true);

    // The minted token must actually authorize a tunnel.
    const reg = await rawRegister(port, 'octo-tunnel', token);
    expect(reg.ok).toBe(true);
  }, 20000);

  test('a bad token is rejected (401)', async () => {
    const res = await post(port, '/signup/github', { token: 'nope' });
    expect(res.status).toBe(401);
  });

  test('a valid GitHub user not on the allowlist is refused (403)', async () => {
    const res = await post(port, '/signup/github', { token: 'other-token' });
    expect(res.status).toBe(403);
  });

  test('logging in again creates a fresh device token for the same account', async () => {
    const res = await post(port, '/signup/github', { token: 'good-token' });
    expect(res.status).toBe(200);
    expect(res.json.slug).toBe('gh-4242');
    const reg = await rawRegister(port, 'octo-tunnel-2', res.json.token as string);
    expect(reg.ok).toBe(true);
  }, 20000);
});

describe('gist-proof signup (no token sent to us)', () => {
  test('issues a nonce + verifier, reads the public gist, and provisions the owner', async () => {
    const start = await post(port, '/signup/github/gist/start', {});
    expect(start.status).toBe(200);
    const nonce = start.json.nonce as string;
    const verifier = start.json.verifier as string;
    expect(nonce.startsWith('volter-verify-')).toBe(true);
    expect(typeof verifier).toBe('string');

    // The user puts the NONCE (only) in a public gist; our stub now serves it.
    gistContent = nonce;
    const verify = await post(port, '/signup/github/gist/verify', { gistId: 'abc123', verifier });
    expect(verify.status).toBe(200);
    expect(verify.json.slug).toBe('gh-7777');
    expect(verify.json.login).toBe('gistuser');
    const reg = await rawRegister(port, 'gist-tunnel', verify.json.token as string);
    expect(reg.ok).toBe(true);
  }, 20000);

  test('a gist without a valid nonce is rejected (401)', async () => {
    const start = await post(port, '/signup/github/gist/start', {});
    gistContent = 'not-a-real-nonce';
    const verify = await post(port, '/signup/github/gist/verify', {
      gistId: 'abc123',
      verifier: start.json.verifier,
    });
    expect(verify.status).toBe(401);
  });

  test('ATTACK: someone who only sees the public gist (no verifier) cannot complete', async () => {
    const start = await post(port, '/signup/github/gist/start', {});
    // The attacker has the public nonce (it's in the gist) but NOT the verifier.
    gistContent = start.json.nonce as string;
    const noVerifier = await post(port, '/signup/github/gist/verify', { gistId: 'abc123' });
    expect(noVerifier.status).toBe(400);
    const wrongVerifier = await post(port, '/signup/github/gist/verify', {
      gistId: 'abc123',
      verifier: 'deadbeef'.repeat(8), // 64 hex chars, but not the real verifier
    });
    expect(wrongVerifier.status).toBe(401);
  });
});

describe('public front door (landing + docs + waitlist)', () => {
  test('apex GET / serves the HTML landing page with the waitlist form', async () => {
    const res = await get(port, '/');
    expect(res.status).toBe(200);
    expect(res.ctype).toContain('text/html');
    expect(res.body).toContain('volter-tunnel');
    expect(res.body).toContain('id="waitlist"');
    expect(res.body).toContain("fetch('/waitlist'");
    // example URLs use the configured TUNNEL_DOMAIN
    expect(res.body).toContain(DOMAIN);
  });

  test('reserved host www.<domain> serves the landing page, not a tunnel', async () => {
    const res = await get(port, '/', { host: `www.${DOMAIN}` });
    expect(res.status).toBe(200);
    expect(res.ctype).toContain('text/html');
    expect(res.body).toContain('id="waitlist"');
  });

  test('a normal subdomain is still treated as a tunnel (not the landing page)', async () => {
    const res = await get(port, '/', { host: `sometunnel.${DOMAIN}` });
    // No client is connected for this id, so the tunnel path returns 502 — proving
    // it routed to a TunnelDO rather than serving the apex landing page.
    expect(res.status).toBe(502);
    expect(res.body).not.toContain('id="waitlist"');
  });

  test('?__tunnel override is IGNORED on the public domain (isolation)', async () => {
    // On the apex/public host the override must not route to an arbitrary tunnel;
    // it falls through to the apex front door. (It is only honored on direct hosts
    // like *.workers.dev / localhost.) If it were applied we'd get a 502.
    const res = await get(port, '/?__tunnel=evil', { host: DOMAIN });
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="waitlist"');
  });

  test('apex GET /docs serves the docs page', async () => {
    const res = await get(port, '/docs');
    expect(res.status).toBe(200);
    expect(res.ctype).toContain('text/html');
    expect(res.body).toContain('Documentation');
    expect(res.body).toContain('volter-tunnel login');
  });

  test('POST /waitlist records a username not on the allowlist', async () => {
    const res = await post(port, '/waitlist', {
      githubUser: 'newdev',
      email: 'newdev@example.com',
      useCase: 'webhook testing',
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.alreadyAllowed).toBeUndefined();

    // It shows up for the operator (root).
    const list = await get(port, '/admin/waitlist', {
      authorization: 'Bearer vtr_TESTROOT0000000000000000000000000000000',
    });
    expect(list.status).toBe(200);
    const wl = JSON.parse(list.body).waitlist as Array<{ githubUser: string; email: string }>;
    expect(wl.some((w) => w.githubUser === 'newdev' && w.email === 'newdev@example.com')).toBe(true);
  });

  test('POST /waitlist for an already-allowlisted user says they can sign up now', async () => {
    const res = await post(port, '/waitlist', { githubUser: 'octocat' });
    expect(res.status).toBe(200);
    expect(res.json.alreadyAllowed).toBe(true);
  });

  test('POST /waitlist rejects an invalid GitHub username (400)', async () => {
    const res = await post(port, '/waitlist', { githubUser: 'not a real-name!' });
    expect(res.status).toBe(400);
  });

  test('re-submitting the same username dedups (latest wins, no duplicate row)', async () => {
    await post(port, '/waitlist', { githubUser: 'dupedev', useCase: 'first' });
    await post(port, '/waitlist', { githubUser: 'DupeDev', useCase: 'second' });
    const list = await get(port, '/admin/waitlist', {
      authorization: 'Bearer vtr_TESTROOT0000000000000000000000000000000',
    });
    const wl = JSON.parse(list.body).waitlist as Array<{ githubUser: string; useCase: string }>;
    const rows = wl.filter((w) => w.githubUser.toLowerCase() === 'dupedev');
    expect(rows.length).toBe(1);
    expect(rows[0].useCase).toBe('second');
  });

  test('GET /admin/waitlist requires the root token (403 without)', async () => {
    const res = await get(port, '/admin/waitlist');
    expect(res.status).toBe(403);
  });

  test('DELETE /admin/waitlist/:user (root) removes an entry', async () => {
    await post(port, '/waitlist', { githubUser: 'removeme' });
    const root = { authorization: 'Bearer vtr_TESTROOT0000000000000000000000000000000' };
    const del = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port, path: '/admin/waitlist/removeme', method: 'DELETE', headers: root },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
        }
      );
      r.on('error', reject);
      r.end();
    });
    expect(del.status).toBe(200);
    expect(JSON.parse(del.body).removed).toBe(1);

    const list = await get(port, '/admin/waitlist', root);
    const wl = JSON.parse(list.body).waitlist as Array<{ githubUser: string }>;
    expect(wl.some((w) => w.githubUser.toLowerCase() === 'removeme')).toBe(false);
  });
});
