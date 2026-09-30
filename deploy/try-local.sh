#!/usr/bin/env bash
# Try the one-step install against the platform running on this computer.
#
#   deploy/try-local.sh           check the platform, create a test builder and key, build the
#                                 images, install, and print exactly what to enter on the page
#   deploy/try-local.sh verify    check the finished install (and run scripts/smoke.sh)
#   deploy/try-local.sh clean     remove the test install, so the next run starts fresh
#
# It expects the repos side by side (prediction-go, dpm-wallet, dpm-wallet-manager) and the local
# platform already started with the devtool. Nothing here touches a remote environment.
#
# Overridable: WORKSPACE (the folder holding the repos), INSTALL_DIR (~/dpm-custody-local),
# MANAGER_PORT (3300, since the demo stack uses 3000), SETUP_PORT (8480).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="${WORKSPACE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
PREDICTION_GO="$WORKSPACE/prediction-go"
DPM_WALLET="$WORKSPACE/dpm-wallet"
MANAGER="$WORKSPACE/dpm-wallet-manager"
INSTALL_DIR="${INSTALL_DIR:-$HOME/dpm-custody-local}"
MANAGER_PORT="${MANAGER_PORT:-3300}"
SETUP_PORT="${SETUP_PORT:-8480}"
IMAGE_TAG=local
KEY_FILE="$INSTALL_DIR/test-builder-key.txt"

step() { printf '\n▸ %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
fail() {
  printf '\n  ✕ %s\n' "$1"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  printf '\n'
  exit 1
}

# json_field <field> reads one top-level field from JSON on stdin; empty when absent or invalid.
json_field() {
  python3 -c 'import json,sys
try: print(json.load(sys.stdin).get(sys.argv[1], ""))
except Exception: pass' "$1"
}

env_value() { sed -n "s/^$1=//p" "$PREDICTION_GO/.env" | tail -n 1; }

# http <method> <url> [curl args...] prints the body, then the status code on its own last line.
http() {
  local method="$1" url="$2"
  shift 2
  curl -s -X "$method" -w '\n%{http_code}' --max-time 15 "$url" "$@" || printf '\n000'
}
status_of() { tail -n 1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

# ── start ────────────────────────────────────────────────────────────────────

check_tools() {
  step "Tools"
  for tool in docker curl python3; do
    command -v "$tool" >/dev/null || fail "$tool is not installed."
  done
  docker info >/dev/null 2>&1 || fail "Docker is not running." "Start it and run this again."
  ok "docker, curl and python3 are available"
}

check_repos() {
  step "Repositories in $WORKSPACE"
  for repo in "$PREDICTION_GO" "$DPM_WALLET" "$MANAGER"; do
    [ -d "$repo/.git" ] || fail "Missing $repo" "Set WORKSPACE to the folder holding prediction-go, dpm-wallet and dpm-wallet-manager."
  done
  grep -q 'optional(env.APP_API_KEY)' "$DPM_WALLET/src/config.ts" ||
    fail "dpm-wallet is on a branch that still requires APP_API_KEY." \
      "cd $DPM_WALLET && git switch feat/gamma-builder-key-only"
  for repo in "$PREDICTION_GO" "$DPM_WALLET" "$MANAGER"; do
    ok "$(basename "$repo"): $(git -C "$repo" branch --show-current)"
  done
}

check_platform() {
  step "Local platform (prediction-go)"
  [ -f "$PREDICTION_GO/.env" ] || fail "No $PREDICTION_GO/.env"
  ADMIN_KEY="$(env_value DPM_API_KEY)"
  DPM_API_PORT="$(env_value DPM_API_PORT)"
  GAMMA_API_PORT="$(env_value GAMMA_API_PORT)"
  DPM_API="http://localhost:${DPM_API_PORT:-8086}"
  GAMMA_API="http://localhost:${GAMMA_API_PORT:-8084}"
  [ -n "$ADMIN_KEY" ] || fail "DPM_API_KEY is not set in $PREDICTION_GO/.env"
  [ -n "$(env_value PUBLIC_DPM_API_URL)" ] ||
    fail "PUBLIC_DPM_API_URL / PUBLIC_GAMMA_API_URL / PUBLIC_RELAYER_API_URL are missing from prediction-go/.env." \
      "Add them (see deploy/README.md, Local), then: cd $PREDICTION_GO && .bin/devtool restart dpm-api"

  local health
  health="$(http GET "$DPM_API/healthz")"
  [ "$(status_of "$health")" = 200 ] ||
    fail "dpm-api is not answering at $DPM_API." \
      "Start the platform: cd $PREDICTION_GO && .bin/devtool start-all  (with 'make devtool' running)"
  local route
  route="$(http GET "$DPM_API/wallet-install/config")"
  case "$(status_of "$route")" in
    401) ok "dpm-api at $DPM_API has GET /wallet-install/config" ;;
    404) fail "dpm-api is an older build without GET /wallet-install/config." \
      "cd $PREDICTION_GO && git switch feat/wallet-install-config && .bin/devtool rebuild dpm-api" ;;
    *) fail "Unexpected answer from $DPM_API/wallet-install/config: $(status_of "$route")" ;;
  esac
  [ "$(status_of "$(http GET "$GAMMA_API/healthz")")" = 200 ] ||
    fail "gamma-api is not answering at $GAMMA_API." "cd $PREDICTION_GO && .bin/devtool start gamma-api"
  ok "gamma-api is up at $GAMMA_API"
}

