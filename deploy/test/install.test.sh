#!/usr/bin/env bash
# Re-runnable checks for deploy/install.sh: checksum handling, NO_START, existing-install re-run.
# Uses a docker shim on PATH; never starts real containers.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# sha256 FILE... prints sha256sum-format lines with whichever tool exists (like install.sh).
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# set_version FILE VERSION rewrites RELEASE_VERSION portably (no sed -i).
set_version() { sed "s/^RELEASE_VERSION=.*/RELEASE_VERSION=$2/" "$1" >"$1.tmp" && mv "$1.tmp" "$1"; }
SUMFILES="install.sh install.ps1 compose.yml versions.env dpm-custody"
resum() { (cd "$rel" && sha256 $SUMFILES >SHA256SUMS); }

mkdir -p "$T/bin"
cat >"$T/bin/docker" <<'S'
#!/bin/sh
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "compose ls") [ -n "${EXISTING_NAME:-}" ] && echo "$EXISTING_NAME"; exit 0 ;;
  # A container publishing $CLAIMED_PORT, when set (stopped or running: install.sh must not care).
  "ps -aq") [ -n "${CLAIMED_PORT:-}" ] && echo c0ffee; exit 0 ;;
esac
[ "$1" = inspect ] && [ -n "${CLAIMED_PORT:-}" ] && echo "$CLAIMED_PORT "
exit 0
S
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log"

rel="$T/rel"
mkdir -p "$rel"
for f in install.sh install.ps1 compose.yml versions.env dpm-custody; do cp "$HERE/$f" "$rel/$f"; done
set_version "$rel/versions.env" 9.9.9
echo "echo custody-v2" >>"$rel/dpm-custody"
resum

# free_port prints a port nothing listens on, so the installer's port check passes.
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
PORT="$(free_port)"

run() { # dir, extra env...
  local d="$1"; shift
  env DPM_CUSTODY_DIR="$d" DPM_CUSTODY_RELEASES_URL="file://$rel" DPM_CUSTODY_NO_START=1 \
    DPM_CUSTODY_MANAGER_PORT="$PORT" "$@" \
    sh "$HERE/install.sh" </dev/null
}

# 1. wrong checksum aborts before anything is written
cp "$rel/SHA256SUMS" "$T/good.sums"
# corrupt the digest of a downloaded file (dpm-custody)
awk '/ dpm-custody$/{ $0 = "0" substr($0, 2) } {print}' "$T/good.sums" >"$rel/SHA256SUMS"
d1="$T/i1"
out="$(run "$d1" 2>&1)"; rc=$?
check "wrong SHA256SUMS exits non-zero" '[ $rc -ne 0 ]'
check "wrong SHA256SUMS writes no .env" '[ ! -e "$d1/.env" ]'
check "wrong SHA256SUMS writes no files" '[ -z "$(ls -A "$d1" 2>/dev/null)" ]'

# 2. correct checksums install
cp "$T/good.sums" "$rel/SHA256SUMS"
out="$(run "$d1" 2>&1)"; rc=$?
check "correct SHA256SUMS exits 0" '[ $rc -eq 0 ]'
check "files written" '[ -f "$d1/compose.yml" ] && [ -f "$d1/versions.env" ] && [ -x "$d1/dpm-custody" ]'
check ".env has version from versions.env" 'grep -qx "DPM_CUSTODY_VERSION=9.9.9" "$d1/.env"'
check ".env has password and tags" 'grep -q "^POSTGRES_PASSWORD=.\{32\}$" "$d1/.env" && grep -q "^DPM_WALLET_TAG=" "$d1/.env"'
check "NO_START: no compose up" '! grep -q " up " "$DOCKER_LOG"'

# 3. no SHA256SUMS: warning, proceeds; version unknown when RELEASE_VERSION empty
rm "$rel/SHA256SUMS"; cp "$HERE/versions.env" "$rel/versions.env"
d3="$T/i3"
out="$(run "$d3" 2>&1)"; rc=$?
check "no SHA256SUMS proceeds" '[ $rc -eq 0 ] && [ -f "$d3/.env" ]'
check "no SHA256SUMS warns" 'echo "$out" | grep -q "no SHA256SUMS"'
check "empty RELEASE_VERSION -> unknown" 'grep -qx "DPM_CUSTODY_VERSION=unknown" "$d3/.env"'

