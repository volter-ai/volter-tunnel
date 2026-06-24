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
      res.end(
        JSON.stringify({ owner: { id: 7777, login: 'gistuser' }, files: { 'v.txt': { content: gistContent } } })
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((r) => stub.listen(port, '127.0.0.1', () => r()));
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
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
      DEFAULT_RESERVED_MAX: '3',
      SIGNUP_DAY_LIMIT: '1000',
      SIGNUP_MONTH_LIMIT: '20000',
      SIGNUP_ALLOWED_USERS: 'octocat, gistuser', // allowlist (with spaces, to test trimming)
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

  test('logging in again rotates to a fresh token, same account', async () => {
    const res = await post(port, '/signup/github', { token: 'good-token' });
    expect(res.status).toBe(200);
    expect(res.json.slug).toBe('gh-4242');
    const reg = await rawRegister(port, 'octo-tunnel-2', res.json.token as string);
    expect(reg.ok).toBe(true);
  }, 20000);
});

describe('gist-proof signup (no token sent to us)', () => {
  test('issues a nonce, reads the public gist, and provisions the owner account', async () => {
    const start = await post(port, '/signup/github/gist/start', {});
    expect(start.status).toBe(200);
    const nonce = start.json.nonce as string;
    expect(nonce.startsWith('volter-verify-')).toBe(true);

    // The user would put this nonce in a public gist; our stub now serves it.
    gistContent = nonce;
    const verify = await post(port, '/signup/github/gist/verify', { gistId: 'abc123' });
    expect(verify.status).toBe(200);
    expect(verify.json.slug).toBe('gh-7777');
    expect(verify.json.login).toBe('gistuser');
    const reg = await rawRegister(port, 'gist-tunnel', verify.json.token as string);
    expect(reg.ok).toBe(true);
  }, 20000);

  test('a gist without a valid nonce is rejected (401)', async () => {
    gistContent = 'not-a-real-nonce';
    const verify = await post(port, '/signup/github/gist/verify', { gistId: 'abc123' });
    expect(verify.status).toBe(401);
  });
});
