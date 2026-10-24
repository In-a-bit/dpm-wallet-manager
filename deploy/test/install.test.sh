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
# A throwaway signing key pair (and a second one, for a signature by the wrong key). The
# installer checks SHA256SUMS.sig against key.pub through DPM_CUSTODY_RELEASE_PUBKEY.
openssl ecparam -name prime256v1 -genkey -noout -out "$T/key.pem" 2>/dev/null
openssl pkey -in "$T/key.pem" -pubout -out "$T/key.pub"
openssl ecparam -name prime256v1 -genkey -noout -out "$T/other.pem" 2>/dev/null
# sign [KEY] signs the release's current SHA256SUMS (DER ECDSA over SHA-256, like CI).
sign() { openssl dgst -sha256 -sign "${1:-$T/key.pem}" -out "$rel/SHA256SUMS.sig" "$rel/SHA256SUMS"; }
resum() { (cd "$rel" && sha256 $SUMFILES >SHA256SUMS); sign; }

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
    DPM_CUSTODY_RELEASE_PUBKEY="$T/key.pub" DPM_CUSTODY_ALLOW_INSECURE=1 \
    DPM_CUSTODY_MANAGER_PORT="$PORT" "$@" \
    sh "$HERE/install.sh" </dev/null
}

# 1. wrong checksum aborts before anything is written
cp "$rel/SHA256SUMS" "$T/good.sums"
# corrupt the digest of a downloaded file (dpm-custody)
awk '/ dpm-custody$/{ $0 = (substr($0, 1, 1) == "0" ? "1" : "0") substr($0, 2) } {print}' "$T/good.sums" >"$rel/SHA256SUMS"
sign   # validly signed, so it is the checksum that fails
d1="$T/i1"
out="$(run "$d1" 2>&1)"; rc=$?
check "wrong SHA256SUMS exits non-zero" '[ $rc -ne 0 ]'
check "wrong SHA256SUMS writes no .env" '[ ! -e "$d1/.env" ]'
check "wrong SHA256SUMS writes no files" '[ -z "$(ls -A "$d1" 2>/dev/null)" ]'

# 2. correct checksums install
cp "$T/good.sums" "$rel/SHA256SUMS"; sign
out="$(run "$d1" 2>&1)"; rc=$?
check "correct SHA256SUMS exits 0" '[ $rc -eq 0 ]'
check "files written" '[ -f "$d1/compose.yml" ] && [ -f "$d1/versions.env" ] && [ -x "$d1/dpm-custody" ]'
check ".env has version from versions.env" 'grep -qx "DPM_CUSTODY_VERSION=9.9.9" "$d1/.env"'
check ".env pins the Postgres image from versions.env" 'grep -qx "POSTGRES_TAG=$(sed -n "s/^POSTGRES_TAG=//p" "$rel/versions.env")" "$d1/.env"'
check ".env has password and tags" 'grep -q "^POSTGRES_PASSWORD=.\{32\}$" "$d1/.env" && grep -q "^DPM_WALLET_TAG=" "$d1/.env"'
check "NO_START: no compose up" '! grep -q " up " "$DOCKER_LOG"'

# 3. signature and sums are mandatory; every refusal writes nothing
cp "$HERE/versions.env" "$rel/versions.env"; resum
d3="$T/i3"
out="$(run "$d3" 2>&1)"; rc=$?
check "empty RELEASE_VERSION -> unknown" '[ $rc -eq 0 ] && grep -qx "DPM_CUSTODY_VERSION=unknown" "$d3/.env"'
nothing_written() { [ ! -e "$1/.env" ] && [ -z "$(ls -A "$1" 2>/dev/null)" ]; }
cp "$rel/SHA256SUMS" "$T/signed.sums"; cp "$rel/SHA256SUMS.sig" "$T/signed.sig"
restore() { cp "$T/signed.sums" "$rel/SHA256SUMS"; cp "$T/signed.sig" "$rel/SHA256SUMS.sig"; }

