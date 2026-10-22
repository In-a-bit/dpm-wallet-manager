#!/bin/sh
# Installs a DPM custody stack on Linux or macOS:
#
#   curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh | sh
#
# It checks Docker, puts three files in ~/dpm-custody (override with DPM_CUSTODY_DIR), writes
# .env with a fresh database password, starts the stack, then runs setup in this terminal. Running
# it again on an existing install starts it and finishes setup if it is not done. It refreshes
# only the dpm-custody script (run `dpm-custody upgrade` to move to a new version); compose.yml,
# versions.env and .env are never overwritten. If that refresh fails (download or checksum), it
# warns, keeps the current script and still starts the install.
#
# DPM_CUSTODY_RELEASE=v1.2.3 installs that release instead of the latest.
# DPM_CUSTODY_RELEASES_URL replaces the download base (…/releases/latest/download or
# …/releases/download/<tag>). Downloads are checked against the release's SHA256SUMS, which must
# carry a valid signature (SHA256SUMS.sig, ECDSA P-256, checked with openssl against the public key
# below); a release without either is refused. Only https:// is accepted, unless
# DPM_CUSTODY_ALLOW_INSECURE=1 (file:// and http:// for a local rehearsal), and
# DPM_CUSTODY_RELEASE_PUBKEY=/path/to/public.pem checks against that key instead (rehearsals only).
# DPM_CUSTODY_NO_START=1 stops after the files and .env are written.
# DPM_CUSTODY_MANAGER_PORT moves the wallet manager's port (default 3000). A new install checks
# the port first and stops, naming a free one, when another program or container has it.
# DPM_CUSTODY_PUBLIC_URL is where people reach the manager and its admin dashboard, when that is
# not http://localhost:<port> — e.g. https://custody.example.com behind a TLS proxy. An https://
# address makes the dashboard's session cookie Secure.
# DPM_CUSTODY_NAME names the install (default dpm-custody): its containers, volumes and network
# are all prefixed with it, so two installs with different names run side by side.
# DPM_CUSTODY_SOURCE=/path/to/deploy copies the files from a local folder (for testing).
# SETUP_PLATFORM_URL / SETUP_BUILDER_KEY answer setup's first two questions (still checked).
set -eu

DIR="${DPM_CUSTODY_DIR:-$HOME/dpm-custody}"
RELEASE="${DPM_CUSTODY_RELEASE:-latest}"
REPO_RELEASES="https://github.com/In-a-bit/dpm-wallet-manager/releases"
MANAGER_PORT="${DPM_CUSTODY_MANAGER_PORT:-3000}"
NAME="${DPM_CUSTODY_NAME:-dpm-custody}"
PUBLIC_URL="${DPM_CUSTODY_PUBLIC_URL:-http://localhost:$MANAGER_PORT}"

# >>> release public key >>>
# PLACEHOLDER: no private key exists for this one. Replace it with the real key (see
# scripts/release-signing-key.sh) in install.sh, install.ps1 and dpm-custody; until then no
# release can be verified, so none can be installed or upgraded to.
RELEASE_KEY_IS_PLACEHOLDER=1
RELEASE_PUBKEY='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAmHIZwcph401VXfbdEQCsT5VUeke
b/nekspBGcW/P3518k+tqluQyqTRi8Y7R7jA6zxSdQwNYVFy41HokCfzCQ==
-----END PUBLIC KEY-----'
# <<< release public key <<<

say() { printf '%s\n' "$*"; }
fail() {
  say ""
  say "  ✕ $*"
  say ""
  exit 1
}

check_docker() {
  command -v docker >/dev/null 2>&1 ||
    fail "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/ (or Docker Engine on a server), then run this again."
  docker info >/dev/null 2>&1 ||
    fail "Docker is installed but not running. Start Docker Desktop (or 'sudo systemctl start docker'), wait a minute, then run this again. On Linux you may also need to add yourself to the docker group."
  docker compose version >/dev/null 2>&1 ||
    fail "Docker Compose v2 is missing. Update Docker to a current version, then run this again."
}

