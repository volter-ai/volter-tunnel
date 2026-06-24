/**
 * LIVE end-to-end proof of tunnel metering against the deployed Cloudflare relay.
 *
 *  control: https://volter-tunnel.aaron-0ed.workers.dev   (clients connect /ws?id=)
 *  data:    https://<id>.voltertest.xyz                    (real TLS, real edge)
 *
 * Proves, over the internet:
 *  1. root creates an account + mints an api token via the live /admin API
 *  2. a real tunnel registers with that api token through the live relay
 *  3. exactly dayLimit requests succeed, then the relay returns 429 with
 *     RateLimit-* headers + Retry-After (the hard cutoff)
 *  4. usage is reported by the live /admin usage endpoint
 *  5. back-compat: the legacy TUNNEL_SECRET still registers + serves (internal acct)
 *
 * Run: cd server-cf && npx tsx proof-metering.ts
 */
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { createTunnel } from '../client/tunnel-client.ts';

const CONTROL = 'https://volter-tunnel.aaron-0ed.workers.dev';
const ROOT = readFileSync(new URL('./.root-token', import.meta.url), 'utf8').trim();
const NO_LOG = { info() {}, warn() {}, debug() {} };

function readLegacySecret(): string | null {
  try {
    const env = readFileSync('/Users/yueranyuan/volter/minimal-claude/gateway/.env', 'utf8');
    const m = env.match(/^TUNNEL_SECRET=(.*)$/m);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

async function admin(method: string, path: string, token: string | null, body?: unknown) {
  const res = await fetch(CONTROL + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });

function startOrigin(port: number, tag: string): Promise<http.Server> {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`live-ok:${tag}`);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

async function main() {
  const checks: Array<[string, boolean]> = [];
  const slug = 'proof-' + Date.now().toString(36);
  console.log(`ROOT token loaded (len ${ROOT.length}); proof account = ${slug}`);

  // 1. create account
  const acct = await admin('POST', '/admin/accounts', ROOT, {
    slug,
    name: 'Live proof',
    dayLimit: 5,
    monthLimit: 100,
    leaseChunk: 1,
    concurrentMax: 5,
  });
  console.log(`create account → ${acct.status}`);
  if (acct.status !== 201) throw new Error('account create failed: ' + JSON.stringify(acct.json));
  const service = acct.json.serviceToken as string;
  checks.push(['root created account + got service token', service?.startsWith('vts_' + slug + '_')]);

  // 2. mint api token
  const tok = await admin('POST', `/admin/accounts/${slug}/tokens`, service, { kind: 'api', label: 'proof' });
  const api = tok.json.token as string;
  checks.push(['service minted api token', !!api && api.startsWith('vta_' + slug + '_')]);

  // 3. tunnel via live relay with api token
  const originPort = await freePort();
  const origin = await startOrigin(originPort, 'api');
  const tunnel = await createTunnel({
    port: originPort,
    host: CONTROL,
    tunnelId: slug + '-t',
    secret: api,
    authRequired: false,
    logger: NO_LOG,
  });
  console.log(`tunnel up: ${tunnel.url}`);
  await new Promise((r) => setTimeout(r, 1500)); // let the edge settle

  // 4. drive requests over the internet
  const statuses: number[] = [];
  let firstHeaders: Record<string, string> = {};
  let overHeaders: Record<string, string> = {};
  for (let i = 0; i < 7; i++) {
    const res = await fetch(tunnel.url + '/hello');
    await res.text();
    statuses.push(res.status);
    const h = Object.fromEntries(res.headers) as Record<string, string>;
    if (i === 0) firstHeaders = h;
    if (res.status === 429 && !overHeaders['retry-after']) overHeaders = h;
  }
  console.log(`statuses: ${statuses.join(',')}`);
  console.log(
    `first 200 headers: ratelimit-limit=${firstHeaders['ratelimit-limit']} remaining=${firstHeaders['ratelimit-remaining']} reset=${firstHeaders['ratelimit-reset']}`
  );
  console.log(
    `429 headers: retry-after=${overHeaders['retry-after']} ratelimit-remaining=${overHeaders['ratelimit-remaining']}`
  );

  checks.push(['exactly 5 requests served', statuses.slice(0, 5).every((s) => s === 200)]);
  checks.push(['6th + 7th request 429 (hard cutoff)', statuses[5] === 429 && statuses[6] === 429]);
  checks.push(['200 carried RateLimit-Limit=5', firstHeaders['ratelimit-limit'] === '5']);
  checks.push(['429 carried Retry-After', Number(overHeaders['retry-after']) > 0]);
  checks.push(['429 carried RateLimit-Remaining=0', overHeaders['ratelimit-remaining'] === '0']);

  // 5. usage endpoint
  const usage = await admin('GET', `/admin/accounts/${slug}/usage`, service);
  const day = usage.json.day as { used: number; remaining: number; limit: number };
  console.log(`usage day: ${JSON.stringify(day)}`);
  checks.push(['usage shows drained (remaining 0)', day?.remaining === 0 && day?.used >= 5]);

  tunnel.close();
  origin.close();

  // 6. back-compat: legacy TUNNEL_SECRET registers + serves under internal account
  const legacy = readLegacySecret();
  if (legacy) {
    const lp = await freePort();
    const lo = await startOrigin(lp, 'legacy');
    try {
      const lt = await createTunnel({
        port: lp,
        host: CONTROL,
        tunnelId: slug + '-legacy',
        secret: legacy,
        authRequired: false,
        logger: NO_LOG,
      });
      await new Promise((r) => setTimeout(r, 1200));
      const res = await fetch(lt.url + '/hello');
      const body = await res.text();
      console.log(`legacy tunnel: ${lt.url} → ${res.status} "${body}"`);
      checks.push(['legacy TUNNEL_SECRET still works (back-compat)', res.status === 200 && body === 'live-ok:legacy']);
      lt.close();
    } catch (e) {
      checks.push(['legacy TUNNEL_SECRET still works (back-compat)', false]);
      console.log('legacy proof error:', e instanceof Error ? e.message : e);
    }
    lo.close();
  } else {
    console.log('(skipped legacy back-compat check — gateway/.env TUNNEL_SECRET not found)');
  }

  console.log('\n── results ──');
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✅' : '❌'} ${name}`);
    if (!ok) allPass = false;
  }
  console.log(allPass ? '\nLIVE PROOF PASS ✅' : '\nLIVE PROOF FAIL ❌');
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error('LIVE PROOF ERROR', e);
  process.exit(1);
});
