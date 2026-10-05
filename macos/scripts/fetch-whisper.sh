#!/usr/bin/env bash
# Downloads the prebuilt whisper.cpp XCFramework (MIT) to Vendor/ if missing.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="b5130"
SHA256="033a43b0174e8cf9b366f72e4a428cdcf126f93ad1c87d3fa119a96bed6f231a"
URL="https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}/whisper-${VERSION}-xcframework.zip"
DEST="Vendor/whisper.xcframework"

if [[ -d "$DEST" ]]; then
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Downloading whisper.cpp ${VERSION} XCFramework …"
curl -fL --progress-bar -o "$TMP/whisper.zip" "$URL"
echo "${SHA256}  $TMP/whisper.zip" | shasum -a 256 -c - >/dev/null
unzip -q "$TMP/whisper.zip" -d "$TMP"
mkdir -p Vendor
mv "$TMP/build-apple/whisper.xcframework" "$DEST"
echo "✓ $DEST"
