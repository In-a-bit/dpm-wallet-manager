#!/usr/bin/env bash
# Crash test for a running install: kills dpm-wallet, then the manager, then postgres at random
# points while requests are in flight, retries every request with its Idempotency-Key, and checks
# that no key did its work twice.
#
#   MANAGER_URL=http://localhost:3000 MANAGER_API_KEY=dpmm_..._op_... \
#   INSTALL_DIR=~/dpm-custody bash deploy/test/crash.sh
#
# It sends 20 allowance signings (signatures only, nothing is submitted on chain) for
# ALLOWANCE_WALLET_ID (default: the operations wallet), then ONE real transfer of TRANSFER_MICRO
# (default 10000 = 0.01 USDC.e) from the master wallet to the operations wallet, relayed on chain.
# The transfer key is fixed per run (CRASH_RUN_ID), so the transfer can never be sent twice by
# this script. Only run it where an on-chain transfer is acceptable. CRASH_SKIP_TRANSFER=1 leaves
# the transfer out (signings only, nothing on chain), for a rehearsal.
#
# Kills: CRASH_POINTS="i,j,k" (request numbers 1-21, in kill order dpm-wallet, manager, postgres)
# overrides the random choice. Each kill lands 0-0.25 s after that request starts (a signing takes
# about 0.2 s), or 0-2 s into the transfer, so it may hit the request mid-way or just after it.
# After each kill the script waits for the container to come back and for every service to be
# healthy, then retries any failed request with the same key.
#
# Each signing has its own Idempotency-Key, so each gets its own operations row; a retry with the
# same key reuses that row (the manager's insertOrGet matches on the key).
#
# Checks at the end:
#   - every key, replayed once more, returns exactly the response it returned before;
#   - every allowance row the run created either belongs to a key's response or has the same
#     result_summary as one that does (no key produced a second, different result);
#   - the transfer has one relayer id, its operations rows all share one result_summary, it was
#     mined with one transaction hash, and the operations wallet balance grew by exactly the amount
#     (so at most one transfer reached the chain);
#   - every service is healthy.
# Needs: bash, curl, jq, docker.
set -uo pipefail

MANAGER_URL="${MANAGER_URL:?Set MANAGER_URL, e.g. http://localhost:3000}"
MANAGER_URL="${MANAGER_URL%/}"
KEY="${MANAGER_API_KEY:?Set MANAGER_API_KEY to an operator or admin key}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/dpm-custody}"
COUNT="${CRASH_SIGNINGS:-20}"
TRANSFER_MICRO="${TRANSFER_MICRO:-10000}"
RUN_ID="${CRASH_RUN_ID:-crash-$(date +%Y%m%d%H%M%S)-$$}"
HEALTH_TIMEOUT="${CRASH_HEALTH_TIMEOUT:-300}"
MINE_TIMEOUT="${CRASH_MINE_TIMEOUT:-300}"
MAX_ATTEMPTS=10

for tool in curl jq docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "crash.sh needs $tool" >&2; exit 2; }
done
[ -f "$INSTALL_DIR/.env" ] || { echo "No install at $INSTALL_DIR (set INSTALL_DIR)" >&2; exit 2; }
PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$INSTALL_DIR/.env" | tail -n 1)"
PROJECT="${PROJECT:-dpm-custody}"

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
log() { echo "[$(date +%H:%M:%S)] $*"; }

container_of() { # SERVICE -> container id of this install's service
  docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" | head -n 1
}

# stack_healthy: every service has a running container; those with a healthcheck are healthy.
stack_healthy() {
  local svc id state health
  for svc in postgres dpm-wallet dpm-wallet-manager setup; do
    id="$(container_of "$svc")"
    [ -n "$id" ] || return 1
    state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null)" || return 1
    [ "$state" = running ] || return 1
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$id" 2>/dev/null)"
    case "$health" in - | healthy) ;; *) return 1 ;; esac
  done
}

