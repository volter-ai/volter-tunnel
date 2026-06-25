#!/usr/bin/env bun
/**
 * volter-tunnel CLI — the `bin`. Thin command layer over the SDK (createTunnel):
 * `login` proves a GitHub identity and saves an api token; the default form
 * exposes a local port and prints the public URL. Output formatting only — all
 * tunnel logic lives in the library.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTunnel, DEFAULT_HOST, type TunnelLogger, type TunnelOptions, VolterClient } from './tunnel-client';
import { formatUsage, formatWhoami } from './format';

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
    resp = await postJson('/signup/github/gist/verify', { gistId, verifier });
  } else {
    const token = opts.token ?? sh('gh', ['auth', 'token']);
    resp = await postJson('/signup/github', { token });
  }

  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(resp.token), { mode: 0o600 });
  console.error(`Logged in as github:${resp.login} (account ${resp.slug}).`);
  console.error(`Saved api token to ${file} — future 'volter-tunnel' runs use it automatically.`);
  console.log(String(resp.token)); // stdout = the token (scriptable)
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

if (import.meta.main) {
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

  // `volter-tunnel whoami` / `usage` — read your own account via the saved token.
  if (args[0] === 'whoami' || args[0] === 'usage') {
    const token = flag('token') || readSavedToken();
    if (!token) {
      console.error('Not logged in — run `volter-tunnel login` first.');
      process.exit(1);
    }
    try {
      const me = await new VolterClient({ host, token }).whoami();
      if (args.includes('--json')) {
        console.log(JSON.stringify(args[0] === 'usage' ? me.usage : me, null, 2));
      } else {
        console.log(args[0] === 'usage' ? formatUsage(me.usage) : formatWhoami(me));
      }
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
    const client = new VolterClient({ host, token: root });
    const [, sub, slug] = args;
    const usdBody = (): Record<string, number> => {
      const b: Record<string, number> = {};
      const d = flag('day-usd');
      const m = flag('month-usd');
      if (d !== undefined) b.dayUsd = Number(d);
      if (m !== undefined) b.monthUsd = Number(m);
      return b;
    };
    try {
      let result: unknown;
      if (sub === 'list') result = await client.usageSummary();
      else if (sub === 'usage' && slug) result = await client.accountUsage(slug);
      else if (sub === 'create' && slug) result = await client.createAccount({ slug, ...usdBody() });
      else if (sub === 'limits' && slug) result = await client.patchLimits(slug, usdBody());
      else if (sub === 'suspend' && slug) result = await client.setStatus(slug, 'suspended');
      else if (sub === 'resume' && slug) result = await client.setStatus(slug, 'active');
      else {
        console.error(
          'Usage: volter-tunnel account <list | usage <slug> | create <slug> | limits <slug> | suspend <slug> | resume <slug>> [--day-usd N] [--month-usd N]'
        );
        process.exit(1);
      }
      console.log(JSON.stringify(result, null, 2));
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
