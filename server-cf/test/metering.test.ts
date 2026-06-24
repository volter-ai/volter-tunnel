/**
 * Metering E2E — proves the account/token/limit system in real workerd.
 *
 * Boots the Worker (TunnelDO + AccountDO + RegistryDO) via unstable_dev, drives
 * the management API over HTTP (root + service tokens), opens tunnels with api
 * tokens, and asserts the hard guarantees: daily credit cutoff (429), usage
 * accounting, concurrent-tunnel cap, suspend, the global ceiling invariant,
 * bad-token rejection, and that a service token cannot raise its own limits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { WebSocket } from 'ws';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { createTunnel, type TunnelHandle } from '../../client/tunnel-client.ts';

const DOMAIN = 'tunnel.test';
const LEGACY_SECRET = 'meter-legacy-secret';
const ROOT_TOKEN = 'vtr_TESTROOT0000000000000000000000000000000';
const NO_LOG = { info() {}, warn() {}, debug() {} };

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

function admin(
  port: number,
  method: string,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          let json: Record<string, unknown>;
          try {
            json = JSON.parse(b);
          } catch {
            json = { raw: b };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function reqViaTunnel(port: number, tunnelId: string, path: string): Promise<number> {
  return reqFull(port, tunnelId, path).then((r) => r.status);
}

function reqFull(
  port: number,
  tunnelId: string,
  path: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `${tunnelId}.${DOMAIN}` } },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

/** Fire a tunnel request without awaiting its response (used to drive metering). */
function fireAndForget(port: number, tunnelId: string, path: string): void {
  const r = http.request({
    host: '127.0.0.1',
    port,
    path,
    method: 'GET',
    headers: { Host: `${tunnelId}.${DOMAIN}` },
  });
  r.on('error', () => {});
  r.end();
}

