#!/usr/bin/env bash
# Try the one-step install on this machine against any platform you can reach: one running on
# this computer, or a shared one such as dev. It installs exactly what a builder installs; only
# where the images come from and which platform to join are yours to choose.
#
#   deploy/try-install.sh [options] [bld_sk_…]   check, then install and set up as a builder does
#   deploy/try-install.sh verify [--dir DIR]      check a finished install (runs scripts/smoke.sh)
#   deploy/try-install.sh clean [--dir DIR]       remove the install, to start over
#
# Options:
#   --platform URL      the platform's dpm-api address      (asked for; suggests http://localhost:8086)
#   --images TAG        use the published images ghcr.io/in-a-bit/*:TAG   (default main)
#   --build             build the images from source instead, from this checkout and
#   --wallet-src DIR    a dpm-wallet checkout             (default: ../dpm-wallet, if it exists)
#   --dir DIR           where to install                          (default ~/dpm-custody-try)
#
# The builder private key comes from that platform's backoffice (Custody Builders → create a
# builder → New key); without it on the command line the script asks for it. Every answer is
# checked as soon as it is given, and asked for again if it does not pass. No browser is needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MANAGER_SRC="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM=""
PROBLEM=""
CONFIG=""
BUILDER_NAME=""
DEFAULT_PLATFORM="http://localhost:8086"
IMAGE_TAG="main"
BUILD=false
WALLET_SRC=""
INSTALL_DIR="$HOME/dpm-custody-try"
BUILDER_KEY=""
COMMAND=start

step() { printf '\n▸ %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ✕ %s\n' "$*"; }
fail() {
  printf '\n  ✕ %s\n' "$1"
  shift
  for line in "$@"; do printf '    %s\n' "$line"; done
  printf '\n'
  exit 1
}

usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      verify | clean) COMMAND="$1" ;;
      start) ;;
      --platform) PLATFORM="${2:?--platform needs a URL}"; shift ;;
      --images) IMAGE_TAG="${2:?--images needs a tag}"; shift ;;
      --build) BUILD=true ;;
      --wallet-src) WALLET_SRC="${2:?--wallet-src needs a folder}"; shift ;;
      --dir) INSTALL_DIR="${2:?--dir needs a folder}"; shift ;;
      -h | --help | help) usage; exit 0 ;;
      -*) fail "Unknown option $1" "Run $0 --help" ;;
      # Anything else is the key: a malformed one gets a message about keys, not the usage text.
      *) BUILDER_KEY="$1" ;;
    esac
    shift
  done
}

# can_ask is true when a wrong answer can be asked for again rather than ending the run.
can_ask() { [ -t 0 ]; }

# json_path <a.b.c> reads a nested field from JSON on stdin; empty when absent or invalid.
json_path() {
  python3 -c 'import json,sys
try:
    value = json.load(sys.stdin)
    for part in sys.argv[1].split("."): value = value[part]
    print(value)
except Exception: pass' "$1"
}

# http <method> <url> [curl args...] prints the body, then the status code on its own last line.
http() {
  local method="$1" url="$2"
  shift 2
  curl -s -X "$method" -w '\n%{http_code}' --max-time 15 "$url" "$@" || printf '\n000'
}
status_of() { tail -n 1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# free_port <preferred> prints the preferred port, or the next free one after it.
free_port() {
  local port="$1"
  while port_in_use "$port"; do port=$((port + 1)); done
  echo "$port"
}

install_env() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1; }

# ── start ────────────────────────────────────────────────────────────────────

check_tools() {
  step "Tools"
  for tool in docker curl python3; do
    command -v "$tool" >/dev/null || fail "$tool is not installed."
  done
  docker info >/dev/null 2>&1 || fail "Docker is not running." "Start it and run this again."
  ok "docker, curl and python3 are available"
}

check_no_other_install() {
  step "Earlier install"
  if [ -f "$INSTALL_DIR/.env" ]; then
    fail "An install already exists in $INSTALL_DIR." \
      "Check it: $0 verify --dir $INSTALL_DIR" "Or start over: $0 clean --dir $INSTALL_DIR"
  fi
  if docker compose ls -q 2>/dev/null | grep -qx dpm-custody; then
    fail "Another dpm-custody install is running on this machine (they share one Docker project name)." \
      "Stop it first: in its folder, docker compose --env-file .env -f compose.yml down"
  fi
  ok "none"
}

ask_platform() {
  step "Platform"
  local answer
  while :; do
    if [ -z "$PLATFORM" ]; then
      can_ask || fail "No platform address." "Pass it with --platform URL."
      read -rp "  dpm-api address [$DEFAULT_PLATFORM]: " answer
      PLATFORM="${answer:-$DEFAULT_PLATFORM}"
    fi
    PLATFORM="$(tr -d '[:space:]' <<<"$PLATFORM")"
    PLATFORM="${PLATFORM%/}"
    if platform_ok; then
      ok "dpm-api at $PLATFORM is up and supports self-install"
      return
    fi
    warn "$PROBLEM"
    can_ask || exit 1
    PLATFORM=""
  done
}

