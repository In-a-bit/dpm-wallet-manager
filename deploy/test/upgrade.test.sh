#!/usr/bin/env bash
# Re-runnable checks for `dpm-custody upgrade` and `dpm-custody rollback`. Every case runs in its
# own temp install folder against a local release folder (file://). `docker` and `sleep` are PATH
# shims: docker logs each call to $EVENTS and answers with scripted results, so no container runs.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
mode_of() { ls -l "$1" | cut -c1-10; }
D1="sha256:$(printf 'a%.0s' $(seq 64))"
D2="sha256:$(printf 'b%.0s' $(seq 64))"
D3="sha256:$(printf 'c%.0s' $(seq 64))"

# ---- shims ----------------------------------------------------------------------------------
mkdir -p "$T/bin"
cat >"$T/bin/docker" <<'S'
#!/bin/sh
# Scripted docker. Knobs: HEALTH_BY_UP (state per number of `up -d` so far: healthy|unhealthy),
# PS_ARRAY=1 (ps prints one JSON array), FAIL_PULL, FAIL_BACKUP, DB_BYTES, IMAGES (folder of
# `image ls` answers, one file per repository name), ADD_ENV_LINE (appended to .env at first up),
# IN_USE_REFS / IN_USE_IDS (images of containers on the host, space-separated), HUP_PIDFILE (send
# SIGHUP to that PID at the first health poll after `up`, as a dropped SSH session would).
echo "docker $*" >>"$EVENTS"
args="$*"
case "$args" in
  "ps -a --format"*) for r in ${IN_USE_REFS:-}; do echo "$r"; done; exit 0 ;;
  "ps -aq"*) [ -n "${IN_USE_IDS:-}" ] && echo "c1 c2"; exit 0 ;;
  "inspect "*) for r in ${IN_USE_IDS:-}; do echo "$r"; done; exit 0 ;;
  "image ls"*)
    for last; do :; done
    f="$IMAGES/${last##*/}"
    [ -n "${IMAGES:-}" ] && [ -f "$f" ] && grep "^$last " "$f"
    exit 0
    ;;
  "image "*) exit 0 ;;
esac
case "$args" in
  *" config --services"*) if [ -n "${USE_REAL_COMPOSE:-}" ]; then
      out="$("$REAL_DOCKER" "$@" 2>/dev/null)" || out=""
    fi
    if [ -n "${out:-}" ]; then printf '%s\n' "$out"; else printf 'postgres\ndpm-wallet\ndpm-wallet-manager\nsetup\n'; fi ;;
  *" ps "*"--format json"*)
    n=$(grep -c ' up -d' "$EVENTS")
    if [ -n "${HUP_PIDFILE:-}" ] && [ "$n" -ge 1 ] && [ ! -e "$HUP_PIDFILE.sent" ]; then
      : >"$HUP_PIDFILE.sent"; kill -HUP "$(cat "$HUP_PIDFILE")"
    fi
    st=$(echo "${HEALTH_BY_UP:-healthy}" | awk -v i=$((n + 1)) '{ if (i > NF) i = NF; print $i }')
    mh=healthy; [ "$st" = unhealthy ] && mh=unhealthy
    o1='{"Health":"healthy","Labels":"a=b","Name":"x-postgres-1","Publishers":[{"URL":"","TargetPort":5432}],"Service":"postgres","State":"running","Status":"Up"}'
    o2='{"Health":"healthy","Name":"x-dpm-wallet-1","Service":"dpm-wallet","State":"running"}'
    o3='{"State":"running","Service":"dpm-wallet-manager","Health":"'"$mh"'","Publishers":[{"URL":"127.0.0.1","TargetPort":3000,"PublishedPort":3000}]}'
    o4='{"Health":"","Name":"x-setup-1","Service":"setup","State":"running","Status":"Up"}'
    if [ -n "${USE_REAL_COMPOSE:-}" ] && real="$("$REAL_DOCKER" compose --env-file .env -f compose.yml config --services 2>/dev/null)" && [ -n "$real" ]; then
      # One answer per service of the compose.yml in the folder, as Docker would give them.
      for svc in $real; do
        h=healthy; [ "$svc" = dpm-wallet-manager ] && h=$mh
        printf '{"Health":"%s","Service":"%s","State":"running"}\n' "$h" "$svc"
      done
      exit 0
    fi
    if [ "${PS_ARRAY:-}" = 1 ]; then printf '[%s,%s,%s,%s]\n' "$o1" "$o2" "$o3" "$o4"
    else printf '%s\n%s\n%s\n%s\n' "$o1" "$o2" "$o3" "$o4"; fi
    ;;
  *" pull"*)
    [ -n "${FAIL_PULL:-}" ] && { echo "pull failed" >&2; exit 1; }
    echo "at-pull compose=$(head -n 1 compose.yml) prev=$([ -e compose.yml.prev ] && echo yes || echo no) tag=${DPM_WALLET_MANAGER_TAG:-}" >>"$EVENTS"
    ;;
  *" run "*"dist/setup/main migrate"*)
    echo "at-migrate compose=$(head -n 1 compose.yml) marker=$([ -e upgrade.inprogress ] && echo yes || echo no)" >>"$EVENTS"
    [ -n "${FAIL_MIGRATE:-}" ] && { echo "migrate failed" >&2; exit 1; }
    ;;
  *" up -d"*)
    echo "at-up compose=$(head -n 1 compose.yml) marker=$([ -e upgrade.inprogress ] && echo yes || echo no) prev=$([ -e .env.prev ] && ls -l compose.yml.prev .env.prev dpm-custody.prev | cut -c1-10 | sort -u | tr '\n' ' ')" >>"$EVENTS"
    if [ -n "${ADD_ENV_LINE:-}" ] && [ "$(grep -c ' up -d' "$EVENTS")" = 1 ]; then echo "$ADD_ENV_LINE" >>.env; fi
    ;;
  *"exec -T dpm-wallet-manager node"*)
    [ -n "${STORAGE_FAIL:-}" ] && { echo "no such service" >&2; exit 1; }
    printf '%s\n' "${STORAGE_OUT-warning|81.2|13}"
    ;;
  *"exec -T postgres pg_dumpall"*) [ -n "${FAIL_BACKUP:-}" ] && { echo "no postgres" >&2; exit 1; }; echo "-- dump" ;;
  *"exec -T postgres psql"*) echo "${DB_BYTES:-1000}" ;;
  *"setup node dist/setup/main scrub-legacy"*) [ -n "${FAIL_SCRUB:-}" ] && exit 1; exit 0 ;;
  *"setup node dist/setup/main backup-recipient"*) [ -n "${FAKE_RECIPIENT:-}" ] && echo "$FAKE_RECIPIENT"; exit 0 ;;
  *"setup node dist/setup/main backup-"*)
    # The real implementation, from the compiled dist, so the sealed files are really sealed.
    [ -f "$DIST_MAIN" ] || { echo "no dist/setup/main.js (run npm run build)" >&2; exit 3; }
    cmd="${args##*dist/setup/main }"
    exec node "$DIST_MAIN" "$cmd" ;;
  *"exec -T setup sh -c "*)
    # Run the script the way the container's sh would, against a fake /proc/mounts and a tar that
    # only reports its arguments, so a quoting mistake in dpm-custody fails here.
    script=""; prev=""
    for a in "$@"; do [ "$prev" = -c ] && script="$a"; prev="$a"; done
    mounts="${FAKE_MOUNTS:-/dev/null}"
    script="$(printf '%s' "$script" | sed "s|/proc/mounts|$mounts|g")"
    PATH="$FAKE_TAR_DIR:$PATH" sh -c "$script" ;;
  *"exec -T "*" tar "*) echo "tarbytes" ;;
