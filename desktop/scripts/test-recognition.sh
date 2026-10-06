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
cargo run --locked --manifest-path "$ROOT/Cargo.toml" -p openwhisper-speech --example transcribe "$@" -- \
  "$MODEL" "$TEST/jfk.f32" whisper en gpu > "$TEST/transcript.txt"
[[ "$(grep -ic 'country' "$TEST/transcript.txt")" -eq 2 ]] || { echo "Repeated recognition smoke test failed." >&2; exit 1; }
echo "Whisper recognized the known fixture twice using one loaded context."
