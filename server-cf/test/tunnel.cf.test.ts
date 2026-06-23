/**
 * End-to-end test of the Cloudflare relay running in real `workerd`.
 *
 * Boots the Worker + Durable Object via `wrangler dev --local`, stands up a local
 * HTTP+WS origin, opens a tunnel with the real `createTunnel` client (which now
 * appends `?id=<tunnelId>` so the Worker routes the control socket to the right
 * DO), and drives traffic through the relay. Same contract as the Fly suite:
 * HTTP, POST echo, streaming, 404, WebSocket relay, JWT auth.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { createTunnel, type TunnelHandle } from '../../client/tunnel-client.ts';

const DOMAIN = 'tunnel.test';
const SECRET = 'cf-e2e-secret';
const JWT_SECRET = 'cf-e2e-jwt';
const NO_LOG = { info() {}, warn() {}, debug() {} };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function requestViaTunnel(
  relayPort: number,
  tunnelId: string,
  opts: { path: string; method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: relayPort,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { Host: `${tunnelId}.${DOMAIN}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let relayPort: number;
let originPort: number;
let worker: Unstable_DevWorker;
let origin: http.Server;
let originWss: WebSocketServer;
let tunnel: TunnelHandle;
const TUNNEL_ID = 'cftun';

beforeAll(async () => {
  relayPort = await freePort();
  originPort = await freePort();

  // Local origin: HTTP + WebSocket echo (identical to the Fly suite's origin).
  origin = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from origin');
    } else if (req.url === '/echo' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => {
        b += c;
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end(`echo:${b}`);
      });
    } else if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk1-');
      setTimeout(() => {
        res.write('chunk2-');
        setTimeout(() => res.end('chunk3'), 15);
      }, 15);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  originWss = new WebSocketServer({ server: origin });
  originWss.on('connection', (ws) => {
    ws.send('welcome');
    ws.on('message', (m) => ws.send(`echo:${m.toString()}`));
  });
  await new Promise<void>((r) => origin.listen(originPort, '127.0.0.1', r));

  // Boot the Worker + DO in real workerd via wrangler's programmatic API.
  // Resolves only once the dev server is ready; manages its own port.
  worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.jsonc',
    local: true,
    vars: { TUNNEL_DOMAIN: DOMAIN, TUNNEL_SECRET: SECRET, JWT_SECRET },
    experimental: { disableExperimentalWarning: true },
  });
  relayPort = worker.port;

  tunnel = await createTunnel({
    port: originPort,
    host: `http://127.0.0.1:${relayPort}`,
    tunnelId: TUNNEL_ID,
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
  originWss?.close();
  await new Promise<void>((r) => origin?.close(() => r()));
});

test('registers and returns an https public URL (no port suffix on CF)', () => {
  expect(tunnel.url).toBe(`https://${TUNNEL_ID}.${DOMAIN}`);
  expect(tunnel.tunnelId).toBe(TUNNEL_ID);
});

test('forwards an HTTP GET to the origin and relays the response', async () => {
  const res = await requestViaTunnel(relayPort, TUNNEL_ID, { path: '/hello' });
  expect(res.status).toBe(200);
  expect(res.body).toBe('hello from origin');
});

test('forwards a POST body and relays the echoed response', async () => {
  const res = await requestViaTunnel(relayPort, TUNNEL_ID, {
    path: '/echo',
    method: 'POST',
    body: 'payload-123',
    headers: { 'content-type': 'text/plain' },
  });
  expect(res.status).toBe(200);
  expect(res.body).toBe('echo:payload-123');
});

test('relays a chunked/streamed response in full', async () => {
  const res = await requestViaTunnel(relayPort, TUNNEL_ID, { path: '/stream' });
  expect(res.status).toBe(200);
  expect(res.body).toBe('chunk1-chunk2-chunk3');
});

test('returns 404 from the origin through the tunnel', async () => {
  const res = await requestViaTunnel(relayPort, TUNNEL_ID, { path: '/nope' });
  expect(res.status).toBe(404);
});

test('relays a WebSocket connection bidirectionally', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/`, {
    headers: { Host: `${TUNNEL_ID}.${DOMAIN}` },
  });
  const messages: string[] = [];
  const echoed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws echo timeout')), 8000);
    ws.on('message', (m) => {
      messages.push(m.toString());
      if (messages.includes('echo:ping')) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send('ping');
  await echoed;
  ws.close();
  expect(messages).toContain('welcome');
  expect(messages).toContain('echo:ping');
});

describe('JWT auth (authRequired tunnel)', () => {
  let authTunnel: TunnelHandle;
  const AUTH_ID = 'cfauth';

  beforeAll(async () => {
    authTunnel = await createTunnel({
      port: originPort,
      host: `http://127.0.0.1:${relayPort}`,
      tunnelId: AUTH_ID,
      secret: SECRET,
      authRequired: true,
      logger: NO_LOG,
    });
  }, 15000);

  afterAll(() => {
    try {
      authTunnel?.close();
    } catch {
      /* ignore */
    }
  });

  test('rejects an unauthenticated request with 401', async () => {
    const res = await requestViaTunnel(relayPort, AUTH_ID, { path: '/hello' });
    expect(res.status).toBe(401);
  });

  test('allows a request bearing a valid JWT', async () => {
    const token = jwt.sign({ sub: 'tester' }, JWT_SECRET, { algorithm: 'HS256' });
    const res = await requestViaTunnel(relayPort, AUTH_ID, {
      path: '/hello',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello from origin');
  });
});
