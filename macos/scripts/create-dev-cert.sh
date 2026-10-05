#!/usr/bin/env bash
# Legt ein lokales, selbstsigniertes Code-Signing-Zertifikat "WhisperFree Dev" im Login-Schlüsselbund an.
#
# Warum: Ad-hoc-signierte Builds haben bei jedem Rebuild einen neuen Hash – macOS verwirft dann die
# Bedienungshilfen-Berechtigung. Mit einer festen Signatur-Identität bleibt sie über Rebuilds erhalten.
# build-app.sh verwendet das Zertifikat automatisch, sobald es existiert.
#
# Entfernen: Schlüsselbundverwaltung → "WhisperFree Dev" löschen.
set -euo pipefail

NAME="WhisperFree Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ Zertifikat \"$NAME\" existiert bereits"
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
# -legacy: macOS' security-Tool versteht die neueren PKCS12-Verschlüsselungen von OpenSSL 3 nicht.
LEGACY=""
openssl pkcs12 -help 2>&1 | grep -q -- "-legacy" && LEGACY="-legacy"
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/cert.p12" -passout pass:whisperfree

security import "$TMP/cert.p12" -k "$KEYCHAIN" -P whisperfree -T /usr/bin/codesign >/dev/null
echo "✓ Zertifikat \"$NAME\" angelegt"