# Downloads go to a temporary folder first, so a bad download or checksum never leaves anything
# half-written in the install folder.
STAGE=""
cleanup() { [ -z "$STAGE" ] || rm -rf "$STAGE"; }
trap cleanup EXIT

releases_base() {
  if [ -n "${DPM_CUSTODY_RELEASES_URL:-}" ]; then
    printf '%s' "${DPM_CUSTODY_RELEASES_URL%/}"
  elif [ "$RELEASE" = latest ]; then
    printf '%s' "$REPO_RELEASES/latest/download"
  else
    printf '%s' "$REPO_RELEASES/download/$RELEASE"
  fi
}

# require_secure_url URL refuses anything but https://, except for a local rehearsal.
require_secure_url() {
  case "$1" in
    https://*) ;;
    *) [ "${DPM_CUSTODY_ALLOW_INSECURE:-}" = 1 ] ||
      fail "Refusing to download from $1: releases are fetched over https:// only. (DPM_CUSTODY_ALLOW_INSECURE=1 allows file:// and http:// for a local rehearsal; never use it on a real install.)" ;;
  esac
}

# fetch_file NAME downloads one release file into the staging folder.
fetch_file() {
  if [ -n "${DPM_CUSTODY_SOURCE:-}" ]; then
    cp "$DPM_CUSTODY_SOURCE/$1" "$STAGE/$1" || fail "Could not copy $1 from $DPM_CUSTODY_SOURCE."
    return
  fi
  url="$(releases_base)/$1"
  require_secure_url "$url"
  case "$url" in
    https://*) curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$STAGE/$1" ;;
    *) curl -fsSL "$url" -o "$STAGE/$1" ;;
  esac || fail "Could not download $1 ($url). Check the internet connection."
}

# sha_check runs the available checksum tool over a sums file, in the staging folder.
sha_check() {
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$STAGE" && sha256sum -c "$1") >/dev/null 2>&1
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$STAGE" && shasum -a 256 -c "$1") >/dev/null 2>&1
  else
    fail "Neither sha256sum nor shasum is available to check the download."
  fi
}

# verify_signature checks SHA256SUMS against SHA256SUMS.sig with the release public key: the
# embedded one, or DPM_CUSTODY_RELEASE_PUBKEY (a PEM file) for a rehearsal.
verify_signature() {
  command -v openssl >/dev/null 2>&1 ||
    fail "openssl is needed to check the release signature and was not found. Install it, then run this again."
  if [ -n "${DPM_CUSTODY_RELEASE_PUBKEY:-}" ]; then
    [ -r "$DPM_CUSTODY_RELEASE_PUBKEY" ] || fail "DPM_CUSTODY_RELEASE_PUBKEY ($DPM_CUSTODY_RELEASE_PUBKEY) is not a readable file."
    cp "$DPM_CUSTODY_RELEASE_PUBKEY" "$STAGE/release.pub"
  else
    printf '%s\n' "$RELEASE_PUBKEY" >"$STAGE/release.pub"
  fi
  if ! openssl dgst -sha256 -verify "$STAGE/release.pub" -signature "$STAGE/SHA256SUMS.sig" "$STAGE/SHA256SUMS" >/dev/null 2>&1; then
    if [ "$RELEASE_KEY_IS_PLACEHOLDER" = 1 ] && [ -z "${DPM_CUSTODY_RELEASE_PUBKEY:-}" ]; then
      fail "This installer still carries a placeholder release key, so no signature can be valid. Nothing was installed. Tell the platform team."
    fi
    fail "The release's signature (SHA256SUMS.sig) does not match its SHA256SUMS. Nothing was installed. Do not use this download; tell the platform team."
  fi
}

