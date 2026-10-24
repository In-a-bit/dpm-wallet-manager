#!/bin/sh
# Usage: sh scripts/embed-release-key.sh PUBLIC_KEY.pem
# Replaces the release public key (the block between the ">>> release public key" markers) in
# deploy/install.sh, deploy/install.ps1 and deploy/dpm-custody, and clears the placeholder flag.
set -eu
KEY_FILE="${1:?usage: sh scripts/embed-release-key.sh PUBLIC_KEY.pem}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="${DEPLOY_DIR:-$HERE/deploy}"
openssl pkey -pubin -in "$KEY_FILE" -noout 2>/dev/null || { echo "$KEY_FILE is not a public key." >&2; exit 1; }
openssl pkey -pubin -in "$KEY_FILE" -text -noout 2>/dev/null | grep -q 'prime256v1\|P-256' ||
  { echo "$KEY_FILE is not a P-256 key." >&2; exit 1; }
PEM="$(openssl pkey -pubin -in "$KEY_FILE" -pubout)"

embed() { # FILE FLAVOUR(sh|ps1)
  awk -v pem="$PEM" -v flavour="$2" '
    /^# >>> release public key >>>$/ {
      print
      print "# Embedded by scripts/embed-release-key.sh. To rotate, run that script again."
      if (flavour == "sh") { print "RELEASE_KEY_IS_PLACEHOLDER=0"; print "RELEASE_PUBKEY=\x27" pem "\x27" }
      else { print "$ReleaseKeyIsPlaceholder = $false"; print "$ReleasePubKey = @\x27"; print pem; print "\x27@" }
      skip = 1; next
    }
    /^# <<< release public key <<<$/ { skip = 0 }
    !skip { print }
  ' "$1" >"$1.tmp" && cat "$1.tmp" >"$1" && rm -f "$1.tmp"
}

embed "$DEPLOY/install.sh" sh
embed "$DEPLOY/dpm-custody" sh
embed "$DEPLOY/install.ps1" ps1
echo "Embedded the public key in install.sh, install.ps1 and dpm-custody under $DEPLOY."
