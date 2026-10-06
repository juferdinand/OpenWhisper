#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$ROOT/native/whisper-source.json"
REVISION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["revision"])' "$PIN")"
SHA256="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha256"])' "$PIN")"
DEST="$ROOT/vendor/whisper.cpp"
if [[ -f "$DEST/.source-revision" ]] && [[ "$(cat "$DEST/.source-revision")" == "$REVISION" ]]; then exit 0; fi
mkdir -p "$ROOT/vendor"
TMP="$(mktemp -d "$ROOT/vendor/.download.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --retry 2 \
  "https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/$REVISION" -o "$TMP/source.tar.gz"
printf '%s  %s\n' "$SHA256" "$TMP/source.tar.gz" | sha256sum -c -
mkdir "$TMP/source"
tar -xzf "$TMP/source.tar.gz" -C "$TMP/source" --strip-components=1 --no-same-owner
printf '%s\n' "$REVISION" > "$TMP/source/.source-revision"
if [[ -e "$DEST" ]]; then
  echo "Existing native source has a different revision. Remove desktop/vendor/whisper.cpp and retry." >&2
  exit 1
fi
mv "$TMP/source" "$DEST"
echo "Native speech source is ready ($REVISION)."
