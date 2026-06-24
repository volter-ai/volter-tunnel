# Tunnel metering & accounts

Status: **implemented** in `server-cf/` (Cloudflare Workers relay). Tests:
`server-cf/test/metering.test.ts` (real workerd).

The relay is fronted on Cloudflare's metered Durable Object product, so usage is
our cost of goods. The metering system exists to make **runaway spend
impossible**, while staying idiomatic to how ngrok / Cloudflare Tunnel structure
accounts and credentials.

## Model

- **Account** — the billing/isolation unit. `volter-internal` is the built-in
  privileged account; the legacy shared `TUNNEL_SECRET` maps to it for
  backward-compatible migration.
- **Three token tiers** (opaque, prefixed, SHA-256-at-rest, shown once):
  | Tier | String | Holder | May | May **not** |
  |---|---|---|---|---|
  | root | `vtr_<rand>` | us | create accounts, **set limits**, anything | — |
  | service | `vts_<slug>_<rand>` | account owner | mint/revoke api tokens, suspend/resume, read usage | **raise its own limits** |
  | api | `vta_<slug>_<rand>` | tunnel clients | register tunnels (the "tunnel secret") | manage anything |

  The slug is embedded in service/api tokens so the data plane routes straight to
  the strongly-consistent `AccountDO` with no global index — the same approach
  Cloudflare Tunnel's own connector token uses. The one rule beyond the standard
  ngrok-style split: **only root may raise limits**, so a leaked service token can
  never uncap spend.

- **Credits** — the single blended spend unit. `credits = w_req·requests +
  w_ws·wsUpgrades + w_byte·bytes + w_sec·tunnelSeconds`. Defaults charge **1 per
  HTTP request and per WS upgrade**; bytes (free egress on Workers) and
  tunnel-seconds (gated by the concurrency cap) are weight 0 but tracked for
  dashboards. Weights live in `src/credits.ts`.

- **Limits** — every account has a **daily and monthly** credit cap, plus a
  `concurrentMax` (open-tunnel cap) and a `leaseChunk`.

## Topology (Durable Objects)

```
mgmt client ─/admin/*─▶ RegistryDO (singleton)         data plane
                         · root credential              tunnel client ─/ws?id=─▶ TunnelDO
                         · account directory                                      │ authorize / lease / close
                         · global ceiling invariant                               ▼
                         · token source of truth ──configure──▶ AccountDO(slug)
                                                                  · day/month counters
                                                                  · api-token hashes
                                                                  · open-tunnel set + lease ledger
```

- **`RegistryDO`** (`idFromName('registry')`) — management plane. Authenticates
  root/service tokens, owns the account directory + token records, enforces the
  global ceiling, and pushes config + api-token hashes to each `AccountDO`.
- **`AccountDO`** (`idFromName(slug)`) — data-plane authority. Strongly-consistent
  per account: credit counters, lease ledger, concurrency, status. Never raises
  its own limits (config is pushed in).
- **`TunnelDO`** (`idFromName(tunnelId)`) — unchanged relay, now metered: it
  authorizes at register and pre-authorizes (leases) credits before relaying.

## How runaway is prevented (the core guarantee)

1. **Pre-authorization, not after-the-fact metering.** A `TunnelDO` may only relay
   traffic it holds *leased* budget for. Budget exists only as credits the
   `AccountDO` has debited from `remaining = limit − used − leased`. When a lease
   request returns 0, the relay returns **429** and stops. Worst-case overshoot is
   bounded by `leaseChunk × concurrentMax` — independent of throughput, by
   construction. Shrink `leaseChunk` to tighten the bound; enlarge it to amortize
   the per-tunnel→account round trip.
2. **Fail-closed.** If the `AccountDO` is unreachable, no lease is granted, so
   traffic stops rather than runs free. In-flight tunnels keep serving only as far
   as the lease they already hold.
3. **Concurrency cap** bounds parallel tunnels (the overshoot multiplier and the
   main driver of idle DO-duration cost).