rm "$rel/SHA256SUMS" "$rel/SHA256SUMS.sig"
d3a="$T/i3a"; out="$(run "$d3a" 2>&1)"; rc=$?
check "missing SHA256SUMS: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "SHA256SUMS" && nothing_written "$d3a"'
restore; rm "$rel/SHA256SUMS.sig"
d3b="$T/i3b"; out="$(run "$d3b" 2>&1)"; rc=$?
check "missing signature: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "SHA256SUMS.sig" && nothing_written "$d3b"'
restore; sign "$T/other.pem"
d3c="$T/i3c"; out="$(run "$d3c" 2>&1)"; rc=$?
check "signature by another key: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && nothing_written "$d3c"'
restore; printf 'garbage' >"$rel/SHA256SUMS.sig"
d3d="$T/i3d"; out="$(run "$d3d" 2>&1)"; rc=$?
check "garbage signature: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && nothing_written "$d3d"'
restore; { cat "$rel/SHA256SUMS"; echo "0000000000000000000000000000000000000000000000000000000000000000  extra"; } >"$rel/SHA256SUMS.new"; mv "$rel/SHA256SUMS.new" "$rel/SHA256SUMS"
d3e="$T/i3e"; out="$(run "$d3e" 2>&1)"; rc=$?
check "SHA256SUMS changed after signing: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "signature .* does not match" && nothing_written "$d3e"'
restore
d3f="$T/i3f"; out="$(run "$d3f" DPM_CUSTODY_ALLOW_INSECURE= 2>&1)"; rc=$?
check "file:// refused without DPM_CUSTODY_ALLOW_INSECURE" '[ $rc -ne 0 ] && echo "$out" | grep -q "Refusing to download" && nothing_written "$d3f"'
d3g="$T/i3g"; out="$(run "$d3g" DPM_CUSTODY_ALLOW_INSECURE= DPM_CUSTODY_RELEASES_URL=http://example.test/rel 2>&1)"; rc=$?
check "http:// refused without DPM_CUSTODY_ALLOW_INSECURE" '[ $rc -ne 0 ] && echo "$out" | grep -q "https:// only" && nothing_written "$d3g"'
# The embedded key (no override) is a placeholder in the source tree: nothing verifies against it.
d3h="$T/i3h"; out="$(run "$d3h" DPM_CUSTODY_RELEASE_PUBKEY= 2>&1)"; rc=$?
check "placeholder embedded key: refused, and says why" '[ $rc -ne 0 ] && echo "$out" | grep -q "placeholder release key" && nothing_written "$d3h"'
# Embedding a real key (scripts/embed-release-key.sh) makes that key the one that counts.
emb="$T/embedded"; mkdir -p "$emb"
cp "$HERE/install.sh" "$HERE/install.ps1" "$HERE/dpm-custody" "$emb/"
DEPLOY_DIR="$emb" sh "$HERE/../scripts/embed-release-key.sh" "$T/key.pub" >/dev/null
d3i="$T/i3i"
out="$(env DPM_CUSTODY_DIR="$d3i" DPM_CUSTODY_RELEASES_URL="file://$rel" DPM_CUSTODY_ALLOW_INSECURE=1 DPM_CUSTODY_NO_START=1 DPM_CUSTODY_MANAGER_PORT="$PORT" sh "$emb/install.sh" </dev/null 2>&1)"; rc=$?
check "embedded real key verifies a release signed with its private half" '[ $rc -eq 0 ] && [ -f "$d3i/.env" ]'
sign "$T/other.pem"
d3j="$T/i3j"
out="$(env DPM_CUSTODY_DIR="$d3j" DPM_CUSTODY_RELEASES_URL="file://$rel" DPM_CUSTODY_ALLOW_INSECURE=1 DPM_CUSTODY_NO_START=1 DPM_CUSTODY_MANAGER_PORT="$PORT" sh "$emb/install.sh" </dev/null 2>&1)"; rc=$?
check "embedded real key rejects a release signed by another key" '[ $rc -ne 0 ] && nothing_written "$d3j"'
restore

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
out=""; url=""; wcode=0; fail_on_http=0
echo "$*" >>"${CURL_LOG:-/dev/null}"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -w) wcode=1; shift ;;
    --proto) shift ;;
    -*f*) fail_on_http=1 ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
