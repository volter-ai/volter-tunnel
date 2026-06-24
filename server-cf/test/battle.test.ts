/**
 * Battle test — hammers the relay in real workerd: concurrency, large bodies,
 * streaming, many WebSockets, multi-tunnel isolation, origin errors, auth
 * rejection, and malformed/abusive control input (must not crash the DO).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { createTunnel, type TunnelHandle } from '../../client/tunnel-client.ts';

const DOMAIN = 'tunnel.test';
const SECRET = 'battle-secret';
const NO_LOG = { info() {}, warn() {}, debug() {} };

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

/** A local origin that streams `?n` bytes at /big, echoes size at /size, etc. */
function makeOrigin(tag: string): { server: http.Server; port: Promise<number> } {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/hello') {
      res.writeHead(200);
      res.end(`ok:${tag}`);
    } else if (u.pathname === '/size' && req.method === 'POST') {
      let n = 0;
      req.on('data', (c) => {
        n += c.length;
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end(`len:${n}`);
      });
    } else if (u.pathname === '/big') {
      const total = Number(u.searchParams.get('n') ?? '500000');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      let sent = 0;
      const chunk = Buffer.alloc(32 * 1024, 65);
      const pump = () => {
        while (sent < total) {
          const take = Math.min(chunk.length, total - sent);
          sent += take;
          if (!res.write(chunk.subarray(0, take))) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
    } else if (u.pathname === '/500') {
      res.writeHead(500);
      res.end('boom');
    } else {
      res.writeHead(404);
      res.end('nf');
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.send('welcome');
    ws.on('message', (m) => ws.send(`echo:${m}`));
  });
  const port = new Promise<number>((r) =>
    server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))
  );
  return { server, port };
}

function req(
  relayPort: number,
  tunnelId: string,
  opts: { path: string; method?: string; body?: string | Buffer }
): Promise<{ status: number; bytes: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: relayPort,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { Host: `${tunnelId}.${DOMAIN}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, bytes: buf.length, body: buf.toString() });
        });
      }
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

let worker: Unstable_DevWorker;
let relayPort: number;
let origin: http.Server;
let originPort: number;
let tunnel: TunnelHandle;
const ID = 'battle';

beforeAll(async () => {
  // Hermetic start: clear persisted DO state so the internal account bootstraps
  // fresh (other suites may have left it with a low metered limit).
  for (const cls of ['AccountDO', 'RegistryDO', 'TunnelDO']) {
    rmSync(`.wrangler/state/v3/do/volter-tunnel-test-${cls}`, { recursive: true, force: true });
  }
  const o = makeOrigin('main');
  origin = o.server;
  originPort = await o.port;

  worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.test.jsonc',
    local: true,
    vars: { TUNNEL_DOMAIN: DOMAIN, TUNNEL_SECRET: SECRET, JWT_SECRET: '' },
    experimental: { disableExperimentalWarning: true },
  });
  relayPort = worker.port;

  tunnel = await createTunnel({
    port: originPort,
    host: `http://127.0.0.1:${relayPort}`,
    tunnelId: ID,
    secret: SECRET,
    authRequired: false,
    logger: NO_LOG,
  });
}, 70000);

afterAll(async () => {
  try {
    tunnel?.close();
  } catch {
    /* ignore */
  }
  await worker?.stop();
  await new Promise<void>((r) => origin?.close(() => r()));
});

test('50 concurrent HTTP requests all succeed', async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => req(relayPort, ID, { path: '/hello' })));
  expect(results.every((r) => r.status === 200 && r.body === 'ok:main')).toBe(true);
}, 20000);

test('large request body under the cap (700KB) succeeds', async () => {
  const body = Buffer.alloc(700 * 1024, 120);
  const r = await req(relayPort, ID, { path: '/size', method: 'POST', body });
  expect(r.status).toBe(200);
  expect(r.body).toBe(`len:${body.length}`);
}, 20000);

