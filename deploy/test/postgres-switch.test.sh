#!/usr/bin/env bash
# A real rehearsal of moving an install's Postgres from the Alpine image to the pinned Debian one:
# a throwaway volume is initialised by postgres:18-alpine with a text-indexed table, the pinned
# image from compose.yml takes it over, and `setup migrate` (compiled from src/) repairs the
# indexes. Needs Docker and both images already pulled; skipped when they are not. Creates one
# container and one volume, both removed on exit.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$HERE/.."
T="$(mktemp -d)"
NAME="dpm-switch-test-$$"
VOL="$NAME-vol"
DIST="$ROOT/node_modules/.cache/dpm-switch-test-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  rm -rf "$T" "$DIST"
}
trap cleanup EXIT
fails=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

command -v docker >/dev/null 2>&1 || { echo "skip - postgres switch (no docker)"; exit 0; }
PINNED="$(sed -n 's/.*image: postgres:\${POSTGRES_TAG:-\(.*\)}$/\1/p' "$HERE/compose.yml")"
[ -n "$PINNED" ] || { bad "could not read the pinned Postgres from compose.yml"; exit 1; }
ALPINE=postgres:18-alpine
for image in "$ALPINE" "postgres:$PINNED"; do
  docker image inspect "$image" >/dev/null 2>&1 || { echo "skip - postgres switch (pull $image first)"; exit 0; }
done

psql_in() { docker exec -i "$NAME" psql -U dpm -d "$1" -tA -v ON_ERROR_STOP=1; }
# The capabilities compose.yml gives the postgres service (read from it, so the two cannot drift):
# the entrypoint must still be able to hand the data directory to its own user with only these.
CAPS="$(sed -n '/^  postgres:/,/^  dpm-wallet:/p' "$HERE/compose.yml" | sed -n 's/^ *cap_add: \[\(.*\)\]/\1/p' | tr -d ' ' | tr ',' ' ')"
HARDEN=(--cap-drop ALL --security-opt no-new-privileges:true)
for cap in $CAPS; do HARDEN+=(--cap-add "$cap"); done
start() { # IMAGE [hardened]
  local extra=()
  [ "${2:-}" = hardened ] && extra=("${HARDEN[@]}")
  docker run -d --name "$NAME" "${extra[@]}" -e POSTGRES_USER=dpm -e POSTGRES_PASSWORD=pw -p 127.0.0.1::5432 -v "$VOL:/var/lib/postgresql" "$1" >/dev/null
  for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U dpm >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}

# 1. an Alpine install with data: names that sort differently by code point and by locale
start "$ALPINE" || { bad "alpine postgres did not start"; exit 1; }
docker exec "$NAME" psql -U dpm -d postgres -c "CREATE DATABASE dpm_wallet_manager" >/dev/null
psql_in dpm_wallet_manager >/dev/null <<'SQL'
CREATE TABLE things (name text PRIMARY KEY, n int);
INSERT INTO things SELECT x, ordinality FROM unnest(ARRAY['a','B','c','A','_x','b','Zed','zed','alpha','Alpha','ALPHA']) WITH ORDINALITY t(x, ordinality);
CREATE INDEX things_name_idx ON things (name);
SQL
docker stop "$NAME" >/dev/null && docker rm "$NAME" >/dev/null

# 2. the pinned Debian image takes over the same volume
check "the compose.yml capability list was read" '[ -n "$CAPS" ]'
start "postgres:$PINNED" hardened || { bad "the pinned postgres did not start on the old volume"; exit 1; }
check "with only those capabilities the entrypoint hands the Alpine-made data directory to the Debian postgres user (uid 999)" \
  '[ "$(docker exec "$NAME" stat -c %u /var/lib/postgresql/18/docker)" = 999 ]'
# The manager measures the disk through a read-only mount of this volume, as its own non-root user
# (uid 100); any image with busybox `stat` shows whether that still works on the converted volume.
check "the manager's read-only statfs mount of the volume still works as uid 100" \
  'docker run --rm -u 100:101 -v "$VOL:/storage/pg:ro" --entrypoint stat "$ALPINE" -f /storage/pg >/dev/null 2>&1'
check "the data and its columns are readable after the switch" \
  '[ "$(psql_in dpm_wallet_manager <<<"SELECT count(*) FROM things;")" = 11 ]'
psql_in dpm_wallet_manager >/dev/null <<<"CREATE EXTENSION IF NOT EXISTS amcheck;"
broken() { psql_in dpm_wallet_manager <<<"SELECT bt_index_check('things_name_idx'::regclass, true);" 2>&1 | grep -q "order invariant violated"; }
check "before the repair the old text index is out of order for the new C library (this is the bug)" 'broken'
check "and an equality lookup through it misses a row that is there" \
  '[ -z "$(psql_in dpm_wallet_manager <<<"SET enable_seqscan=off; SET enable_bitmapscan=off; SELECT name FROM things WHERE name = '"'b'"';" | grep -v "^SET$")" ]'

# 3. setup migrate, compiled from this checkout, as setup runs it at start
if ! "$ROOT/node_modules/.bin/tsc" -p "$ROOT/tsconfig.build.json" --outDir "$DIST" >"$T/tsc.log" 2>&1; then
  bad "building src failed: $(head -3 "$T/tsc.log")"; exit 1
fi
PORT="$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')"
mkdir -p "$T/legacy" "$T/wallet" "$T/manager" "$T/state"
migrate() {
  SETUP_LEGACY_CONFIG_DIR="$T/legacy" SETUP_WALLET_CONFIG_DIR="$T/wallet" SETUP_MANAGER_CONFIG_DIR="$T/manager" \
    SETUP_STATE_DIR="$T/state" SETUP_POSTGRES_HOST=127.0.0.1 SETUP_POSTGRES_PORT="$PORT" \
    POSTGRES_USER=dpm POSTGRES_PASSWORD=pw node "$DIST/setup/main.js" migrate 2>&1
}
out="$(migrate)"; rc=$?
check "setup migrate succeeds and says it rebuilt the indexes" '[ $rc -eq 0 ] && echo "$out" | grep -q "rebuilt the text indexes of dpm_wallet_manager"'
check "the index is valid again" '! broken'
check "an equality lookup through the index finds the row" \
  '[ "$(psql_in dpm_wallet_manager <<<"SET enable_seqscan=off; SET enable_bitmapscan=off; SELECT name FROM things WHERE name = '"'b'"';" | grep -v "^SET$")" = b ]'
check "the data is unchanged" '[ "$(psql_in dpm_wallet_manager <<<"SELECT count(*), sum(n) FROM things;")" = "11|66" ]'
out="$(migrate)"; rc=$?
check "a second run changes nothing" '[ $rc -eq 0 ] && echo "$out" | grep -q "already match" && ! echo "$out" | grep -q "rebuilt"'

# 4. and back: a rollback to a release on Alpine leaves the indexes in the Debian order, which
# dpm-custody's rollback rebuilds with the same statement (reindex_if_musl)
docker stop "$NAME" >/dev/null && docker rm "$NAME" >/dev/null
start "$ALPINE" hardened || { bad "alpine postgres did not start again under the hardened settings"; exit 1; }
check "back on Alpine the index built under Debian's order is out of order (the rollback hazard)" 'broken'
docker exec "$NAME" psql -U dpm -d dpm_wallet_manager -c "REINDEX DATABASE dpm_wallet_manager" >/dev/null 2>&1
check "the rollback's REINDEX makes it valid for Alpine again" '! broken'

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
