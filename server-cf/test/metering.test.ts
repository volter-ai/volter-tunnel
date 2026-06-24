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
import { WebSocket, WebSocketServer } from 'ws';
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
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `${tunnelId}.${DOMAIN}` } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
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
let monApi: string;
let sharedApi: string;
let revApi: string;
let revService: string;
let wscapApi: string;
let rezcapApi: string;
let dollarsService: string;
let dollarsAccount: { dayLimit: number; monthLimit: number };

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
  // WebSocket echo so the message-metering test can drive frames through.
  const originWss = new WebSocketServer({ server: origin });
  originWss.on('connection', (ws) => ws.on('message', (m) => ws.send(String(m))));
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
      DEFAULT_RESERVED_MAX: '50', // high default so multi-id test accounts aren't capped
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

  // mon: roomy daily cap but a tiny MONTHLY cap, so the month binds first.
  const mon = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'mon',
    name: 'Mon',
    dayLimit: 10,
    monthLimit: 4,
    leaseChunk: 1,
    concurrentMax: 5,
  });
  monApi = (await admin(port, 'POST', '/admin/accounts/mon/tokens', mon.json.serviceToken as string, {
    kind: 'api',
  })).json.token as string;

  // shared: one daily pool of 4 credits shared across multiple tunnels.
  const shared = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'shared',
    name: 'Shared',
    dayLimit: 4,
    monthLimit: 1000,
    leaseChunk: 1,
    concurrentMax: 5,
  });
  sharedApi = (await admin(port, 'POST', '/admin/accounts/shared/tokens', shared.json.serviceToken as string, {
    kind: 'api',
  })).json.token as string;

  // rev: for the token-revocation test.
  const rev = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'rev',
    name: 'Rev',
    dayLimit: 10,
    monthLimit: 1000,
    leaseChunk: 1,
    concurrentMax: 5,
  });
  revService = rev.json.serviceToken as string;
  revApi = (await admin(port, 'POST', '/admin/accounts/rev/tokens', revService, { kind: 'api' })).json
    .token as string;

  // wscap: small cap to prove relayed WS frames (messages) are metered + cut off.
  const wscap = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'wscap',
    name: 'WsCap',
    dayLimit: 60,
    monthLimit: 100000,
    leaseChunk: 16,
    concurrentMax: 5,
  });
  wscapApi = (await admin(port, 'POST', '/admin/accounts/wscap/tokens', wscap.json.serviceToken as string, {
    kind: 'api',
  })).json.token as string;

  // dollars: created via dollar amounts (created here, before the global-ceiling
  // test consumes the remaining headroom). 1 op = $0.000001 → dayUsd 0.0005 = 500.
  const dollars = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'dollars',
    name: 'Dollars',
    dayUsd: 0.0005,
    monthUsd: 0.0009,
    leaseChunk: 1,
    concurrentMax: 2,
  });
  dollarsService = dollars.json.serviceToken as string;
  dollarsAccount = dollars.json.account as { dayLimit: number; monthLimit: number };

  // rezcap: reservedMax 2, for the reserved-id count cap test (#3).
  const rezcap = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
    slug: 'rezcap',
    name: 'Rezcap',
    dayLimit: 20,
    monthLimit: 100,
    reservedMax: 2,
  });
  rezcapApi = (
    await admin(port, 'POST', '/admin/accounts/rezcap/tokens', rezcap.json.serviceToken as string, {
      kind: 'api',
      label: 't',
    })
  ).json.token as string;
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

  test('only the configured ROOT_TOKEN authenticates as root', async () => {
    // A different root-looking token is not the live env secret → rejected.
    const r = await admin(port, 'GET', '/admin/accounts', 'vtr_someoneelsestokennnnnnnnnnnnnnnnnnnnnn');
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
    // Compute remaining global headroom dynamically (robust to other accounts).
    const list = await admin(port, 'GET', '/admin/accounts', ROOT_TOKEN);
    const g = list.json.global as { day: number; allocated: { day: number } };
    const room = g.day - g.allocated.day;
    // An account that fits the remaining room is accepted...
    const beta = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
      slug: 'beta',
      dayLimit: room - 10,
      monthLimit: 1,
    });
    expect(beta.status).toBe(201);
    // ...and the next one that would breach the global ceiling is rejected.
    const gamma = await admin(port, 'POST', '/admin/accounts', ROOT_TOKEN, {
      slug: 'gamma',
      dayLimit: 100,
      monthLimit: 1,
    });
    expect(gamma.status).toBe(409);
  });
});

