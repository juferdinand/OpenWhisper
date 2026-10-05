#!/usr/bin/env bash
# Regression für implizite Ad-hoc-Anforderungen universeller CI-Builds.
set -euo pipefail
APP="${1:?Aufruf: test-signing-requirement.sh <ad-hoc.app>}"
EXTRACT="$(dirname "$0")/extract-signing-requirement.swift"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
COPY="$TMP/WhisperFree.app"

swift "$EXTRACT" "$APP" "$TMP/requirement.bin"
ditto "$APP" "$COPY"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"

# Manipulation versiegelter Ressourcen muss bereits den Export verhindern.
printf '\n' >> "$COPY/Contents/Resources/models.json"
if swift "$EXTRACT" "$COPY" "$TMP/tampered.bin"; then
  echo "::error::Manipulierte Original-App wurde akzeptiert" >&2
  exit 1
fi
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"; then
  echo "::error::Manipulierte Kopie wurde akzeptiert" >&2
  exit 1
fi

# Auch eine gültig neu signierte Kopie mit gleicher Bundle-ID muss an der
# ursprünglichen Ad-hoc-Anforderung (Code-Hashes aller Architekturen) scheitern.
codesign --force --timestamp=none --sign - "$COPY"
codesign --verify --all-architectures --deep --strict "$COPY"
if codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$COPY"; then
  echo "::error::Neu signierte Änderung wurde als Original akzeptiert" >&2
  exit 1
fi

codesign --remove-signature "$COPY"
if swift "$EXTRACT" "$COPY" "$TMP/unsigned.bin"; then
  echo "::error::Unsignierte App wurde akzeptiert" >&2
  exit 1
fi
echo "✓ Ad-hoc-Anforderung akzeptiert die Originalkopie und weist manipulierten, neu signierten und unsignierten Code ab"