wait_healthy() {
  local waited=0
  until stack_healthy; do
    if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
      log "stack not healthy after ${HEALTH_TIMEOUT}s"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "stack healthy (waited ${waited}s)"
}

# kill_and_recover SERVICE: docker kill, then wait for the container to run again (the restart
# policy does not restart a container stopped by `docker kill`, so it is started after 5 s, as an
# operator or a supervisor would) and for the whole stack to be healthy.
kill_and_recover() {
  local svc="$1" id before after i
  id="$(container_of "$svc")"
  before="$(docker inspect -f '{{.State.StartedAt}}' "$id")"
  log "docker kill $svc"
  docker kill "$id" >/dev/null || { log "kill $svc failed"; return 1; }
  for i in $(seq 1 5); do
    sleep 1
    after="$(docker inspect -f '{{.State.Status}} {{.State.StartedAt}}' "$id")"
    case "$after" in "running $before") ;; running*) break ;; esac
  done
  case "$after" in
    running*) [ "$after" != "running $before" ] || docker start "$id" >/dev/null ;;
    *) log "$svc did not restart by itself; starting it"; docker start "$id" >/dev/null ;;
  esac
  sleep 3
  wait_healthy
}

# post PATH KEY BODY OUT: one attempt; prints the HTTP status (000 when the connection failed).
post() {
  local args=(-s -o "$4" -w '%{http_code}' --max-time 90 -X POST -H "x-api-key: $KEY" -H "idempotency-key: $2")
  [ -n "$3" ] && args+=(-H 'content-type: application/json' -d "$3")
  curl "${args[@]}" "$MANAGER_URL/v1$1" 2>/dev/null || true
}

get() { curl -s --max-time 30 -H "x-api-key: $KEY" "$MANAGER_URL/v1$1"; }

# send N PATH KEY BODY: sends with retries; a 5xx or a dropped connection is retried with the same
# key once the stack is healthy. Saves the first successful body as $T/resp.N.
send() {
  local n="$1" path="$2" key="$3" body="$4" code attempt
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    code="$(post "$path" "$key" "$body" "$T/out.$n")"
    case "$code" in
      2??) cp "$T/out.$n" "$T/resp.$n"; [ "$attempt" -gt 1 ] && log "#$n succeeded on attempt $attempt"; return 0 ;;
      000 | 5??)
        log "#$n attempt $attempt: HTTP $code $(head -c 200 "$T/out.$n" 2>/dev/null); retrying with the same key"
        wait_kills
        wait_healthy || return 1
        ;;
      *) log "#$n: HTTP $code $(head -c 300 "$T/out.$n")"; return 1 ;;
    esac
  done
  return 1
}

KILL_PIDS=""
wait_kills() { local p; for p in $KILL_PIDS; do wait "$p" 2>/dev/null; done; KILL_PIDS=""; }

# ---- set up --------------------------------------------------------------------------------
wait_healthy || { echo "The install is not healthy; not starting." >&2; exit 1; }
PLATFORM="$(get /platform)"
MASTER="$(jq -r '.masterWallet.id // empty' <<<"$PLATFORM")"
OPS="$(jq -r '.operationsWallet.id // empty' <<<"$PLATFORM")"
[ -n "$MASTER" ] && [ -n "$OPS" ] || { echo "No master or operations wallet: $PLATFORM" >&2; exit 1; }
ALLOWANCE_WALLET="${ALLOWANCE_WALLET_ID:-$OPS}"
balance() {
  curl -s --max-time 30 -X POST -H "x-api-key: $KEY" -H 'content-type: application/json' \
    -d "{\"walletIds\":[\"$1\"]}" "$MANAGER_URL/v1/wallets/balances" | jq -r '.[0].balanceMicro'
}
OPS_BEFORE="$(balance "$OPS")"
START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep 1

