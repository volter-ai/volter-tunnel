# @volter/tunnel — Roadmap

The build plan for turning the tunnel into a public free-tier product (an
ngrok/Cloudflare-Tunnel alternative whose headline differentiator is a free,
stable, reservable tunnel ID). The rationale behind every item — cost model,
build-vs-adopt, free-vs-paid, signup, idle-reclaim design — lives in
[DECISIONS.md](./DECISIONS.md). Open policy values are tracked there (D6).

Last updated: 2026-06-24.

## Progress (branch `roadmap-buildout`)

Shipped, tested, committed: **#1** idle-reclaim · **#2** GitHub signup (token
exchange + gist proof, no OAuth app) · **#5** live inspector · **#6** basic-auth
gate · **#7** header rewrite rules · **#8** CLI banner + QR · **#9** wildcard
subdomains · **#3 (partial)** identity-gating (via #2) + per-account reserved-id
count cap. Suite: 77 CF + 10 root green.

Signup uses the user's existing GitHub auth (no OAuth app to register) — see
DECISIONS D4. That removed the only external blocker; nothing now waits on input
except policy values / infra.

Remaining:
- **#3 (rest)** — handle revocation (cross-DO: TunnelDO clears reservation +
  AccountDO release + close socket) and an abuse-report endpoint. Unblocked,
  small; deferred as a focused follow-up.
- **#4** — largely satisfied by the metering substrate; only short-window req/sec
  burst is net-new and needs a policy threshold.
- **#6 (OAuth-gating form)** — end-user OAuth in front of a tunnel (the basic-auth
  form is shipped); can reuse the #2 GitHub plumbing.
- **#10–#14** — Phase 2 (persistence/paid/infra).

---

## Already built (don't rebuild) ✅

HTTP/WS/streaming relay · JWT end-user auth (`auth.ts`) · iframe/CSP
`frame-ancestors` stripping · metering + dollar-denominated credits ·
account/token model (`credits.ts`) · hibernation = idle-is-free (verified) ·
robust client reconnect/backoff.

## Phase 0 — Launch blockers

One milestone; the items are intertwined. Signup (#2) provides the identity
that powers abuse control (#3) and the per-account reservation cap that makes
idle-reclaim (#1) meaningful. **Phase 0 is the launch.**

| # | Item | Free/Paid | Effort | Depends on | Ref |
|---|---|---|---|---|---|
| 1 | **Idle-reclaim of reserved IDs** — lazy reclaim-on-contention; `lastSeenAt` + TTL in `registry-do`; reset on reconnect | Free | M | — | D5 |
| 2 | **Self-serve signup** — GitHub OAuth device-flow → mint `vta_` token into a fresh slug | Free | M | — | D4 |
| 3 | **Abuse controls** — identity-gating, fast handle revocation, abuse-report endpoint, per-account reserved-ID count cap, provider-as-trust-signal | Free | M | #2 | D3 |
| 4 | **Fair-use rate limits wired + enforced** — monthly active-bandwidth/duration cap, req/sec burst, concurrent-tunnel cap | Free | S–M | metering ✅ | D2, D3 |

## Phase 1 — Free-tier differentiators (the bait; cheap to provide)

| # | Item | Free/Paid | Effort | Notes |
|---|---|---|---|---|
| 5 | **Request inspector — live view** (in-memory ring buffer at the DO) | Free | M | ngrok's most-loved feature; DO already brokers every frame |
| 6 | **End-user OAuth / basic-auth gating** | Free | S–M | extends `auth.ts`; "share with only my team" |
| 7 | **Header/CSP rewrite → general rule list** | Free | S | generalizes the CSP strip already in place |
| 8 | **QR code + copy-URL on connect** | Free | XS | instant mobile testing; tiny effort, big delight |
| 9 | **Wildcard subdomains under a reserved ID** (`*.app.<domain>`) | Free | S | routing in `worker.ts` |

## Phase 2 — Paid tier (each item gated because it genuinely costs us)

| # | Item | Free/Paid | Effort | Cost driver |
|---|---|---|---|---|
| 10 | **Inspector replay w/ persisted history** | Free preview / **Paid** retention (TTL + size capped) | M | DO storage |
| 11 | **Higher / unlimited bandwidth tiers** | **Paid** | S | active duration/bandwidth |
| 12 | **BYO custom hostname** | **Paid** | M–L | per-hostname TLS cert (CF for SaaS) |
| 13 | **TCP/UDP tunnels** | **Paid** | L | off-Cloudflare compute (Fly path or TCP-over-WS) |
| 14 | **More concurrent tunnels beyond free cap** | **Paid** | S | concurrency already modeled |

## Critical path

Phase 0 *is* the launch — #1 (idle-reclaim) and #2 (signup) are the two
genuinely-missing pillars; #3/#4 layer policy onto existing substrate. Phase 1
makes users choose us over ngrok's free tier at ~zero cost to us. Phase 2 lines
revenue up with real cost drivers.