# 4. existing-install re-run: only dpm-custody replaced, .env byte-identical
cp "$T/good.sums" "$rel/SHA256SUMS"; set_version "$rel/versions.env" 9.9.9
resum
echo "# local edit" >>"$d1/compose.yml"
cp "$d1/.env" "$T/env.before"; cp "$d1/compose.yml" "$T/compose.before"; cp "$d1/versions.env" "$T/ver.before"
echo "echo custody-v3" >>"$rel/dpm-custody"
resum
out="$(run "$d1" 2>&1)"; rc=$?
check "re-run exits 0" '[ $rc -eq 0 ]'
check "re-run keeps .env byte-identical" 'cmp -s "$d1/.env" "$T/env.before"'
check "re-run keeps compose.yml and versions.env" 'cmp -s "$d1/compose.yml" "$T/compose.before" && cmp -s "$d1/versions.env" "$T/ver.before"'
check "re-run replaced dpm-custody, executable" 'cmp -s "$d1/dpm-custody" "$rel/dpm-custody" && [ -x "$d1/dpm-custody" ]'
check "re-run tells operator to upgrade" 'echo "$out" | grep -q "dpm-custody upgrade"'
check "re-run leaves no temp file" '[ ! -e "$d1/.dpm-custody.new" ]'

# 5. existing-install re-run with bad checksum keeps old dpm-custody, warns, and carries on
cp "$d1/dpm-custody" "$T/cust.before"
echo "tampered" >>"$rel/dpm-custody"
out="$(run "$d1" 2>&1)"; rc=$?
check "re-run with mismatch keeps dpm-custody untouched" 'cmp -s "$d1/dpm-custody" "$T/cust.before"'
check "re-run with mismatch warns and carries on" '[ $rc -eq 0 ] && echo "$out" | grep -q "kept the current dpm-custody"'
check "re-run with mismatch leaves no temp file" '[ ! -e "$d1/.dpm-custody.new" ]'

# 5b. a failed refresh still starts the stack, as before (stub script: setup must stay harmless)
d9="$T/i9"; mkdir -p "$d9"
cp "$d1/.env" "$d1/compose.yml" "$d1/versions.env" "$d9/"
printf '#!/bin/sh\necho "stub-custody $*" >>"$DOCKER_LOG"\n' >"$d9/dpm-custody"; chmod +x "$d9/dpm-custody"
cp "$d9/dpm-custody" "$T/stub.before"
: >"$DOCKER_LOG"
out="$(run "$d9" DPM_CUSTODY_NO_START= 2>&1)"; rc=$?
check "mismatch on an existing install: stack started" 'grep -q "compose .* up -d" "$DOCKER_LOG"'
check "mismatch on an existing install: exits 0, script untouched" '[ $rc -eq 0 ] && cmp -s "$d9/dpm-custody" "$T/stub.before"'
: >"$DOCKER_LOG"
out="$(run "$d9" DPM_CUSTODY_NO_START= DPM_CUSTODY_RELEASES_URL="file://$T/no-such-release" 2>&1)"; rc=$?
check "download failure on an existing install: warns, starts the stack" '[ $rc -eq 0 ] && echo "$out" | grep -q "kept the current dpm-custody" && grep -q "compose .* up -d" "$DOCKER_LOG"'
check "download failure on an existing install: script untouched" 'cmp -s "$d9/dpm-custody" "$T/stub.before"'

# 6. SHA256SUMS fetch failures. Only "not found" skips verification; anything else aborts.
resum
d6="$T/i6"; mkdir -p "$T/sums-dir-rel"; for f in $SUMFILES; do cp "$rel/$f" "$T/sums-dir-rel/$f"; done
mkdir "$T/sums-dir-rel/SHA256SUMS"   # present but unreadable as a file
out="$(run "$d6" DPM_CUSTODY_RELEASES_URL="file://$T/sums-dir-rel" 2>&1)"; rc=$?
check "unreadable SHA256SUMS aborts, nothing written" '[ $rc -ne 0 ] && [ ! -e "$d6/.env" ] && [ -z "$(ls -A "$d6" 2>/dev/null)" ]'
# http shim: curl that serves $rel and answers SHA256SUMS with $SUMS_CODE
mkdir -p "$T/curlbin"
cat >"$T/curlbin/curl" <<'S'
#!/bin/sh
out=""; url=""; wcode=0
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift ;; -w) wcode=1; shift ;; -*) ;; *) url="$1" ;; esac
  shift
done
# The installer's port check: nothing answers on loopback (curl's "could not connect").
case "$url" in http://127.0.0.1:*) exit 7 ;; esac
name="${url##*/}"
code=200
[ "$name" = SHA256SUMS ] && code="$SUMS_CODE"
[ "$code" = 200 ] && cp "$REL/$name" "$out"
[ "$code" != 200 ] && : >"$out"
[ "$wcode" = 1 ] && printf '%s' "$code"
exit 0
S
chmod +x "$T/curlbin/curl"
d7="$T/i7"
out="$(PATH="$T/curlbin:$PATH" REL="$rel" SUMS_CODE=404 run "$d7" DPM_CUSTODY_RELEASES_URL=http://example.test/rel 2>&1)"; rc=$?
check "HTTP 404 SHA256SUMS: warns and proceeds" '[ $rc -eq 0 ] && [ -f "$d7/.env" ] && echo "$out" | grep -q "no SHA256SUMS"'
d8="$T/i8"
out="$(PATH="$T/curlbin:$PATH" REL="$rel" SUMS_CODE=500 run "$d8" DPM_CUSTODY_RELEASES_URL=http://example.test/rel 2>&1)"; rc=$?
check "HTTP 500 SHA256SUMS: aborts, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "Could not download SHA256SUMS" && [ -z "$(ls -A "$d8" 2>/dev/null)" ]'

