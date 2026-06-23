# @volter/tunnel

WebSocket-based HTTP/WS reverse tunnel. Two halves that speak one wire protocol:

- **`server/`** — a relay you host on a public domain. Browsers hit
  `https://{tunnelId}.your-domain` and the relay forwards each request/response
  (and WebSocket upgrade) over a control channel to a connected client.
- **`client/`** — a connector library + CLI that runs next to a local server,
  registers a `tunnelId` with the relay, and proxies traffic to a local port.

It supports HTTP, streaming responses, WebSocket relay, optional JWT auth
(Bearer header, `?__volter_token=` query, or `__volter_auth` cookie), and
CSP `frame-ancestors` stripping so tunneled apps can be embedded in iframes.

> Runtime note: the published package ships TypeScript source for the client
> (`client/tunnel-client.ts`). It is designed to be consumed under **Bun**
> (which imports `.ts` directly), as in the Volter gateway/sandbox. The server
> is plain ESM JavaScript and runs under Node.

## Install

```bash
bun add @volter/tunnel        # client library + CLI (Bun)
# jsonwebtoken is an optional peer dep, only needed by the server for JWT auth
```

## Client — library

```ts
import { createTunnel } from '@volter/tunnel/client';

const tunnel = await createTunnel({
  port: 3000,                                   // local port to expose
  host: 'https://vgit-tunnels.volterapp.com',   // relay URL
  tunnelId: 'my-app',                           // -> https://my-app.<domain>
  secret: process.env.TUNNEL_SECRET,            // must match relay's TUNNEL_SECRET
  authRequired: false,
});

console.log(tunnel.url);   // public URL
// ... later
tunnel.close();
```

## Client — CLI

```bash
# via the bin once installed
volter-tunnel --port 3000 [--host <relayUrl>] [--tunnel-id <id>] [--auth-not-required]

# or directly with Bun
bun run node_modules/@volter/tunnel/client/tunnel-client.ts --port 3000
```

Defaults: `--host` falls back to `$TUNNEL_SERVER_URL` then
`https://vgit-tunnels.volterapp.com`.

## Server — deploy

The relay lives in `server/` with a Dockerfile and a Fly.io config
(`server/fly.toml`, app `mc-tunnel`, domain `vgit-tunnels.volterapp.com`).

```bash
cd server
fly deploy            # deploy the relay to Fly.io
# or run locally:
npm install && node server.mjs
```

### Server environment variables

| Var | Purpose |
|---|---|
| `PORT` | Port the relay listens on (Fly: `8080`) |
| `TUNNEL_DOMAIN` | Public base domain, e.g. `vgit-tunnels.volterapp.com` |
| `TUNNEL_SECURE` | `true` to emit `https`/`wss` public URLs |
| `TUNNEL_SECRET` | Shared secret clients must present in `register` |
| `JWT_SECRET` | HS256 secret for validating end-user auth tokens (optional) |

Client and relay must share the same `TUNNEL_SECRET`.

## Layout

```
@volter/tunnel
├── client/tunnel-client.ts   # createTunnel() + CLI  (export "./client", bin "volter-tunnel")
└── server/                   # relay (export "./server")
    ├── server.mjs
    ├── Dockerfile
    └── fly.toml
```