esac
exit 0
S
printf '#!/bin/sh\nexit 0\n' >"$T/bin/sleep"
chmod +x "$T/bin/docker" "$T/bin/sleep"
REAL_DOCKER="$(command -v docker || true)"
export REAL_DOCKER
export DIST_MAIN="$HERE/../dist/setup/main.js"
mkdir -p "$T/faketar"
printf '#!/bin/sh\necho "TAR $*"\n' >"$T/faketar/tar"
chmod +x "$T/faketar/tar"
export FAKE_TAR_DIR="$T/faketar"
export PATH="$T/bin:$PATH"

# ---- signing --------------------------------------------------------------------------------
# A throwaway key pair (and a second, wrong one). The installed dpm-custody checks the release's
# SHA256SUMS.sig against key.pub through DPM_CUSTODY_RELEASE_PUBKEY, or against the key embedded
# in it (see case 18).
openssl ecparam -name prime256v1 -genkey -noout -out "$T/key.pem" 2>/dev/null
openssl pkey -in "$T/key.pem" -pubout -out "$T/key.pub"
openssl ecparam -name prime256v1 -genkey -noout -out "$T/other.pem" 2>/dev/null
# sign_release DIR [KEY] signs DIR/SHA256SUMS the way CI does.
sign_release() { openssl dgst -sha256 -sign "${2:-$T/key.pem}" -out "$1/SHA256SUMS.sig" "$1/SHA256SUMS"; }

# ---- fixtures -------------------------------------------------------------------------------
# make_release DIR VERSION MIN WALLET_TAG MANAGER_TAG
make_release() {
  local r="$1"
  mkdir -p "$r"
  printf '# compose %s\nservices: {}\n' "$2" >"$r/compose.yml"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\nRELEASE_VERSION=%s\nMIN_UPGRADE_FROM=%s\n' "$4" "$5" "$2" "$3" >"$r/versions.env"
  { cat "$HERE/dpm-custody"; echo "# release $2"; } >"$r/dpm-custody"
  (cd "$r" && sha256 compose.yml versions.env dpm-custody >SHA256SUMS)
  sign_release "$r"
}
# make_install DIR VERSION(or "none") WALLET_TAG MANAGER_TAG
make_install() {
  local d="$1"
  mkdir -p "$d"
  printf '# compose old\nservices: {}\n' >"$d/compose.yml"
  printf 'DPM_WALLET_TAG=%s\nDPM_WALLET_MANAGER_TAG=%s\nRELEASE_VERSION=old\n' "$3" "$4" >"$d/versions.env"
  cp "$HERE/dpm-custody" "$d/dpm-custody"
  chmod +x "$d/dpm-custody"
  {
    echo "COMPOSE_PROJECT_NAME=x"
    echo "POSTGRES_USER=dpm"
    echo "POSTGRES_PASSWORD=secret"
    echo "DPM_WALLET_TAG=$3"
    echo "DPM_WALLET_MANAGER_TAG=$4"
    [ "$2" = none ] || echo "DPM_CUSTODY_VERSION=$2"
    echo "MANAGER_PORT=3000"
  } >"$d/.env"
  chmod 600 "$d/.env"
  for f in compose.yml .env dpm-custody versions.env; do cp "$d/$f" "$d.orig.$f"; done
}
unchanged() { local d="$1" f; for f in compose.yml .env dpm-custody versions.env; do cmp -s "$d/$f" "$d.orig.$f" || return 1; done; }
# run DIR ARGS... runs the install's own dpm-custody with no terminal; events go to DIR.events.
run() {
  local d="$1"; shift
  : >"$d.events"
  EVENTS="$d.events" DPM_CUSTODY_RELEASES_URL="${REL_URL:-file://$T/rel}" DPM_CUSTODY_HEALTH_TIMEOUT="${TIMEOUT:-10}" \
    DPM_CUSTODY_RELEASE_PUBKEY="${PUBKEY-$T/key.pub}" DPM_CUSTODY_ALLOW_INSECURE="${INSECURE-1}" \
    bash "$d/dpm-custody" "$@" </dev/null 2>&1
}
line_of() { grep -n -- "$2" "$1" | head -n 1 | cut -d: -f1; }
has() { grep -q -- "$2" "$1"; }

make_release "$T/rel" 1.1.0 "" "0.2.0" "1.1.0@$D1"

# 1. bad checksum
d="$T/c1"; make_install "$d" 1.0.0 0.1.0 1.0.0
cp -r "$T/rel" "$T/rel-bad"; echo "# tampered" >>"$T/rel-bad/compose.yml"
out="$(REL_URL="file://$T/rel-bad" run "$d" upgrade --yes)"; rc=$?
check "1 bad checksum: exits non-zero" '[ $rc -ne 0 ]'
check "1 bad checksum: says so and that nothing changed" 'echo "$out" | grep -q "SHA256SUMS" && echo "$out" | grep -qi "nothing was changed"'
check "1 bad checksum: files unchanged, no pull/up, no .prev, no upgrade.tmp" 'unchanged "$d" && ! has "$d.events" " pull" && ! has "$d.events" " up -d" && [ ! -e "$d/compose.yml.prev" ] && [ ! -e "$d/upgrade.tmp" ]'

