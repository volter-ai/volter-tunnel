/**
 * Live proof via a REAL per-tunnel subdomain on Cloudflare (no ?__tunnel hack).
 *
 *   npx tsx proof-subdomain.ts <control-host> <subdomain-url> <tunnelId> <secret>
 *
 * Control socket connects out to <control-host> (/ws?id=); browser traffic hits
 * the real subdomain <subdomain-url> → CF edge → Worker (Host routing) → DO.
 */
import http from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { createTunnel } from '../client/tunnel-client.ts';

const [controlHost, subUrl, ID, SECRET] = process.argv.slice(2);
if (!controlHost || !subUrl || !ID) throw new Error('usage: tsx proof-subdomain.ts <control-host> <subdomain-url> <id> <secret>');
const WSS = subUrl.replace(/^http/, 'ws');
const NO_LOG = { info() {}, warn() {}, debug() {} };
const results: string[] = [];
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
  if (!ok) failures++;
};
const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });

async function main() {
  const originPort = await freePort();
  const origin = http.createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200);
      res.end('hello via real subdomain');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  const wss = new WebSocketServer({ server: origin });
  wss.on('connection', (ws) => {
    ws.send('welcome');
    ws.on('message', (m) => ws.send(`echo:${m}`));
  });
  await new Promise<void>((r) => origin.listen(originPort, '127.0.0.1', r));

  const tunnel = await createTunnel({
    port: originPort,
    host: controlHost,
    tunnelId: ID,
    secret: SECRET || undefined,
    authRequired: false,
    logger: NO_LOG,
  });
  check('control registered; server-issued public URL', tunnel.url === subUrl, tunnel.url);

  const r1 = await fetch(`${subUrl}/hello`);
  check('HTTP GET via REAL subdomain → DO → origin', r1.status === 200, `status=${r1.status} body=${JSON.stringify(await r1.text())}`);

  const r2 = await fetch(`${subUrl}/missing`);
  check('404 passthrough via real subdomain', r2.status === 404);

  const msgs: string[] = [];
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${WSS}/`);
    const t = setTimeout(resolve, 10000);
    ws.on('open', () => ws.send('ping'));
    ws.on('message', (m) => {
      msgs.push(m.toString());
      if (msgs.includes('echo:ping')) {
        clearTimeout(t);
        ws.close();
        resolve();
      }
    });
    ws.on('error', () => {
      clearTimeout(t);
      resolve();
    });
  });
  check('WebSocket relay via real subdomain', msgs.includes('welcome') && msgs.includes('echo:ping'), JSON.stringify(msgs));

  tunnel.close();
  await new Promise<void>((r) => origin.close(() => r()));
  process.stderr.write(`\n=== REAL-SUBDOMAIN CLOUDFLARE PROOF (${subUrl}) ===\n${results.join('\n')}\n`);
  process.stderr.write(failures === 0 ? '\nALL PASSED ✅\n' : `\n${failures} FAILED ❌\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => {
  process.stderr.write('PROOF ERROR: ' + (e instanceof Error ? e.stack : String(e)) + '\n');
  process.exit(1);
});