/** Raw control register — resolves {ok:true} on `registered`, else {ok:false,code}. */
function rawRegister(
  port: number,
  id: string,
  secret: string
): { ws: WebSocket; result: Promise<{ ok: boolean; code?: number }> } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`);
  const result = new Promise<{ ok: boolean; code?: number }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, code: -1 }), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', tunnelId: id, secret, authRequired: false })));
    ws.on('message', (m) => {
      try {
        if (JSON.parse(m.toString()).type === 'registered') {
          clearTimeout(timer);
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
  return { ws, result };
}

let worker: Unstable_DevWorker;
let port: number;
let origin: http.Server;
let originPort: number;
let acmeApi: string;
let acmeService: string;
let capApi: string;
let capService: string;
let hdrApi: string;
let pushApi: string;

beforeAll(async () => {
  // Hermetic start: DO storage persists in .wrangler/state across runs, which
  // would leave stale accounts (409 on create) and inflate the global-ceiling
  // sum. Wipe this worker's DO state before boot so every run is deterministic.
  for (const cls of ['AccountDO', 'RegistryDO', 'TunnelDO']) {
    rmSync(`.wrangler/state/v3/do/volter-tunnel-test-${cls}`, { recursive: true, force: true });
  }

  originPort = await freePort();
  origin = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>((r) => origin.listen(originPort, '127.0.0.1', r));

  worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.test.jsonc',
    local: true,
    vars: {
      TUNNEL_DOMAIN: DOMAIN,
      TUNNEL_SECRET: LEGACY_SECRET,
      JWT_SECRET: '',
      ROOT_TOKEN,
      INTERNAL_ACCOUNT: 'volter-internal',
      INTERNAL_DAY_LIMIT: '500',
      INTERNAL_MONTH_LIMIT: '5000',
      INTERNAL_CONCURRENT: '100',
      GLOBAL_DAY_LIMIT: '2000',
      GLOBAL_MONTH_LIMIT: '200000',
      DEFAULT_CONCURRENT: '100',
      DEFAULT_LEASE_CHUNK: '50',
    },
    experimental: { disableExperimentalWarning: true },
  });
  port = worker.port;

  // acme: tight daily cap (5) with leaseChunk 1 so the cutoff is exact.
  const acme = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'acme',
    name: 'Acme',
    dayLimit: 5,
    monthLimit: 100,
    leaseChunk: 1,
    concurrentMax: 2,
  });
  acmeService = acme.json.serviceToken as string;
  acmeApi = (await admin(port, 'POST', '/admin/accounts/acme/tokens', acmeService, { kind: 'api', label: 't' }))
    .json.token as string;

  // cap: roomy daily cap, concurrentMax 2 for the concurrency test.
  const cap = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'cap',
    name: 'Cap',
    dayLimit: 1000,
    monthLimit: 10000,
    leaseChunk: 50,
    concurrentMax: 2,
  });
  capService = cap.json.serviceToken as string;
  capApi = (await admin(port, 'POST', '/admin/accounts/cap/tokens', capService, { kind: 'api', label: 't' }))
    .json.token as string;

  // hdr: roomy account for asserting RateLimit-* headers on a 200.
  const hdr = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'hdr',
    name: 'Hdr',
    dayLimit: 50,
    monthLimit: 1000,
    leaseChunk: 10,
    concurrentMax: 5,
  });
  hdrApi = (await admin(port, 'POST', '/admin/accounts/hdr/tokens', hdr.json.serviceToken as string, {
    kind: 'api',
  })).json.token as string;

  // push: tiny daily cap so usage crosses warn(≥80%) then exceeded for the
  // control-plane quota-push test.
  const push = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'push',
    name: 'Push',
    dayLimit: 5,
    monthLimit: 100,
    leaseChunk: 1,
    concurrentMax: 5,
  });
  pushApi = (await admin(port, 'POST', '/admin/accounts/push/tokens', push.json.serviceToken as string, {
    kind: 'api',
  })).json.token as string;
}, 90000);

afterAll(async () => {
  await worker?.stop();
  await new Promise<void>((r) => origin?.close(() => r()));
});

describe('management API + tokens', () => {
  test('root creates an account and gets a service token', () => {
    expect(acmeService).toMatch(/^vts_acme_/);
    expect(acmeApi).toMatch(/^vta_acme_/);
  });

  test('an unauthenticated admin call is 401', async () => {
    const r = await admin(port, 'GET', '/admin/accounts', null);
    expect(r.status).toBe(401);
  });

  test('a service token cannot create an account (root only)', async () => {
    const r = await admin(port, 'POST', '/admin/accounts', acmeService, {
      slug: 'sneaky',
      dayLimit: 1,
      monthLimit: 1,
    });
    expect(r.status).toBe(403);
  });

  test('a service token cannot raise its own limits', async () => {
    const r = await admin(port, 'PATCH', '/admin/accounts/acme/limits', acmeService, { dayLimit: 999999 });
    expect(r.status).toBe(403);
  });
});

describe('global ceiling invariant', () => {
  test('an account that would exceed the global day ceiling is rejected', async () => {
    const r = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
      slug: 'toobig',
      dayLimit: 2001,
      monthLimit: 1,
    });
    expect(r.status).toBe(409);
  });

  test('cumulative allocation is enforced across accounts', async () => {
    // allocated so far = acme(5)+cap(1000)+hdr(50)+push(5) = 1060; global day = 2000.
    const beta = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
      slug: 'beta',
      dayLimit: 900,
      monthLimit: 1,
    });
    expect(beta.status).toBe(201); // 1060+900=1960 ≤ 2000
    const gamma = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
      slug: 'gamma',
      dayLimit: 900,
      monthLimit: 1,
    });
    expect(gamma.status).toBe(409); // 1960+900 = 2860 > 2000
  });
});

describe('hard daily credit cutoff', () => {
  let tunnel: TunnelHandle;

  beforeAll(async () => {
    tunnel = await createTunnel({
      port: originPort,
      host: `http://127.0.0.1:${port}`,
      tunnelId: 'acme-t1',
      secret: acmeApi,
      authRequired: false,
      logger: NO_LOG,
    });
  }, 15000);

  afterAll(() => {
    try {
      tunnel?.close();
    } catch {
      /* ignore */
    }
  });

  test('registers with a valid api token', () => {
    expect(tunnel.url).toBe('https://acme-t1.tunnel.test');
  });

  test('exactly dayLimit requests succeed, then 429 with Retry-After', async () => {
    const results = [];
    for (let i = 0; i < 7; i++) results.push(await reqFull(port, 'acme-t1', '/hello'));
    expect(results.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results[5]!.status).toBe(429);
    expect(results[6]!.status).toBe(429);
    // The 429 surfaces standard retry/limit headers.
    const over = results[6]!.headers;
    expect(Number(over['retry-after'])).toBeGreaterThan(0);
    expect(over['ratelimit-remaining']).toBe('0');
    expect(over['ratelimit-limit']).toBe('5');
  }, 20000);

  test('usage view reports the account drained', async () => {
    const r = await admin(port, 'GET', '/admin/accounts/acme/usage', acmeService);
    const day = r.json.day as { used: number; remaining: number; limit: number };
    expect(day.limit).toBe(5);
    expect(day.remaining).toBe(0);
    expect(day.used).toBeGreaterThanOrEqual(5);
  });

  test('a fresh register on a drained account is rejected (4029)', async () => {
    const { ws, result } = rawRegister(port, 'acme-drained', acmeApi);
    const res = await result;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4029);
  }, 12000);
});