# 1a. signature checks: missing, wrong key, altered sums, http refused; nothing changes, no pull
cp -r "$T/rel" "$T/rel-nosig"; rm "$T/rel-nosig/SHA256SUMS.sig"
out="$(REL_URL="file://$T/rel-nosig" run "$d" upgrade --yes)"; rc=$?
check "1a missing signature: refused, files unchanged, no pull" '[ $rc -ne 0 ] && echo "$out" | grep -q "SHA256SUMS.sig" && unchanged "$d" && ! has "$d.events" " pull"'
cp -r "$T/rel" "$T/rel-wrongkey"; sign_release "$T/rel-wrongkey" "$T/other.pem"
out="$(REL_URL="file://$T/rel-wrongkey" run "$d" upgrade --yes)"; rc=$?
check "1a signed by another key: refused, files unchanged, no pull" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && unchanged "$d" && ! has "$d.events" " pull"'
cp -r "$T/rel" "$T/rel-altered"; echo "0000000000000000000000000000000000000000000000000000000000000000  extra" >>"$T/rel-altered/SHA256SUMS"
out="$(REL_URL="file://$T/rel-altered" run "$d" upgrade --yes)"; rc=$?
check "1a SHA256SUMS altered after signing: refused, files unchanged" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && unchanged "$d" && ! has "$d.events" " pull"'
out="$(INSECURE= run "$d" upgrade --yes)"; rc=$?
check "1a file:// refused without DPM_CUSTODY_ALLOW_INSECURE" '[ $rc -ne 0 ] && echo "$out" | grep -q "https:// only" && unchanged "$d" && ! has "$d.events" " pull"'
out="$(INSECURE= REL_URL=http://example.test/rel run "$d" upgrade --yes)"; rc=$?
check "1a http:// refused without DPM_CUSTODY_ALLOW_INSECURE" '[ $rc -ne 0 ] && echo "$out" | grep -q "https:// only" && unchanged "$d"'
out="$(PUBKEY= run "$d" upgrade --yes)"; rc=$?
check "1a embedded placeholder key: refused, and says why" '[ $rc -ne 0 ] && echo "$out" | grep -q "placeholder release key" && unchanged "$d"'

# 1b. a release without SHA256SUMS is refused by upgrade
cp -r "$T/rel" "$T/rel-nosums"; rm "$T/rel-nosums/SHA256SUMS"
out="$(REL_URL="file://$T/rel-nosums" run "$d" upgrade --yes)"; rc=$?
check "1b no SHA256SUMS: refused, files unchanged, no pull" '[ $rc -ne 0 ] && echo "$out" | grep -q "SHA256SUMS" && unchanged "$d" && ! has "$d.events" " pull"'

# 2. target equal to or older than installed
d="$T/c2a"; make_install "$d" 1.1.0 0.2.0 1.1.0
out="$(run "$d" upgrade --yes)"; rc=$?
check "2 same version refused" '[ $rc -ne 0 ] && echo "$out" | grep -q "1.1.0" && unchanged "$d" && ! has "$d.events" " pull"'
d="$T/c2b"; make_install "$d" 1.2.0 0.2.0 1.2.0
out="$(run "$d" upgrade --yes)"; rc=$?
check "2 older target refused" '[ $rc -ne 0 ] && echo "$out" | grep -q "older" && unchanged "$d" && ! has "$d.events" " pull"'

# 3. below MIN_UPGRADE_FROM
make_release "$T/rel-min" 1.3.0 1.2.0 "0.3.0" "1.3.0"
d="$T/c3"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(REL_URL="file://$T/rel-min" run "$d" upgrade --yes)"; rc=$?
check "3 below MIN_UPGRADE_FROM refused, names 1.2.0" '[ $rc -ne 0 ] && echo "$out" | grep -q "1\.2\.0" && unchanged "$d" && ! has "$d.events" " pull"'

# 4. no DPM_CUSTODY_VERSION: proceeds once, records the target
d="$T/c4"; make_install "$d" none 0.1.0 1.0.0
out="$(run "$d" upgrade --yes)"; rc=$?
check "4 unknown version: proceeds" '[ $rc -eq 0 ]'
check "4 unknown version: says so" 'echo "$out" | grep -qi "installed version unknown"'
check "4 unknown version: .env gets target" 'grep -qx "DPM_CUSTODY_VERSION=1.1.0" "$d/.env"'

# 5. unhealthy before the upgrade
d="$T/c5"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(HEALTH_BY_UP=unhealthy run "$d" upgrade --yes)"; rc=$?
check "5 unhealthy stack refused before backup/pull" '[ $rc -ne 0 ] && echo "$out" | grep -qi "not healthy" && unchanged "$d" && ! has "$d.events" pg_dumpall && ! has "$d.events" " pull"'

# 6. failed pull
d="$T/c6"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(FAIL_PULL=1 run "$d" upgrade --yes)"; rc=$?
check "6 failed pull aborts, files unchanged, no up, no .prev" '[ $rc -ne 0 ] && unchanged "$d" && ! has "$d.events" " up -d" && [ ! -e "$d/.env.prev" ] && echo "$out" | grep -qi "nothing was changed"'

