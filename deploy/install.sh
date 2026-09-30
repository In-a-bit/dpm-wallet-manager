#!/bin/sh
# Installs a DPM custody stack on Linux or macOS:
#
#   curl -fsSL https://github.com/In-a-bit/dpm-wallet-manager/releases/latest/download/install.sh | sh
#
# It checks Docker, puts three files in ~/dpm-custody (override with DPM_CUSTODY_DIR), writes
# .env with a fresh database password and setup PIN, starts the stack and opens the setup page.
# Running it again on an existing install just starts it; nothing is overwritten.
#
# DPM_CUSTODY_RELEASE=v1.2.3 installs that release instead of the latest.
# DPM_CUSTODY_SETUP_PORT / DPM_CUSTODY_MANAGER_PORT move the two ports (8480 / 3000) when taken.
# DPM_CUSTODY_SOURCE=/path/to/deploy copies the files from a local folder (for testing).
set -eu

DIR="${DPM_CUSTODY_DIR:-$HOME/dpm-custody}"
RELEASE="${DPM_CUSTODY_RELEASE:-latest}"
REPO_RELEASES="https://github.com/In-a-bit/dpm-wallet-manager/releases"
SETUP_PORT="${DPM_CUSTODY_SETUP_PORT:-8480}"
MANAGER_PORT="${DPM_CUSTODY_MANAGER_PORT:-3000}"

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

fetch_file() {
  if [ -n "${DPM_CUSTODY_SOURCE:-}" ]; then
    cp "$DPM_CUSTODY_SOURCE/$1" "$DIR/$1"
    return
  fi
  if [ "$RELEASE" = latest ]; then base="$REPO_RELEASES/latest/download"; else base="$REPO_RELEASES/download/$RELEASE"; fi
  curl -fsSL "$base/$1" -o "$DIR/$1" || fail "Could not download $1. Check the internet connection."
}

random_password() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32; }
random_pin() { LC_ALL=C tr -dc '0-9' </dev/urandom | head -c 6; }

write_env() {
  umask 077
  {
    say "# Written by the installer. Keep this file private: it holds the database password."
    say "POSTGRES_USER=dpm"
    say "POSTGRES_PASSWORD=$(random_password)"
    say "SETUP_PIN=$(random_pin)"
    say "SETUP_PORT=$SETUP_PORT"
    say "MANAGER_BIND=127.0.0.1"
    say "MANAGER_PORT=$MANAGER_PORT"
    say "MANAGER_PUBLIC_URL=http://localhost:$MANAGER_PORT"
    grep -E '^DPM_WALLET(_MANAGER)?_TAG=' "$DIR/versions.env"
  } >"$DIR/.env"
}

wait_for_setup_page() {
  i=0
  while [ $i -lt 90 ]; do
    if curl -fsS -o /dev/null "http://localhost:$SETUP_PORT/" 2>/dev/null; then return 0; fi
    i=$((i + 1))
    sleep 2
  done
  fail "The setup page did not start. Run '$DIR/dpm-custody logs setup' to see why."
}

open_browser() {
  url="$1"
  if command -v open >/dev/null 2>&1 && [ "$(uname)" = Darwin ]; then
    open "$url" && return 0
  fi
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 && return 0
  fi
  return 1
}

main() {
  say ""
  say "  DPM Custody installer"
  say ""
  check_docker
  mkdir -p "$DIR"
  if [ -f "$DIR/.env" ]; then
    say "  Found an existing install in $DIR; starting it."
  else
    say "  Installing into $DIR ..."
    for f in compose.yml versions.env dpm-custody; do fetch_file "$f"; done
    chmod +x "$DIR/dpm-custody"
    write_env
  fi
  say "  Downloading and starting the services (the first time takes a few minutes) ..."
  (cd "$DIR" && docker compose --env-file .env -f compose.yml up -d --pull missing) ||
    fail "Docker could not start the services. See the messages above."
  wait_for_setup_page

  url="http://localhost:$SETUP_PORT"
  pin="$(sed -n 's/^SETUP_PIN=//p' "$DIR/.env")"
  say ""
  say "  ✓ Ready. Finish setup in your browser:"
  say ""
  say "      Address:  $url"
  say "      PIN:      $pin"
  say ""
  if open_browser "$url"; then
    say "  (Your browser should open by itself.)"
  else
    say "  No browser on this machine? Either:"
    say "    • from your own computer:  ssh -L $SETUP_PORT:localhost:$SETUP_PORT <you>@<this-server>"
    say "      then open $url there, or"
    say "    • finish here in the terminal:  $DIR/dpm-custody setup"
  fi
  say ""
  say "  Later: $DIR/dpm-custody (start, stop, status, backup, ...)"
  say ""
}

main "$@"