describe('limit surfacing (headers + control plane)', () => {
  let hdrTunnel: TunnelHandle;

  beforeAll(async () => {
    hdrTunnel = await createTunnel({
      port: originPort,
      host: `http://127.0.0.1:${port}`,
      tunnelId: 'hdr-t',
      secret: hdrApi,
      authRequired: false,
      logger: NO_LOG,
    });
  }, 15000);

  afterAll(() => {
    try {
      hdrTunnel?.close();
    } catch {
      /* ignore */
    }
  });

  test('a 200 response carries standard RateLimit-* headers', async () => {
    const r = await reqFull(port, 'hdr-t', '/hello');
    expect(r.status).toBe(200);
    expect(r.headers['ratelimit-limit']).toBe('50');
    expect(Number(r.headers['ratelimit-remaining'])).toBeGreaterThanOrEqual(0);
    expect(Number(r.headers['ratelimit-remaining'])).toBeLessThanOrEqual(50);
    expect(Number(r.headers['ratelimit-reset'])).toBeGreaterThan(0);
  });

  test('the registered message includes the account snapshot', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=hdr-reg`);
    const account = await new Promise<{ slug: string; day: { limit: number }; level: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no registered reply')), 8000);
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'register', tunnelId: 'hdr-reg', secret: hdrApi, authRequired: false }))
        );
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString());
          if (msg.type === 'registered') {
            clearTimeout(timer);
            resolve(msg.account);
          }
        });
        ws.on('error', reject);
      }
    );
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(account?.slug).toBe('hdr');
    expect(account?.day.limit).toBe(50);
    expect(account?.level).toBe('ok');
  }, 12000);

  test('crossing thresholds pushes quota frames (warn → exceeded) to the control client', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=push-t`);
    const levels: string[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 9000);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'register', tunnelId: 'push-t', secret: pushApi, authRequired: false }))
      );
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'registered') {
          // Drive past 80% then 100% of the day limit (5) to trigger pushes.
          for (let i = 0; i < 7; i++) fireAndForget(port, 'push-t', '/hello');
        } else if (msg.type === 'request') {
          // Act as the origin so the relayed requests complete promptly.
          ws.send(
            JSON.stringify({
              type: 'response',
              reqId: msg.reqId,
              status: 200,
              headers: {},
              body: Buffer.from('ok').toString('base64'),
            })
          );
        } else if (msg.type === 'quota') {
          levels.push(msg.level);
          if (levels.includes('exceeded')) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
      ws.on('error', () => {});
    });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(levels).toContain('warn');
    expect(levels).toContain('exceeded');
  }, 15000);
});

describe('concurrent-tunnel cap', () => {
  test('the (concurrentMax + 1)th tunnel is rejected', async () => {
    const a = rawRegister(port, 'cap-a', capApi);
    const b = rawRegister(port, 'cap-b', capApi);
    expect((await a.result).ok).toBe(true);
    expect((await b.result).ok).toBe(true);
    // Two held open → the third must be refused on concurrency.
    const c = rawRegister(port, 'cap-c', capApi);
    const cRes = await c.result;
    expect(cRes.ok).toBe(false);
    expect(cRes.code).toBe(4029);
    for (const h of [a, b, c]) {
      try {
        h.ws.close();
      } catch {
        /* ignore */
      }
    }
  }, 20000);
});

describe('suspend / bad token', () => {
  test('a suspended account refuses new tunnels, resume restores', async () => {
    const s = await admin(port, 'POST', '/admin/accounts/cap/suspend', ROOT_TOKEN);
    expect(s.status).toBe(200);
    const blocked = rawRegister(port, 'cap-susp', capApi);
    const bRes = await blocked.result;
    try {
      blocked.ws.close();
    } catch {
      /* ignore */
    }
    expect(bRes.ok).toBe(false);
    expect(bRes.code).toBe(4029);

    await admin(port, 'POST', '/admin/accounts/cap/resume', ROOT_TOKEN);
    const ok = rawRegister(port, 'cap-resumed', capApi);
    const okRes = await ok.result;
    try {
      ok.ws.close();
    } catch {
      /* ignore */
    }
    expect(okRes.ok).toBe(true);
  }, 20000);

  test('an unknown api token for a real account is rejected (4003)', async () => {
    const { ws, result } = rawRegister(port, 'cap-bad', 'vta_cap_totallybogustoken00000000000000000000');
    const res = await result;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4003);
  }, 12000);

  test('a non-token, non-legacy secret is rejected (4003)', async () => {
    const { ws, result } = rawRegister(port, 'cap-junk', 'not-a-token-and-not-the-legacy-secret');
    const res = await result;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4003);
  }, 12000);
});

describe('legacy shared secret still works (internal account)', () => {
  test('the legacy TUNNEL_SECRET registers under the internal account', async () => {
    const { ws, result } = rawRegister(port, 'legacy-1', LEGACY_SECRET);
    const res = await result;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(true);
  }, 12000);
});
