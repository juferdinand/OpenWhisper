#!/usr/bin/env bash
# Prüft das fertige Image und seine unverändert signierte App auf einem macOS-Runner.
set -euo pipefail
DMG="${1:?Aufruf: verify-dmg.sh <image.dmg> <original.app>}"
APP="${2:?Original-App fehlt}"
TMP="$(mktemp -d)"
MOUNT="$TMP/mount"
MOUNTED=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$MOUNTED" == 1 ]]; then
    if ! hdiutil detach "$MOUNT" -quiet; then
      echo "Test-Image konnte nicht ausgehängt werden: $MOUNT" >&2
      exit 1
    fi
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

hdiutil verify "$DMG"
codesign --verify --strict --verbose=2 "$DMG"
mkdir "$MOUNT"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT" "$DMG"
MOUNTED=1
[[ "$(readlink "$MOUNT/Applications")" == /Applications ]]
[[ -f "$MOUNT/Install.txt" ]]
swift "$(dirname "$0")/extract-signing-requirement.swift" "$APP" "$TMP/requirement.bin"
codesign --verify --all-architectures --deep --strict -R "$TMP/requirement.bin" "$MOUNT/WhisperFree.app"
cmp "$APP/Contents/MacOS/WhisperFree" "$MOUNT/WhisperFree.app/Contents/MacOS/WhisperFree"
cmp "$APP/Contents/Info.plist" "$MOUNT/WhisperFree.app/Contents/Info.plist"
echo "✓ DMG, Programme-Verknüpfung und enthaltene App geprüft"