check_no_other_install() {
  step "Earlier test install"
  if [ -f "$INSTALL_DIR/.env" ]; then
    fail "A test install already exists in $INSTALL_DIR." \
      "Check it with: $0 verify" "Or start over with: $0 clean  (then run this again)"
  fi
  if docker compose ls -q 2>/dev/null | grep -qx dpm-custody; then
    fail "Another dpm-custody install is running (they share one Docker project name)." \
      "Stop it first: cd <its folder> && docker compose --env-file .env -f compose.yml down"
  fi
  ok "none"
}

create_test_builder() {
  step "Test custody builder"
  local name created builder_id issued
  name="install-test-$(date +%Y%m%d-%H%M%S)"
  created="$(http POST "$DPM_API/builders" -H "X-API-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"builder_type\":\"custody\"}")"
  [ "$(status_of "$created")" = 201 ] ||
    fail "Creating the builder failed ($(status_of "$created")): $(body_of "$created")"
  builder_id="$(body_of "$created" | json_field id)"
  ok "created \"$name\" (id $builder_id)"

  issued="$(http POST "$DPM_API/builders/$builder_id/api-private-key" -H "X-API-Key: $ADMIN_KEY")"
  BUILDER_KEY="$(body_of "$issued" | json_field api_private_key)"
  [ -n "$BUILDER_KEY" ] || fail "Issuing its private key failed ($(status_of "$issued")): $(body_of "$issued")"
  ok "issued its private key"
}

preflight() {
  step "Pre-flight with the new key"
  local config
  config="$(http GET "$DPM_API/wallet-install/config" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")"
  case "$(status_of "$config")" in
    200) ok "GET /wallet-install/config answers for $(body_of "$config" | python3 -c 'import json,sys; print(json.load(sys.stdin)["owner"]["name"])')" ;;
    503) fail "dpm-api has no PUBLIC_* URLs loaded." "Restart it after editing .env: cd $PREDICTION_GO && .bin/devtool restart dpm-api" ;;
    *) fail "GET /wallet-install/config answered $(status_of "$config"): $(body_of "$config")" ;;
  esac
  local events
  events="$(http GET "$GAMMA_API/events?limit=1" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")"
  case "$(status_of "$events")" in
    200) ok "gamma-api accepts the builder key at its gate" ;;
    401) fail "gamma-api is an older build that does not accept builder keys at its gate." \
      "cd $PREDICTION_GO && git switch feat/wallet-install-config && .bin/devtool rebuild gamma-api" ;;
    *) fail "gamma-api answered $(status_of "$events"): $(body_of "$events")" ;;
  esac
}

build_images() {
  step "Images (built from your checkouts, tagged :$IMAGE_TAG; the first build takes a few minutes)"
  docker build -q -t "ghcr.io/in-a-bit/dpm-wallet:$IMAGE_TAG" "$DPM_WALLET" >/dev/null
  ok "ghcr.io/in-a-bit/dpm-wallet:$IMAGE_TAG"
  docker build -q -t "ghcr.io/in-a-bit/dpm-wallet-manager:$IMAGE_TAG" "$MANAGER" >/dev/null
  ok "ghcr.io/in-a-bit/dpm-wallet-manager:$IMAGE_TAG"
}