test('oversized request body (900KB) is rejected fast with 413', async () => {
  const body = Buffer.alloc(900 * 1024, 120);
  const t0 = Date.now();
  const r = await req(relayPort, ID, { path: '/size', method: 'POST', body });
  expect(r.status).toBe(413);
  expect(Date.now() - t0).toBeLessThan(5000); // fast, not a 30s hang
}, 20000);

test('large streamed response (1MB) reassembles exactly', async () => {
  const r = await req(relayPort, ID, { path: '/big?n=1048576' });
  expect(r.status).toBe(200);
  expect(r.bytes).toBe(1048576);
}, 30000);

test('origin 500 is relayed through', async () => {
  const r = await req(relayPort, ID, { path: '/500' });
  expect(r.status).toBe(500);
  expect(r.body).toBe('boom');
});

test('20 concurrent WebSocket connections all relay', async () => {
  const one = (i: number) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/`, { headers: { Host: `${ID}.${DOMAIN}` } });
      const seen: string[] = [];
      const timer = setTimeout(() => resolve(false), 12000);
      ws.on('open', () => ws.send(`ping${i}`));
      ws.on('message', (m) => {
        seen.push(m.toString());
        if (seen.includes(`echo:ping${i}`)) {
          clearTimeout(timer);
          ws.close();
          resolve(seen.includes('welcome'));
        }
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  const oks = await Promise.all(Array.from({ length: 20 }, (_, i) => one(i)));
  expect(oks.every(Boolean)).toBe(true);
}, 30000);

describe('multi-tunnel isolation', () => {
  const tunnels: TunnelHandle[] = [];
  const origins: http.Server[] = [];
  const ids = ['iso-a', 'iso-b', 'iso-c'];

  beforeAll(async () => {
    for (const id of ids) {
      const o = makeOrigin(id);
      origins.push(o.server);
      const port = await o.port;
      tunnels.push(
        await createTunnel({
          port,
          host: `http://127.0.0.1:${relayPort}`,
          tunnelId: id,
          secret: SECRET,
          authRequired: false,
          logger: NO_LOG,
        })
      );
    }
  }, 30000);

  afterAll(async () => {
    for (const t of tunnels) {
      try {
        t.close();
      } catch {
        /* ignore */
      }
    }
    await Promise.all(origins.map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  test('each tunnelId routes to its own DO/origin concurrently', async () => {
    const results = await Promise.all(ids.map((id) => req(relayPort, id, { path: '/hello' })));
    expect(results.map((r) => r.body)).toEqual(['ok:iso-a', 'ok:iso-b', 'ok:iso-c']);
  }, 20000);
});

describe('abuse / malformed input does not crash the DO', () => {
  function rawWs(id: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${relayPort}/ws?id=${id}`);
  }

  test('register with wrong secret is rejected (4003)', async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = rawWs('bad-secret');
      const timer = setTimeout(() => resolve(-1), 8000);
      ws.on('open', () =>
        ws.send(JSON.stringify({ type: 'register', tunnelId: 'bad-secret', secret: 'WRONG' }))
      );
      ws.on('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      ws.on('error', () => {});
    });
    expect(code).toBe(4003);
  }, 12000);

  test('garbage frames then a valid register still works (DO survives)', async () => {
    const url = await new Promise<string>((resolve, reject) => {
      const ws = rawWs('survivor');
      const timer = setTimeout(() => reject(new Error('no registered reply')), 8000);
      ws.on('open', () => {
        ws.send('not json at all');
        ws.send(JSON.stringify({ type: 'bogus', foo: 1 }));
        ws.send(Buffer.from([0, 1, 2, 3, 255]));
        ws.send(JSON.stringify({ type: 'register', tunnelId: 'survivor', secret: SECRET, authRequired: false }));
      });
      ws.on('message', (m) => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'registered') {
          clearTimeout(timer);
          ws.close();
          resolve(msg.url);
        }
      });
      ws.on('error', reject);
    });
    expect(url).toBe('https://survivor.tunnel.test');
  }, 12000);
});
