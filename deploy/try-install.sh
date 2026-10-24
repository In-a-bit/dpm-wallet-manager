#!/usr/bin/env bash
# Try the one-step install on this machine against any platform you can reach: one running on
# this computer, or a shared one such as dev. It installs exactly what a builder installs; only
# where the images come from and which platform to join are yours to choose.
#
#   deploy/try-install.sh [options]               check, then install and set up as a builder does
#   deploy/try-install.sh verify [--dir DIR]      check a finished install (runs scripts/smoke.sh)
#   deploy/try-install.sh clean [--dir DIR]       remove the install, to start over
#
# Options:
#   --platform URL      the platform's dpm-api address      (asked for; suggests http://localhost:8086)
#   --images TAG        use ghcr.io/in-a-bit/*:TAG: pulled, or already on this machine (default main)
#   --build             build the images from source instead, from this checkout and
#   --wallet-src DIR    a dpm-wallet checkout             (default: ../dpm-wallet, if it exists)
#   --dir DIR           where to install                          (default ~/dpm-custody-try)
#   --name NAME         the install's Docker project name              (default dpm-custody)
#                       Two installs with different names and folders run side by side, e.g.
#                       one segregated and one shared (see deploy/README.md):
#                         --name dpm-custody-segregated --dir ~/dpm-custody-segregated
#                         --name dpm-custody-shared     --dir ~/dpm-custody-shared
#   --builder-key-file FILE   read the builder private key from FILE (its first line)
#
# The builder private key comes from that platform's backoffice (Custody Builders → create a
# builder → New key). It is never taken as an argument, so it cannot show up in `ps` or the shell
# history: the script reads it from --builder-key-file, from $SETUP_BUILDER_KEY (the shell-history
# caveat of setting it on the command line is yours), or asks for it with the typing hidden.
# It reaches curl through a config on stdin, never on a command line.
#
# Every answer is checked as soon as it is given, and asked for again if it does not pass. No
# browser is needed.
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
INSTALL_NAME="dpm-custody"
BUILDER_KEY="${SETUP_BUILDER_KEY:-}"
BUILDER_KEY_FILE=""
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
      --name) INSTALL_NAME="${2:?--name needs a name}"; shift ;;
      --builder-key-file) BUILDER_KEY_FILE="${2:?--builder-key-file needs a file}"; shift ;;
      -h | --help | help) usage; exit 0 ;;
      -*) fail "Unknown option $1" "Run $0 --help" ;;
      # A key given as an argument would sit in `ps` and the shell history; refuse it.
      bld_sk_*) fail "Do not pass the builder key as an argument: it would be visible in ps and in your shell history." \
        "Use --builder-key-file FILE, set SETUP_BUILDER_KEY, or leave it out and paste it when asked." ;;
      *) fail "Unexpected argument $1" "Run $0 --help" ;;
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

# sha256_of FILE... prints sha256sum-format lines with whichever tool exists.
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# http <method> <url> [curl args...] prints the body, then the status code on its own last line.
http() { http_with_header "" "$@"; }

# http_with_header <"Name: value" | ""> <method> <url> [curl args...] is http with one request
# header that may be secret. It goes to curl as a config on stdin, never as an argument, so it
# is not in `ps` or /proc/*/cmdline.
http_with_header() {
  local header="$1" method="$2" url="$3"
  shift 3
  header="${header//\\/\\\\}"
  header="${header//\"/\\\"}"
  { [ -z "$header" ] || printf 'header = "%s"\n' "$header"; } |
    curl -s --config - -X "$method" -w '\n%{http_code}' --max-time 15 "$url" "$@" || printf '\n000'
}
status_of() { tail -n 1 <<<"$1"; }
body_of() { sed '$d' <<<"$1"; }

# safe_platform_url URL succeeds when a builder key may be sent to URL: https://, or http:// only
# for a host on this computer (localhost, 127.0.0.1, [::1], host.docker.internal). Userinfo (an
# `@` in the authority) is refused: `http://localhost@evil.example` is evil.example. This is the
# shell twin of isSafePlatformUrl in src/setup/environments.ts.
safe_platform_url() {
  local url scheme rest authority host
  url="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$url" in
    https://?*) scheme=https; rest="${url#https://}" ;;
    http://?*) scheme=http; rest="${url#http://}" ;;
    *) return 1 ;;
  esac
  authority="${rest%%[/?#]*}"
  case "$authority" in *@* | *[[:space:]]*) return 1 ;; esac
  [ "$scheme" = https ] && return 0
  case "$authority" in
    "[::1]" | "[::1]":*) host="[::1]" ;;
    *) host="${authority%%:*}" ;;
  esac
  case "$host" in
    localhost | 127.0.0.1 | "[::1]" | host.docker.internal) ;;
    *) return 1 ;;
  esac
  # Only an optional :port may follow the host.
  case "${authority#"$host"}" in
    "" | :[0-9]*) ;;
    *) return 1 ;;
  esac
  case "${authority#"$host"}" in *[!0-9:]*) return 1 ;; esac
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# claimed_ports lists every host port a container on this machine publishes, running or stopped.
# A stopped install's port is free right now, but taking it would clash once both are started.
claimed_ports() {
  local ids
  ids="$(docker ps -aq)"
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one id per word
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids |
    tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u
}

