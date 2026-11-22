# CLI

The `volter-tunnel` binary ships with `@volter/tunnel`.

## Commands

```bash
volter-tunnel login [--gist] [--host <url>]          # prove a GitHub identity, save an api token
volter-tunnel --port 3000 [--tunnel-id my-app]       # expose a local port; prints the URL (+ QR)
volter-tunnel whoami                                  # your account + usage
volter-tunnel usage [--json]                          # your current spend (today / month)
volter-tunnel reservations [--json]                   # stable ids + capacity
volter-tunnel release <tunnel-id>                     # release an owned stable id
volter-tunnel tokens [--json]                         # safe device-token metadata
volter-tunnel token <restore|revoke> <token-id>       # recover or retire one device
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

### Behind a proxy

The tunnel's connection to the relay goes through an HTTP proxy when the
environment names one:

- **Proxy:** `https_proxy`, else `HTTPS_PROXY`, for an `https://` relay;
  `http_proxy`, else `HTTP_PROXY`, for `http://`. A value without a scheme is
  taken as `http://`; a proxy of another scheme (such as `socks5://`) is an error.
- **Bypass:** `no_proxy`, else `NO_PROXY`, a list separated by commas or spaces.
  `*` anywhere in the list bypasses every host. `example.com`, `.example.com`
  and `*.example.com` each match `example.com` and its subdomains. A `:port`
  suffix (`[::1]:port` for IPv6) limits an entry to that port. Addresses match
  literally; CIDR ranges are not supported.

The client opens the WebSocket with an HTTP `CONNECT` through the proxy.
Credentials in the proxy URL are sent as `Proxy-Authorization` and are not in
the client's own log. **`DEBUG=https-proxy-agent` (or `DEBUG=*`) prints the
proxy URL, credentials included.** The client adds no certificate handling of
its own: the relay's certificate is checked against the runtime's trust store,
which is where `NODE_EXTRA_CA_CERTS` applies. Traffic to your local port never
uses the proxy: it goes through the client's own agent, never the runtime's
global one.

Only the tunnel socket is opened this way. The account commands (`login`,
`whoami`, `usage`, `reservations`, `release`, `tokens`, `token`, `account`) use the runtime's
`fetch` and its own proxy rules: under Node it ignores the proxy variables
unless Node runs with `--use-env-proxy`.

## Authenticating

```bash
volter-tunnel login --host https://your-relay     # gh token exchange → saves an api token
volter-tunnel login --host https://your-relay --gist   # gist proof, sends the relay no token
```

The saved token lives at `~/.config/volter/token` (mode `600`). Logging in on a
second device creates an independent token; it does not revoke credentials used
by persistent hosts. When two devices claim the same tunnel id with replacement
enabled, the newest active credential owns it and stale clients stop retrying.
Use `tokens` and `token revoke` to retire old devices.

## Self-service & admin

```bash
volter-tunnel whoami            # { slug, name, usage }
volter-tunnel usage --json      # machine-readable current spend
volter-tunnel reservations      # stable ids held by this account
volter-tunnel tokens            # ids, labels, last four characters, and status
volter-tunnel token restore ID  # recover a host token invalidated by old clients
volter-tunnel token revoke ID   # deliberately retire a device token

# admin (require the root token via VOLTER_TOKEN or the saved token):
volter-tunnel account list
volter-tunnel account create acme --day-usd 10 --month-usd 100
volter-tunnel account limits acme --day-usd 25
volter-tunnel account suspend acme
volter-tunnel account resume acme
```

See [Metering & accounts](/self-hosting/metering) for what the dollar limits and
token tiers mean.
