/**
 * Inspector replay + persisted capture (#10) in real workerd. With INSPECT_REPLAY
 * on, a request is captured; POSTing its id to /__volter_replay re-issues it
 * through the tunnel to the origin (e.g. re-firing a webhook).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { type Unstable_DevWorker, unstable_dev } from 'wrangler';
import { createTunnel, type TunnelHandle } from '../../client/tunnel-client.ts';

const DOMAIN = 'tunnel.test';
const SECRET = 'replay-secret';
const NO_LOG = { info() {}, warn() {}, debug() {} };

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

function reqOnce(
  relayPort: number,
  tunnelId: string,
  opts: { path: string; method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port: relayPort,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: { Host: `${tunnelId}.${DOMAIN}`, ...(opts.headers ?? {}) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
      }
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// The wrangler dev runtime occasionally evicts the worker isolate and answers an
// in-flight request with a 503 "Your worker restarted mid-request… please try
// again" — a harness artifact, not an app response. It auto-retries GET/HEAD but
// not POST, so retry that specific transient ourselves to keep the suite stable.
async function req(
  relayPort: number,
  tunnelId: string,
  opts: { path: string; method?: string; body?: string; headers?: Record<string, string> }
): Promise<{ status: number; body: string }> {
  let res = await reqOnce(relayPort, tunnelId, opts);
  if (res.status === 503 && res.body.includes('worker restarted')) {
    res = await reqOnce(relayPort, tunnelId, opts);
  }
  return res;
}

let worker: Unstable_DevWorker;
let relayPort: number;
let originPort: number;
let origin: http.Server;
let tunnel: TunnelHandle;
let hookCount = 0;
const TUNNEL_ID = 'replaytun';

beforeAll(async () => {
  for (const cls of ['AccountDO', 'RegistryDO', 'TunnelDO']) {
    rmSync(`.wrangler/state/v3/do/volter-tunnel-test-${cls}`, { recursive: true, force: true });
  }
  originPort = await freePort();

  origin = http.createServer((r, res) => {
    if (r.url === '/hook' && r.method === 'POST') {
      hookCount += 1;
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        res.writeHead(200);
        res.end(`hook:${hookCount}:${b}`);
      });
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => origin.listen(originPort, '127.0.0.1', r));

  worker = await unstable_dev('src/worker.ts', {
    config: 'wrangler.test.jsonc',
    local: true,
    vars: { TUNNEL_DOMAIN: DOMAIN, TUNNEL_SECRET: SECRET, JWT_SECRET: '', INSPECT_REPLAY: 'true' },
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
  await new Promise<void>((r) => origin?.close(() => r()));
});

describe('inspector replay (#10)', () => {
  test('captures a request and replays it through the tunnel', async () => {
    // Original request — origin sees it once.
    const first = await req(relayPort, TUNNEL_ID, { path: '/hook', method: 'POST', body: 'payload' });
    expect(first.status).toBe(200);
    expect(first.body).toBe('hook:1:payload');

    // Find the captured request's id (owner-only endpoint → present the secret).
    const auth = { Authorization: `Bearer ${SECRET}` };
    const insp = await req(relayPort, TUNNEL_ID, { path: '/__volter_inspect', headers: auth });
    const data = JSON.parse(insp.body) as {
      replay: boolean;
      entries: Array<{ id: string; method: string; path: string }>;
    };
    expect(data.replay).toBe(true);
    const entry = data.entries.find((e) => e.path === '/hook' && e.method === 'POST');
    expect(entry).toBeTruthy();

    // Replay it — origin sees the SAME request again, with the same body.
    const replay = await req(relayPort, TUNNEL_ID, {
      path: '/__volter_replay',
      method: 'POST',
      body: JSON.stringify({ id: entry!.id }),
      headers: auth,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toBe('hook:2:payload');
    expect(hookCount).toBe(2);
  }, 20000);

  test('replay requires the tunnel secret (401 without it)', async () => {
    const r = await req(relayPort, TUNNEL_ID, {
      path: '/__volter_replay',
      method: 'POST',
      body: JSON.stringify({ id: 'whatever' }),
    });
    expect(r.status).toBe(401);
  });

  test('replaying an unknown id is a 404', async () => {
    const r = await req(relayPort, TUNNEL_ID, {
      path: '/__volter_replay',
      method: 'POST',
      body: JSON.stringify({ id: 'nope' }),
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(r.status).toBe(404);
  });
});
