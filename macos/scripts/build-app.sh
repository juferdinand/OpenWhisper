#!/usr/bin/env bash
# Baut build/WhisperFree.app (Release) – nur mit den Xcode Command Line Tools, ohne Xcode.
#
#   SIGN_IDENTITY="Developer ID Application: …" scripts/build-app.sh   # Release mit Developer ID (+ Hardened Runtime)
#   scripts/build-app.sh   # nutzt "WhisperFree Dev" (scripts/create-dev-cert.sh), sonst Ad-hoc
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="WhisperFree"
APP="build/${APP_NAME}.app"
if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  IDENTITY="$SIGN_IDENTITY"
elif DEV_HASH="$(security find-identity -p codesigning 2>/dev/null | awk '/"WhisperFree Dev"/ {print $2; exit}')" && [[ -n "$DEV_HASH" ]]; then
  # Feste lokale Identität: Bedienungshilfen-Berechtigung überlebt Rebuilds.
  IDENTITY="$DEV_HASH"
else
  IDENTITY="-"
  echo "Hinweis: Ad-hoc-Signatur – nach jedem Rebuild Bedienungshilfen neu erteilen (oder scripts/create-dev-cert.sh ausführen)."
fi

scripts/fetch-whisper.sh

if [[ "${UNIVERSAL:-}" == "1" ]]; then
  # Beide Architekturen einzeln bauen und zusammenfügen – funktioniert auch ohne Xcode.
  BINARIES=()
  for ARCH in arm64 x86_64; do
    echo "→ swift build (release, $ARCH)"
    swift build -c release --product "$APP_NAME" --triple "$ARCH-apple-macosx14.0"
    BINARIES+=("$(swift build -c release --triple "$ARCH-apple-macosx14.0" --show-bin-path)/$APP_NAME")
  done
  BIN_DIR="build/universal"
  mkdir -p "$BIN_DIR"
  lipo -create "${BINARIES[@]}" -output "$BIN_DIR/$APP_NAME"
else
  echo "→ swift build (release)"
  swift build -c release --product "$APP_NAME"
  BIN_DIR="$(swift build -c release --show-bin-path)"
fi

echo "→ Bundle $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$BIN_DIR/$APP_NAME" "$APP/Contents/MacOS/"
cp Resources/Info.plist "$APP/Contents/"
VERSION="$(tr -d '[:space:]' < ../VERSION)"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(git rev-list --count HEAD 2>/dev/null || echo 1)" "$APP/Contents/Info.plist"
if [[ -n "${UPDATE_REPO:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :WFUpdateRepository $UPDATE_REPO" "$APP/Contents/Info.plist"
fi
[[ -f Resources/AppIcon.icns ]] && cp Resources/AppIcon.icns "$APP/Contents/Resources/"
cp ../shared/models.json "$APP/Contents/Resources/"
cp Resources/install-update.sh "$APP/Contents/Resources/"
cp -R Vendor/whisper.xcframework/macos-arm64_x86_64/whisper.framework "$APP/Contents/Frameworks/"

echo "→ codesign (${IDENTITY})"
SIGN_FLAGS=(--force --timestamp=none --sign "$IDENTITY")
if [[ "$IDENTITY" == Developer\ ID* ]]; then
  SIGN_FLAGS=(--force --options runtime --timestamp --sign "$IDENTITY" --entitlements Resources/WhisperFree.entitlements)
fi
codesign "${SIGN_FLAGS[@]}" "$APP/Contents/Frameworks/whisper.framework"
codesign "${SIGN_FLAGS[@]}" "$APP"

echo "✓ $APP ($VERSION)"
