#!/usr/bin/env bash
# Tests the actual release identity without exporting its private key.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: test-release-signature.sh <candidate.app> [<original.app>]" >&2
  exit 1
fi
APP="$1"
ORIGINAL="${2:-$APP}"
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swift "$(dirname "$0")/extract-signing-requirement.swift" "$ORIGINAL" "$TMP/requirement.bin"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$APP"

# The same bundle ID and contents with a different (ad-hoc) signature must be rejected.
cp -R "$APP" "$TMP/OpenWhisper.app"
codesign --force --sign - --timestamp=none "$TMP/OpenWhisper.app"
codesign --verify --all-architectures --deep --strict "$TMP/OpenWhisper.app"
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$TMP/OpenWhisper.app"; then
  echo "::error::Release requirement accepted a different signing identity" >&2
  exit 1
fi
printf '%s\n' '{"status":"PASS","originalRequirement":"ACCEPTED","validSameIdDifferentPublisher":"REJECTED","flags":"all-architectures,nested-code,strict-resources","scope":"Publisher continuity only; no install or handoff acceptance"}'