# 7. happy path (ps answers as one JSON array here)
d="$T/c7"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(PS_ARRAY=1 run "$d" upgrade --yes)"; rc=$?
ev="$d.events"
check "7 happy: exit 0 and success message" '[ $rc -eq 0 ] && echo "$out" | grep -q "Upgraded to 1.1.0"'
# The database-roles migration step runs inside this `setup node dist/setup/main migrate` call: it
# is the service that holds the Postgres superuser credentials (the others are given none).
check "7 happy: migrate (and so database-roles) runs in the setup service, after the switch, before up" 'grep -q "run --rm --no-deps -T -v config:/legacy-config:rw setup node dist/setup/main migrate" "$ev" && [ "$(line_of "$ev" at-migrate)" -lt "$(line_of "$ev" "at-up")" ]'
check "7 happy: backup before pull before up" '[ "$(line_of "$ev" pg_dumpall)" -lt "$(line_of "$ev" " pull")" ] && [ "$(line_of "$ev" " pull")" -lt "$(line_of "$ev" " up -d")" ]'
check "7 happy: pull uses new tag, before .prev and switch" 'has "$ev" "at-pull compose=# compose old prev=no tag=1.1.0@$D1"'
check "7 happy: at up, .prev written (600), marker written, switched" 'has "$ev" "at-up compose=# compose 1.1.0 marker=yes prev=-rw------- $"'
check "7 happy: marker and lock gone, upgrade.log (600) has the outcome" '[ ! -e "$d/upgrade.inprogress" ] && [ ! -e "$d/upgrade.lock" ] && grep -q "Upgraded to 1.1.0" "$d/upgrade.log" && [ "$(mode_of "$d/upgrade.log")" = "-rw-------" ]'
check "7 happy: health checked after up" '[ "$(grep -n "ps -a --format json" "$ev" | tail -n 1 | cut -d: -f1)" -gt "$(line_of "$ev" " up -d")" ]'
check "7 happy: .env has new tags and version" 'grep -qx "DPM_WALLET_TAG=0.2.0" "$d/.env" && grep -qx "DPM_WALLET_MANAGER_TAG=1.1.0@$D1" "$d/.env" && grep -qx "DPM_CUSTODY_VERSION=1.1.0" "$d/.env"'
check "7 happy: files switched, dpm-custody executable" 'cmp -s "$d/compose.yml" "$T/rel/compose.yml" && cmp -s "$d/dpm-custody" "$T/rel/dpm-custody" && [ -x "$d/dpm-custody" ]'
check "7 happy: .prev files hold the old ones, mode 600" 'cmp -s "$d/compose.yml.prev" "$d.orig.compose.yml" && cmp -s "$d/.env.prev" "$d.orig..env" && cmp -s "$d/dpm-custody.prev" "$d.orig.dpm-custody" && [ "$(mode_of "$d/.env.prev")" = "-rw-------" ] && [ "$(mode_of "$d/dpm-custody.prev")" = "-rw-------" ]'
check "7 happy: backup folder written, no upgrade.tmp left" '[ -n "$(ls "$d/backups" 2>/dev/null)" ] && [ ! -e "$d/upgrade.tmp" ]'
check "7 happy: mentions rollback" 'echo "$out" | grep -q "dpm-custody rollback"'
check "7 happy: the old setup worker is stopped before the volumes are migrated" '[ "$(line_of "$ev" "stop setup")" -lt "$(line_of "$ev" at-migrate)" ]'
check "7 happy: setup migrate runs after the switch and before up, never in the old compose" 'has "$ev" "at-migrate compose=# compose 1.1.0 marker=yes" && has "$ev" "run --rm --no-deps -T -v config:/legacy-config:rw setup node dist/setup/main migrate" && [ "$(line_of "$ev" at-migrate)" -lt "$(line_of "$ev" " up -d")" ] && [ "$(line_of "$ev" " pull")" -lt "$(line_of "$ev" at-migrate)" ]'
check "7 happy: cleanup-legacy hint printed" 'echo "$out" | grep -q "cleanup-legacy"'

# 12. rollback after a good upgrade
cp "$d/.env" "$T/c7.env.after"
echo "OPERATOR_LATER=1" >>"$d/.env"
out="$(run "$d" rollback)"; rc=$?
check "12 rollback: exit 0, files and versions back" '[ $rc -eq 0 ] && cmp -s "$d/compose.yml" "$d.orig.compose.yml" && cmp -s "$d/dpm-custody" "$d.orig.dpm-custody" && grep -qx "DPM_CUSTODY_VERSION=1.0.0" "$d/.env" && grep -qx "DPM_WALLET_MANAGER_TAG=1.0.0" "$d/.env"'
check "12 rollback: warns that an older version runs from the old config volume" 'echo "$out" | grep -q "old config volume"'
check "12 rollback: operator edit kept, up ran, .prev removed" 'grep -qx "OPERATOR_LATER=1" "$d/.env" && has "$d.events" " up -d" && [ ! -e "$d/.env.prev" ]'


# 7b. migrate fails: the upgrade does not start the new containers, and rolls back
d="$T/c7b"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(FAIL_MIGRATE=1 run "$d" upgrade --yes)"; rc=$?
check "7b migrate failure: non-zero, says so, files restored, only the rollback ran up" '[ $rc -ne 0 ] && echo "$out" | grep -q "configuration volumes" && cmp -s "$d/compose.yml" "$d.orig.compose.yml" && [ "$(grep -c " up -d" "$d.events")" -eq 1 ] && ! has "$d.events" "at-up compose=# compose 1.1.0"'


# 7a0. the backup runs the script it sends to the container: split layout when /config-wallet is a
# mount, the single volume otherwise (the shim executes the script, so quoting bugs fail here)
d="$T/c7a0"; make_install "$d" 1.1.0 0.2.0 1.1.0
printf 'x /config-wallet ext4 rw 0 0\n' >"$T/mounts.split"
out="$(FAKE_MOUNTS="$T/mounts.split" run "$d" backup)"; rc=$?
b="$(ls -d "$d"/backups/[0-9]* | head -n 1)"
check "7a0 backup, split volumes: script runs and saves the three" '[ $rc -eq 0 ] && grep -q "^TAR -C / -czf - config-wallet config-manager state$" "$b/config.tar.gz"'
rm -rf "$d/backups"
out="$(FAKE_MOUNTS="$T/mounts.none" run "$d" backup)"; rc=$?
b="$(ls -d "$d"/backups/[0-9]* | head -n 1)"
check "7a0 backup, single volume: falls back to /config" '[ $rc -eq 0 ] && grep -q "^TAR -C / -czf - config$" "$b/config.tar.gz"'

# 7a. the released v0.2.2 dpm-custody performs the upgrade (it reads this release's real compose.yml
# and requires every service to be running and healthy: no one-shot service may be left behind).
if command -v git >/dev/null 2>&1 && [ -n "$REAL_DOCKER" ] &&
  git -C "$HERE" show v0.2.2:deploy/dpm-custody >"$T/dpm-custody.v022" 2>/dev/null; then
  rel="$T/rel-real"; mkdir -p "$rel"
  cp "$HERE/compose.yml" "$rel/compose.yml"
  printf 'DPM_WALLET_TAG=0.2.0\nDPM_WALLET_MANAGER_TAG=1.1.0\nRELEASE_VERSION=1.1.0\nMIN_UPGRADE_FROM=\n' >"$rel/versions.env"
  cp "$HERE/dpm-custody" "$rel/dpm-custody"
  (cd "$rel" && sha256 compose.yml versions.env dpm-custody >SHA256SUMS)
  sign_release "$rel"
  d="$T/c7a"; make_install "$d" 0.2.2 0.1.0 0.2.2
  cp "$T/dpm-custody.v022" "$d/dpm-custody"; chmod +x "$d/dpm-custody"
  out="$(REL_URL="file://$rel" USE_REAL_COMPOSE=1 run "$d" upgrade --yes)"; rc=$?
  check "7a v0.2.2 dpm-custody upgrades to this release's compose.yml: gate passes, no rollback" '[ $rc -eq 0 ] && echo "$out" | grep -q "Upgraded to 1.1.0" && [ "$(grep -c " up -d" "$d.events")" -eq 1 ] && cmp -s "$d/compose.yml" "$rel/compose.yml"'
  # The upgrade's migrate call is only meaningful if the setup service can reach Postgres as the
  # superuser: it has the credentials and waits for the server. Asked of the real release compose.yml.
  check "7a setup (where database-roles runs) has the Postgres superuser and waits for postgres" '"$REAL_DOCKER" compose --env-file "$d/.env" -f "$rel/compose.yml" config --format json 2>/dev/null | python3 -c "