# platform_ok succeeds when $PLATFORM can be used; otherwise PROBLEM says why.
platform_ok() {
  case "$PLATFORM" in
    http://?* | https://?*) ;;
    *) PROBLEM="\"$PLATFORM\" is not an address: it should start with http:// or https://." && return 1 ;;
  esac
  [ "$(status_of "$(http GET "$PLATFORM/healthz")")" = 200 ] || {
    PROBLEM="Nothing answers at $PLATFORM/healthz: check the address and that the platform's dpm-api is running."
    return 1
  }
  local route
  route="$(http GET "$PLATFORM/wallet-install/config")"
  case "$(status_of "$route")" in
    401) ;;
    404) PROBLEM="This dpm-api predates self-install (no GET /wallet-install/config): deploy or rebuild it from a prediction-go version that includes it." && return 1 ;;
    *) PROBLEM="Unexpected answer from $PLATFORM/wallet-install/config: $(status_of "$route")." && return 1 ;;
  esac
}

ask_builder_key() {
  step "Builder private key"
  while :; do
    if [ -z "$BUILDER_KEY" ]; then
      can_ask || fail "No builder private key." "Pass it as the last argument."
      printf "  From this platform's backoffice: Custody Builders → your builder → New key → Copy.\n"
      read -rsp "  Paste it here (it is not shown): " BUILDER_KEY
      printf '\n'
    fi
    BUILDER_KEY="$(tr -d '[:space:]' <<<"$BUILDER_KEY")"
    if key_ok; then
      BUILDER_NAME="$(body_of "$CONFIG" | json_path owner.name)"
      ok "the platform knows this key: builder \"$BUILDER_NAME\""
      break
    fi
    warn "$PROBLEM"
    can_ask || exit 1
    BUILDER_KEY=""
  done
  check_gamma_api
}

# key_ok succeeds, with the platform's answer in CONFIG, when $BUILDER_KEY can be used; otherwise
# PROBLEM says why. A problem with the platform, not the key, ends the run: another key cannot fix it.
key_ok() {
  case "$BUILDER_KEY" in
    bld_sk_?*) ;;
    *) PROBLEM="That is not a builder private key: it should start with bld_sk_." && return 1 ;;
  esac
  CONFIG="$(http GET "$PLATFORM/wallet-install/config" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")"
  case "$(status_of "$CONFIG")" in
    200) ;;
    401) PROBLEM="The platform does not accept this key: check you copied all of it, that it was issued on this platform, and that it has not been revoked." && return 1 ;;
    409) PROBLEM="This key belongs to an embedded builder, which does not run a DPM Wallet: create a custody builder instead (Custody Builders → Onboard custody builder)." && return 1 ;;
    503) fail "This platform is not configured for self-install." \
      "Its dpm-api needs PUBLIC_DPM_API_URL, PUBLIC_GAMMA_API_URL and PUBLIC_RELAYER_API_URL, then a restart." ;;
    *) fail "GET /wallet-install/config answered $(status_of "$CONFIG"): $(body_of "$CONFIG")" ;;
  esac
}

check_gamma_api() {
  local gamma_api events
  gamma_api="$(body_of "$CONFIG" | json_path services.gamma_api)"
  events="$(http GET "$gamma_api/events?limit=1" -H "X-Builder-Api-Private-Key: $BUILDER_KEY")"
  case "$(status_of "$events")" in
    200) ok "gamma-api ($gamma_api) accepts the builder key" ;;
    401) fail "gamma-api at $gamma_api does not accept builder keys at its gate." \
      "Deploy or rebuild gamma-api from a prediction-go version that accepts X-Builder-Api-Private-Key." ;;
    *) fail "gamma-api at $gamma_api answered $(status_of "$events")." \
      "Check the platform's PUBLIC_GAMMA_API_URL is reachable from this machine." ;;
  esac
}

prepare_images() {
  if [ "$BUILD" = true ]; then
    build_images
  else
    pull_images
  fi
}

pull_images() {
  step "Images: published, tag :$IMAGE_TAG"
  local image
  for image in dpm-wallet dpm-wallet-manager; do
    docker pull -q "ghcr.io/in-a-bit/$image:$IMAGE_TAG" >/dev/null 2>&1 ||
      fail "Could not pull ghcr.io/in-a-bit/$image:$IMAGE_TAG." \
        "Not published yet, or the package is still private? Use another --images tag, or --build."
    ok "ghcr.io/in-a-bit/$image:$IMAGE_TAG"
  done
}

