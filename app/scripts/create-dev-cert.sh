#!/usr/bin/env bash
# Creates a local self-signed code-signing certificate, "WhisperFree Dev", in the login keychain.
#
# Ad-hoc builds get a new hash on rebuild, which can cause macOS to discard
# Accessibility permission. A persistent signing identity preserves it across rebuilds.
# build-app.sh automatically uses the certificate when available.
#
# To remove: delete "WhisperFree Dev" in Keychain Access.
set -euo pipefail

NAME="WhisperFree Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ Certificate \"$NAME\" already exists"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" >/dev/null 2>&1
# -legacy: macOS security does not support newer OpenSSL 3 PKCS#12 encryption.
LEGACY=""
openssl pkcs12 -help 2>&1 | grep -q -- "-legacy" && LEGACY="-legacy"
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/cert.p12" -passout pass:whisperfree

security import "$TMP/cert.p12" -k "$KEYCHAIN" -P whisperfree -T /usr/bin/codesign >/dev/null
echo "✓ Created certificate \"$NAME\""
