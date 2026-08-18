# Getting started

volter-tunnel exposes a local port over a public, stable URL. It relays HTTP,
streamed responses, and WebSocket traffic, and lets you reserve a friendly
subdomain that survives reconnects.

## Install

```bash
bun add @volter/tunnel        # client library + CLI (runs under Bun)
```

This installs both the `@volter/tunnel` library and the `volter-tunnel` CLI.

## Expose a port in two commands

```bash
volter-tunnel login --host https://your-relay     # prove a GitHub identity, save an api token
volter-tunnel --port 3000 --tunnel-id my-app      # → https://my-app.your-relay  (+ QR code)
```

- `login` authenticates against a relay and saves an api token to
  `~/.config/volter/token`. Use `--gist` if you'd rather prove your identity via
  a GitHub gist and send the relay no token at all. Each device receives an
  independent credential, so signing in elsewhere does not disconnect a
  persistent host.
- The run command prints the public URL and a scannable QR code. Reconnecting
  with the same `--tunnel-id` gives you back the same URL.

::: tip No account needed to try it
You can [run a relay locally](/self-hosting/deploy) and point the client at it
with `--host http://127.0.0.1:8787 --auth-not-required` — no hosted account
required.
:::

## Common run flags

| Flag | Meaning |
|---|---|
| `--host <relayUrl>` | Which relay to connect to (defaults to the public demo). |
| `--tunnel-id <id>` | Request a specific reserved subdomain. |
| `--basic-auth user:pass` | Gate the tunnel with HTTP basic-auth. |
| `--auth-not-required` | Leave the tunnel open (no auth). |
| `--no-qr` | Don't print the QR code. |

## Next steps

- [CLI reference](/guide/cli) — every command and flag.
- [Library](/guide/library) — embed tunnels with `createTunnel`, or drive the
  relay API with `VolterClient`.
- [MCP server](/guide/mcp) — let AI agents manage a relay.
- [Self-host a relay](/self-hosting/deploy) — run your own on Cloudflare.
