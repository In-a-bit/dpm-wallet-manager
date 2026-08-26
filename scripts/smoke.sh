#!/usr/bin/env bash
#
# Walks the whole API against a running dpm-wallet-manager, in order, and checks the answers.
#
# This exists because no test double can prove the one thing that actually matters in shared mode:
# that the `maker` and `recipient` this service rewrites are accepted by the real dpm-wallet and
# produce a signature over the order it intended. Everything up to that point is covered by the
# suite; this is the part that needs the real upstream.
#
#   BASE_URL=http://localhost:3000 ADMIN_KEY=dpmm_live_ad_… ./scripts/smoke.sh
#
# With no ADMIN_KEY, it bootstraps one — which only works on an install that has no keys yet.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
API="${BASE_URL}/v1"

fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d||"{}");const v=process.argv[1].split(".").reduce((a,k)=>a?.[k],o);console.log(v??"")})' "$1"; }

call() { # method path [body] [key]
  local method="$1" path="$2" body="${3:-}" key="${4:-$ADMIN_KEY}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$API$path" -H "X-API-Key: $key" -H 'Content-Type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$API$path" -H "X-API-Key: $key"
  fi
}
status() { # method path [body] [key]
  local method="$1" path="$2" body="${3:-}" key="${4:-$ADMIN_KEY}"
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" "$API$path" \
    -H "X-API-Key: $key" -H 'Content-Type: application/json' ${body:+-d "$body"}
}

# ── 0. liveness ──────────────────────────────────────────────────────────────
[ "$(curl -sS "$API/health" | field status)" = "ok" ] || fail "health is not ok at $API/health"
ok "health"

# ── 1. credentials ───────────────────────────────────────────────────────────
if [ -z "${ADMIN_KEY:-}" ]; then
  ADMIN_KEY="$(npm run --silent keys:bootstrap:dist 2>/dev/null || npm run --silent keys:bootstrap)"
  # Empty stdout means the table was not empty: bootstrap only ever mints the *first* key, so an
  # install that already has one has to hand its key over rather than be re-seeded.
  [ -n "$ADMIN_KEY" ] ||
    fail "this install already has API keys, so no new one was minted. Pass ADMIN_KEY=… (reveal it with POST /v1/api-keys/:id/reveal)."
  ok "bootstrapped admin key ${ADMIN_KEY:0:21}…"
fi
[ "$(call GET /api-keys/self | field role)" = "admin" ] || fail "ADMIN_KEY is not an admin key"
ok "admin key authenticates"

OPERATOR_KEY="$(call POST /api-keys '{"role":"operator","name":"smoke"}' | field key)"
[ -n "$OPERATOR_KEY" ] || fail "could not mint an operator key"
[ "$(status GET /api-keys '' "$OPERATOR_KEY")" = "403" ] || fail "operator key reached an admin route"
ok "operator key minted and correctly refused on an admin route"

# ── 2. platform ──────────────────────────────────────────────────────────────
MODE="$(call GET /platform | field mode)"
[ -n "$MODE" ] || fail "no mode reported"
ok "mode is $MODE"

MASTER_ID="$(call POST /platform/master-wallet '{}' | field id)"
[ -n "$MASTER_ID" ] || fail "no master wallet"
[ "$(status POST /platform/master-wallet '{}' "$OPERATOR_KEY")" = "403" ] ||
  fail "an operator key created the master wallet"
ok "master wallet $MASTER_ID (admin only)"

OPS_ID="$(call POST /platform/operations-wallet '{}' '' "$OPERATOR_KEY" | field id)"
[ -n "$OPS_ID" ] || fail "no operations wallet"
ok "operations wallet $OPS_ID (operator reachable)"

# ── 3. a user wallet ─────────────────────────────────────────────────────────
WALLET="$(call POST /wallets "{\"externalId\":\"smoke-$(date +%s)\"}" '' "$OPERATOR_KEY")"
WALLET_ID="$(echo "$WALLET" | field id)"
WALLET_PROXY="$(echo "$WALLET" | field proxyAddress)"
[ -n "$WALLET_ID" ] && [ -n "$WALLET_PROXY" ] || fail "wallet creation returned no address: $WALLET"
ok "wallet $WALLET_ID at proxy $WALLET_PROXY"

# ── 4. the routing decision — the reason this script exists ──────────────────
ORDER_BODY='{"side":0,"tokenId":"71321045679252212594626385532706912750332728571942532289631379312455583992563","shares":10,"price":0.4,"feeRateBps":200}'
ORDER="$(call POST "/wallets/$WALLET_ID/orders/sign" "$ORDER_BODY" "$OPERATOR_KEY")"
SIGNED_MAKER="$(echo "$ORDER" | field order.maker)"
SIGNED_RECIPIENT="$(echo "$ORDER" | field order.recipient)"
SIGNER_WALLET="$(echo "$ORDER" | field routing.signerWalletId)"
[ -n "$SIGNED_MAKER" ] || fail "order was not signed: $ORDER"

ZERO="0x0000000000000000000000000000000000000000"
if [ "$MODE" = "shared" ]; then
  OPS_PROXY="$(call GET "/wallets/$OPS_ID" | field proxyAddress)"
  [ "$SIGNED_MAKER" = "$OPS_PROXY" ] || fail "shared BUY should be funded by the treasury, got $SIGNED_MAKER"
  [ "$SIGNED_RECIPIENT" = "$WALLET_PROXY" ] || fail "shared BUY should pay the user, got $SIGNED_RECIPIENT"
  [ "$SIGNER_WALLET" = "$OPS_ID" ] || fail "shared BUY should be signed by the treasury"
  ok "shared BUY: treasury funds, user receives, treasury signs"
else
  [ "$SIGNED_MAKER" = "$WALLET_PROXY" ] || fail "segregated BUY should be funded by the wallet"
  [ "$SIGNED_RECIPIENT" = "$ZERO" ] || fail "segregated order should carry no recipient, got $SIGNED_RECIPIENT"
  ok "segregated BUY: wallet funds itself, no recipient"
fi

# ── 5. the money rule ────────────────────────────────────────────────────────
EXTERNAL="0x000000000000000000000000000000000000dEaD"
WITHDRAW="{\"recipient\":\"$EXTERNAL\",\"amountDecimal\":\"1\"}"
[ "$(status POST "/wallets/$WALLET_ID/withdraw" "$WITHDRAW" "$OPERATOR_KEY")" = "403" ] ||
  fail "a user wallet withdrew off-platform"
[ "$(status POST "/wallets/$WALLET_ID/withdraw" "$WITHDRAW")" = "403" ] ||
  fail "an admin key withdrew off-platform from a user wallet"
[ "$(status POST "/wallets/$MASTER_ID/withdraw" "$WITHDRAW" "$OPERATOR_KEY")" = "403" ] ||
  fail "an operator key withdrew off-platform from the master wallet"
ok "off-platform withdrawal refused from every wallet but master, and from every key but admin"

[ "$(status POST "/wallets/$MASTER_ID/allowance" '')" = "403" ] ||
  fail "the master wallet was given an allowance"
ok "master wallet refuses an allowance"

# ── 6. the trail ─────────────────────────────────────────────────────────────
DENIED="$(call GET '/audit?outcome=denied&limit=100' | field total)"
[ "${DENIED:-0}" -ge 3 ] || fail "denials were not recorded (saw ${DENIED:-0})"
ok "$DENIED refusals recorded in the audit trail"

printf '\n\033[32mAll checks passed against %s (mode: %s)\033[0m\n' "$BASE_URL" "$MODE"
