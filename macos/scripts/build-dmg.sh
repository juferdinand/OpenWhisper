#!/usr/bin/env bash
# Creates a compressed installation image with the app and an Applications shortcut.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="build/OpenWhisper.app"
DMG="build/OpenWhisper-macOS.dmg"
[[ -d "$APP" ]] || { echo "Build the app first" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/image"
ditto "$APP" "$TMP/image/OpenWhisper.app"
ln -s /Applications "$TMP/image/Applications"
cp Resources/Install.txt "$TMP/image/Install.txt"

hdiutil create -quiet -volname "OpenWhisper" -srcfolder "$TMP/image" -fs HFS+ -format UDZO -ov "$DMG"
codesign --force --timestamp=none --sign "${SIGN_IDENTITY:--}" "$DMG"
echo "✓ $DMG"
