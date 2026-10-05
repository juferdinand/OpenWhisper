#!/usr/bin/env bash
# Prüft die tatsächliche Release-Identität ohne den privaten Schlüssel zu exportieren.
set -euo pipefail

APP="${1:?Aufruf: test-release-signature.sh <WhisperFree.app>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swift "$(dirname "$0")/extract-signing-requirement.swift" "$APP" "$TMP/requirement.bin"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$APP"

# Gleiche Bundle-ID und gleicher Inhalt, aber eine andere (Ad-hoc-)Signatur müssen scheitern.
cp -R "$APP" "$TMP/WhisperFree.app"
codesign --force --sign - "$TMP/WhisperFree.app/Contents/Frameworks/whisper.framework"
codesign --force --sign - "$TMP/WhisperFree.app"
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$TMP/WhisperFree.app"; then
  echo "::error::Release-Anforderung akzeptiert eine fremde Signatur" >&2
  exit 1
fi
echo "✓ Release-Signatur akzeptiert; fremde Signatur mit gleicher Bundle-ID abgewiesen"
