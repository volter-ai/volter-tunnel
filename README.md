# volter-tunnel

[![CI](https://github.com/volter-app/tunnel/actions/workflows/ci.yml/badge.svg)](./.github/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

An open-source, WebSocket-based **HTTP/WS reverse tunnel** — an ngrok /
Cloudflare-Tunnel alternative whose headline feature is a **free, stable,
reservable subdomain** that survives reconnects. Built on Cloudflare Workers +
Durable Objects, so idle tunnels cost ~nothing.

```bash
volter-tunnel login --host https://your-relay        # GitHub login, no OAuth app
volter-tunnel --port 3000 --tunnel-id my-app         # → https://my-app.your-relay
```

**Why it exists:** reserve a friendly subdomain once and keep it; expose a local
port over HTTP, streaming, and WebSocket; gate it with basic-auth/JWT; embed the
tunneled app in an iframe (it strips `frame-ancestors`/X-Frame-Options — no other
OSS tunnel does this); inspect every request live. See
[docs/DECISIONS.md](./docs/DECISIONS.md) for the full rationale.

## Install

```bash
bun add @volter/tunnel        # client library + CLI (runs under Bun)
```

## CLI

```bash
volter-tunnel login [--gist] [--host <url>]          # prove a GitHub identity, save an api token
volter-tunnel --port 3000 [--tunnel-id my-app]       # expose a local port; prints the URL (+ QR)
volter-tunnel whoami                                  # your account + usage
volter-tunnel usage [--json]                          # your current spend (today / month)
volter-tunnel account <list|usage|create|limits|suspend|resume> [slug] \
  [--day-usd N] [--month-usd N]                       # admin ops (needs the root token)
```

Common run flags: `--host <relayUrl>`, `--basic-auth user:pass`,
`--auth-not-required`, `--no-qr`.

## Library

```ts
import { createTunnel } from '@volter/tunnel/client';

const tunnel = await createTunnel({
  port: 3000,
  host: 'https://your-relay',
  tunnelId: 'my-app',              // → https://my-app.your-relay
});
console.log(tunnel.url);
// … later
tunnel.close();
```

And a typed client for the relay's management/self-service API:

```ts
import { VolterClient } from '@volter/tunnel/client';

const client = new VolterClient({ host: 'https://your-relay', token });
const me = await client.whoami();          // { slug, name, usage }
await client.createAccount({ slug: 'x', dayUsd: 10 });   // root token
```

## MCP server (for AI agents)

`@volter/tunnel-mcp` exposes account/usage/abuse operations as MCP tools
(`whoami`, `usage`, `account_*`, `reports`, `waitlist`, `revoke_reservation`):

```bash
VOLTER_HOST=https://your-relay VOLTER_TOKEN=<token> volter-tunnel-mcp
```

## Architecture

A monorepo with one shared protocol contract consumed by both sides:

```
packages/core/   @volter/tunnel-core — the wire protocol (message union + frame
                 codec + DTOs). Pure, dependency-free, 100% covered.
client/          @volter/tunnel — core ← transport ← sdk (createTunnel +
                 VolterClient) ← cli (the bin).
packages/mcp/    @volter/tunnel-mcp — MCP server over the SDK.
server-cf/       Cloudflare Worker + Durable Objects relay (primary). One DO per
                 tunnelId holds the hibernatable control socket → idle = free.
server/          a legacy single-process Fly relay (same wire protocol).
```

The protocol lives in `core` and nowhere else, so the client and relay can't
drift — a change to the contract is type-checked on both sides.

## Develop

```bash
bun install
bun run typecheck                                  # client + core + mcp
cd packages/core && bun test                       # protocol (100% gate)
cd packages/mcp  && bun test                       # MCP tools
bun test ./test                                    # client SDK + CLI
cd server-cf && npm install && npx vitest run      # relay (real workerd, no mocks)
```

See [CONTRIBUTING.md](./CONTRIBUTING.md). Deploy the relay with
[docs/DEPLOY.md](./docs/DEPLOY.md).

## License

[Apache-2.0](./LICENSE) © Volter.