# free_port <preferred> prints the preferred port, or the next one after it that is neither in
# use nor claimed by another container.
free_port() {
  local port="$1" claimed
  claimed="$(claimed_ports)"
  while port_in_use "$port" || grep -qx "$port" <<<"$claimed"; do port=$((port + 1)); done
  echo "$port"
}

install_env() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1; }

# ── start ────────────────────────────────────────────────────────────────────

check_tools() {
  step "Tools"
  for tool in docker curl python3 openssl; do
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
  case "$INSTALL_NAME" in
    [a-z0-9]*) ;;
    *) fail "--name must start with a lowercase letter or digit." ;;
  esac
  case "$INSTALL_NAME" in
    *[!a-z0-9_-]*) fail "--name may only use lowercase letters, digits, '-' and '_'." ;;
  esac
  # Running or stopped: Docker treats two installs with one name as one install.
  if docker compose ls -a -q 2>/dev/null | grep -qx "$INSTALL_NAME"; then
    fail "Another install on this machine is already named \"$INSTALL_NAME\"." \
      "To run a second install beside it, give this one its own name and folder:" \
      "  $0 --name dpm-custody-2 --dir ~/dpm-custody-2 …"
  fi
  ok "none named \"$INSTALL_NAME\" in $INSTALL_DIR"
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
  safe_platform_url "$PLATFORM" || {
    PROBLEM="\"$PLATFORM\" must use https://, or http:// only for a platform on this computer (localhost, 127.0.0.1, [::1] or host.docker.internal), and carry no user@ part: the builder key is sent to it."
    return 1
  }
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
  if [ -n "$BUILDER_KEY_FILE" ]; then
    [ -r "$BUILDER_KEY_FILE" ] || fail "Cannot read $BUILDER_KEY_FILE."
    BUILDER_KEY="$(head -n 1 "$BUILDER_KEY_FILE")"
  fi
  while :; do
    if [ -z "$BUILDER_KEY" ]; then
      can_ask || fail "No builder private key." "Use --builder-key-file FILE or set SETUP_BUILDER_KEY."
      printf "  From this platform's backoffice: Custody Builders → your builder → New key → Copy.\n"
      read -rsp "  Paste it here (it is not shown): " BUILDER_KEY
      printf '\n'
    fi
    BUILDER_KEY="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//' <<<"$BUILDER_KEY")"
    if key_ok; then
      BUILDER_NAME="$(body_of "$CONFIG" | json_path owner.name)"
      ok "the platform knows this key: builder \"$BUILDER_NAME\""
      break
    fi
    warn "$PROBLEM"
    can_ask || exit 1
    BUILDER_KEY=""
  done
  check_platform_apis
}

# key_ok succeeds, with the platform's answer in CONFIG, when $BUILDER_KEY can be used; otherwise
# PROBLEM says why. A problem with the platform, not the key, ends the run: another key cannot fix it.
key_ok() {
  case "$BUILDER_KEY" in
    bld_sk_?*) ;;
    *) PROBLEM="That is not a builder private key: it should start with bld_sk_." && return 1 ;;
  esac
  # The key travels in a curl config on stdin: a space, quote or line break in it would be read as
  # more config. A real key has none, so refuse rather than strip.
  case "$BUILDER_KEY" in
    *[[:space:][:cntrl:]\"\\]*) PROBLEM="That key contains spaces, quotes or line breaks, which a builder key never does: paste only the key." && return 1 ;;
  esac
  CONFIG="$(http_with_header "X-Builder-Api-Private-Key: $BUILDER_KEY" GET "$PLATFORM/wallet-install/config")"
  case "$(status_of "$CONFIG")" in
    200) ;;
    401) PROBLEM="The platform does not accept this key: check you copied all of it, that it was issued on this platform, and that it has not been revoked." && return 1 ;;
    409) PROBLEM="This key belongs to an embedded builder, which does not run a DPM Wallet: create a custody builder instead (Custody Builders → Onboard custody builder)." && return 1 ;;
    503) fail "This platform is not configured for self-install." \
      "Its dpm-api needs PUBLIC_DPM_API_URL, PUBLIC_GAMMA_API_URL and PUBLIC_RELAYER_API_URL, then a restart." ;;
    *) fail "GET /wallet-install/config answered $(status_of "$CONFIG"): $(body_of "$CONFIG")" ;;
  esac
}

