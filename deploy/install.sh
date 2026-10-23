#!/bin/sh
# Installs a DPM custody stack on Linux or macOS:
#
#   curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh | sh
#
# It checks Docker, puts three files in ~/dpm-custody (override with DPM_CUSTODY_DIR), writes
# .env with a fresh database password, starts the stack, then runs setup in this terminal. Running
# it again on an existing install starts it and finishes setup if it is not done. It refreshes
# only the dpm-custody script (run `dpm-custody upgrade` to move to a new version); compose.yml,
# versions.env and .env are never overwritten.
#
# DPM_CUSTODY_RELEASE=v1.2.3 installs that release instead of the latest.
# DPM_CUSTODY_RELEASES_URL replaces the download base (…/releases/latest/download or
# …/releases/download/<tag>); file:// works. Downloads are checked against the release's
# SHA256SUMS. DPM_CUSTODY_NO_START=1 stops after the files and .env are written.
# DPM_CUSTODY_MANAGER_PORT moves the wallet manager's port (3000) when it is taken.
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

# fetch_file NAME downloads one release file into the staging folder.
fetch_file() {
  if [ -n "${DPM_CUSTODY_SOURCE:-}" ]; then
    cp "$DPM_CUSTODY_SOURCE/$1" "$STAGE/$1" || fail "Could not copy $1 from $DPM_CUSTODY_SOURCE."
    return
  fi
  curl -fsSL "$(releases_base)/$1" -o "$STAGE/$1" || fail "Could not download $1. Check the internet connection."
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

# verify_files NAME... checks the staged files against the release's SHA256SUMS. A release
# without one (older releases) is accepted with a warning; a mismatch aborts.
verify_files() {
  if [ -n "${DPM_CUSTODY_SOURCE:-}" ]; then
    [ -f "$DPM_CUSTODY_SOURCE/SHA256SUMS" ] && cp "$DPM_CUSTODY_SOURCE/SHA256SUMS" "$STAGE/SHA256SUMS" || true
  else
    curl -fsSL "$(releases_base)/SHA256SUMS" -o "$STAGE/SHA256SUMS" 2>/dev/null || rm -f "$STAGE/SHA256SUMS"
  fi
  if [ ! -s "$STAGE/SHA256SUMS" ]; then
    say "  ! This release has no SHA256SUMS; the downloads could not be checked."
    return 0
  fi
  : >"$STAGE/SHA256SUMS.use"
  for f in "$@"; do
    line="$(grep -E "^[0-9a-fA-F]{64}  \*?$f\$" "$STAGE/SHA256SUMS" | head -n 1 || true)"
    [ -n "$line" ] || fail "SHA256SUMS has no entry for $f. Nothing was installed."
    printf '%s\n' "$line" >>"$STAGE/SHA256SUMS.use"
  done
  sha_check SHA256SUMS.use || fail "A downloaded file does not match SHA256SUMS. Nothing was installed. Try again; if it keeps failing, tell the platform team."
}

# refresh_custody replaces only the dpm-custody script in an existing install.
refresh_custody() {
  fetch_file dpm-custody
  verify_files dpm-custody
  # Copy next to the target first so the final mv is an atomic rename on the same filesystem.
  cp "$STAGE/dpm-custody" "$DIR/.dpm-custody.new"
  chmod +x "$DIR/.dpm-custody.new"
  mv -f "$DIR/.dpm-custody.new" "$DIR/dpm-custody"
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
    say "MANAGER_PUBLIC_URL=http://localhost:$MANAGER_PORT"
    grep -E '^DPM_WALLET(_MANAGER)?_TAG=' "$DIR/versions.env"
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
    refresh_custody
    say "  Updated $DIR/dpm-custody. To move this install to the new version, run:  $DIR/dpm-custody upgrade"
    say "  Starting the install as it is ..."
  else
    check_name
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
  say "  Later: $DIR/dpm-custody (start, stop, status, backup, ...)"
  say ""
}

main "$@"
