/**
 * Reconnect/backoff behavior of createTunnel, driven against a stub WebSocket
 * relay (the `ws` server) — covers the control-socket reconnect loop that the
 * e2e/unit suites otherwise don't exercise.
 */
import net from 'node:net';
import { afterEach, describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';
import { createTunnel } from '../client/tunnel-client.ts';

const NO_LOG = { info() {}, warn() {}, debug() {} };

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('createTunnel reconnect', () => {
  test('re-registers after the relay drops the control socket', async () => {
    const port = await freePort();
    let registers = 0;
    const wss = new WebSocketServer({ port, path: '/ws' });
    cleanups.push(() => wss.close());
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') {
          registers += 1;
          ws.send(JSON.stringify({ type: 'registered', tunnelId: msg.tunnelId ?? 't', url: 'http://example' }));
          if (registers === 1) setTimeout(() => ws.close(), 50); // drop once to force a reconnect
        }
      });
    });

    const tunnel = await createTunnel({
      port: 1,
      host: `http://127.0.0.1:${port}`,
      tunnelId: 't',
      authRequired: false,
      logger: NO_LOG,
    });
    cleanups.push(() => tunnel.close());

    // first registration resolved createTunnel; the drop + ~1s backoff yields a 2nd
    await sleep(2500);
    expect(registers).toBeGreaterThanOrEqual(2);
  }, 15000);

  test('does not retry when the relay rejects before registration', async () => {
    const port = await freePort();
    let connections = 0;
    const wss = new WebSocketServer({ port, path: '/ws' });
    cleanups.push(() => wss.close());
    wss.on('connection', (ws) => {
      connections += 1;
      ws.on('message', () => {
        ws.send(JSON.stringify({ type: 'error', message: 'denied' }));
        setTimeout(() => ws.close(), 20);
      });
    });

    await expect(
      createTunnel({ port: 1, host: `http://127.0.0.1:${port}`, tunnelId: 't', authRequired: false, logger: NO_LOG })
    ).rejects.toThrow(/denied/);

    await sleep(1500); // would-be backoff window
    expect(connections).toBe(1); // never registered → no retry
  }, 15000);
});
