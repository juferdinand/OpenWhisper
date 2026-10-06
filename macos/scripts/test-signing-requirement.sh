#!/usr/bin/env bash
# Regression test for implicit ad-hoc requirements in universal CI builds.
set -euo pipefail
APP="${1:?Usage: test-signing-requirement.sh <ad-hoc.app>}"
EXTRACT="$(dirname "$0")/extract-signing-requirement.swift"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
COPY="$TMP/OpenWhisper.app"

swift "$EXTRACT" "$APP" "$TMP/requirement.bin"
ditto "$APP" "$COPY"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"

# Tampering with sealed resources must prevent exporting the requirement.
printf '\n' >> "$COPY/Contents/Resources/models.json"
if swift "$EXTRACT" "$COPY" "$TMP/tampered.bin"; then
  echo "::error::Tampered original app was accepted" >&2
  exit 1
fi
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"; then
  echo "::error::Tampered copy was accepted" >&2
  exit 1
fi

# Even a validly re-signed copy with the same bundle ID must fail the
# original ad-hoc requirement (code hashes for all architectures).
codesign --force --timestamp=none --sign - "$COPY"
codesign --verify --all-architectures --deep --strict "$COPY"
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"; then
  echo "::error::Re-signed modification was accepted as the original" >&2
  exit 1
fi

codesign --remove-signature "$COPY"
if swift "$EXTRACT" "$COPY" "$TMP/unsigned.bin"; then
  echo "::error::Unsigned app was accepted" >&2
  exit 1
fi
echo "✓ Ad-hoc requirement accepts the original copy and rejects tampered, re-signed, and unsigned code"
