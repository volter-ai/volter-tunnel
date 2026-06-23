/**
 * End-to-end tunnel test: real relay server + real client + a real local origin.
 *
 * Boots server/server.mjs on a free port, stands up a local HTTP+WebSocket
 * origin, opens a tunnel with createTunnel(), then drives traffic THROUGH the
 * relay (routing by `Host: <tunnelId>.<domain>`) and asserts it reaches the
 * origin and comes back. No mocks.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnel, type TunnelHandle } from '../client/tunnel-client.ts';

const DOMAIN = 'tunnel.test';
const SECRET = 'e2e-test-secret';
const JWT_SECRET = 'e2e-jwt-secret';
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

function waitFor(fn: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch {
        /* keep polling */
      }
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for ${label}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Raw HTTP request through the relay — lets us set the Host header freely. */
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
let serverProc: ChildProcess;
let origin: http.Server;
let originWss: WebSocketServer;
let tunnel: TunnelHandle;
const TUNNEL_ID = 'e2etun';

beforeAll(async () => {
  relayPort = await freePort();
  originPort = await freePort();

  // ── Local origin: HTTP + WebSocket echo ──────────────────────────────────
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

  // ── Relay server (real server.mjs child process) ─────────────────────────
  serverProc = spawn('node', ['server/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(relayPort),
      TUNNEL_DOMAIN: DOMAIN,
      TUNNEL_SECURE: 'false',
      TUNNEL_SECRET: SECRET,
      JWT_SECRET,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await waitFor(
    () =>
      new Promise<boolean>((resolve) => {
        const r = http.request(
          { host: '127.0.0.1', port: relayPort, path: '/api/status', method: 'GET' },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          }
        );
        r.on('error', () => resolve(false));
        r.end();
      }),
    8000,
    'relay server ready'
  );

  // ── Open the tunnel (auth disabled by default for most tests) ────────────
  tunnel = await createTunnel({
    port: originPort,
    host: `http://127.0.0.1:${relayPort}`,
    tunnelId: TUNNEL_ID,
    secret: SECRET,
    authRequired: false,
    logger: NO_LOG,
  });
}, 20000);

afterAll(async () => {
  try {
    tunnel?.close();
  } catch {
    /* ignore */
  }
  serverProc?.kill('SIGKILL');
  originWss?.close();
  await new Promise<void>((r) => origin?.close(() => r()));
});

test('registers and returns a public URL on the configured domain', () => {
  expect(tunnel.url).toBe(`http://${TUNNEL_ID}.${DOMAIN}:${relayPort}`);
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
    const timer = setTimeout(() => reject(new Error('ws echo timeout')), 5000);
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
  let authPort: number;
  let authTunnel: TunnelHandle;
  const AUTH_ID = 'e2eauth';

  beforeAll(async () => {
    authPort = originPort; // reuse the same origin
    authTunnel = await createTunnel({
      port: authPort,
      host: `http://127.0.0.1:${relayPort}`,
      tunnelId: AUTH_ID,
      secret: SECRET,
      authRequired: true,
      logger: NO_LOG,
    });
  }, 10000);

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