# verify_files NAME... checks the staged files against the release's SHA256SUMS, after checking
# the signature on it. A release without SHA256SUMS or SHA256SUMS.sig, a bad signature or a
# mismatch aborts before anything is installed.
verify_files() {
  rm -f "$STAGE/SHA256SUMS" "$STAGE/SHA256SUMS.sig"
  fetch_file SHA256SUMS
  fetch_file SHA256SUMS.sig
  [ -s "$STAGE/SHA256SUMS" ] || fail "SHA256SUMS was downloaded but is empty or unreadable. Nothing was installed."
  [ -s "$STAGE/SHA256SUMS.sig" ] || fail "SHA256SUMS.sig was downloaded but is empty. Nothing was installed."
  verify_signature
  : >"$STAGE/SHA256SUMS.use"
  for f in "$@"; do
    line="$(awk -v f="$f" 'NF == 2 && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/ { n = $2; sub(/^\*/, "", n); if (n == f) { print; exit } }' "$STAGE/SHA256SUMS" || true)"
    [ -n "$line" ] || fail "SHA256SUMS has no entry for $f. Nothing was installed."
    printf '%s\n' "$line" >>"$STAGE/SHA256SUMS.use"
  done
  sha_check SHA256SUMS.use || fail "A downloaded file does not match SHA256SUMS. Nothing was installed. Try again; if it keeps failing, tell the platform team."
}

# refresh_custody replaces only the dpm-custody script in an existing install. Run it in a
# subshell: a failed download or checksum exits that subshell only, with the current script
# untouched. Each step is checked by hand because errexit does not apply inside an `if`.
refresh_custody() {
  fetch_file dpm-custody
  verify_files dpm-custody
  # Copy next to the target first so the final mv is an atomic rename on the same filesystem.
  if cp "$STAGE/dpm-custody" "$DIR/.dpm-custody.new" &&
    chmod +x "$DIR/.dpm-custody.new" &&
    mv -f "$DIR/.dpm-custody.new" "$DIR/dpm-custody"; then
    return 0
  fi
  rm -f "$DIR/.dpm-custody.new"
  return 1
}

random_password() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }

write_env() {
  umask 077
  {
    say "# Written by the installer. Keep this file private: it holds the database password."
    # Overrides compose.yml's `name:`, which is what keeps this install apart from any other.
    say "COMPOSE_PROJECT_NAME=$NAME"
    say "POSTGRES_USER=dpm"
    say "POSTGRES_PASSWORD=$(random_password)"
    say "MANAGER_BIND=127.0.0.1"
    say "MANAGER_PORT=$MANAGER_PORT"
    say "MANAGER_PUBLIC_URL=${PUBLIC_URL%/}"
    grep -E '^(DPM_WALLET(_MANAGER)?|POSTGRES)_TAG=' "$DIR/versions.env"
    version="$(sed -n 's/^RELEASE_VERSION=//p' "$DIR/versions.env" | head -n 1)"
    say "DPM_CUSTODY_VERSION=${version:-unknown}"
  } >"$DIR/.env"
}

# check_name refuses a name another install on this machine already uses: Docker would treat the
# two as one, and the new install would take over the other's containers and data.
check_name() {
  case "$NAME" in
    [a-z0-9]*) ;;
    *) fail "DPM_CUSTODY_NAME must start with a lowercase letter or digit." ;;
  esac
  case "$NAME" in
    *[!a-z0-9_-]*) fail "DPM_CUSTODY_NAME may only use lowercase letters, digits, '-' and '_'." ;;
  esac
  if docker compose ls -a -q 2>/dev/null | grep -qx "$NAME"; then
    fail "Another install on this machine is already named \"$NAME\". Choose another name with DPM_CUSTODY_NAME=…"
  fi
}

# port_taken PORT succeeds when PORT is unusable for a new install: something on this machine
# answers on it, or a container (running or stopped) already publishes it. A stopped install's
# port is free right now, but taking it would clash once both are started. curl's exit code 7
# means nothing answered.
port_taken() {
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" >/dev/null 2>&1
  [ $? -ne 7 ] && return 0
  ids="$(docker ps -aq 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 1
  # shellcheck disable=SC2086 # one id per word
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids 2>/dev/null |
    tr ' ' '\n' | grep -qx "$1"
}

