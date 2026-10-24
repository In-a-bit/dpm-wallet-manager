#!/bin/sh
# Prints the commands that create the release signing key and put it to use. It runs none of them:
# read them, then run each yourself, on a machine you trust.
#
# Releases are signed: build_and_push.yml signs the release's SHA256SUMS with the private key
# (GitHub secret RELEASE_SIGNING_KEY), and install.sh, install.ps1 and dpm-custody check that
# signature against the public key embedded in them. Until the real public key is embedded they
# carry a placeholder that no signature can match, so no release can be installed.
cat <<'EOF'
# 1. Create the key pair (ECDSA P-256). Keep release-signing-key.pem private; never commit it.
umask 077
openssl ecparam -name prime256v1 -genkey -noout -out release-signing-key.pem
openssl pkey -in release-signing-key.pem -pubout -out release-signing-key.pub

# 2. Store the private key as the repository secret the release workflow signs with.
gh secret set RELEASE_SIGNING_KEY --repo In-a-bit/dpm-wallet-manager < release-signing-key.pem

# 3. Embed the public key in install.sh, install.ps1 and dpm-custody (replaces the placeholder),
#    then review the diff and commit it.
sh scripts/embed-release-key.sh release-signing-key.pub
git diff --stat deploy

# 4. Back up release-signing-key.pem somewhere offline (a password manager), then delete the
#    local copy. Losing it means a new key and a new embedded public key; installs made with the
#    old installer must then re-run the installer once to learn the new key.
#    Rotating a leaked key is the same steps with a new pair, and a release that carries the new
#    scripts; installs still holding the old key cannot verify it, so announce the reinstall.
EOF