import json, sys
s = json.load(sys.stdin)[\"services\"][\"setup\"]
sys.exit(0 if \"POSTGRES_PASSWORD\" in s[\"environment\"] and s[\"depends_on\"][\"postgres\"][\"condition\"] == \"service_healthy\" else 1)"'
  check "7a the release's compose.yml has no one-shot service (a v0.2.2 gate would fail on it)" '! grep -q "restart: \"no\"" "$rel/compose.yml"'
else
  echo "skip - 7a (needs git history with v0.2.2 and docker)"
fi

# 7c. cleanup-legacy
d="$T/c7c"; make_install "$d" 1.1.0 0.2.0 1.1.0
out="$(run "$d" cleanup-legacy --yes)"; rc=$?
check "7c cleanup-legacy --yes mounts the legacy volume writable and empties it" '[ $rc -eq 0 ] && has "$d.events" "run --rm --no-deps -T -v config:/legacy-config:rw setup node dist/setup/main cleanup-legacy"'
out="$(run "$d" cleanup-legacy)"; rc=$?
check "7c cleanup-legacy without a terminal or --yes refuses and runs nothing" '[ $rc -ne 0 ] && ! has "$d.events" "cleanup-legacy$"'

# 8. unhealthy after up for the whole gate: automatic rollback
d="$T/c8"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(HEALTH_BY_UP="healthy unhealthy healthy" ADD_ENV_LINE="OPERATOR_EDIT=1" TIMEOUT=15 run "$d" upgrade --yes)"; rc=$?
check "8 failed gate: exit non-zero" '[ $rc -ne 0 ]'
check "8 failed gate: compose.yml and dpm-custody restored" 'cmp -s "$d/compose.yml" "$d.orig.compose.yml" && cmp -s "$d/dpm-custody" "$d.orig.dpm-custody" && [ -x "$d/dpm-custody" ]'
check "8 failed gate: tags and version back to old" 'grep -qx "DPM_WALLET_TAG=0.1.0" "$d/.env" && grep -qx "DPM_WALLET_MANAGER_TAG=1.0.0" "$d/.env" && grep -qx "DPM_CUSTODY_VERSION=1.0.0" "$d/.env"'
check "8 failed gate: operator line survives, rest of .env as before" 'grep -qx "OPERATOR_EDIT=1" "$d/.env" && [ "$(grep -v "^OPERATOR_EDIT=" "$d/.env")" = "$(cat "$d.orig..env")" ]'
check "8 failed gate: up ran again" '[ "$(grep -c " up -d" "$d.events")" -eq 2 ]'
check "8 failed gate: names the backup folder and support" 'echo "$out" | grep -q "backups/[0-9]" && echo "$out" | grep -q "dpm-custody support"'
check "8 failed gate: marker removed after the completed rollback" '[ ! -e "$d/upgrade.inprogress" ]'
check "8 failed gate: waited for the gate (several health polls)" '[ "$(grep -c "ps -a --format json" "$d.events")" -ge 4 ]'

# 8b. same, from an install that had no DPM_CUSTODY_VERSION: the key is removed again
d="$T/c8b"; make_install "$d" none 0.1.0 1.0.0
out="$(HEALTH_BY_UP="healthy unhealthy healthy" TIMEOUT=5 run "$d" upgrade --yes)"; rc=$?
check "8b failed gate from unknown version: .env exactly as before" '[ $rc -ne 0 ] && cmp -s "$d/.env" "$d.orig..env"'

# 8c. the old version does not come back either: backup restore steps, never a DB restore
d="$T/c8c"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(HEALTH_BY_UP="healthy unhealthy unhealthy" TIMEOUT=5 run "$d" upgrade --yes)"; rc=$?
check "8c rollback also unhealthy: prints restore steps, no psql restore" '[ $rc -ne 0 ] && echo "$out" | grep -qi "restor" && echo "$out" | grep -q "backups/[0-9]" && ! grep -q "psql.*<\|DROP DATABASE" "$d.events"'
check "8c rollback also unhealthy: marker stays" '[ -f "$d/upgrade.inprogress" ]'

# 8d. a good upgrade, then a failed one that rolls back by itself: `rollback` still undoes the
# good one (its *.prev files are put back, not lost)
make_release "$T/rel-bad120" 1.2.0 "" "0.3.0" "1.2.0"
d="$T/c8d"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade --yes)"; rc=$?
check "8d first upgrade to 1.1.0 succeeds" '[ $rc -eq 0 ] && grep -qx "DPM_CUSTODY_VERSION=1.1.0" "$d/.env"'
out="$(REL_URL="file://$T/rel-bad120" HEALTH_BY_UP="healthy unhealthy healthy" TIMEOUT=5 run "$d" upgrade --yes)"; rc=$?
check "8d failed 1.2.0 rolled back to 1.1.0" '[ $rc -ne 0 ] && grep -qx "DPM_CUSTODY_VERSION=1.1.0" "$d/.env" && cmp -s "$d/compose.yml" "$T/rel/compose.yml"'
check "8d the 1.0.0 *.prev files are back (600), no stash left" 'cmp -s "$d/compose.yml.prev" "$d.orig.compose.yml" && cmp -s "$d/.env.prev" "$d.orig..env" && cmp -s "$d/dpm-custody.prev" "$d.orig.dpm-custody" && [ "$(mode_of "$d/.env.prev")" = "-rw-------" ] && [ -z "$(ls "$d" | grep "\.last$")" ]'
out="$(run "$d" rollback)"; rc=$?
check "8d rollback then returns to 1.0.0" '[ $rc -eq 0 ] && grep -qx "DPM_CUSTODY_VERSION=1.0.0" "$d/.env" && grep -qx "DPM_WALLET_MANAGER_TAG=1.0.0" "$d/.env" && cmp -s "$d/compose.yml" "$d.orig.compose.yml" && [ ! -e "$d/.env.prev" ]'
out="$(run "$d" upgrade --yes)"; rc=$?
check "8d a good upgrade leaves no stash" '[ $rc -eq 0 ] && [ -z "$(ls -a "$d" | grep "\.last$")" ]'

# 17. SIGHUP (dropped SSH session) during the health gate: the run still completes its rollback
d="$T/c17"; make_install "$d" 1.0.0 0.1.0 1.0.0
: >"$d.events"
EVENTS="$d.events" DPM_CUSTODY_RELEASES_URL="file://$T/rel" DPM_CUSTODY_RELEASE_PUBKEY="$T/key.pub" DPM_CUSTODY_ALLOW_INSECURE=1 DPM_CUSTODY_HEALTH_TIMEOUT=10 \
  HEALTH_BY_UP="healthy unhealthy healthy" HUP_PIDFILE="$T/c17.pid" \
  sh -c 'echo $$ >"$1"; shift; exec "$@"' _ "$T/c17.pid" bash "$d/dpm-custody" upgrade --yes </dev/null >"$T/c17.out" 2>&1
rc=$?
check "17 HUP: the signal was sent during the gate" '[ -e "$T/c17.pid.sent" ]'
check "17 HUP: rollback completed anyway" '[ $rc -eq 1 ] && [ "$(grep -c " up -d" "$d.events")" -eq 2 ] && cmp -s "$d/compose.yml" "$d.orig.compose.yml" && grep -qx "DPM_CUSTODY_VERSION=1.0.0" "$d/.env"'
check "17 HUP: outcome in upgrade.log, marker and lock gone" 'grep -q "was rolled back" "$d/upgrade.log" && [ ! -e "$d/upgrade.inprogress" ] && [ ! -e "$d/upgrade.lock" ]'

# 18. an unfinished upgrade (marker) blocks upgrade, shows in status; rollback clears it
d="$T/c18"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade --yes)"; rc=$?
printf 'from=1.0.0\nto=1.1.0\nstarted=now\n' >"$d/upgrade.inprogress"
out="$(run "$d" upgrade --yes)"; rc=$?
check "18 marker: upgrade refused, points to rollback and upgrade.log" '[ $rc -ne 0 ] && echo "$out" | grep -q "dpm-custody rollback" && echo "$out" | grep -q "upgrade.log" && ! has "$d.events" " pull"'
out="$(run "$d" status)"; rc=$?
check "18 marker: status shows the hint" 'echo "$out" | grep -q "did not finish" && echo "$out" | grep -q "dpm-custody rollback"'
check "18 marker: status still prints the storage line" 'echo "$out" | grep -qxF "Storage: warning · 81.2% used · ~13 days to full"'
out="$(run "$d" rollback)"; rc=$?
check "18 marker: rollback clears it" '[ $rc -eq 0 ] && [ ! -e "$d/upgrade.inprogress" ]'

