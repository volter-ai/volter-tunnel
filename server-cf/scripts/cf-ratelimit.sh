#!/usr/bin/env bash
# Create/update the public-surface rate-limit WAF rule via the Cloudflare API.
# Per-IP edge limiter for the unauthenticated surface (/signup/*, /report,
# /waitlist), complementing the in-DO SIGNUP_RPS limiter (which is global).
#
# Needs a Cloudflare API token with **Zone → WAF → Edit** on the zone:
#   CLOUDFLARE_API_TOKEN=xxxxx bash server-cf/scripts/cf-ratelimit.sh
#
# Idempotent: PUTs the whole http_ratelimit entrypoint ruleset (one rule).
set -euo pipefail

# Auto-load a local, gitignored .env (repo root or server-cf/) so the token can
# be persisted there instead of pasted each run.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for envf in "$PWD/.env" "${SCRIPT_DIR}/../../.env" "${SCRIPT_DIR}/../.env"; do
  if [ -f "$envf" ]; then set -a; . "$envf"; set +a; break; fi
done

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN (a token with Zone WAF: Edit) — e.g. in a gitignored .env}"
ZONE_NAME="${ZONE_NAME:-voltertest.xyz}"
REQUESTS="${REQUESTS:-20}"     # requests allowed per period, per IP
PERIOD="${PERIOD:-10}"      # seconds (free plan: 10)
MITIGATION="${MITIGATION:-10}" # block duration, seconds (free plan: 10)
API="https://api.cloudflare.com/client/v4"
auth=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

echo "Resolving zone id for ${ZONE_NAME}…"
ZONE_ID=$(curl -fsS "${auth[@]}" "${API}/zones?name=${ZONE_NAME}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["id"])')
echo "  zone: ${ZONE_ID}"

EXPR='(starts_with(http.request.uri.path, "/signup/")) or (http.request.uri.path eq "/report") or (http.request.uri.path eq "/waitlist")'

body=$(python3 - "$EXPR" "$REQUESTS" "$PERIOD" "$MITIGATION" <<'PY'
import json, sys
expr, req, period, mit = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
print(json.dumps({
  "rules": [{
    "description": "public-surface-rate-limit",
    "expression": expr,
    "action": "block",
    "ratelimit": {
      "characteristics": ["ip.src", "cf.colo.id"],
      "period": period,
      "requests_per_period": req,
      "mitigation_timeout": mit
    }
  }]
}))
PY
)

echo "Deploying rate-limit rule (${REQUESTS} req / ${PERIOD}s per IP → block ${MITIGATION}s)…"
curl -fsS -X PUT "${auth[@]}" \
  "${API}/zones/${ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
  --data "${body}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("success:",d.get("success"),"| rules:",len(d.get("result",{}).get("rules",[])))'