TOTAL=$((COUNT + 1))
[ "${CRASH_SKIP_TRANSFER:-}" = 1 ] && TOTAL="$COUNT"
if [ -n "${CRASH_POINTS:-}" ]; then
  IFS=, read -r P1 P2 P3 <<<"$CRASH_POINTS"
else
  read -r P1 P2 P3 <<<"$(for i in $(seq 1 "$TOTAL"); do echo "$RANDOM $i"; done | sort -n | head -n 3 | awk '{print $2}' | sort -n | tr '\n' ' ')"
fi
if [ "$TOTAL" -gt "$COUNT" ]; then
  log "run $RUN_ID: $COUNT allowances on $ALLOWANCE_WALLET, then transfer #$TOTAL of $TRANSFER_MICRO micro master -> operations"
else
  log "run $RUN_ID: $COUNT allowances on $ALLOWANCE_WALLET (no transfer)"
fi
log "kills: dpm-wallet at #$P1, dpm-wallet-manager at #$P2, postgres at #$P3"

amount_decimal="$(awk -v m="$TRANSFER_MICRO" 'BEGIN { printf "%.6f", m / 1000000 }')"
for n in $(seq 1 "$TOTAL"); do
  victim=""
  [ "$n" = "$P1" ] && victim=dpm-wallet
  [ "$n" = "$P2" ] && victim=dpm-wallet-manager
  [ "$n" = "$P3" ] && victim=postgres
  if [ -n "$victim" ]; then
    # A transfer runs for seconds (sign, then relay), so its kill may land anywhere in 0-2 s.
    span=25
    [ "$n" -gt "$COUNT" ] && span=200
    delay="$(awk -v r="$RANDOM" -v s="$span" 'BEGIN { printf "%.2f", (r % s) / 100 }')"
    log "#$n: killing $victim in ${delay}s"
    (sleep "$delay"; kill_and_recover "$victim") &
    KILL_PIDS="$KILL_PIDS $!"
  fi
  if [ "$n" -le "$COUNT" ]; then
    echo "/wallets/$ALLOWANCE_WALLET/allowance|$RUN_ID-allowance-$n|" >"$T/req.$n"
  else
    echo "/wallets/$MASTER/transfers|$RUN_ID-transfer|{\"recipientWalletId\":\"$OPS\",\"amountDecimal\":\"$amount_decimal\"}" >"$T/req.$n"
  fi
  IFS='|' read -r path key body <"$T/req.$n"
  send "$n" "$path" "$key" "$body" || bad "request #$n ($key) never succeeded"
  wait_kills
done
wait_healthy || bad "stack healthy after the kills"

# ---- checks --------------------------------------------------------------------------------
# 1. Replays: each key returns exactly its first response.
replay_bad=0
for n in $(seq 1 "$TOTAL"); do
  [ -f "$T/resp.$n" ] || continue
  IFS='|' read -r path key body <"$T/req.$n"
  code="$(post "$path" "$key" "$body" "$T/replay.$n")"
  if [ "$code" != 200 ] || [ "$(jq -S . "$T/replay.$n")" != "$(jq -S . "$T/resp.$n")" ]; then
    replay_bad=$((replay_bad + 1))
    log "#$n replay differs (HTTP $code)"
  fi
done
[ "$replay_bad" = 0 ] && ok "all $TOTAL keys replay their first response" || bad "$replay_bad keys replayed a different response"

# 2. Allowance rows: none outside a key's own result.
get "/operations?walletId=$ALLOWANCE_WALLET&kind=allowance&from=$START&limit=200" >"$T/allow.json"
rows="$(jq '.items | length' "$T/allow.json")"
for n in $(seq 1 "$COUNT"); do [ -f "$T/resp.$n" ] && jq -r .operationId "$T/resp.$n"; done | sort -u >"$T/keyed.ids"
# A replayed nonce returns an operation that may predate this run, so look ids up without `from`.
get "/operations?walletId=$ALLOWANCE_WALLET&kind=allowance&limit=200" >"$T/allow-all.json"
jq -r --rawfile ids "$T/keyed.ids" '.items[] | select(.id as $i | ($ids | split("\n") | index($i))) | .resultSummary' \
  "$T/allow-all.json" | sort -u >"$T/keyed.summaries"