# 19. lock: a second upgrade or rollback while one runs is refused, and the lock is not taken over
d="$T/c19"; make_install "$d" 1.0.0 0.1.0 1.0.0
mkdir "$d/upgrade.lock"; echo 4242 >"$d/upgrade.lock/pid"
out="$(run "$d" upgrade --yes)"; rc=$?
check "19 lock: upgrade refused, names the lock, nothing ran" '[ $rc -ne 0 ] && echo "$out" | grep -q "upgrade.lock" && echo "$out" | grep -q 4242 && ! has "$d.events" " pull" && unchanged "$d"'
check "19 lock: refusal keeps the lock of the other run" '[ -f "$d/upgrade.lock/pid" ]'
out="$(run "$d" rollback)"; rc=$?
check "19 lock: rollback refused too" '[ $rc -ne 0 ] && echo "$out" | grep -q "upgrade.lock" && [ -d "$d/upgrade.lock" ]'

# 20. an invalid value in .env.prev is skipped with a warning, the others are restored
d="$T/c20"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade --yes)"; rc=$?
sed 's/^DPM_WALLET_TAG=.*/DPM_WALLET_TAG=bad|x\&y/' "$d/.env.prev" >"$T/c20.prev" && cat "$T/c20.prev" >"$d/.env.prev"
out="$(run "$d" rollback)"; rc=$?
check "20 invalid .env.prev value: skipped with a warning" 'echo "$out" | grep -q "DPM_WALLET_TAG in .env.prev" && grep -qx "DPM_WALLET_TAG=0.2.0" "$d/.env"'
check "20 invalid .env.prev value: the other keys restored" 'grep -qx "DPM_WALLET_MANAGER_TAG=1.0.0" "$d/.env" && grep -qx "DPM_CUSTODY_VERSION=1.0.0" "$d/.env"'

# 9. rollback with no .prev
d="$T/c9"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" rollback)"; rc=$?
check "9 rollback without .prev refused" '[ $rc -ne 0 ] && echo "$out" | grep -qi "nothing to roll back" && unchanged "$d" && ! has "$d.events" " up -d"'

# 10. failed backup
d="$T/c10"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(FAIL_BACKUP=1 run "$d" upgrade --yes)"; rc=$?
check "10 failed backup aborts before pull" '[ $rc -ne 0 ] && echo "$out" | grep -qi "backup" && unchanged "$d" && ! has "$d.events" " pull" && ! has "$d.events" " up -d"'

# 11. image prune after a successful upgrade: only images other than the current and previous tags
d="$T/c11"; make_install "$d" 1.0.0 0.1.0 1.0.0
mkdir -p "$T/images"
R=ghcr.io/in-a-bit
printf '%s\n' "$R/dpm-wallet 0.2.0 <none> w1" "$R/dpm-wallet 0.1.0 <none> w2" "$R/dpm-wallet 0.0.9 $D2 w3" \
  "$R/dpm-wallet <none> $D3 w4" >"$T/images/dpm-wallet"
printf '%s\n' "$R/dpm-wallet-manager <none> $D1 m1" "$R/dpm-wallet-manager 1.0.0 <none> m2" \
  "$R/dpm-wallet-manager 0.9.0 <none> 3333aaaa3333" >"$T/images/dpm-wallet-manager"
out="$(IMAGES="$T/images" run "$d" upgrade --yes)"; rc=$?
rm_line="$(grep "docker image rm" "$d.events")"
check "11 prune: exactly one image rm call" '[ $rc -eq 0 ] && [ "$(grep -c "docker image rm" "$d.events")" -eq 1 ]'
check "11 prune: lists exactly the older images" '[ "$rm_line" = "docker image rm $R/dpm-wallet:0.0.9 $R/dpm-wallet@$D3 $R/dpm-wallet-manager:0.9.0" ]'
check "11 prune: never a blanket prune" '! has "$d.events" "prune"'
d="$T/c11b"; make_install "$d" 1.0.0 0.1.0 1.0.0; echo "DPM_IMAGE_REGISTRY=reg.example/x" >>"$d/.env"
out="$(IMAGES="$T/images" run "$d" upgrade --yes)"; rc=$?
check "11b prune: lists the install's registry" '[ $rc -eq 0 ] && has "$d.events" "image ls .*reg.example/x/dpm-wallet$" && ! has "$d.events" "docker image rm"'

