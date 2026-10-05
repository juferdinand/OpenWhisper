#!/usr/bin/env bash
# Prüft die tatsächliche Release-Identität ohne den privaten Schlüssel zu exportieren.
set -euo pipefail

APP="${1:?Aufruf: test-release-signature.sh <WhisperFree.app>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REQUIREMENT="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
[[ -n "$REQUIREMENT" ]] || { echo "Signaturanforderung fehlt" >&2; exit 1; }
codesign --verify --deep --strict -R "$REQUIREMENT" "$APP"

# Gleiche Bundle-ID und gleicher Inhalt, aber eine andere (Ad-hoc-)Signatur müssen scheitern.
cp -R "$APP" "$TMP/WhisperFree.app"
codesign --force --sign - "$TMP/WhisperFree.app/Contents/Frameworks/whisper.framework"
codesign --force --sign - "$TMP/WhisperFree.app"
if codesign --verify --deep --strict -R "$REQUIREMENT" "$TMP/WhisperFree.app"; then
  echo "::error::Release-Anforderung akzeptiert eine fremde Signatur" >&2
  exit 1
fi
echo "✓ Release-Signatur akzeptiert; fremde Signatur mit gleicher Bundle-ID abgewiesen"