describe('dollar-denominated limits', () => {
  test('dollar amounts (dayUsd/monthUsd) convert to op-credits; usage reports usd', () => {
    expect(dollarsAccount.dayLimit).toBe(500); // 0.0005 / 0.000001
    expect(dollarsAccount.monthLimit).toBe(900); // 0.0009 / 0.000001
  });

  test('the usage view surfaces dollars', async () => {
    const usage = await admin(port, 'GET', '/admin/accounts/dollars/usage', dollarsService);
    const usd = usage.json.usd as { dayLimit: number; monthLimit: number };
    expect(typeof usd.dayLimit).toBe('number');
    expect(typeof usd.monthLimit).toBe('number');
    expect((usage.json.day as { limit: number }).limit).toBe(500);
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

describe('monthly cutoff binds independently of daily', () => {
  let tunnel: TunnelHandle;
  beforeAll(async () => {
    tunnel = await createTunnel({
      port: originPort,
      host: `http://127.0.0.1:${port}`,
      tunnelId: 'mon-t',
      secret: monApi,
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

  test('monthLimit requests succeed, then 429 with scope "month"', async () => {
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await reqFull(port, 'mon-t', '/hello'));
    expect(results.slice(0, 4).map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(results[4]!.status).toBe(429);
    const body = JSON.parse(results[4]!.body);
    expect(body.error).toBe('quota_exceeded');
    expect(body.scope).toBe('month'); // daily (10) still had room; the month (4) bound
  }, 20000);
});

describe('one account budget is shared across its tunnels', () => {
  const tunnels: TunnelHandle[] = [];
  beforeAll(async () => {
    for (const id of ['shared-a', 'shared-b']) {
      tunnels.push(
        await createTunnel({
          port: originPort,
          host: `http://127.0.0.1:${port}`,
          tunnelId: id,
          secret: sharedApi,
          authRequired: false,
          logger: NO_LOG,
        })
      );
    }
  }, 20000);
  afterAll(() => {
    for (const t of tunnels) {
      try {
        t.close();
      } catch {
        /* ignore */
      }
    }
  });

  test('two tunnels draw from the same daily pool (4), 5th request 429s', async () => {
    // Interleave across both tunnels; the account-wide cap is what binds.
    const order = ['shared-a', 'shared-b', 'shared-a', 'shared-b', 'shared-a'];
    const statuses: number[] = [];
    for (const id of order) statuses.push((await reqFull(port, id, '/hello')).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses[4]).toBe(429); // pool exhausted regardless of which tunnel
  }, 20000);
});

describe('token revocation', () => {
  test('a revoked api token can no longer register', async () => {
    // Works before revocation.
    const before = rawRegister(port, 'rev-1', revApi);
    expect((await before.result).ok).toBe(true);
    try {
      before.ws.close();
    } catch {
      /* ignore */
    }

    // Find + revoke the api token.
    const list = await admin(port, 'GET', '/admin/accounts/rev/tokens', revService);
    const apiTok = (list.json.tokens as Array<{ id: string; kind: string }>).find((t) => t.kind === 'api');
    expect(apiTok).toBeTruthy();
    const del = await admin(port, 'DELETE', `/admin/accounts/rev/tokens/${apiTok!.id}`, revService);
    expect(del.status).toBe(200);

    // Now the same token is rejected as a bad token.
    const after = rawRegister(port, 'rev-2', revApi);
    const res = await after.result;
    try {
      after.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4003);
  }, 15000);
});

describe('relayed WS frames are metered (cap holds for chatty tunnels)', () => {
  let tunnel: TunnelHandle;
  beforeAll(async () => {
    tunnel = await createTunnel({
      port: originPort,
      host: `http://127.0.0.1:${port}`,
      tunnelId: 'wscap-t',
      secret: wscapApi,
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

  test('a chatty WebSocket is cut off (1011) once the account budget is spent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { Host: `wscap-t.${DOMAIN}` } });
    let closeCode = 0;
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 14000);
      ws.on('close', (c) => {
        closeCode = c;
        clearTimeout(timer);
        resolve();
      });
      ws.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    // Each relayed frame (both directions) is a metered op; with a 60-op/day cap
    // the relay must close the socket well before 200 frames.
    let i = 0;
    const pump = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && i < 200) ws.send('x' + i++);
      else clearInterval(pump);
    }, 25);
    await done;
    clearInterval(pump);
    expect(closeCode).toBe(1011); // closed by the relay on quota exhaustion
  }, 20000);
});

describe('fleet usage summary', () => {
  test('GET /admin/usage returns all accounts + totals in dollars (root only)', async () => {
    const forbidden = await admin(port, 'GET', '/admin/usage', acmeService);
    expect(forbidden.status).toBe(403); // a service token can't see the whole fleet

    const r = await admin(port, 'GET', '/admin/usage', ROOT_TOKEN);
    expect(r.status).toBe(200);
    const accounts = r.json.accounts as Array<{ slug: string; usd: { monthLimit: number } }>;
    expect(Array.isArray(accounts)).toBe(true);
    expect(accounts.find((a) => a.slug === 'acme')).toBeTruthy();
    const totals = r.json.totals as { accounts: number; usd: { monthLimit: number } };
    expect(totals.accounts).toBeGreaterThan(0);
    expect(typeof totals.usd.monthLimit).toBe('number');
  });
});

describe('robustness regressions', () => {
  test('register-replace does not throttle the surviving tunnel (regId race)', async () => {
    const id = 'race-t';
    const reg = (ws: WebSocket, replace: boolean) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no registered')), 8000);
        ws.on('open', () =>
          ws.send(JSON.stringify({ type: 'register', tunnelId: id, secret: hdrApi, authRequired: false, replace }))
        );
        ws.on('message', (m) => {
          const msg = JSON.parse(m.toString());
          if (msg.type === 'registered') {
            clearTimeout(timer);
            resolve();
          }
          if (msg.type === 'request') {
            ws.send(
              JSON.stringify({
                type: 'response',
                reqId: msg.reqId,
                status: 200,
                headers: {},
                body: Buffer.from('survivor').toString('base64'),
              })
            );
          }
        });
        ws.on('error', () => {});
      });

    const a = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`);
    await reg(a, false);
    const b = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`); // replaces A, closing it
    await reg(b, true);
    await new Promise((r) => setTimeout(r, 600)); // let A's close land (must be a no-op vs B's entry)

    // The survivor (B) must still serve — its account ledger entry must not have
    // been clobbered by the replaced socket's close.
    const r = await reqFull(port, id, '/x');
    try {
      a.close();
      b.close();
    } catch {
      /* ignore */
    }
    expect(r.status).toBe(200);
    expect(r.body).toBe('survivor');
  }, 15000);

  test('a malformed tunnel response resolves 502, not a 30s hang', async () => {
    const id = 'malformed-t';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?id=${id}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no registered')), 8000);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'register', tunnelId: id, secret: hdrApi, authRequired: false }))
      );
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'registered') {
          clearTimeout(timer);
          resolve();
        }
        if (msg.type === 'request') {
          // Reply with body that is NOT valid base64 — the relay must 502, not throw/hang.
          ws.send(JSON.stringify({ type: 'response', reqId: msg.reqId, status: 200, headers: {}, body: '@@not base64@@' }));
        }
      });
      ws.on('error', reject);
    });
    const t0 = Date.now();
    const r = await reqFull(port, id, '/x');
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    expect(r.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15000);
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

describe('reserved-id ownership (idle reclaim-on-contention, DECISIONS D5)', () => {
  // `cap` owns the id; `hdr` is a different account that contends for it. The
  // contender is refused at the reservation check (before authorize), so neither
  // account's budget matters here — only ownership.
  test('a reserved tunnelId is refused to a different account while the owner is active', async () => {
    const owner = rawRegister(port, 'rez-stable', capApi);
    expect((await owner.result).ok).toBe(true);
    // Owner disconnects — the id must STAY reserved (this is the whole feature).
    try {
      owner.ws.close();
    } catch {
      /* ignore */
    }

    const contender = rawRegister(port, 'rez-stable', hdrApi);
    const res = await contender.result;
    try {
      contender.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4002); // "Tunnel ID reserved"
  }, 15000);

  test('the owning account keeps (refreshes) its own reserved id on reconnect', async () => {
    const again = rawRegister(port, 'rez-stable', capApi);
    const res = await again.result;
    try {
      again.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(true);
  }, 15000);
});

describe('reserved-id count cap (#3)', () => {
  // `rezcap` has reservedMax 2. Reservations persist across disconnect, so two
  // distinct ids fill the cap even after their tunnels close.
  test('an account cannot reserve more distinct ids than its reservedMax', async () => {
    const a = rawRegister(port, 'rezcap-a', rezcapApi);
    expect((await a.result).ok).toBe(true);
    try {
      a.ws.close();
    } catch {
      /* ignore */
    }

    const b = rawRegister(port, 'rezcap-b', rezcapApi);
    expect((await b.result).ok).toBe(true);
    try {
      b.ws.close();
    } catch {
      /* ignore */
    }

    // Third distinct id exceeds the cap → rejected.
    const c = rawRegister(port, 'rezcap-c', rezcapApi);
    const res = await c.result;
    try {
      c.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(false);
    expect(res.code).toBe(4029);
  }, 15000);

  test('re-registering an already-held id is free (does not count against the cap)', async () => {
    const again = rawRegister(port, 'rezcap-a', rezcapApi);
    const res = await again.result;
    try {
      again.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(true);
  }, 15000);
});

describe('handle revocation (#3)', () => {
  test('root can revoke a reserved handle, freeing it for another account', async () => {
    // cap reserves it, disconnects — the id stays reserved to cap.
    const owner = rawRegister(port, 'revoke-me', capApi);
    expect((await owner.result).ok).toBe(true);
    try {
      owner.ws.close();
    } catch {
      /* ignore */
    }

    // A different account is refused while cap owns it.
    const before = rawRegister(port, 'revoke-me', hdrApi);
    expect((await before.result).code).toBe(4002);
    try {
      before.ws.close();
    } catch {
      /* ignore */
    }

    // Root revokes the handle.
    const revoke = await admin(port, 'DELETE', '/admin/reservations/revoke-me', ROOT_TOKEN);
    expect(revoke.status).toBe(200);
    expect(revoke.json.revoked).toBe(true);

    // Now the other account can take it.
    const after = rawRegister(port, 'revoke-me', hdrApi);
    const res = await after.result;
    try {
      after.ws.close();
    } catch {
      /* ignore */
    }
    expect(res.ok).toBe(true);
  }, 20000);

  test('a non-root caller cannot revoke (403)', async () => {
    const r = await admin(port, 'DELETE', '/admin/reservations/anything', acmeService);
    expect(r.status).toBe(403);
  });
});

describe('abuse reports (#3)', () => {
  test('anyone can file a report; root can review them', async () => {
    const filed = await admin(port, 'POST', '/report', null, { tunnelId: 'phishy', reason: 'phishing' });
    expect(filed.status).toBe(200);
    expect(filed.json.ok).toBe(true);

    const list = await admin(port, 'GET', '/admin/reports', ROOT_TOKEN);
    expect(list.status).toBe(200);
    const reports = list.json.reports as Array<{ tunnelId: string; reason: string }>;
    expect(reports.some((r) => r.tunnelId === 'phishy' && r.reason === 'phishing')).toBe(true);
  });

  test('a report without a tunnelId is rejected (400)', async () => {
    const r = await admin(port, 'POST', '/report', null, { reason: 'no target' });
    expect(r.status).toBe(400);
  });

  test('reviewing reports requires root (403)', async () => {
    const r = await admin(port, 'GET', '/admin/reports', acmeService);
    expect(r.status).toBe(403);
  });
});