# The installer's port check: nothing answers on loopback (curl's "could not connect").
case "$url" in http://127.0.0.1:*) exit 7 ;; esac
name="${url##*/}"
code=200
[ "$name" = SHA256SUMS ] && code="$SUMS_CODE"
[ "$code" != 200 ] && [ "$fail_on_http" = 1 ] && exit 22
[ "$code" = 200 ] && cp "$REL/$name" "$out"
[ "$code" != 200 ] && : >"$out"
[ "$wcode" = 1 ] && printf '%s' "$code"
exit 0
S
chmod +x "$T/curlbin/curl"
d7="$T/i7"
out="$(PATH="$T/curlbin:$PATH" REL="$rel" SUMS_CODE=404 run "$d7" DPM_CUSTODY_RELEASES_URL=http://example.test/rel 2>&1)"; rc=$?
check "HTTP 404 SHA256SUMS: refused, nothing written" '[ $rc -ne 0 ] && echo "$out" | grep -q "Could not download SHA256SUMS" && nothing_written "$d7"'
# An https release is fetched with curl restricted to https and TLS 1.2.
d7b="$T/i7b"; : >"$T/curl.log"
out="$(PATH="$T/curlbin:$PATH" CURL_LOG="$T/curl.log" REL="$rel" SUMS_CODE=200 run "$d7b" DPM_CUSTODY_RELEASES_URL=https://example.test/rel 2>&1)"; rc=$?
check "https release: fetched with --proto =https --tlsv1.2" '[ $rc -eq 0 ] && grep -q "https://example.test/rel/SHA256SUMS.sig" "$T/curl.log" && grep -- "example.test" "$T/curl.log" | grep -q -- "--proto =https" && grep -- "example.test" "$T/curl.log" | grep -q -- "--tlsv1.2"'
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
    if python3 - "$T/cfg.json" "$HERE/versions.env" <<'PY'
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
# Postgres is the pinned Debian image; with no POSTGRES_TAG in .env the compose default is the very
# reference versions.env carries, so an install that predates the variable still gets it.
versions = dict(l.strip().split("=", 1) for l in open(sys.argv[2]) if "=" in l and not l.startswith("#"))
pg = svc["postgres"]["image"]
bad_pg = not (pg == "postgres:" + versions["POSTGRES_TAG"] and "-trixie@sha256:" in pg and "alpine" not in pg)
# Hardening: the app services (and tools) drop every capability, cannot gain privileges and have a
# read-only root filesystem; Postgres keeps only what its entrypoint needs; Postgres sits on an
# internal network alone (no route out), dpm-wallet and the manager bridge it to the default
# network, and tools has no network at all.
hardened = ("dpm-wallet", "dpm-wallet-manager", "setup")
weak = [n for n in hardened if not (svc[n].get("cap_drop") == ["ALL"] and "no-new-privileges:true" in svc[n].get("security_opt", []) and svc[n].get("read_only") is True and not svc[n].get("cap_add"))]
pg_svc = svc["postgres"]
weak_pg = pg_svc.get("cap_drop") != ["ALL"] or "no-new-privileges:true" not in pg_svc.get("security_opt", []) or set(pg_svc.get("cap_add", [])) - {"CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"}
nets = {n: set(svc[n].get("networks", {"default": None})) for n in svc}
net_defs = json.load(open(sys.argv[1]))["networks"]
bad_net = (nets["postgres"] != {"backend"} or net_defs["backend"].get("internal") is not True
           or not {"backend", "default"} <= nets["dpm-wallet"] or not {"backend", "default"} <= nets["dpm-wallet-manager"]
           or not {"backend", "default"} <= nets["setup"] or net_defs.get("default", {}).get("internal"))
