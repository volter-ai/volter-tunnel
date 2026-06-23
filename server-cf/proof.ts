/**
 * Live proof against the DEPLOYED Cloudflare relay.
 *
 * Runs a local HTTP+WS origin on this machine, opens a tunnel to the deployed
 * Worker over the real internet (wss), then drives traffic back through
 * Cloudflare's edge → Durable Object → control socket → this client → origin.
 *
 *   npx tsx proof.ts https://volter-tunnel.<acct>.workers.dev
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnel } from '../client/tunnel-client.ts';

const RELAY = process.argv[2];
if (!RELAY) throw new Error('usage: tsx proof.ts <relay-https-url>');
const WSS = RELAY.replace(/^http/, 'ws');
const ID = `proof-${Date.now().toString(36)}`;
const NO_LOG = { info() {}, warn() {}, debug() {} };
const results: string[] = [];
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

async function main() {
  const originPort = await freePort();
  const origin = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200);
      res.end('hello from origin');
    } else if (req.url === '/stream') {
      res.writeHead(200);
      res.write('a-');
      setTimeout(() => {
        res.write('b-');
        setTimeout(() => res.end('c'), 20);
      }, 20);
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  const wss = new WebSocketServer({ server: origin });
  wss.on('connection', (ws) => {
    ws.send('welcome');
    ws.on('message', (m) => ws.send(`echo:${m.toString()}`));
  });
  await new Promise<void>((r) => origin.listen(originPort, '127.0.0.1', r));

  const tunnel = await createTunnel({
    port: originPort,
    host: RELAY,
    tunnelId: ID,
    authRequired: false,
    logger: NO_LOG,
  });
  check('control WS registered (wss → CF → DO)', tunnel.url.includes(ID), tunnel.url);

  // HTTP GET through the deployed relay
  const r1 = await fetch(`${RELAY}/hello?__tunnel=${ID}`);
  check('HTTP GET round-trips through deployed DO', r1.status === 200, `status=${r1.status} body=${JSON.stringify(await r1.text())}`);

  // Streaming response through the deployed relay
  const r2 = await fetch(`${RELAY}/stream?__tunnel=${ID}`);
  const body2 = await r2.text();
  check('streamed response reassembled', body2 === 'a-b-c', `body=${JSON.stringify(body2)}`);

  // 404 passthrough
  const r3 = await fetch(`${RELAY}/missing?__tunnel=${ID}`);
  check('404 from origin passes through', r3.status === 404);

  // WebSocket relay through the deployed relay
  const wsMessages: string[] = [];
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${WSS}/?__tunnel=${ID}`);
    const timer = setTimeout(() => resolve(), 10000);
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => {
      wsMessages.push(m.toString());
      if (wsMessages.includes('echo:ping')) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  check(
    'WebSocket relay bidirectional (browser ⇄ CF DO ⇄ origin)',
    wsMessages.includes('welcome') && wsMessages.includes('echo:ping'),
    JSON.stringify(wsMessages)
  );

  tunnel.close();
  await new Promise<void>((r) => origin.close(() => r()));

  process.stderr.write(`\n=== LIVE CLOUDFLARE PROOF (relay=${RELAY}, tunnelId=${ID}) ===\n`);
  for (const line of results) process.stderr.write(line + '\n');
  process.stderr.write(failures === 0 ? '\nALL PASSED ✅\n' : `\n${failures} FAILED ❌\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write('PROOF ERROR: ' + (e instanceof Error ? e.stack : String(e)) + '\n');
  process.exit(1);
});