# 11c. prune never removes an image a container on the host uses (another install, by name or ID)
d="$T/c11c"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(IMAGES="$T/images" IN_USE_REFS="$R/dpm-wallet:0.0.9" IN_USE_IDS="sha256:3333aaaa3333$(printf '0%.0s' $(seq 52))" run "$d" upgrade --yes)"; rc=$?
check "11c prune: skips images in use by any container" '[ $rc -eq 0 ] && [ "$(grep "docker image rm" "$d.events")" = "docker image rm $R/dpm-wallet@$D3" ]'
d="$T/c11d"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(IMAGES="$T/images" IN_USE_REFS="$R/dpm-wallet:0.0.9@$D2 $R/dpm-wallet@$D3 $R/dpm-wallet-manager:0.9.0" run "$d" upgrade --yes)"; rc=$?
check "11d prune: in-use by digest or tag@digest, nothing removed" '[ $rc -eq 0 ] && ! has "$d.events" "docker image rm"'

# 13. no terminal and no --yes: refused before anything
d="$T/c13"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade)"; rc=$?
check "13 no tty without --yes refused" '[ $rc -ne 0 ] && echo "$out" | grep -q -- "--yes" && unchanged "$d" && ! has "$d.events" pg_dumpall'

# 14. disk floor: 2x database + 1 GB
d="$T/c14"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(DB_BYTES=900000000000000000 run "$d" upgrade --yes)"; rc=$?
check "14 not enough disk refused" '[ $rc -ne 0 ] && echo "$out" | grep -qi "disk" && unchanged "$d" && ! has "$d.events" pg_dumpall'

# 15. a requested version that is not what the release folder holds
d="$T/c15"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade 1.4.0 --yes)"; rc=$?
check "15 requested version mismatch refused" '[ $rc -ne 0 ] && unchanged "$d" && ! has "$d.events" " pull"'

# 16. pre-release suffix compares by x.y.z
make_release "$T/rel-pre" 1.2.0-broken "" "0.2.0" "1.2.0"
d="$T/c16"; make_install "$d" 1.1.0 0.1.0 1.1.0
out="$(REL_URL="file://$T/rel-pre" run "$d" upgrade --yes)"; rc=$?
check "16 1.1.0 -> 1.2.0-broken allowed, recorded verbatim" '[ $rc -eq 0 ] && grep -qx "DPM_CUSTODY_VERSION=1.2.0-broken" "$d/.env"'

# 20. status: the storage line leaves out unknown parts, and a failing call never fails status
d="$T/c20"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(STORAGE_OUT='critical|93|' run "$d" status)"; rc=$?
check "20 storage: days left out when unknown" '[ $rc -eq 0 ] && echo "$out" | grep -qxF "Storage: critical · 93% used"'
out="$(STORAGE_OUT='ok||' run "$d" status)"; rc=$?
check "20 storage: only the level when nothing else is known" '[ $rc -eq 0 ] && echo "$out" | grep -qxF "Storage: ok"'
out="$(STORAGE_FAIL=1 run "$d" status)"; rc=$?
check "20 storage: a failing call prints nothing and status succeeds" '[ $rc -eq 0 ] && ! echo "$out" | grep -q "Storage:"'
out="$(STORAGE_OUT='' run "$d" status)"; rc=$?
check "20 storage: no sample yet prints nothing" '[ $rc -eq 0 ] && ! echo "$out" | grep -q "Storage:"'

# 18. the key embedded in the INSTALLED dpm-custody is the one that counts, not the new release's
emb="$T/embedded"; mkdir -p "$emb"
cp "$HERE/install.sh" "$HERE/install.ps1" "$HERE/dpm-custody" "$emb/"
DEPLOY_DIR="$emb" sh "$HERE/../scripts/embed-release-key.sh" "$T/key.pub" >/dev/null
d="$T/c18"; make_install "$d" 1.0.0 0.1.0 1.0.0; cp "$emb/dpm-custody" "$d/dpm-custody"
out="$(PUBKEY= run "$d" upgrade --yes)"; rc=$?
check "18 embedded key verifies a release signed with its private half" '[ $rc -eq 0 ] && echo "$out" | grep -q "Upgraded to 1.1.0"'
d="$T/c18b"; make_install "$d" 1.0.0 0.1.0 1.0.0; cp "$emb/dpm-custody" "$d/dpm-custody"
out="$(PUBKEY= REL_URL="file://$T/rel-wrongkey" run "$d" upgrade --yes)"; rc=$?
check "18 embedded key rejects a release signed by another key, even if its own script carries that key" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && ! has "$d.events" " pull"'

