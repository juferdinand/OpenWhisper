#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST="$ROOT/target/speech-smoke"
mkdir -p "$TEST"
MODEL="$TEST/ggml-tiny.bin"
HASH=be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21
if ! [[ -f "$MODEL" ]] || ! printf '%s  %s\n' "$HASH" "$MODEL" | sha256sum -c - >/dev/null; then
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin -o "$MODEL.part"
  printf '%s  %s\n' "$HASH" "$MODEL.part" | sha256sum -c -
  mv "$MODEL.part" "$MODEL"
fi
ffmpeg -hide_banner -loglevel error -y -i "$ROOT/vendor/whisper.cpp/samples/jfk.wav" \
  -f f32le -ar 16000 -ac 1 "$TEST/jfk.f32"
RELEASE=false
for arg in "$@"; do
  if [[ "$arg" == --release ]]; then RELEASE=true; fi
done
if [[ "$RELEASE" == true ]]; then
  # Resolve build dependencies with the packaged desktop's feature graph.
  BUILD=$(mktemp "$TEST/build.XXXXXX")
  trap 'rm -f "$BUILD"' EXIT
  cargo build --locked --manifest-path "$ROOT/Cargo.toml" \
    -p openwhisper-desktop -p openwhisper-speech --example transcribe \
    --message-format=json-render-diagnostics "$@" > "$BUILD"
  PROBE=$(python3 - "$BUILD" "$ROOT/crates/speech/examples/transcribe.rs" <<'PYTHON'
import json
from pathlib import Path
import sys

messages = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
source = Path(sys.argv[2]).resolve()
probes = []
for message in messages:
    if message.get("reason") != "compiler-artifact":
        continue
    target = message.get("target", {})
    if (target.get("name") == "transcribe" and "example" in target.get("kind", [])
            and Path(target.get("src_path", "")).resolve() == source
            and message.get("executable")):
        probes.append(Path(message["executable"]))
if (len(probes) != 1 or not probes[0].is_file()
        or not probes[0].stat().st_mode & 0o111
        or not any(message.get("reason") == "build-finished" and message.get("success") is True
                   for message in messages)):
    raise SystemExit("Cargo did not produce one executable recognition probe in this build.")
print(probes[0].resolve())
PYTHON
  )
  "$PROBE" "$MODEL" "$TEST/jfk.f32" whisper en gpu > "$TEST/transcript.txt"
else
  cargo run --locked --manifest-path "$ROOT/Cargo.toml" -p openwhisper-speech --example transcribe "$@" -- \
    "$MODEL" "$TEST/jfk.f32" whisper en gpu > "$TEST/transcript.txt"
fi
[[ "$(grep -ic 'country' "$TEST/transcript.txt")" -eq 2 ]] || { echo "Repeated recognition smoke test failed." >&2; exit 1; }
echo "Whisper recognized the known fixture twice using one loaded context."
