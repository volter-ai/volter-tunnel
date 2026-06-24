# @volter/tunnel — Decisions & Strategy

The "why" behind the product. Durable decisions, the cost model, and the
analysis they rest on. The build plan that follows from these lives in
[ROADMAP.md](./ROADMAP.md).

Last updated: 2026-06-24.

---

## D1. Build-vs-adopt: stay custom, no migration

Building a custom tunnel was **justified**. A 2026 survey of the OSS tunnel
landscape (frp, chisel, bore, rathole, sish, localtunnel, Tunnelmole, zrok,
Piko, Wormhole, boringproxy, pgrok, Pangolin, and the 80–100+ project
`awesome-tunneling` catalog) found **no single project** that satisfies our
four hard requirements without a heavy fork:

1. **Embeddable library** — a `createTunnel({port, host, tunnelId, secret})`
   TypeScript/Bun API embedded inside the product, not a standalone CLI.
2. **Iframe embedding** — strips/rewrites CSP `frame-ancestors` /
   `X-Frame-Options` so tunneled apps render inside the product UI.
   **No surveyed OSS tunnel offers this at all** — the single most
   distinguishing feature.
3. **Relay-side end-user auth** — JWT bearer / `?__volter_token=` query /
   `__volter_auth` cookie validated at the relay.
4. **Serverless scale-to-zero backend** — a Cloudflare Worker routing by
   subdomain to one hibernatable Durable Object per tunnelId.

Closest near-misses, each failing decisively:

| Project | Nails | Fails |
|---|---|---|
| **zrok** (OpenZiti, Apache-2.0) | npm SDK + native relay OAuth gating | long-running OpenZiti overlay (not serverless DO); no iframe/CSP rewriting |
| **Wormhole** (MIT) | identical Worker+DO+WebSocket arch; free reserved subdomains via GitHub login | Go CLI-only (no library); no auth/CSP injection; effectively abandoned (v0.1.0, ~3 days of activity) |
| **Piko** (MIT) | embeddable SDK | Go-only; stateful K8s gossip cluster (not scale-to-zero); no end-user auth/CSP |

**Decision: stay custom.** If migration were ever forced, zrok (SDK + auth) or
Wormhole (identical architecture) are the nearest starting points — but both
are heavy forks. Wormhole independently arrived at the *exact* Worker+DO+
WebSocket design — convergent validation that our architecture is the right
shape, not over-engineering.

---

## D2. Cost model (verified in code)

**Cloudflare does not bill egress bandwidth, and idle Durable Objects under
WebSocket Hibernation are not billed for duration.** This is the whole reason a
free reservable-ID tier is viable for us when it isn't for ngrok (whose primary
cost is bandwidth).

Verified in `server-cf/src/tunnel-do.ts`:

- Control + browser sockets are accepted via `ctx.acceptWebSocket(...)` (the
  Hibernation API), with `serializeAttachment`/`deserializeAttachment` for state
  and `ctx.getWebSockets(tag)` for re-fetch — sockets are **not** held in
  memory. Handlers are `webSocketMessage`/`webSocketClose`/`webSocketError`.
