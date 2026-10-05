#!/usr/bin/env bash
# Überträgt genau eine zuvor exportierte Signieridentität in die GitHub-Secrets.
# In der Schlüsselbundverwaltung nur das gewünschte Zertifikat MIT privatem Schlüssel
# markieren und als verschlüsselte .p12-Datei exportieren. Niemals alle Identitäten exportieren.
# Die bestehende Release-Identität nicht durch ein neu erzeugtes Zertifikat ersetzen.
#
#   scripts/export-dev-cert.sh <owner/repo> <identity.p12>
set -euo pipefail
set +x
umask 077

REPO="${1:?Aufruf: scripts/export-dev-cert.sh <owner/repo> <identity.p12>}"
P12="${2:?Bitte genau die gewünschte Identität in der Schlüsselbundverwaltung als .p12 exportieren}"
[[ -f "$P12" ]] || { echo "PKCS#12-Datei nicht gefunden" >&2; exit 1; }
read -r -s -p "Passwort der PKCS#12-Datei: " PASSWORD
printf '\n'
[[ -n "$PASSWORD" ]] || { echo "Ein verschlüsselter Export mit Passwort ist erforderlich" >&2; exit 1; }
trap 'unset PASSWORD' EXIT

LEGACY=()
if openssl pkcs12 -help 2>&1 | /usr/bin/grep -- '-legacy' >/dev/null; then LEGACY=(-legacy); fi
# Der entschlüsselte Schlüssel fließt nur durch eine Pipe, nie in eine Datei oder ins Terminal.
# Das Passwort wird über einen Dateideskriptor statt als Prozessargument übergeben.
openssl pkcs12 "${LEGACY[@]}" -in "$P12" -passin fd:3 -nocerts -nodes 3<<< "$PASSWORD" |
  awk '/-----BEGIN .*PRIVATE KEY-----/ { count++ } END { exit count != 1 }'

base64 < "$P12" | gh secret set SIGNING_CERT_P12 --repo "$REPO"
printf '%s' "$PASSWORD" | gh secret set SIGNING_CERT_PASSWORD --repo "$REPO"
echo "✓ Signier-Secrets in $REPO gesetzt; verschlüsseltes Backup sicher aufbewahren."
