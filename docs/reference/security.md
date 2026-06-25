# Security model

Security posture of the Cloudflare relay (`server-cf/`): the threat model, what
is enforced, and which tradeoffs are accepted by default for a free, self-hostable
tunnel. Published for transparency — if you self-host, the operator checklist at
the end is the part to action.

---

## Cost (financial) model

- **Egress is free** on Cloudflare — the usual #1 tunnel cost is zero.
- **Tunnel traffic is metered to a hard $ ceiling.** Requests / ws-upgrades /
  relayed messages / tunnel-seconds → credits; `GLOBAL_DAY_LIMIT` /
  `GLOBAL_MONTH_LIMIT` cap Σ(account spend) (default ≈ **$1,000/day,
  $10,000/month**). Per-account `day/monthLimit` are sub-caps.
- **Idle tunnels hibernate** → no duration billing when idle (the 25s client
  keepalive is a protocol ping, auto-answered without waking the DO — do **not**
  change it to an application message — this is deliberate).
- **The signup allowlist bounds accounts** → bounds reserved-id and per-account
  storage growth.

The credit ceiling covers *tunnel* traffic only. Worker/DO invocations on the
unauthenticated control plane are **not** metered — see fix #1.

## Review findings (2026-06-24) — status

### Fixed

1. **[was HIGH — cost] Unauthenticated public endpoints had no rate limiting.**
   `/signup/*` and `/report` are public and unmetered, so a flood ran up
   Worker/DO/subrequest cost outside the credit ceiling.
   **Fix:** an in-DO token-bucket limiter (`SIGNUP_RPS`, default 5/s; bucket 4×)
   on the public surface → `429` when exceeded. Recommend *also* adding a
   Cloudflare WAF rate-limiting rule on `/signup/*` + `/report` as a per-IP layer
   (the in-DO limiter is global; WAF adds per-source granularity + edge drop).

2. **[was MED–HIGH — account takeover] Gist-proof nonce wasn't bound to the
   requester.** The verification nonce lived in a *public* gist, so anyone who
   saw it could call `/gist/verify` first and receive a token for the gist
   owner's account.
   **Fix:** `/gist/start` now also returns a private **`verifier`** (a separate
   HMAC, *not* placed in the gist); `/gist/verify` requires it. A third party who
   only sees the public gist can't produce the verifier → `401`. Covered by an
   explicit attack test.

### Accepted / configuration decisions

3. **`JWT_SECRET` is unset in production → the end-user JWT auth layer is inert.**
   Consequences: `authRequired` tunnels aren't enforced (tunnels are public), and
   `/__volter_inspect` is public on every tunnel (leaks request *metadata* —
   paths/methods/statuses). Acceptable for a free tier where tunnel traffic is
   already public; users who want a private tunnel use `--basic-auth`. Set
   `JWT_SECRET` to activate the layer, or gate the inspector behind the tunnel's
   own secret, if you want privacy by default. **Decide consciously.**

4. **The gh token transits the relay** (token method): verified to be
   used-once-and-discarded (never stored/logged). The **gist method sends us no
   token** for the security-conscious. A documented tradeoff.

5. **`/__internal/revoke-reservation`** is reachable on any tunnel path but
   **root-token gated** (constant-time). Large blast radius if `ROOT_TOKEN` leaks
   — keep it strong and rotate (it's env-sourced, no lockout).

6. **basic-auth hash is unsalted SHA-256** (fast). Lives only in the DO
   attachment (not exposed); low risk for a dev-tunnel gate, not password-grade.

7. **Gist-verify calls the GitHub API unauthenticated** (60 req/hr/IP). The new
   public rate limiter bounds abuse of this path; a full fix would require an
   app-owned GitHub token.

### Already solid (verified)

Token model (opaque, SHA-256-only storage, constant-time compare) · allowlist
enforced before provisioning on both methods · reservation ownership prevents
handle hijacking · **`__volter_auth` cookie stripped before forwarding** (no
cross-tunnel cookie harvest) · replay off by default · admin is Bearer-token
(no CSRF) · `gh-<id>` slug derived from trusted GitHub id.

## Operator checklist

- Set a strong `ROOT_TOKEN`; rotate periodically.
- Keep `SIGNUP_ALLOWED_USERS` set until ready for open signup.
- Add a Cloudflare WAF rate-limit rule on `/signup/*` and `/report`.
- Decide `JWT_SECRET` (auth layer on/off) and whether the inspector should be
  gated on public tunnels.
- Confirm `GLOBAL_*_LIMIT` is your intended maximum spend exposure.