- No always-on `alarm()`; timers exist only per in-flight request/stream.
- The client's 25s ping keepalive is a **protocol-level** ping — Cloudflare
  auto-responds with pong **without waking the DO and without billing**
  (confirmed against Cloudflare's WebSocket Hibernation docs).

> ⚠️ **Landmine — do not "fix" this:** the 25s ping exists for Fly.io's 30s idle
> timeout (the `server/` path) and is harmless on CF *because it is a protocol
> ping*. If anyone converts the keepalive to an application-level "ping"
> **message**, it will wake the DO every 25s (~3,400×/day per idle tunnel) and
> bill duration — silently destroying "idle = free." Keep it a protocol ping,
> or use `setWebSocketAutoResponse`.

**What actually costs us money** (→ rate-limit/paid-gated):

| Cost driver | Notes |
|---|---|
| Active relay (DO duration GB-s + request units) | Main variable cost; scales with active bytes×time, **not** user/reservation count |
| Persisted inspector replay (DO storage) | Real but bounded by TTL + size caps |
| TCP/UDP tunnels | Cannot run on CF DO — needs off-platform always-on compute (fixed cost floor) |
| Custom BYO hostnames | Per-hostname TLS cert (CF for SaaS) — real per-unit monthly cost |

**Essentially free to give away:** reserved IDs while idle, OAuth gating,
header/CSP rewrite, reconnect, QR codes, wildcard subdomains, multiple *idle*
tunnels, and global edge/regions (free from Cloudflare — market it, don't build
it).

---

## D3. Free-vs-paid principle

**Rate limits solve every *cost* problem** — meter on active bandwidth/duration,
req/sec burst, concurrent tunnels, reserved-ID count, reservation idle-TTL, and
inspector retention (days + MB). The metering/credits substrate already exists.

**Rate limits do NOT solve three things** (handle separately):

1. **Abuse / phishing** — a phishing page *under* the rate limit still costs us
   Cloudflare ToS standing and domain reputation. Needs **identity + revocation
   + abuse reporting**, not a throughput cap.
2. **TCP/UDP** — a *capability* gap (CF DO can't accept inbound TCP), not a cost
   knob. Either drop it or run it on separate paid infra.
3. **Idle-connection duration** — only safe because hibernation is wired
   correctly (see D2). A code-correctness property, not a policy lever.

---

## D4. Signup & identity: GitHub OAuth primary

Today there is **no self-serve front door** — accounts/tokens (`root` `vtr_`,
`service` `vts_<slug>_`, `api` `vta_<slug>_`) are provisioned via the root
token. But the entire account substrate (`AccountDO`, token model, credit
limits) already exists. The gap is only the onboarding shim that creates a slug
and mints a `vta_` token.

**Decision (updated): piggyback on the user's existing GitHub auth — no OAuth
app of our own.** Rather than register an OAuth app and run a device flow, we
reuse the GitHub credential the user already has. Two methods, both implemented
(#2):

- **Token exchange (default):** the CLI sends `gh auth token` once; the relay
  verifies it via the GitHub `/user` API and **discards it** (never stored or
  logged), then mints **our own** `vta_` token as the ongoing credential. The gh
  token is a one-time identity proof, not a stored secret.
- **Gist proof (zero-token):** the relay issues a signed, self-expiring nonce
  (stateless HMAC); the user publishes it as a public gist; the relay reads the
  gist's public owner. No token ever leaves the user's machine.

A verified GitHub id maps to a deterministic `gh-<id>` account, so returning
users keep their account + reserved ids. This removes the OAuth-app dependency
entirely and collapses signup to one relay endpoint + a `volter-tunnel login`
command. Tradeoff (token method): the relay momentarily receives the broad gh
token — mitigated by verify-and-discard + HTTPS, and avoidable via the gist
method or self-hosting. **SSH-key proof** (signature challenge against
`github.com/<user>.keys`) is a noted future third method for the git-over-SSH
crowd who don't use `gh`. GitHub remains the right identity for its abuse signal
and dev-native fit; device-flow OAuth was the original plan but is unnecessary.

- **Add Google OAuth as a "reach" option later**, with a *tighter abuse default*
  (gmail is farmable) — provider strength becomes a trust/risk signal feeding
  rate-limit defaults.
- **Model identity as `account → one-or-more linked identities, each with a
  trust weight`** so Google / GitLab / card-on-file slot in later without
  reworking the account model. Don't hard-code `provider == github`.
- **Skip:** email+password (storage liability, weak gate, awkward CLI), SMS
  (per-message cost, dev-hostile), passkeys (solves auth, not identity/abuse).

The signup-method choice *is* the abuse-control lever — one decision, not two.

---

## D5. Idle-reclaim of reserved IDs: lazy reclaim-on-contention

The product premise is "a stable reservable tunnel ID with a limit on how long
we hold it." The **hold-limit does not exist today**: `registry-do.ts` records a
reservation with no `createdAt`/`lastSeenAt`/`expiresAt`, and there is no
`alarm`/sweep/reclaim anywhere. Reservations are **permanent until manually
deleted** — both the missing feature and a squatting/abuse problem.

**Decision: lazy reclaim-on-contention.** With one DO per tunnelId there is no
central list to sweep — a cron/alarm sweep would mean fanning out across every
DO. Instead:

1. Store the reservation index (`tunnelId → {owner, lastSeenAt}`) in the single
   central `registry-do`.
2. Update `lastSeenAt` on every (re)registration (the event already fires).
3. On a **new reserve request for a taken ID**, reclaim only if
   `now - lastSeenAt > idleTTL`.

This never takes an ID from a user just because time passed — only when the
grace window has lapsed **and** someone else wants that exact name. Idle-but-
uncontested IDs keep working. Grace window **resets on any reconnect** (the
friendly behavior originally pitched).

---

## D6. Policy defaults (decided; live in `wrangler.jsonc`)

Reasonable defaults are set and deployed; tune any via env without code changes.

| Knob | Default | Meaning |
|---|---|---|
| `RESERVATION_IDLE_TTL_DAYS` | 60 | idle days before a reserved id is reclaimable-on-contention |
| `DEFAULT_RESERVED_MAX` | 3 | reserved tunnel ids per free account (matches Wormhole) |
| `SIGNUP_DAY_LIMIT` / `SIGNUP_MONTH_LIMIT` | 1,000,000 / 10,000,000 | free-tier spend cap ≈ $1/day, $10/month (op-credits) |
| `BURST_RPS` / `BURST_SIZE` | 50 / 500 | per-tunnel fair-use: 50 req/s sustained, 500 burst (floods only) |
| `SIGNUP_RPS` | 5 | rate limit on the unauthenticated public surface (signup/report) |
| `GLOBAL_DAY_LIMIT` / `GLOBAL_MONTH_LIMIT` | 1e9 / 1e10 | Σ(account) ceiling ≈ $1,000/day, $10,000/month — total spend cap |
| `INSPECT_REPLAY` | off | persisted inspector history + replay (paid feature; DO-storage cost) |
| `JWT_SECRET` | unset | end-user JWT layer off — keeps tunnels publicly shareable (inspector is independently owner-gated) |
| `SIGNUP_ALLOWED_USERS` | set (waitlist) | only listed GitHub logins may sign up |

Revisit when productizing paid tiers (raise per-account limits via the admin API)
or opening signup to the public (widen / clear `SIGNUP_ALLOWED_USERS`).

---

## D7. Watch items

- **CF outbound-connection 15-min cap (2026-06-19 changelog):** does **not**
  apply to our control socket — it is client-initiated (inbound to the DO,
  hibernatable). The DO makes no outbound connections for tunneling. Reconnect
  resilience already handles ordinary flaps.
- **Iframe/CSP-rewriting uniqueness** rests on absence-of-documentation across
  the OSS field, not exhaustive code audits — high confidence, not proof.