build_images() {
  IMAGE_TAG=local
  [ -n "$WALLET_SRC" ] || WALLET_SRC="$(cd "$MANAGER_SRC/.." && pwd)/dpm-wallet"
  [ -f "$WALLET_SRC/Dockerfile" ] ||
    fail "No dpm-wallet checkout at $WALLET_SRC." "Point at yours with --wallet-src DIR."
  grep -q 'optional(env.APP_API_KEY)' "$WALLET_SRC/src/config.ts" ||
    fail "The dpm-wallet checkout at $WALLET_SRC still requires APP_API_KEY." \
      "Check out a version where it is optional (builder key only)."
  step "Images: built from source, tagged :$IMAGE_TAG (the first build takes a few minutes)"
  docker build -q -t "ghcr.io/in-a-bit/dpm-wallet:$IMAGE_TAG" "$WALLET_SRC" >/dev/null
  ok "dpm-wallet from $WALLET_SRC"
  docker build -q -t "ghcr.io/in-a-bit/dpm-wallet-manager:$IMAGE_TAG" "$MANAGER_SRC" >/dev/null
  ok "dpm-wallet-manager from $MANAGER_SRC"
}

install() {
  local source manager_port
  manager_port="$(free_port 3000)"
  step "Install into $INSTALL_DIR (wallet manager on :$manager_port)"
  source="$(mktemp -d)"
  cp "$SCRIPT_DIR/compose.yml" "$SCRIPT_DIR/dpm-custody" "$source/"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$IMAGE_TAG" "$IMAGE_TAG" >"$source/versions.env"
  # The installer goes on to setup in this terminal, with the two answers checked above preset.
  local status=0
  DPM_CUSTODY_DIR="$INSTALL_DIR" DPM_CUSTODY_SOURCE="$source" \
    DPM_CUSTODY_MANAGER_PORT="$manager_port" \
    SETUP_PLATFORM_URL="$PLATFORM" SETUP_BUILDER_KEY="$BUILDER_KEY" \
    sh "$SCRIPT_DIR/install.sh" || status=$?
  rm -rf "$source"
  [ "$status" = 0 ] || exit "$status"
}

offer_verify() {
  local answer=y
  if can_ask; then read -rp "  Run the smoke test now? It creates a wallet and signs an order. [Y/n] " answer; fi
  case "${answer:-y}" in
    [nN]*) printf '\n  Later: %s verify --dir %s\n' "$0" "$INSTALL_DIR" ;;
    *) cmd_verify ;;
  esac
  printf '  Start over: %s clean --dir %s, then use a NEW builder: each can be installed only once.\n\n' \
    "$0" "$INSTALL_DIR"
}

cmd_start() {
  check_tools
  check_no_other_install
  ask_platform
  ask_builder_key
  prepare_images
  install
  offer_verify
}

# ── verify ───────────────────────────────────────────────────────────────────

cmd_verify() {
  [ -f "$INSTALL_DIR/.env" ] || fail "No install in $INSTALL_DIR." "Pass the folder you installed into with --dir."
  local manager_port admin_key platform
  manager_port="$(install_env MANAGER_PORT)"
  step "Services"
  "$INSTALL_DIR/dpm-custody" status
  step "Setup"
  admin_key="$("$INSTALL_DIR/dpm-custody" backup-kit 2>/dev/null | sed -n 's/^Admin API key: *//p')" || true
  [ -n "$admin_key" ] ||
    fail "Setup has not been started yet." "Run it: $INSTALL_DIR/dpm-custody setup"
  platform="$(http GET "http://localhost:$manager_port/v1/platform" -H "X-API-Key: $admin_key")"
  [ "$(status_of "$platform")" = 200 ] ||
    fail "The wallet manager is not answering yet ($(status_of "$platform"))." \
      "Is setup finished? Continue it: $INSTALL_DIR/dpm-custody setup"
  ok "wallet manager is up on :$manager_port in $(body_of "$platform" | json_path mode) mode"
  step "Smoke test (creates a wallet, signs an order, checks routing and the money rule)"
  BASE_URL="http://localhost:$manager_port" ADMIN_KEY="$admin_key" "$MANAGER_SRC/scripts/smoke.sh"
}

# ── clean ────────────────────────────────────────────────────────────────────

cmd_clean() {
  [ -f "$INSTALL_DIR/.env" ] || {
    ok "nothing to clean in $INSTALL_DIR"
    return
  }
  printf 'This deletes the install in %s, including its wallets and keys.\nType "yes" to continue: ' "$INSTALL_DIR"
  local answer
  read -r answer
  [ "$answer" = yes ] || fail "Cancelled."
  (cd "$INSTALL_DIR" && docker compose --env-file .env -f compose.yml down -v >/dev/null 2>&1)
  rm -rf "$INSTALL_DIR"
  ok "removed. If setup was started, that builder now has a Turnkey sub-organization: use a new builder next time."
}

parse_args "$@"
case "$COMMAND" in
  start) cmd_start ;;
  verify) cmd_verify ;;
  clean) cmd_clean ;;
esac