# 21. sealed backups, restore, prune (the real seal/open from dist/; skipped if dist is not built)
if [ -f "$DIST_MAIN" ]; then
  keys="$(node "$DIST_MAIN" backup-keygen)"
  RECIP="$(printf '%s\n' "$keys" | sed -n 's/^recipient=//p')"; RKEY="$(printf '%s\n' "$keys" | sed -n 's/^recovery_key=//p')"
  d="$T/c19"; make_install "$d" 1.1.0 0.2.0 1.1.0
  out="$(FAKE_RECIPIENT="$RECIP" run "$d" backup)"; rc=$?
  b="$(ls -d "$d"/backups/[0-9]* | head -n 1)"
  check "21 backup with a recipient: exit 0, every artifact sealed, no plaintext copy" '[ $rc -eq 0 ] && for f in databases.sql config.tar.gz wallet-data.tar.gz installer.env; do [ -s "$b/$f.sealed" ] && [ ! -e "$b/$f" ] || exit 1; done; ! echo "$out" | grep -q WARNING'
  check "21 sealed files do not contain the plaintext" '! grep -q -- "-- dump" "$b/databases.sql.sealed" && ! grep -q "POSTGRES_PASSWORD" "$b/installer.env.sealed"'
  printf '%s\n' "$RKEY" >"$T/rkey"
  opened="$(DPM_BACKUP_RECOVERY_KEY_FILE="$T/rkey" run "$d" backup-open "$b/databases.sql.sealed")"; rc=$?
  check "21 backup-open with the recovery key returns the original" '[ $rc -eq 0 ] && [ "$opened" = "-- dump" ]'
  opened="$(DPM_BACKUP_RECOVERY_KEY_FILE="$T/rkey" run "$d" backup-open "$b/installer.env.sealed")"
  check "21 the sealed .env round-trips" 'echo "$opened" | grep -qx "POSTGRES_PASSWORD=secret"'
  other="$(node "$DIST_MAIN" backup-keygen | sed -n 's/^recovery_key=//p')"; printf '%s\n' "$other" >"$T/other.key"
  opened="$(DPM_BACKUP_RECOVERY_KEY_FILE="$T/other.key" run "$d" backup-open "$b/databases.sql.sealed")"; rc=$?
  check "21 backup-open with another key fails, prints no data" '[ $rc -ne 0 ] && ! echo "$opened" | grep -q -- "-- dump"'
  cp "$b/databases.sql.sealed" "$T/tampered.sealed"; printf 'X' | dd of="$T/tampered.sealed" bs=1 seek=70 conv=notrunc 2>/dev/null
  opened="$(DPM_BACKUP_RECOVERY_KEY_FILE="$T/rkey" run "$d" backup-open "$T/tampered.sealed")"; rc=$?
  check "21 a tampered backup is refused" '[ $rc -ne 0 ] && ! echo "$opened" | grep -q -- "-- dump"'

  # the recipient in .env counts too, and no recipient anywhere means plaintext with a warning
  d="$T/c19b"; make_install "$d" 1.1.0 0.2.0 1.1.0; echo "DPM_BACKUP_RECIPIENT=$RECIP" >>"$d/.env"
  out="$(run "$d" backup)"; rc=$?
  check "21 recipient from .env: sealed" '[ $rc -eq 0 ] && [ -s "$(ls -d "$d"/backups/[0-9]* | head -n 1)/databases.sql.sealed" ]'
  d="$T/c19c"; make_install "$d" 1.1.0 0.2.0 1.1.0
  out="$(run "$d" backup)"; rc=$?
  check "21 no recipient: plaintext, with a loud warning that names backup-key" '[ $rc -eq 0 ] && [ -s "$(ls -d "$d"/backups/[0-9]* | head -n 1)/databases.sql" ] && echo "$out" | grep -q "NOT encrypted" && echo "$out" | grep -q "backup-key"'

  # backup-key: .env gets the recipient, the recovery key is shown once and not stored; a second run refuses
  d="$T/c19d"; make_install "$d" 1.1.0 0.2.0 1.1.0
  out="$(run "$d" backup-key)"; rc=$?
  shown="$(printf '%s\n' "$out" | grep -o 'dpmbk_key_[A-Za-z0-9_-]*' | head -n 1)"
  check "21 backup-key: recipient in .env, recovery key shown once and not written anywhere" '[ $rc -eq 0 ] && grep -q "^DPM_BACKUP_RECIPIENT=dpmbk_pub_" "$d/.env" && [ -n "$shown" ] && ! grep -rq "$shown" "$d" 2>/dev/null'
  out="$(run "$d" backup-key)"; rc=$?
  check "21 backup-key again: refuses without --rotate" '[ $rc -eq 0 ] && echo "$out" | grep -q "already has a backup recovery key" && ! echo "$out" | grep -q "dpmbk_key_"'

  # prune: keep the newest N complete backups, only after a good backup
  d="$T/c19e"; make_install "$d" 1.1.0 0.2.0 1.1.0
  mkdir -p "$d/backups"
  for n in 20200101-000001 20200101-000002 20200101-000003 20200101-000004; do mkdir "$d/backups/$n"; done
  mkdir "$d/backups/20190101-000000-incomplete"
  out="$(FAIL_BACKUP=1 DPM_CUSTODY_KEEP_BACKUPS=2 run "$d" backup)"; rc=$?
  check "21 prune: a failed backup removes nothing" '[ $rc -ne 0 ] && [ -d "$d/backups/20200101-000001" ] && [ -d "$d/backups/20200101-000002" ]'
  out="$(DPM_CUSTODY_KEEP_BACKUPS=2 run "$d" backup)"; rc=$?
  left="$(ls -1 "$d/backups" | grep -v incomplete | wc -l | tr -d ' ')"
  check "21 prune: keeps the newest 2 (the new one and the latest old one), leaves *-incomplete alone" '[ $rc -eq 0 ] && [ "$left" = 2 ] && [ -d "$d/backups/20200101-000004" ] && [ ! -d "$d/backups/20200101-000001" ] && [ -d "$d/backups/20190101-000000-incomplete" ]'
  d="$T/c19f"; make_install "$d" 1.1.0 0.2.0 1.1.0; mkdir -p "$d/backups"; for n in 20200101-000001 20200101-000002 20200101-000003 20200101-000004 20200101-000005 20200101-000006; do mkdir "$d/backups/$n"; done
  out="$(run "$d" backup)"
  check "21 prune: default keeps 5" '[ "$(ls -1 "$d/backups" | wc -l | tr -d " ")" = 5 ]'
else
  echo "skip - 21 sealed backups (build first: npx nest build)"
fi

# 22. spent credentials are scrubbed from the OLD config volume too, even after an upgrade run by an
# older dpm-custody (which never mounted it writable): once per installed version, at the first
# command of this dpm-custody; and by the upgrade itself
SCRUB='-v config:/legacy-config:rw setup node dist/setup/main scrub-legacy'
d="$T/c22"; make_install "$d" 1.1.0 0.2.0 1.1.0
out="$(run "$d" status)"; rc=$?
check "22 the first command scrubs the old config volume (writable mount) and stamps the version" 'has "$d.events" "$SCRUB" && [ "$(cat "$d/.legacy-scrubbed")" = "1.1.0" ]'
out="$(run "$d" start)"
check "22 later commands of the same version do not repeat it" '! has "$d.events" "$SCRUB"'
sed -i 's/^DPM_CUSTODY_VERSION=.*/DPM_CUSTODY_VERSION=1.2.0/' "$d/.env"
out="$(run "$d" start)"
check "22 a new installed version scrubs again" 'has "$d.events" "$SCRUB" && [ "$(cat "$d/.legacy-scrubbed")" = "1.2.0" ]'
d="$T/c22b"; make_install "$d" 1.1.0 0.2.0 1.1.0
out="$(FAIL_SCRUB=1 run "$d" status)"; rc=$?
check "22 a failing scrub never fails the command, and is retried next time" '[ ! -e "$d/.legacy-scrubbed" ]'
d="$T/c22c"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" upgrade --yes)"; rc=$?
check "22 the upgrade (writable migrate run) stamps the target version, so nothing runs twice" '[ $rc -eq 0 ] && [ "$(cat "$d/.legacy-scrubbed")" = "1.1.0" ]'
out="$(run "$d" start)"
check "22 and the next command does not scrub again" '! has "$d.events" "$SCRUB"'
d="$T/c22d"; make_install "$d" 1.0.0 0.1.0 1.0.0
out="$(run "$d" cleanup-legacy --yes)"
check "22 cleanup-legacy and rollback do not trigger it" '! has "$d.events" "$SCRUB"'

check "scripts parse" 'bash -n "$HERE/dpm-custody" && bash -n "$0"'

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }

