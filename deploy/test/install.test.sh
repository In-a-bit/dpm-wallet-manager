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

mkdir -p "$T/bin"
cat >"$T/bin/docker" <<'S'
#!/bin/sh
echo "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "compose ls") exit 0 ;;
esac
exit 0
S
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" DOCKER_LOG="$T/docker.log"

rel="$T/rel"
mkdir -p "$rel"
for f in install.sh install.ps1 compose.yml versions.env dpm-custody; do cp "$HERE/$f" "$rel/$f"; done
sed -i 's/^RELEASE_VERSION=.*/RELEASE_VERSION=9.9.9/' "$rel/versions.env"
echo "echo custody-v2" >>"$rel/dpm-custody"
(cd "$rel" && sha256sum install.sh install.ps1 compose.yml versions.env dpm-custody >SHA256SUMS)

run() { # dir, extra env...
  local d="$1"; shift
  env DPM_CUSTODY_DIR="$d" DPM_CUSTODY_RELEASES_URL="file://$rel" DPM_CUSTODY_NO_START=1 "$@" \
    sh "$HERE/install.sh" </dev/null
}

# 1. wrong checksum aborts before anything is written
cp "$rel/SHA256SUMS" "$T/good.sums"
sed 's/^[0-9a-f]/0/' "$T/good.sums" >"$rel/SHA256SUMS"
sed -i '0,/^0/s//1/' "$rel/SHA256SUMS"
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
cp "$T/good.sums" "$rel/SHA256SUMS"; sed -i 's/^RELEASE_VERSION=.*/RELEASE_VERSION=9.9.9/' "$rel/versions.env"
(cd "$rel" && sha256sum install.sh install.ps1 compose.yml versions.env dpm-custody >SHA256SUMS)
echo "# local edit" >>"$d1/compose.yml"
cp "$d1/.env" "$T/env.before"; cp "$d1/compose.yml" "$T/compose.before"; cp "$d1/versions.env" "$T/ver.before"
echo "echo custody-v3" >>"$rel/dpm-custody"
(cd "$rel" && sha256sum install.sh install.ps1 compose.yml versions.env dpm-custody >SHA256SUMS)
out="$(run "$d1" 2>&1)"; rc=$?
check "re-run exits 0" '[ $rc -eq 0 ]'
check "re-run keeps .env byte-identical" 'cmp -s "$d1/.env" "$T/env.before"'
check "re-run keeps compose.yml and versions.env" 'cmp -s "$d1/compose.yml" "$T/compose.before" && cmp -s "$d1/versions.env" "$T/ver.before"'
check "re-run replaced dpm-custody, executable" 'cmp -s "$d1/dpm-custody" "$rel/dpm-custody" && [ -x "$d1/dpm-custody" ]'
check "re-run tells operator to upgrade" 'echo "$out" | grep -q "dpm-custody upgrade"'
check "re-run leaves no temp file" '[ ! -e "$d1/.dpm-custody.new" ]'

# 5. existing-install re-run with bad checksum keeps old dpm-custody
cp "$d1/dpm-custody" "$T/cust.before"
echo "tampered" >>"$rel/dpm-custody"
out="$(run "$d1" 2>&1)"; rc=$?
check "re-run with mismatch aborts, dpm-custody untouched" '[ $rc -ne 0 ] && cmp -s "$d1/dpm-custody" "$T/cust.before"'

# 6. compose validates (needs a real docker; skipped when absent)
if command -v docker >/dev/null 2>&1 && [ -x /usr/bin/docker ]; then
  if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
    docker compose -f "$HERE/compose.yml" config >/dev/null 2>"$T/cfg.err"; then ok "compose config validates"
  else bad "compose config validates: $(head -3 "$T/cfg.err")"; fi
fi

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
