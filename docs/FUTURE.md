# @volter/tunnel — Future Work / Backlog

Everything deferred out of the free-tier build, with *what unblocks it*. The
free tier (Phase 0 + 1 + #10) is built, deployed, and hardened — see
[ROADMAP.md](./ROADMAP.md). No git remote is configured, so this file is the
backlog of record (convert to issues once a remote exists).

---

## Blocked on infrastructure / Cloudflare product tier

### #13 — TCP/UDP tunnels (paid)
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

### #12 — BYO custom hostname (paid)
Needs the **Cloudflare for SaaS** product (custom-hostname routing + per-hostname
TLS cert provisioning via the CF API). Worker-side routing is small (map an
incoming custom Host → its tunnelId); it's inert without the subscription. Per-
hostname cert is the paid cost driver.

## Buildable now, deferred (no blocker)

- **#6 OAuth-gating variant** — end-user OAuth (Google/GitHub) in front of a
  tunnel, reusing the #2 GitHub plumbing. The HTTP basic-auth form is shipped.
- **SSH-key signup proof** — a third identity method for the git-over-SSH crowd
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
  (per-account limits via the admin API, #11/#14). Productizing = a pricing page +
  billing (e.g. Stripe) that calls the admin API to set limits. Outside this repo.

## Operator tasks (not code)

- **Cloudflare WAF rate-limit rule** on `/signup/*` and `/report` — per-IP edge
  layer atop the in-DO `SIGNUP_RPS` limiter. Needs the dashboard or a WAF-scoped
  API token (the wrangler OAuth token is `zone:read` only).
- **Finalize D6 policy numbers**; widen the waitlist (`SIGNUP_ALLOWED_USERS`) when
  ready for open signup.

## Security hardening (minor, deferred)

- **basic-auth hash** is unsalted SHA-256 (fast). Fine for a dev-tunnel gate (the
  hash isn't exposed); move to a slow KDF if it becomes a real auth surface.
- **`JWT_SECRET`** is deliberately unset (setting it would force JWTs on visitors
  and break public sharing). Revisit only if a private-by-default mode is wanted —
  and note the inspector is already independently owner-gated.
- **Gist-verify GitHub call** is unauthenticated (60 req/hr/IP); bounded by the
  public rate limiter. A full fix needs an app-owned GitHub token.
