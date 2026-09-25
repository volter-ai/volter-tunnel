# @volter/tunnel — Future Work / Backlog

Everything deferred out of the free-tier build, with *what unblocks it*. The
free tier is built, deployed, and hardened ([ROADMAP.md](./ROADMAP.md)).
This file is the backlog of record (convert to
GitHub issues as items are picked up).

---

## Blocked on infrastructure / Cloudflare product tier

### TCP/UDP tunnels (paid)
Cloudflare Workers/DO **cannot accept inbound raw TCP** — a hard platform limit,
not a code gap. Paths to ship:
- **CF Spectrum** (enterprise) — raw TCP at the edge; transparent `host:port`.
- **Separate TCP-listener host** (e.g. Fly) that accepts raw TCP and bridges over
  the existing control-WS protocol to the client. New service + deploy target.
- **Helper-based TCP-over-WebSocket** — buildable on *this* stack: the client
  bridges a local TCP service over the control WS, and a `volter-tunnel connect`
  consumer command listens locally and bridges in. New protocol messages
  (`tcp-open`/`tcp-data`/`tcp-close`), analogous to the existing browser-WS relay.
  Not a transparent `host:port` (both ends run our client), but no infra needed.

### BYO custom hostname (paid)
Needs the **Cloudflare for SaaS** product (custom-hostname routing + per-hostname
TLS cert provisioning via the CF API). Worker-side routing is small (map an
incoming custom Host → its tunnelId); it's inert without the subscription. Per-
hostname cert is the paid cost driver.

## Buildable now, deferred (no blocker)

- **OAuth-gating variant** — end-user OAuth (Google/GitHub) in front of a
  tunnel; it needs an OAuth app, which does not exist (D4: signup uses no OAuth app of our own).
  The HTTP basic-auth form is shipped.
- **SSH-key signup proof** — a fourth identity method (after GitHub token, gist and Volter identity) for the git-over-SSH crowd
  who don't use `gh`: signature challenge verified against
  `https://github.com/<user>.keys`. Sends us no token.
- **Org-based signup allowlist** — restrict signup to a GitHub org's members.
  Token method only (needs `read:org`); the gist method sends no token, so it
  can't verify org membership. The login allowlist (`SIGNUP_ALLOWED_USERS`) works
  uniformly today.
- **Inspector web UI** — the inspector/replay is owner-gated and accessed via
  `Authorization: Bearer <tunnel-secret>` (curl today). A small browser UI for the
  owner would be nice.
- **Pricing/tier productization** — the *enforcement* for tiers exists
  (per-account limits via the admin API). Productizing = a pricing page +
  billing (e.g. Stripe) that calls the admin API to set limits. Outside this repo.

## Operator tasks (not code)

- **Cloudflare WAF rate-limit rule** on `/signup/*` and `/report` — per-IP edge
  layer atop the in-DO `SIGNUP_RPS` limiter. Needs the dashboard or a WAF-scoped
  API token.
- **Open signup**, when ready: set `SIGNUP_OPEN=true` (an empty `SIGNUP_ALLOWED_USERS` fails closed).

## Security hardening (minor, deferred)

- **basic-auth hash** is unsalted SHA-256 (fast). Fine for a dev-tunnel gate (the
  hash isn't exposed); move to a slow KDF if it becomes a real auth surface.
- **`JWT_SECRET`** is deliberately unset (setting it would force JWTs on visitors
  and break public sharing). Revisit only if a private-by-default mode is wanted —
  and note the inspector is already independently owner-gated.
- **Gist-verify GitHub call** is unauthenticated (60 req/hr/IP); bounded by the
  public rate limiter. A full fix needs an app-owned GitHub token.