# check_port refuses a port that is not a number or is already taken, before anything is written,
# and names the next free one.
check_port() {
  case "$MANAGER_PORT" in
    '' | *[!0-9]*) fail "DPM_CUSTODY_MANAGER_PORT must be a port number, e.g. 3001." ;;
  esac
  [ "$MANAGER_PORT" -ge 1 ] && [ "$MANAGER_PORT" -le 65535 ] ||
    fail "DPM_CUSTODY_MANAGER_PORT must be between 1 and 65535."
  port_taken "$MANAGER_PORT" || return 0
  free=$((MANAGER_PORT + 1))
  while [ "$free" -le 65535 ] && port_taken "$free"; do free=$((free + 1)); done
  fail "Port $MANAGER_PORT is already in use on this machine. Nothing was installed. Run the installer again with a free port, e.g. DPM_CUSTODY_MANAGER_PORT=$free (before sh)."
}

# check_public_url refuses a DPM_CUSTODY_PUBLIC_URL the manager would not boot with (it must be an
# http(s) address) or that could break .env (spaces, quotes or line breaks).
check_public_url() {
  case "$PUBLIC_URL" in
    *[[:space:]\"\'\\\`\$]*) fail "DPM_CUSTODY_PUBLIC_URL must be a plain address, e.g. https://custody.example.com." ;;
    http://?* | https://?*) ;;
    *) fail "DPM_CUSTODY_PUBLIC_URL must start with http:// or https://, e.g. https://custody.example.com." ;;
  esac
}

# wait_for_setup waits until the setup container can run a command, which is what setup needs.
wait_for_setup() {
  i=0
  while [ $i -lt 90 ]; do
    if (cd "$DIR" && docker compose --env-file .env -f compose.yml exec -T setup true) >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  fail "The setup service did not start. Run '$DIR/dpm-custody logs setup' to see why."
}

# can_ask is true when there is a terminal to ask setup's questions in. Under `curl | sh` the
# script's own input is the download, so the questions go to the terminal itself.
can_ask() { (exec </dev/tty) 2>/dev/null; }

main() {
  started="$(date +%s)"
  say ""
  say "  DPM Custody installer"
  say ""
  check_docker
  STAGE="$(mktemp -d)"
  if [ -f "$DIR/.env" ]; then
    # Only the dpm-custody script is refreshed; compose.yml, versions.env and .env stay as they are.
    say "  Found an existing install in $DIR."
    if (refresh_custody); then
      say "  Updated $DIR/dpm-custody. To move this install to the new version, run:  $DIR/dpm-custody upgrade"
    else
      # Never install an unverified script, but do not stop a working install from starting.
      say "  ! Could not refresh dpm-custody (see above); kept the current dpm-custody script."
      say "    Run this installer again later to get the new one before running dpm-custody upgrade."
    fi
    say "  Starting the install as it is ..."
  else
    check_name
    check_port
    check_public_url
    say "  Installing into $DIR ..."
    for f in compose.yml versions.env dpm-custody; do fetch_file "$f"; done
    verify_files compose.yml versions.env dpm-custody
    mkdir -p "$DIR"
    for f in compose.yml versions.env dpm-custody; do cp "$STAGE/$f" "$DIR/$f"; done
    chmod +x "$DIR/dpm-custody"
    write_env
  fi
  if [ "${DPM_CUSTODY_NO_START:-}" = 1 ]; then
    say "  DPM_CUSTODY_NO_START=1: stopping before the services start."
    exit 0
  fi
  say "  Downloading and starting the services (the first time takes a few minutes) ..."
  (cd "$DIR" && docker compose --env-file .env -f compose.yml up -d --pull missing) ||
    fail "Docker could not start the services. See the messages above."
  wait_for_setup
  # Shown in setup's checklist as the time the installation took.
  SETUP_INSTALL_SECONDS="$(($(date +%s) - started))"
  export SETUP_INSTALL_SECONDS
  say ""
  if ! can_ask; then
    say "  ✓ Running. To finish, run setup in a terminal:  $DIR/dpm-custody setup"
  elif ! "$DIR/dpm-custody" setup </dev/tty; then
    say ""
    say "  Setup is not finished. Continue any time:  $DIR/dpm-custody setup"
    say "  Need help? Run $DIR/dpm-custody support and send the file it writes to the platform team."
    say ""
    exit 1
  fi
  say ""
  say "  Later: $DIR/dpm-custody (start, stop, status, backup, ...). Backups are encrypted: keep the backup recovery key from the kit."
  say ""
}

main "$@"
