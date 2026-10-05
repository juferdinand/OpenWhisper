#!/usr/bin/env bash
# Erstellt ein komprimiertes Installations-Image mit App und Programme-Verknüpfung.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="build/WhisperFree.app"
DMG="build/WhisperFree-macOS.dmg"
[[ -d "$APP" ]] || { echo "Zuerst die App bauen" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/image"
ditto "$APP" "$TMP/image/WhisperFree.app"
ln -s /Applications "$TMP/image/Applications"
cp Resources/Install.txt "$TMP/image/Install.txt"

hdiutil create -quiet -volname "WhisperFree" -srcfolder "$TMP/image" -fs HFS+ -format UDZO -ov "$DMG"
codesign --force --timestamp=none --sign "${SIGN_IDENTITY:--}" "$DMG"
echo "✓ $DMG"
