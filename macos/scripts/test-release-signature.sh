#!/usr/bin/env bash
# Tests the actual release identity without exporting its private key.
set -euo pipefail

APP="${1:?Usage: test-release-signature.sh <WhisperFree.app>}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swift "$(dirname "$0")/extract-signing-requirement.swift" "$APP" "$TMP/requirement.bin"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$APP"

# The same bundle ID and contents with a different (ad-hoc) signature must be rejected.
cp -R "$APP" "$TMP/WhisperFree.app"
codesign --force --sign - "$TMP/WhisperFree.app/Contents/Frameworks/whisper.framework"
codesign --force --sign - "$TMP/WhisperFree.app"
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$TMP/WhisperFree.app"; then
  echo "::error::Release requirement accepted a different signing identity" >&2
  exit 1
fi
echo "✓ Release signature accepted; different signature with the same bundle ID rejected"
