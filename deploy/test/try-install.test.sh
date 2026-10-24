#!/usr/bin/env bash
# Checks that deploy/try-install.sh and scripts/smoke.sh never put a secret on a command line.
# A curl shim records every argument and what arrives on stdin; nothing touches the network.
# The variables below are read by the functions sourced from try-install.sh and by eval'd checks.
# shellcheck disable=SC2034
set -u
HERE="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fails=0

mkdir -p "$T/bin"
cat >"$T/bin/curl" <<'S'
#!/bin/sh
printf '%s\n' "$*" >>"$CURL_ARGV"
# `--config -` reads curl's options from stdin; record them, as a real curl would consume them.
for a in "$@"; do [ "$a" = "-" ] && cat >>"$CURL_STDIN"; done
# Answer like a healthy install, whatever was asked.
if printf '%s' "$*" | grep -q '%{http_code}'; then printf '{"ok":true}\n200'; else printf '{"status":"ok","role":"admin","mode":"shared"}'; fi
S
chmod +x "$T/bin/curl"
export PATH="$T/bin:$PATH" CURL_ARGV="$T/argv" CURL_STDIN="$T/stdin"
KEY="bld_sk_TESTSECRET0123456789"

# ── try-install.sh ───────────────────────────────────────────────────────────
# shellcheck source=/dev/null
. "$HERE/deploy/try-install.sh"
# Sourcing brought try-install.sh's own ok/warn/step and its `set -e`; the checks use other names.
set +e
pass() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fails=$((fails + 1)); }
check() { if eval "$2"; then pass "$1"; else bad "$1"; fi; }

: >"$CURL_ARGV"
: >"$CURL_STDIN"
out="$(http_with_header "X-Builder-Api-Private-Key: $KEY" GET http://platform.test/wallet-install/config)"
check "the secret header reaches curl on stdin" "grep -q 'X-Builder-Api-Private-Key: $KEY' '$CURL_STDIN'"
check "the secret is on no curl command line" "! grep -q TESTSECRET '$CURL_ARGV'"
check "the status code still comes back last" "[ \"\$(tail -n 1 <<<\"\$out\")\" = 200 ]"

: >"$CURL_STDIN"
http_with_header 'X-Odd: a"b\c' GET http://platform.test/ >/dev/null
check "quotes and backslashes in a header are escaped for the config" "grep -qF 'header = \"X-Odd: a\\\"b\\\\c\"' '$CURL_STDIN'"

: >"$CURL_STDIN"
http GET http://platform.test/healthz >/dev/null
check "a plain request sends an empty config" "[ ! -s '$CURL_STDIN' ]"

# ── the key only goes to https, or to this computer over http ────────────────
for url in https://api.example.com http://localhost:8086 http://127.0.0.1 "http://[::1]:8086/x" \
  http://host.docker.internal:8086 HTTP://LOCALHOST; do
  check "safe_platform_url accepts $url" "safe_platform_url '$url'"
done
for url in http://api.example.com http://localhost@evil.com http://localhost:80@evil.com/ \
  http://127.0.0.1.nip.io "http://[::ffff:127.0.0.1]" http://localhost.evil.example \
  http://localhost: http://localhostx ftp://localhost https://user@api.example.com "not a url" ""; do
  check "safe_platform_url refuses '$url'" "! safe_platform_url '$url'"
done
PLATFORM="http://evil.example"
: >"$CURL_ARGV"
if platform_ok; then platform_rc=0; else platform_rc=1; fi
check "an http:// platform away from this computer is refused before any request" "[ $platform_rc -eq 1 ] && [ ! -s '$CURL_ARGV' ]"
CONFIG='200'
check "the refusal says why" "grep -q 'must use https' <<<\"\$PROBLEM\""

# A service address the platform reports is held to the same rule; the key is not sent there.
CONFIG="$(printf '%s\n200' '{"services":{"gamma_api":"http://evil.example","relayer_api":"https://r.example"}}')"
BUILDER_KEY="$KEY"
: >"$CURL_ARGV"
( check_platform_apis ) >"$T/svc.out" 2>&1
check "an unsafe reported service address stops the run" "grep -q 'unsafe service address' '$T/svc.out'"
check "and nothing was sent to it" "[ ! -s '$CURL_ARGV' ]"

# A key with whitespace, quotes or a line break is refused (it would be read as curl config).
for bad_key in "bld_sk_a b" "bld_sk_a\"b" 'bld_sk_a\b' "$(printf 'bld_sk_a\nheader = "X-Evil: 1"')"; do
  BUILDER_KEY="$bad_key"
  check "key_ok refuses a key with whitespace/quotes/line breaks" "! key_ok"
done

# A key on the command line is refused, with its value kept out of the message.
msg="$(bash "$HERE/deploy/try-install.sh" "$KEY" 2>&1)"
check "a builder key as an argument is refused" "grep -q 'Do not pass the builder key as an argument' <<<\"\$msg\""
check "the refusal does not echo the key" "! grep -q TESTSECRET <<<\"\$msg\""
bash "$HERE/deploy/try-install.sh" "$KEY" >/dev/null 2>&1
check "the refusal is a failure exit" "[ \$? -ne 0 ]"

# --builder-key-file feeds the key; the key itself is not an argument to anything.
printf '%s\n' "$KEY" >"$T/keyfile"
BUILDER_KEY=""
BUILDER_KEY_FILE="$T/keyfile"
PLATFORM="http://platform.test"
: >"$CURL_ARGV"
( ask_builder_key >/dev/null 2>&1 ) || true
check "no curl argument carries the key read from a file" "! grep -q TESTSECRET '$CURL_ARGV'"

# ── smoke.sh ─────────────────────────────────────────────────────────────────
: >"$CURL_ARGV"
: >"$CURL_STDIN"
ADMIN_KEY="dpmm_live_ad_TESTSECRETADMINKEY0123456789ab" BASE_URL=http://manager.test \
  bash "$HERE/scripts/smoke.sh" >/dev/null 2>&1
check "smoke.sh calls the API" "[ -s '$CURL_ARGV' ]"
check "smoke.sh sends the key on stdin" "grep -q 'X-API-Key: dpmm_live_ad_TESTSECRET' '$CURL_STDIN'"
check "smoke.sh puts no key on a curl command line" "! grep -q TESTSECRET '$CURL_ARGV'"

# A line break in the admin key must not start a second curl config line.
: >"$CURL_STDIN"
ADMIN_KEY="$(printf 'dpmm_live_ad_TESTSECRETX\nheader = "X-Evil: 1"')" BASE_URL=http://manager.test \
  bash "$HERE/scripts/smoke.sh" >/dev/null 2>&1
check "smoke.sh keeps an injected line break out of the curl config" "! grep -q '^header = \"X-Evil' '$CURL_STDIN'"

if [ "$fails" -eq 0 ]; then echo "all passed"; else echo "$fails failed"; exit 1; fi
