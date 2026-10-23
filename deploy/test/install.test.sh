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
  "compose ls") exit 0 ;;
esac
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

run() { # dir, extra env...
  local d="$1"; shift
  env DPM_CUSTODY_DIR="$d" DPM_CUSTODY_RELEASES_URL="file://$rel" DPM_CUSTODY_NO_START=1 "$@" \
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

# 7. compose validates (needs a real docker; skipped when absent)
if command -v docker >/dev/null 2>&1 && [ -x /usr/bin/docker ]; then
  if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
    docker compose -f "$HERE/compose.yml" config >/dev/null 2>"$T/cfg.err"; then ok "compose config validates"
  else bad "compose config validates: $(head -3 "$T/cfg.err")"; fi
fi

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