# Only setup (and postgres) holds the database superuser; the services get their own roles from
# the env files setup writes, and setup waits for postgres to create them.
env_of = lambda n: svc[n].get("environment", {})
leak = [n for n in ("dpm-wallet", "dpm-wallet-manager") if any(k.startswith("POSTGRES_") for k in env_of(n))]
setup_waits_pg = svc["setup"]["depends_on"].get("postgres", {}).get("condition") == "service_healthy"
sys.exit(1 if weak or weak_pg or bad_net or bad or bad_pg or oneshot or waits or leak or not setup_waits_pg or "healthcheck" not in svc["setup"] else 0)
PY
    then ok "compose: config volumes are mounted only by their consumers"
    else bad "compose: config volumes are mounted only by their consumers"; fi

    # The `tools` helper (decrypted backups, a new recovery key) is profile-only, so `up` and the
    # upgrade health gate never see it, and it keeps nothing in Docker's logs and gets no volumes.
    if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
      docker compose -f "$HERE/compose.yml" config --services 2>/dev/null | grep -qx tools; then
      bad "compose: the tools helper is not part of the default services"
    else ok "compose: the tools helper is not part of the default services"; fi
    if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
      docker compose -f "$HERE/compose.yml" --profile tools config --format json 2>/dev/null | python3 -c '
import json, sys
t = json.load(sys.stdin)["services"]["tools"]
sys.exit(0 if t["logging"]["driver"] == "none" and not t.get("volumes") and not t.get("environment") and t["restart"] == "no" and t.get("network_mode") == "none" and t.get("cap_drop") == ["ALL"] and t.get("read_only") is True else 1)'; then
      ok "compose: the tools helper has no log driver, no volumes, no environment"
    else bad "compose: the tools helper has no log driver, no volumes, no environment"; fi

    # config-reader (support's view of the env files): profile-only too, read-only mounts of exactly
    # the two configuration volumes, no network, no log driver.
    if PATH="/usr/bin:/bin:/usr/local/bin" DPM_WALLET_TAG=1 DPM_WALLET_MANAGER_TAG=1 POSTGRES_PASSWORD=x \
      docker compose -f "$HERE/compose.yml" --profile tools config --format json 2>/dev/null | python3 -c '
import json, sys
svc = json.load(sys.stdin)["services"]
r = svc["config-reader"]
mounts = {(v["source"], v["target"], bool(v.get("read_only"))) for v in r.get("volumes", [])}
sys.exit(0 if r["logging"]["driver"] == "none" and r.get("network_mode") == "none" and r.get("read_only") is True
         and mounts == {("config-wallet", "/config-wallet", True), ("config-manager", "/config-manager", True)}
         and r.get("profiles") == ["tools"] and r.get("cap_drop") == ["ALL"] else 1)'; then
      ok "compose: config-reader is isolated and sees only the two configuration volumes, read-only"
    else bad "compose: config-reader is isolated and sees only the two configuration volumes, read-only"; fi

    # Run setup's start script with a fake node: a failed migration must leave the container
    # running (so it is unhealthy and `up -d` fails), never exit; a good one marks the volume and
    # hands over to the worker.
    python3 - "$T/cfg.json" "$T/setup-start.sh" "$T/state" <<'PY'
import json, sys
cmd = json.load(open(sys.argv[1]))["services"]["setup"]["command"]
open(sys.argv[2], "w").write(cmd[2].replace("/state", sys.argv[3]))
PY
    mkdir -p "$T/state" "$T/fakenode"
    printf '#!/bin/sh\n[ "$2" = migrate ] && exit "${FAKE_MIGRATE_RC:-0}"\necho worker >"$T/state/worker"\n' >"$T/fakenode/node"
    sed -i "s|\$T|$T|g" "$T/fakenode/node"
    chmod +x "$T/fakenode/node"
    FAKE_MIGRATE_RC=1 PATH="$T/fakenode:$PATH" timeout 3 sh "$T/setup-start.sh" >/dev/null 2>&1; rc=$?
    if [ $rc -eq 124 ] && [ ! -e "$T/state/.migrated" ] && [ ! -e "$T/state/worker" ]; then
      ok "compose: a failed migration keeps setup running, unhealthy"
    else bad "compose: a failed migration keeps setup running, unhealthy (rc=$rc)"; fi
    FAKE_MIGRATE_RC=0 PATH="$T/fakenode:$PATH" timeout 3 sh "$T/setup-start.sh" >/dev/null 2>&1; rc=$?
    if [ $rc -eq 0 ] && [ -e "$T/state/.migrated" ] && [ -e "$T/state/worker" ]; then
      ok "compose: a good migration marks the volume, then starts the worker"
    else bad "compose: a good migration marks the volume, then starts the worker (rc=$rc)"; fi
  fi
fi

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