# 8. name and port: written to .env; a taken, claimed or malformed port stops before anything
# is written and names a free one; a name in use is refused.
d10="$T/i10"
out="$(run "$d10" DPM_CUSTODY_NAME=dpm-custody-shared 2>&1)"; rc=$?
check "name and port: exits 0" '[ $rc -eq 0 ]'
check "name and port: .env has the project name" 'grep -qx "COMPOSE_PROJECT_NAME=dpm-custody-shared" "$d10/.env"'
check "name and port: .env has the port and public URL" 'grep -qx "MANAGER_PORT=$PORT" "$d10/.env" && grep -qx "MANAGER_PUBLIC_URL=http://localhost:$PORT" "$d10/.env"'
python3 -c 'import socket,sys,time
s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", 0)); s.listen(8)
print(s.getsockname()[1], flush=True); time.sleep(60)' >"$T/listener.port" &
listener=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$T/listener.port" ] && break; sleep 0.2; done
busy="$(cat "$T/listener.port")"
d11="$T/i11"
out="$(run "$d11" DPM_CUSTODY_MANAGER_PORT="$busy" 2>&1)"; rc=$?
kill "$listener" 2>/dev/null
check "port in use: exits non-zero, nothing written" '[ $rc -ne 0 ] && [ -z "$(ls -A "$d11" 2>/dev/null)" ]'
check "port in use: names the port and a free one" 'echo "$out" | grep -q "Port $busy is already in use" && echo "$out" | grep -q "DPM_CUSTODY_MANAGER_PORT=[0-9]"'
d12="$T/i12"
out="$(run "$d12" CLAIMED_PORT="$PORT" 2>&1)"; rc=$?
check "port claimed by a stopped container: refused, nothing written" '[ $rc -ne 0 ] && [ -z "$(ls -A "$d12" 2>/dev/null)" ] && echo "$out" | grep -q "Port $PORT is already in use"'
d13="$T/i13"
out="$(run "$d13" DPM_CUSTODY_MANAGER_PORT=30x1 2>&1)"; rc=$?
check "malformed port: refused, nothing written" '[ $rc -ne 0 ] && [ -z "$(ls -A "$d13" 2>/dev/null)" ] && echo "$out" | grep -q "must be a port number"'
d14="$T/i14"
out="$(run "$d14" DPM_CUSTODY_NAME=dpm-custody-shared EXISTING_NAME=dpm-custody-shared 2>&1)"; rc=$?
check "name in use: refused, nothing written" '[ $rc -ne 0 ] && [ -z "$(ls -A "$d14" 2>/dev/null)" ] && echo "$out" | grep -q "already named"'
out="$(run "$T/i15" DPM_CUSTODY_NAME=Bad.Name 2>&1)"; rc=$?
check "malformed name: refused" '[ $rc -ne 0 ] && echo "$out" | grep -q "DPM_CUSTODY_NAME"'

# 7. compose validates (needs a real docker; skipped when absent)
if command -v docker >/dev/null 2>&1 && [ -x /usr/bin/docker ]; then
  if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
    docker compose -f "$HERE/compose.yml" config >/dev/null 2>"$T/cfg.err"; then ok "compose config validates"
  else bad "compose config validates: $(head -3 "$T/cfg.err")"; fi
  # Each volume is mounted only where it is needed (the config split).
  if command -v python3 >/dev/null 2>&1 &&
    PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
      docker compose -f "$HERE/compose.yml" config --format json >"$T/cfg.json" 2>/dev/null; then
    if python3 - "$T/cfg.json" <<'PY'
import json, sys
svc = json.load(open(sys.argv[1]))["services"]
users = {}
for name, s in svc.items():
    for v in s.get("volumes", []):
        users.setdefault(v["source"], set()).add(name)
want = {
    "config-wallet": {"dpm-wallet", "setup"},
    "config-manager": {"dpm-wallet-manager", "setup"},
    "setup-state": {"setup"},
    "config": {"setup"},
}
bad = {k: users.get(k) for k, v in want.items() if users.get(k) != v}
# Every service is long-running: the old dpm-custody that performs an upgrade requires each
# service of the new compose.yml to be running, so a one-shot would fail its health gate.
oneshot = [n for n, s in svc.items() if s.get("restart") != "unless-stopped"]
# The services that read the volumes start only once setup has migrated them.
waits = [n for n in ("dpm-wallet", "dpm-wallet-manager")
         if svc[n]["depends_on"].get("setup", {}).get("condition") != "service_healthy"]
sys.exit(1 if bad or oneshot or waits or "healthcheck" not in svc["setup"] else 0)
PY
    then ok "compose: config volumes are mounted only by their consumers"
    else bad "compose: config volumes are mounted only by their consumers"; fi
  fi
fi

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
