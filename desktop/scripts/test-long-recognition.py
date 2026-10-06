#!/usr/bin/env python3
"""Exercise isolated, adaptive inference with seven minutes of public fixture audio.

Never opens a microphone, desktop, clipboard, or the user's application data.
"""
import argparse
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, default=root / "desktop/target/release/openwhisper-desktop")
parser.add_argument("--tiny", type=Path, required=True)
parser.add_argument("--parakeet", type=Path, required=True)
parser.add_argument("--gpu", action="store_true", help="Also verify GPU inference on this host")
args = parser.parse_args()
for path in [args.binary, args.tiny, args.parakeet]:
    if not path.is_file():
        parser.error(f"Missing file: {path}")

with tempfile.TemporaryDirectory(prefix="openwhisper-long-recognition-") as directory:
    work = Path(directory)
    fixture = work / "jfk.f32"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i",
                    str(root / "desktop/vendor/whisper.cpp/samples/jfk.wav"),
                    "-f", "f32le", "-ar", "16000", "-ac", "1", str(fixture)], check=True)
    speech = fixture.read_bytes()
    assert len(speech) < 15 * 16000 * 4
    # Each utterance has a pause, giving the boundary search natural places to split.
    recording = work / "seven-minutes.f32"
    recording.write_bytes((speech + bytes(15 * 16000 * 4 - len(speech))) * 28)
    for backend in ["cpu"] + (["gpu"] if args.gpu else []):
        for model_id, model in [("tiny", args.tiny), ("parakeet-v3-q4", args.parakeet)]:
            command = [str(args.binary.resolve()), "--transcription-smoke-test", model_id,
                       str(model.resolve()), str(recording), backend]
            subprocess.run(command, check=True, timeout=300)
            transcript = recording.with_suffix(".txt").read_text()
            assert transcript.lower().count("country") >= 54, "Speech missing near the end or at boundaries"
            assert not recording.with_suffix(".recovery").exists(), "Successful inference left temporary audio"
            print(f"PASS: seven-minute {model_id} recording on {backend}", flush=True)

    # Kill only our own speech child, using a pidfd so PID reuse cannot target another process.
    process = subprocess.Popen([str(args.binary.resolve()), "--transcription-smoke-test",
                                "parakeet-v3-q4", str(args.parakeet.resolve()), str(recording), "cpu"])
    killed = False
    try:
        deadline = time.monotonic() + 30
        while process.poll() is None and time.monotonic() < deadline:
            children = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().split()
            for child in children:
                try:
                    with open(f"/proc/{child}/cmdline", "rb") as command_line:
                        if b"--linux-speech-helper" not in command_line.read():
                            continue
                    descriptor = os.pidfd_open(int(child))
                    try:
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                        killed = True
                    finally:
                        os.close(descriptor)
                except ProcessLookupError:
                    continue
                break
            if killed:
                break
            time.sleep(0.01)
        assert killed, "Owned speech process did not appear"
        assert process.wait(timeout=300) == 0, "Parent failed to recover from speech process death"
        assert recording.with_suffix(".txt").read_text().lower().count("country") >= 54
        print("PASS: parent survived speech process SIGKILL and finished the complete recording", flush=True)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=10)