4. **Global ceiling = administrative invariant.** `RegistryDO` refuses to allocate
   if `Σ(account limits) > GLOBAL_*_LIMIT`. Since every account is independently
   hard-capped at its own limit, total spend across all accounts is provably ≤ the
   global budget — no runtime cross-account metering needed. (Cloudflare has no
   hard dollar cap, so these credits *are* the spend cap.)

## How limits are surfaced

Three layers, the idiomatic split (standard HTTP rate-limit signalling + an
agent-side warning channel + a management snapshot):

1. **Data plane — standard headers.** Every tunneled response carries the IETF
   `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` headers (binding
   daily window; `reset` is seconds-to-refill). The hard cutoff is a **`429`** with
   `Retry-After` and a JSON body `{ error:'quota_exceeded', scope, retryAfter }`.
   WS-upgrade 429s carry `Retry-After` too.
2. **Control plane — pushed to the tunnel client.** The `registered` frame includes
   an `account` snapshot (`{ slug, day, month, level }`) so the CLI/gateway can show
   usage at startup. As usage crosses thresholds the relay pushes a **`quota`** frame
   (`level: 'warn'` at ≥80%, `'exceeded'` at 100%, `'ok'` on recovery) — only on
   level change. The `@volter/tunnel` client logs these (`info` for ok, `warn`
   otherwise); gateways can relay them to a UI. Hard rejections still close the
   control socket with `4029` + reason.
3. **Management plane.** `GET /admin/accounts/:slug/usage` for the live snapshot;
   future: dashboard panel + threshold alerts/webhooks + Analytics Engine graphs.

## Resets

`AccountDO` lazily rolls the day/month buckets when the wall clock crosses a UTC
boundary (checked on every lease/close/usage call). Outstanding leases carry
across the boundary; committed usage zeroes.

## Management API

All under `/admin`, `Authorization: Bearer <token>`:

```
POST   /admin/accounts                      root    create account → { serviceToken }
GET    /admin/accounts                      root    list + global allocation
POST   /admin/accounts/:slug/tokens         svc*    mint api token (service token: root only)
GET    /admin/accounts/:slug/tokens         svc*    list token metadata
DELETE /admin/accounts/:slug/tokens/:id     svc*    revoke
PATCH  /admin/accounts/:slug/limits         root    change limits (global-checked)
POST   /admin/accounts/:slug/suspend|resume svc*    status
GET    /admin/accounts/:slug/usage          svc*    live usage snapshot
```
`svc*` = that account's service token **or** root. A service token is scoped to
its own slug.

## Configuration (wrangler vars / secrets)

Vars: `TUNNEL_DOMAIN`, `INTERNAL_ACCOUNT`, `INTERNAL_DAY_LIMIT`,
`INTERNAL_MONTH_LIMIT`, `INTERNAL_CONCURRENT`, `GLOBAL_DAY_LIMIT`,
`GLOBAL_MONTH_LIMIT`, `DEFAULT_CONCURRENT`, `DEFAULT_LEASE_CHUNK`.
Secrets: `TUNNEL_SECRET` (legacy), `JWT_SECRET`, `ROOT_TOKEN`.

`ROOT_TOKEN` is hashed into the registry on first use. Rotate by changing the
secret (the new value re-bootstraps the root hash on next admin call).

## Bootstrap & migration

- `volter-internal` self-provisions on first use (legacy/internal register),
  reserving its allocation against the global ceiling.
- Existing consumers keep working: the legacy shared `TUNNEL_SECRET` registers
  under `volter-internal`. Migrate each consumer to a `vta_volter-internal_…` api
  token at its own pace, then retire `TUNNEL_SECRET`.

## What's deliberately out of scope (and why it's still safe)

- **Per-byte / per-WS-message pricing** is off by default (weight 0) so the hot
  relay path stays zero-overhead. Egress is free on Workers; the spend drivers are
  requests + duration, which are charged/bounded. Raise `byte`/`second` weights to
  price them.
- **Runtime global metering** is unnecessary — the administrative ceiling already
  guarantees `Σ spend ≤ global`.
- **Supabase usage rollups / Analytics Engine / alerts** are the next layer
  (history + dashboards); the live authority is the `AccountDO`.