missing="$(jq -r '.items[].id' "$T/allow-all.json" | sort -u | comm -13 - "$T/keyed.ids" | wc -l | tr -d ' ')"
orphans="$(jq -r --rawfile ids "$T/keyed.ids" '.items[] | select(.id as $i | ($ids | split("\n") | index($i)) | not) | .resultSummary' "$T/allow.json")"
orphan_count=0
orphan_bad=0
while read -r s; do
  [ -n "$s" ] || continue
  orphan_count=$((orphan_count + 1))
  grep -qxF "$s" "$T/keyed.summaries" || orphan_bad=$((orphan_bad + 1))
done <<<"$orphans"
log "allowance rows since $START: $rows ($orphan_count not returned to any key)"
[ "$missing" = 0 ] && ok "every allowance response's operation is recorded" || bad "$missing returned operations are not in operations"
[ "$orphan_bad" = 0 ] && ok "no key produced a second allowance row with a different result_summary" ||
  bad "$orphan_bad allowance rows have a result_summary no key returned"

# 3. The transfer.
if [ "$TOTAL" -gt "$COUNT" ] && [ -f "$T/resp.$TOTAL" ]; then
  rid="$(jq -r .relayerTransactionId "$T/resp.$TOTAL")"
  get "/operations?walletId=$MASTER&kind=withdraw&from=$START&limit=200" >"$T/xfer.json"
  ids="$(jq -r '[.items[].relayerTransactionId | select(. != null)] | unique | length' "$T/xfer.json")"
  sums="$(jq -r '[.items[].resultSummary] | unique | length' "$T/xfer.json")"
  log "transfer rows: $(jq '.items | length' "$T/xfer.json"), relayer ids: $ids, result summaries: $sums, relayer id $rid"
  [ "$ids" = 1 ] && [ "$(jq -r '[.items[].relayerTransactionId | select(. != null)] | unique | .[0]' "$T/xfer.json")" = "$rid" ] &&
    ok "the transfer has one relayer id" || bad "the transfer has $ids relayer ids"
  [ "$sums" = 1 ] && ok "the transfer's rows share one result_summary" || bad "the transfer has $sums different result_summaries"
  hash=""
  waited=0
  while [ "$waited" -lt "$MINE_TIMEOUT" ]; do
    st="$(get "/transfers/$rid")"
    hash="$(jq -r '.transactionHash // empty' <<<"$st")"
    state="$(jq -r '.state // empty' <<<"$st")"
    case "$state" in *MINED* | *CONFIRMED*) [ -n "$hash" ] && break ;; *FAILED* | *INVALID*) break ;; esac
    sleep 5
    waited=$((waited + 5))
  done
  log "transfer state: $state, transaction: ${hash:-none}"
  [ -n "$hash" ] && ok "the transfer was mined in one transaction ($hash)" || bad "the transfer was not mined (state $state)"
  OPS_AFTER="$(balance "$OPS")"
  delta=$((OPS_AFTER - OPS_BEFORE))
  log "operations wallet balance: $OPS_BEFORE -> $OPS_AFTER (delta $delta micro)"
  [ "$delta" = "$TRANSFER_MICRO" ] && ok "the operations wallet received the amount exactly once" ||
    bad "the operations wallet balance changed by $delta, expected $TRANSFER_MICRO"
fi

# 4. Healthy at the end.
stack_healthy && ok "every service is healthy at the end" || bad "not every service is healthy at the end"

echo
[ "$fails" = 0 ] && echo "crash test passed" || echo "crash test: $fails check(s) failed"
exit $((fails > 0))
