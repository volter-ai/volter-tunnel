# @volter/tunnel — Production Deploy & Operations

Runbook for launching the Cloudflare relay (`server-cf/`). Assumes the free-tier
build (Phase 0 + 1 + #10) on `main`. See [DECISIONS.md](./DECISIONS.md) for the
why and [ROADMAP.md](./ROADMAP.md) for status.

---

## 1. Prerequisites (one-time)

- **Cloudflare Workers paid plan** — Durable Objects (incl. SQLite + Hibernation)
  require it.
- **A zone for the base domain** added to Cloudflare (e.g. `voltertest.xyz`), with
  a **1-level wildcard** so free Universal SSL covers `*.<domain>`. Tunnel URLs are
  `https://<tunnelId>.<domain>`.
- `wrangler login` (or a CI API token with Workers + DO + the zone).

## 2. Configure

All commands run from `server-cf/`.

**Vars** (`wrangler.jsonc` → `vars`) — already set with sensible defaults; confirm:
- `TUNNEL_DOMAIN` — set to your real base domain (currently `voltertest.xyz`).
- `SIGNUP_DAY_LIMIT` / `SIGNUP_MONTH_LIMIT` — free-tier per-account dollar cap
  (op-credits, ~$1/million). **Do not leave at the code default of 1000** — that
  is ≈$0.001 and makes free accounts unusable.
- `DEFAULT_RESERVED_MAX` (free reserved ids, default 3),
  `RESERVATION_IDLE_TTL_DAYS` (default 60), `BURST_RPS` (0 = off) — confirm vs D6.
- `GLOBAL_DAY_LIMIT` / `GLOBAL_MONTH_LIMIT` — the Σ(account limits) ceiling and
  therefore your total spend cap and signup-capacity limit.

**Secrets** (`wrangler secret put <NAME>`):
- `ROOT_TOKEN` — **required.** Admin credential (mint `vtr_…`, e.g.
  `openssl rand -hex 24` prefixed `vtr_`). Rotatable: re-put + redeploy.
- `SIGNUP_ALLOWED_USERS` — comma-separated GitHub logins allowed to sign up.
  Kept as a secret so it isn't committed to a public repo. **Signup fails CLOSED:**
  if this is unset/empty, *nobody* can sign up unless `SIGNUP_OPEN=true` is also
  set. So the three modes are: allowlist (this set), fully open (`SIGNUP_OPEN=true`,
  no allowlist), or closed (neither — the safe default).
  **LAUNCH POLICY (DECISIONS D6): WAITLIST ONLY.** SET on the live worker (seeded
  with `yueranyuan`) → signup is closed to the public; only listed logins can
  self-provision, everyone else gets 403. To approve someone off the waitlist,
  append their login and re-put:
  `printf 'yueranyuan,newlogin' | wrangler secret put SIGNUP_ALLOWED_USERS`.
- `JWT_SECRET` — optional; HS256 secret for end-user JWT/cookie auth on tunnels.
- `TUNNEL_SECRET` — optional legacy shared secret → the internal account. Set it
  if your own gateway uses the shared-secret path; **omit for a pure-signup
  deployment** (an unset secret fails closed — an api token is then required).

> Optional: `INSPECT_REPLAY=true` to enable persisted inspector history +
> `/__volter_replay`; uncomment the `USAGE_AE` binding after enabling Analytics
> Engine for durable usage time-series.

## 3. Deploy

```bash
cd server-cf
npm run typecheck && npm test     # all suites should pass
npm run deploy                    # wrangler deploy
```

The privileged internal account self-provisions on first use.

## 4. Smoke-test the live relay

```bash
BASE=https://<your-domain>

# Apex responds
curl -s $BASE/api/status                 # {"ok":true,"relay":"cloudflare-do"}
curl -s $BASE/ | grep -o '<title>.*</title>'   # landing page; /docs serves the docs

# Signup (must be on the allowlist if SIGNUP_ALLOWED_USERS is set)
volter-tunnel login --host $BASE         # gh auth token → mints vta_ token
# …or gist proof, sends us no token:
volter-tunnel login --host $BASE --gist

# Expose a local app and hit it
volter-tunnel --port 3000 --host $BASE   # prints https://<id>.<domain> + QR
curl -s https://<id>.<domain>/           # reaches your local app

# Admin (root)
curl -s $BASE/admin/accounts -H "Authorization: Bearer $ROOT_TOKEN"
curl -s $BASE/admin/usage    -H "Authorization: Bearer $ROOT_TOKEN"
```

## 5. Operating it

- **Create / raise an account** (dollars):
  `POST /admin/accounts {"slug":"x","dayUsd":10,"monthUsd":100}` (root).
- **Abuse**: anyone may `POST /report {"tunnelId","reason"}`; review with
  `GET /admin/reports` (root); revoke a handle with
  `DELETE /admin/reservations/<tunnelId>` (root) — frees the id + disconnects.
- **Waitlist**: the apex serves a public landing page (`GET /`) + docs
  (`GET /docs`); its form posts to `POST /waitlist`. Review requests with
  `GET /admin/waitlist` (root). **Approve someone** by appending their GitHub
  login to the allowlist secret and re-putting it:
  `printf 'yueranyuan,newlogin' | wrangler secret put SIGNUP_ALLOWED_USERS`
  (the waitlist is a request queue only — approval is the env-secret edit). A
  user already on the allowlist who submits the form is told they can sign up now.
- **Tune fair-use**: raise `BURST_RPS` if you see request floods; the daily/
  monthly credit caps are the primary limit.
- **Edge rate-limit (per-IP)**: add a Cloudflare WAF rate-limit rule on the
  unauthenticated surface with `CLOUDFLARE_API_TOKEN=… bash server-cf/scripts/cf-ratelimit.sh`
  (needs a token with Zone → WAF → Edit + Zone → Read). Deploys 20 req / 10s per IP → block. Complements the in-DO `SIGNUP_RPS`
  limiter (which is global, not per-IP).
- **Rotate root**: `wrangler secret put ROOT_TOKEN` + redeploy (no lockout — the
  env secret is the source of truth).

## 6. Decide before public launch (DECISIONS D6)

- Free-tier `SIGNUP_DAY/MONTH_LIMIT`, `DEFAULT_RESERVED_MAX`,
  `RESERVATION_IDLE_TTL_DAYS`, and whether `BURST_RPS` is on.
- Open vs allowlist signup (`SIGNUP_ALLOWED_USERS`). Currently launching in
  **allowlist** mode.
- Whether to offer `INSPECT_REPLAY` (paid retention) and at what caps.

## 7. Not yet built (Phase 2)

Custom hostnames (#12, needs CF-for-SaaS), TCP/UDP (#13, needs off-Cloudflare
compute), and the paid bandwidth/concurrency tiers (#11/#14 — enforcement exists
per-account; only packaging remains).
