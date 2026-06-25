# CLI

The `volter-tunnel` binary ships with `@volter/tunnel`.

## Commands

```bash
volter-tunnel login [--gist] [--host <url>]          # prove a GitHub identity, save an api token
volter-tunnel --port 3000 [--tunnel-id my-app]       # expose a local port; prints the URL (+ QR)
volter-tunnel whoami                                  # your account + usage
volter-tunnel usage [--json]                          # your current spend (today / month)
volter-tunnel account <list|usage|create|limits|suspend|resume> [slug] \
  [--day-usd N] [--month-usd N]                       # admin ops (needs the root token)
```

## Exposing a port

```bash
volter-tunnel --port 3000 --tunnel-id my-app
```

Run flags:

| Flag | Meaning |
|---|---|
| `--host <relayUrl>` | Relay to connect to. |
| `--tunnel-id <id>` | Reserved subdomain to claim. |
| `--basic-auth user:pass` | Gate the tunnel with basic-auth. |
| `--auth-not-required` | Leave the tunnel open. |
| `--no-qr` | Suppress the QR code. |

## Authenticating

```bash
volter-tunnel login --host https://your-relay     # gh token exchange → saves an api token
volter-tunnel login --host https://your-relay --gist   # gist proof, sends the relay no token
```

The saved token lives at `~/.config/volter/token` (mode `600`).

## Self-service & admin

```bash
volter-tunnel whoami            # { slug, name, usage }
volter-tunnel usage --json      # machine-readable current spend

# admin (require the root token via VOLTER_TOKEN or the saved token):
volter-tunnel account list
volter-tunnel account create acme --day-usd 10 --month-usd 100
volter-tunnel account limits acme --day-usd 25
volter-tunnel account suspend acme
volter-tunnel account resume acme
```

See [Metering & accounts](/self-hosting/metering) for what the dollar limits and
token tiers mean.
