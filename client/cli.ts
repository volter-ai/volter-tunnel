#!/usr/bin/env node
/**
 * volter-tunnel CLI — the `bin`. Thin command layer over the SDK (createTunnel):
 * `login` proves a GitHub identity and saves an api token; the default form
 * exposes a local port and prints the public URL. Output formatting only — all
 * tunnel logic lives in the library.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTunnel, DEFAULT_HOST, type TunnelLogger, type TunnelOptions, VolterClient } from './tunnel-client';
import { formatUsage, formatWhoami } from './format';

/** True when this file is the process entry (run as the bin), false when merely
 *  imported (e.g. by tests). Portable across Bun and Node (import.meta.main is
 *  only defined in Bun and Node ≥24). */
function invokedDirectly(): boolean {
  return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

/** Path of the saved api token from `volter-tunnel login`. */
function tokenFilePath(): string {
  return path.join(os.homedir(), '.config', 'volter', 'token');
}

/** The api token saved by a prior `login`, if any (used when TUNNEL_SECRET is unset). */
function readSavedToken(): string | undefined {
  try {
    return fs.readFileSync(tokenFilePath(), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `volter-tunnel login` — prove a GitHub identity to the relay and save the api
 * token it mints. Two methods, both via the existing GitHub setup (no OAuth app):
 *   - token (default): send the `gh auth token` to the relay, which verifies it
 *     via the GitHub API and discards it. Override with --token <t>.
 *   - --gist:          relay issues a nonce, we publish it as a public gist, and
 *     the relay reads the gist's public owner — no token ever leaves the machine.
 */
async function runLogin(opts: { host: string; method: 'token' | 'gist'; token?: string }): Promise<void> {
  const host = opts.host.replace(/\/$/, '');
  const { execFileSync } = await import('node:child_process');
  const sh = (cmd: string, a: string[], input?: string): string =>
    execFileSync(cmd, a, { encoding: 'utf8', input }).trim();
  const postJson = async (p: string, body: unknown): Promise<Record<string, unknown>> => {
    const r = await fetch(`${host}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${p} → ${r.status} ${await r.text()}`);
    return (await r.json()) as Record<string, unknown>;
  };

  let resp: Record<string, unknown>;
  if (opts.method === 'gist') {
    // The verifier is kept private (never placed in the public gist) — it binds
    // this verify call to this login session.
    const { nonce, verifier } = (await postJson('/signup/github/gist/start', {})) as {
      nonce: string;
      verifier: string;
    };
    const url = sh('gh', ['gist', 'create', '-p', '-d', 'volter-tunnel identity verification', '-'], nonce);
    const gistId = url.split('/').pop() ?? '';
    resp = await postJson('/signup/github/gist/verify', { gistId, verifier, device: os.hostname() });
  } else {
    const token = opts.token ?? sh('gh', ['auth', 'token']);
    resp = await postJson('/signup/github', { token, device: os.hostname() });
  }

  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(resp.token), { mode: 0o600 });
  console.error(`Logged in as github:${resp.login} (account ${resp.slug}).`);
  console.error(`Saved api token to ${file} — future 'volter-tunnel' runs use it automatically.`);
  console.error('Login complete. The credential was saved locally and will not be printed.');
}

/** A compact, copy-friendly connection banner for the CLI. Written to stderr so
 *  stdout stays just the URL (scripts pipe it). Exported for testing. */
export function formatConnectBanner(url: string, port: number): string {
  return [
    '',
    '  🚇  Tunnel live',
    `      ${url}`,
    `      → forwarding to localhost:${port}`,
    '      Ctrl+C to stop',
    '',
  ].join('\n');
}

/** Best-effort terminal QR of the URL (handy for opening on a phone). Uses the
 *  optional `qrcode-terminal` dependency; silently skipped if it isn't present.
 *  The non-literal import specifier keeps this typecheck-clean without types. */
async function renderQr(url: string, write: (s: string) => void): Promise<void> {
  try {
    const spec = 'qrcode-terminal';
    const mod = await import(spec);
    const qr = (mod.default ?? mod) as {
      generate: (text: string, opts: { small?: boolean }, cb: (out: string) => void) => void;
    };
    await new Promise<void>((resolve) => {
      qr.generate(url, { small: true }, (out: string) => {
        write('\n' + out + '\n');
        resolve();
      });
    });
  } catch {
    /* optional dep absent → URL banner only */
  }
}

// ── command implementations (exported for unit testing; the bin is thin) ──────

/** `whoami` — identity + usage summary (or raw JSON). */
export async function runWhoami(client: VolterClient, json = false): Promise<string> {
  const me = await client.whoami();
  return json ? JSON.stringify(me, null, 2) : formatWhoami(me);
}

/** `usage` — just the usage block (or raw JSON). */
export async function runUsage(client: VolterClient, json = false): Promise<string> {
  const me = await client.whoami();
  return json ? JSON.stringify(me.usage, null, 2) : formatUsage(me.usage);
}

/** List stable ids held by the caller, including the account capacity. */
export async function runReservations(client: VolterClient, json = false): Promise<string> {
  const usage = (await client.whoami()).usage;
  const result = {
    reservedTunnels: usage.reservedTunnels,
    reservedMax: usage.reservedMax,
    used: usage.reservedTunnels.length,
  };
  return json
    ? JSON.stringify(result, null, 2)
    : `Stable ids ${result.used}/${result.reservedMax}: ${result.reservedTunnels.join(', ') || 'none'}`;
}

/** Release one stable id held by the caller. */
export async function runReleaseReservation(client: VolterClient, tunnelId: string | undefined): Promise<string> {
  if (!tunnelId) throw new Error('Usage: volter-tunnel release <tunnel-id>');
  return JSON.stringify(await client.releaseReservation(tunnelId), null, 2);
}

/** List owner-visible device-token metadata without ever printing a secret. */
export async function runTokens(client: VolterClient, json = false): Promise<string> {
  const result = await client.listDeviceTokens();
  if (json) return JSON.stringify(result, null, 2);
  if (!result.tokens.length) return 'Device tokens: none';
  return [
    'Device tokens:',
    ...result.tokens.map((t) => {
      const state = t.revokedAt ? `revoked ${t.revokedAt}` : 'active';
      return `  ${t.id}  …${t.last4}  ${state}${t.current ? '  (current)' : ''}  ${t.label}`;
    }),
  ].join('\n');
}

/** Restore or revoke one selected device token. */
export async function runTokenAction(
  client: VolterClient,
  action: string | undefined,
  tokenId: string | undefined
): Promise<string> {
  if (!tokenId || (action !== 'restore' && action !== 'revoke')) {
    throw new Error('Usage: volter-tunnel token <restore|revoke> <token-id>');
  }
  const result =
    action === 'restore' ? await client.restoreDeviceToken(tokenId) : await client.revokeDeviceToken(tokenId);
  return JSON.stringify(result, null, 2);
}

/** `account <sub> [slug]` admin dispatch → pretty JSON. Throws on a bad subcommand. */
export async function runAccount(
  client: VolterClient,
  sub: string | undefined,
  slug: string | undefined,
  usd: { dayUsd?: number; monthUsd?: number } = {}
): Promise<string> {
  let result: unknown;
  if (sub === 'list') result = await client.usageSummary();
  else if (sub === 'usage' && slug) result = await client.accountUsage(slug);
  else if (sub === 'create' && slug) result = await client.createAccount({ slug, ...usd });
  else if (sub === 'limits' && slug) result = await client.patchLimits(slug, usd);
  else if (sub === 'suspend' && slug) result = await client.setStatus(slug, 'suspended');
  else if (sub === 'resume' && slug) result = await client.setStatus(slug, 'active');
  else {
    throw new Error(
      'Usage: volter-tunnel account <list | usage <slug> | create <slug> | limits <slug> | suspend <slug> | resume <slug>> [--day-usd N] [--month-usd N]'
    );
  }
  return JSON.stringify(result, null, 2);
}

if (invokedDirectly()) {
  const args = process.argv.slice(2);

  function flag(name: string): string | undefined {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  }

  const host = flag('host') || process.env.TUNNEL_SERVER_URL || DEFAULT_HOST;

  // `volter-tunnel login` — establish a GitHub-backed account, save its token.
  if (args[0] === 'login') {
    try {
      await runLogin({ host, method: args.includes('--gist') ? 'gist' : 'token', token: flag('token') });
      process.exit(0);
    } catch (e) {
      console.error('login failed:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  // Self-service account and reservation commands use the saved login token.
  if (
    args[0] === 'whoami' ||
    args[0] === 'usage' ||
    args[0] === 'reservations' ||
    args[0] === 'release' ||
    args[0] === 'tokens' ||
    args[0] === 'token'
  ) {
    const token = flag('token') || readSavedToken();
    if (!token) {
      console.error('Not logged in — run `volter-tunnel login` first.');
      process.exit(1);
    }
    try {
      const client = new VolterClient({ host, token });
      const json = args.includes('--json');
      const output =
        args[0] === 'usage'
          ? await runUsage(client, json)
          : args[0] === 'reservations'
            ? await runReservations(client, json)
            : args[0] === 'release'
              ? await runReleaseReservation(client, args[1])
              : args[0] === 'tokens'
                ? await runTokens(client, json)
                : args[0] === 'token'
                  ? await runTokenAction(client, args[1], args[2])
                  : await runWhoami(client, json);
      console.log(output);
      process.exit(0);
    } catch (e) {
      console.error(`${args[0]} failed:`, e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  // `volter-tunnel account <…>` — admin ops; needs the root token.
  if (args[0] === 'account') {
    const root = flag('token') || process.env.VOLTER_ROOT_TOKEN;
    if (!root) {
      console.error('Admin commands need the root token (--token <vtr_…> or VOLTER_ROOT_TOKEN).');
      process.exit(1);
    }
    const usd: { dayUsd?: number; monthUsd?: number } = {};
    const d = flag('day-usd');
    const m = flag('month-usd');
    if (d !== undefined) usd.dayUsd = Number(d);
    if (m !== undefined) usd.monthUsd = Number(m);
    try {
      console.log(await runAccount(new VolterClient({ host, token: root }), args[1], args[2], usd));
      process.exit(0);
    } catch (e) {
      console.error('account command failed:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  const port = Number(flag('port'));
  if (!port) {
    console.error(
      'Usage:\n' +
        '  volter-tunnel login [--gist] [--token <t>] [--host <url>]\n' +
        '  volter-tunnel whoami | usage [--json] [--host <url>]\n' +
        '  volter-tunnel reservations [--json] | release <tunnel-id> [--host <url>]\n' +
        '  volter-tunnel tokens [--json] | token <restore|revoke> <token-id> [--host <url>]\n' +
        '  volter-tunnel account <list|usage|create|limits|suspend|resume> [slug] [--day-usd N] [--month-usd N]\n' +
        '  volter-tunnel --port <port> [--host <url>] [--tunnel-id <id>] [--auth-not-required] [--basic-auth user:pass] [--no-qr]'
    );
    process.exit(1);
  }

  // Secret precedence: explicit env, else the token saved by `login`.
  const secret = process.env.TUNNEL_SECRET || readSavedToken();
  const tunnelId = flag('tunnel-id');
  const authNotRequired = args.includes('--auth-not-required');

  // CLI logger: send to stderr so only the URL goes to stdout
  const cliLogger: TunnelLogger = {
    info(_obj, msg) {
      console.error(msg);
    },
    warn(_obj, msg) {
      console.error(msg);
    },
    debug(_obj, msg) {
      console.error(msg);
    },
  };

  const opts: TunnelOptions = { port, host, logger: cliLogger };
  if (secret) opts.secret = secret;
  if (tunnelId) opts.tunnelId = tunnelId;
  if (authNotRequired) opts.authRequired = false;
  const basicAuthArg = flag('basic-auth'); // "user:pass"
  if (basicAuthArg) {
    const i = basicAuthArg.indexOf(':');
    if (i > 0) opts.basicAuth = { user: basicAuthArg.slice(0, i), pass: basicAuthArg.slice(i + 1) };
  }
  const handle = await createTunnel(opts);
  console.log(handle.url); // stdout stays machine-readable (just the URL)

  // Human-facing connection banner + optional QR → stderr, only on a real TTY
  // (so piped/non-interactive use stays clean).
  if (process.stderr.isTTY) {
    process.stderr.write(formatConnectBanner(handle.url, port) + '\n');
    if (!args.includes('--no-qr')) await renderQr(handle.url, (s) => process.stderr.write(s));
  }

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
