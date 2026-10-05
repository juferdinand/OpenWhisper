#!/usr/bin/env bash
# Uploads exactly one previously exported signing identity to GitHub secrets.
# In Keychain Access, select only the intended certificate WITH its private key
# and export it as an encrypted .p12 file. Never export all identities.
# Do not replace the existing release identity with a newly generated certificate.
#
#   scripts/export-dev-cert.sh <owner/repo> <identity.p12>
set -euo pipefail
set +x
umask 077

REPO="${1:?Usage: scripts/export-dev-cert.sh <owner/repo> <identity.p12>}"
P12="${2:?Export only the intended identity from Keychain Access as a .p12 file}"
[[ -f "$P12" ]] || { echo "PKCS#12 file not found" >&2; exit 1; }
read -r -s -p "PKCS#12 file password: " PASSWORD
printf '\n'
[[ -n "$PASSWORD" ]] || { echo "A password-protected encrypted export is required" >&2; exit 1; }
trap 'unset PASSWORD' EXIT

LEGACY=""
if openssl pkcs12 -help 2>&1 | /usr/bin/grep -- '-legacy' >/dev/null; then LEGACY=1; fi
# The decrypted key passes through a pipe, never a file or terminal output.
# Pass the password through a file descriptor, not a process argument.
openssl pkcs12 ${LEGACY:+-legacy} -in "$P12" -passin fd:3 -nocerts -nodes 3<<< "$PASSWORD" |
  awk '/-----BEGIN .*PRIVATE KEY-----/ { count++ } END { exit count != 1 }'

base64 < "$P12" | gh secret set SIGNING_CERT_P12 --repo "$REPO"
printf '%s' "$PASSWORD" | gh secret set SIGNING_CERT_PASSWORD --repo "$REPO"
echo "✓ Signing secrets set in $REPO; keep the encrypted backup safe."
