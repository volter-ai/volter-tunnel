# Tunnel metering & accounts

How the relay meters tunnel traffic to a hard dollar ceiling, and how accounts
and tokens work. Implemented in `server-cf/`, with automated tests in
`server-cf/test/metering.test.ts` (real workerd, no mocks).

The relay runs on Cloudflare's metered Durable Object product, so traffic is a
real cost. The metering system exists to make **runaway spend impossible**, while
staying idiomatic to how ngrok / Cloudflare Tunnel structure accounts and
credentials.

## Model

- **Account** — the billing/isolation unit. `volter-internal` is the built-in
  privileged account; the legacy shared `TUNNEL_SECRET` maps to it for
  backward-compatible migration.
- **Three token tiers** (opaque, prefixed, SHA-256-at-rest, shown once):
  | Tier | String | Holder | May | May **not** |
  |---|---|---|---|---|
  | root | `vtr_<rand>` | us | create accounts, **set limits**, anything | — |
  | service | `vts_<slug>_<rand>` | account owner | mint/revoke api tokens, suspend/resume, read usage | **raise its own limits** |
  | api | `vta_<slug>_<rand>` | tunnel clients / account owner | register tunnels; inspect/release owned reservations; manage own device tokens | manage accounts or limits |

  The slug is embedded in service/api tokens so the data plane routes straight to
  the strongly-consistent `AccountDO` with no global index — the same approach
  Cloudflare Tunnel's own connector token uses. The one rule beyond the standard
  ngrok-style split: **only root may raise limits**, so a leaked service token can
  never uncap spend.

- **Credits = money.** Credits are **ops** — the universal Cloudflare billable
  unit. Every event that wakes/charges the relay's DO is 1 op: an HTTP request, a
  WS upgrade, and **each relayed message** (a streamed response chunk or a
  WebSocket frame). Metering messages — not just the opening request — is what
  makes a dollar cap hold for streaming/WS-heavy tunnels. `1 op = COST_PER_OP_USD`
  (~$1/million, conservative; covers DO+Worker requests + a duration margin), so
  op-limits are a hard dollar cap. Bytes/seconds are weight 0 (egress is free;
  idle duration ≈ 0 under hibernation). Weights + cost in `src/credits.ts`.

- **Limits — in dollars.** Every account has a **daily and monthly** cap, set in
  money via the admin API (`{ dayUsd, monthUsd }`, converted to op-credits) or as
  raw op-credits, plus a `concurrentMax` and a `leaseChunk`. The privileged
  **internal** account defaults to **$10/day, $100/month**; **free signup**
  accounts default to **$1/day, $10/month** (`SIGNUP_DAY/MONTH_LIMIT`). Usage is
  reported in both ops and dollars.

  Message metering is **off the critical path** (counted per frame, charged in
  batches fire-and-forget) so it never adds latency to the relay; a chatty WS is
  closed (`1011`) once its account's budget is spent. Overshoot ≤ one batch.

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

An api token also has owner-scoped recovery endpoints under `/me`: `GET
/me/tokens` returns safe metadata, `DELETE /me/tokens/:id` revokes a selected
device, and `POST /me/tokens/:id/restore` deliberately restores it. GitHub login
mints an independent device token and never implicitly revokes another device.
For a contested reserved tunnel id, the newest active device credential is the
fenced owner; an older credential cannot evict it through reconnect attempts.

## Configuration (wrangler vars / secrets)

Vars: `TUNNEL_DOMAIN`, `INTERNAL_ACCOUNT`, `INTERNAL_DAY_LIMIT`,
`INTERNAL_MONTH_LIMIT`, `INTERNAL_CONCURRENT`, `GLOBAL_DAY_LIMIT`,
`GLOBAL_MONTH_LIMIT`, `DEFAULT_CONCURRENT`, `DEFAULT_LEASE_CHUNK`.
Secrets: `TUNNEL_SECRET` (legacy), `JWT_SECRET`, `ROOT_TOKEN`.

`ROOT_TOKEN` is the **single source of truth** for root auth — derived from the
env secret on each check, never persisted. **Rotate** it with
`wrangler secret put ROOT_TOKEN` + `wrangler deploy`; the new value is effective
immediately and the old one stops working. A lost copy is not a lockout — set a
new secret and redeploy. Keep a durable copy in your password manager / secret
store (the live worker secret is the only other copy; CF won't show it back).

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