# check_platform_apis checks that the two other platform services accept the builder key on
# its own on the routes an install calls. Neither probe changes anything: an empty body is
# refused by POST /custody/users (400) only once the key has been accepted, and
# GET /contract-info is a read. A 401 means that service still wants an app key there.
check_platform_apis() {
  local gamma_api relayer_api answer
  gamma_api="$(body_of "$CONFIG" | json_path services.gamma_api)"
  relayer_api="$(body_of "$CONFIG" | json_path services.relayer_api)"
  # The platform names these itself, and the key goes to both: hold them to the same rule.
  local service
  for service in "$gamma_api" "$relayer_api"; do
    safe_platform_url "$service" ||
      fail "The platform reported an unsafe service address: ${service:-(none)}." \
        "Services must use https:// (http:// only for a platform on this computer). The builder key was not sent there."
  done

  answer="$(http_with_header "X-Builder-Api-Private-Key: $BUILDER_KEY" POST "$gamma_api/custody/users" \
    -H 'Content-Type: application/json' -d '{}')"
  case "$(status_of "$answer")" in
    400) ok "gamma-api ($gamma_api) accepts the builder key for user registration" ;;
    401) fail "gamma-api at $gamma_api does not accept the builder key on POST /custody/users." \
      "Deploy gamma-api from a prediction-go version that lists it in CustodyInstallRoutes." ;;
    *) fail "gamma-api at $gamma_api answered $(status_of "$answer")." \
      "Check the platform's PUBLIC_GAMMA_API_URL is reachable from this machine." ;;
  esac

  answer="$(http_with_header "X-Builder-Api-Private-Key: $BUILDER_KEY" GET "$relayer_api/contract-info")"
  case "$(status_of "$answer")" in
    200) ok "relayer-api ($relayer_api) accepts the builder key" ;;
    401) fail "relayer-api at $relayer_api does not accept the builder key." \
      "Deploy relayer-api from a prediction-go version that accepts X-Builder-Api-Private-Key." ;;
    *) fail "relayer-api at $relayer_api answered $(status_of "$answer")." \
      "Check the platform's PUBLIC_RELAYER_API_URL is reachable from this machine." ;;
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
    if docker pull -q "ghcr.io/in-a-bit/$image:$IMAGE_TAG" >/dev/null 2>&1; then
      ok "ghcr.io/in-a-bit/$image:$IMAGE_TAG"
    # Not published, but on this machine: e.g. --images local after an earlier --build.
    elif docker image inspect "ghcr.io/in-a-bit/$image:$IMAGE_TAG" >/dev/null 2>&1; then
      ok "ghcr.io/in-a-bit/$image:$IMAGE_TAG (already on this machine)"
    else
      fail "Could not pull ghcr.io/in-a-bit/$image:$IMAGE_TAG." \
        "Not published yet, or the package is still private? Use another --images tag, or --build."
    fi
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
  step "Install \"$INSTALL_NAME\" into $INSTALL_DIR (wallet manager on :$manager_port)"
  source="$(mktemp -d)"
  cp "$SCRIPT_DIR/compose.yml" "$SCRIPT_DIR/dpm-custody" "$source/"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\n' "$IMAGE_TAG" "$IMAGE_TAG" >"$source/versions.env"
  # The installer only accepts a signed release. This rehearsal signs its files with a throwaway
  # key and tells the installer to trust that key (DPM_CUSTODY_RELEASE_PUBKEY, rehearsals only);
  # the public half is kept in the install folder for rehearsing `dpm-custody upgrade` too.
  local key="$source/.rehearsal-key.pem"
  openssl ecparam -name prime256v1 -genkey -noout -out "$key" 2>/dev/null
  openssl pkey -in "$key" -pubout -out "$source/rehearsal-release.pub"
  (cd "$source" && sha256_of compose.yml versions.env dpm-custody >SHA256SUMS)
  openssl dgst -sha256 -sign "$key" -out "$source/SHA256SUMS.sig" "$source/SHA256SUMS"
  rm -f "$key"
  # The installer goes on to setup in this terminal, with the two answers checked above preset.
  local status=0
  DPM_CUSTODY_DIR="$INSTALL_DIR" DPM_CUSTODY_SOURCE="$source" \
    DPM_CUSTODY_RELEASE_PUBKEY="$source/rehearsal-release.pub" \
    DPM_CUSTODY_MANAGER_PORT="$manager_port" DPM_CUSTODY_NAME="$INSTALL_NAME" \
    SETUP_PLATFORM_URL="$PLATFORM" SETUP_BUILDER_KEY="$BUILDER_KEY" \
    sh "$SCRIPT_DIR/install.sh" || status=$?
  [ -d "$INSTALL_DIR" ] && cp "$source/rehearsal-release.pub" "$INSTALL_DIR/rehearsal-release.pub"
  rm -rf "$source"
  [ "$status" = 0 ] || exit "$status"
  ok "installed from a rehearsal release signed with a throwaway key"
  printf '  To rehearse an upgrade: cd %s && DPM_CUSTODY_RELEASE_PUBKEY=rehearsal-release.pub DPM_CUSTODY_ALLOW_INSECURE=1 DPM_CUSTODY_RELEASES_URL=file:///path/to/signed-release ./dpm-custody upgrade\n' "$INSTALL_DIR"
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
  platform="$(http_with_header "X-API-Key: $admin_key" GET "http://localhost:$manager_port/v1/platform")"
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

# Sourced (by deploy/test/try-install.test.sh) only the functions are wanted.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  parse_args "$@"
  case "$COMMAND" in
    start) cmd_start ;;
    verify) cmd_verify ;;
    clean) cmd_clean ;;
  esac
fi
