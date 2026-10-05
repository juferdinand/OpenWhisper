#!/usr/bin/env bash
# Exportiert das Signier-Zertifikat "WhisperFree Dev" (inkl. privatem Schlüssel) und hinterlegt es
# als GitHub-Secrets, damit die Release-Pipeline mit DERSELBEN Identität signiert wie lokale Builds.
# Nur so akzeptiert der In-App-Updater neue Versionen und Nutzer behalten ihre Berechtigungen.
#
#   scripts/export-dev-cert.sh <owner/repo>
#
# macOS fragt beim Export einmal nach dem Schlüsselbund-Passwort bzw. nach Erlaubnis.
set -euo pipefail

REPO="${1:?Aufruf: scripts/export-dev-cert.sh <owner/repo>}"
NAME="WhisperFree Dev"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASSWORD="$(openssl rand -base64 24)"
security export -k "$HOME/Library/Keychains/login.keychain-db" -t identities -f pkcs12 \
  -P "$PASSWORD" -o "$TMP/all.p12"

# Der Export enthält alle Identitäten – nur "WhisperFree Dev" behalten.
LEGACY=""
openssl pkcs12 -help 2>&1 | grep -q -- "-legacy" && LEGACY="-legacy"
openssl pkcs12 $LEGACY -in "$TMP/all.p12" -passin "pass:$PASSWORD" -nodes -out "$TMP/all.pem"
awk -v name="$NAME" '
  /friendlyName:/ { keep = index($0, name) > 0 }
  /^Bag Attributes/ { buffer = $0 "\n"; next }
  { if (keep || inblock) buffer = buffer $0 "\n" }
  /-----BEGIN/ { inblock = 1 }
  /-----END/ { if (keep) printf "%s", buffer; buffer = ""; inblock = 0 }
' "$TMP/all.pem" > "$TMP/dev.pem"

grep -q "PRIVATE KEY" "$TMP/dev.pem" || { echo "Privater Schlüssel für \"$NAME\" nicht gefunden"; exit 1; }
openssl pkcs12 -export $LEGACY -in "$TMP/dev.pem" -name "$NAME" -passout "pass:$PASSWORD" -out "$TMP/dev.p12"

base64 -i "$TMP/dev.p12" | gh secret set SIGNING_CERT_P12 --repo "$REPO"
printf '%s' "$PASSWORD" | gh secret set SIGNING_CERT_PASSWORD --repo "$REPO"
echo "✓ Secrets SIGNING_CERT_P12 und SIGNING_CERT_PASSWORD in $REPO gesetzt"
echo "  Tipp: Sichere das Zertifikat zusätzlich (Schlüsselbundverwaltung → \"$NAME\" → Exportieren)."