install() {
  step "Install into $INSTALL_DIR"
  local source
  source="$(mktemp -d)"
  cp "$SCRIPT_DIR/compose.yml" "$SCRIPT_DIR/dpm-custody" "$source/"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$IMAGE_TAG" "$IMAGE_TAG" >"$source/versions.env"
  DPM_CUSTODY_DIR="$INSTALL_DIR" DPM_CUSTODY_SOURCE="$source" \
    DPM_CUSTODY_MANAGER_PORT="$MANAGER_PORT" DPM_CUSTODY_SETUP_PORT="$SETUP_PORT" \
    sh "$SCRIPT_DIR/install.sh" >"$source/install.log" 2>&1 ||
    fail "The installer failed. Its output:" "$(tail -n 20 "$source/install.log")"
  rm -rf "$source"
  umask 077
  printf '%s\n' "$BUILDER_KEY" >"$KEY_FILE"
  ok "running; the test key is saved in $KEY_FILE"
}

print_next_steps() {
  local pin
  pin="$(sed -n 's/^SETUP_PIN=//p' "$INSTALL_DIR/.env")"
  cat <<EOF

────────────────────────────────────────────────────────────────────────
  Now finish in the browser:  http://localhost:$SETUP_PORT

  1. PIN:                        $pin
  2. Click "Show more options", choose "Custom", and type:
                                 $DPM_API
  3. Builder private key:        $BUILDER_KEY
     Click "Check key": it should say "Connecting as install-test-…".
  4. Pick a mode, tick the box, click "Start setup".
  5. Download the backup kit, tick "I saved it", click Continue.

  Then check everything:         $0 verify
  Start over (new builder):      $0 clean && $0
────────────────────────────────────────────────────────────────────────
EOF
}

cmd_start() {
  check_tools
  check_repos
  check_platform
  check_no_other_install
  create_test_builder
  preflight
  build_images
  install
  print_next_steps
}

# ── verify ───────────────────────────────────────────────────────────────────

cmd_verify() {
  [ -f "$INSTALL_DIR/.env" ] || fail "No test install in $INSTALL_DIR. Run $0 first."
  step "Services"
  "$INSTALL_DIR/dpm-custody" status
  step "Setup"
  local admin_key platform mode
  admin_key="$("$INSTALL_DIR/dpm-custody" backup-kit 2>/dev/null | sed -n 's/^Admin API key: *//p')" ||
    true
  [ -n "$admin_key" ] || fail "Setup has not been started yet." "Finish it in the browser: http://localhost:$SETUP_PORT"
  platform="$(http GET "http://localhost:$MANAGER_PORT/v1/platform" -H "X-API-Key: $admin_key")"
  [ "$(status_of "$platform")" = 200 ] ||
    fail "The wallet manager is not answering yet ($(status_of "$platform"))." "Is setup finished? See http://localhost:$SETUP_PORT"
  mode="$(body_of "$platform" | json_field mode)"
  ok "wallet manager is up on :$MANAGER_PORT in $mode mode"
  step "Smoke test (creates a wallet, signs an order, checks routing and the money rule)"
  BASE_URL="http://localhost:$MANAGER_PORT" ADMIN_KEY="$admin_key" "$MANAGER/scripts/smoke.sh"
}

# ── clean ────────────────────────────────────────────────────────────────────

cmd_clean() {
  [ -f "$INSTALL_DIR/.env" ] || {
    ok "nothing to clean in $INSTALL_DIR"
    return
  }
  printf 'This deletes the test install in %s, including its wallets and keys.\nType "yes" to continue: ' "$INSTALL_DIR"
  local answer
  read -r answer
  [ "$answer" = yes ] || fail "Cancelled."
  (cd "$INSTALL_DIR" && docker compose --env-file .env -f compose.yml down -v >/dev/null 2>&1)
  rm -rf "$INSTALL_DIR"
  ok "removed. The test builder stays in the local platform; the next run creates a new one."
}

case "${1:-start}" in
  start) cmd_start ;;
  verify) cmd_verify ;;
  clean) cmd_clean ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
