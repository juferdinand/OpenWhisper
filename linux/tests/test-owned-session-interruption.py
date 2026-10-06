#!/usr/bin/env python3
"""Interrupt the owned harness during virtual-source capture and verify complete cleanup."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time


def child_groups(parent_pid):
    processes = {}
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = stat.read_text().rsplit(") ", 1)[1].split()
            processes[int(stat.parent.name)] = (int(fields[1]), int(fields[2]))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    owned = {parent_pid}
    while True:
        children = {pid for pid, (parent, _group) in processes.items() if parent in owned}
        if children <= owned:
            break
        owned |= children
    return {processes[pid][1] for pid in owned if pid in processes}


def group_exists(group):
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=root / "linux/target/release/openwhisper-desktop")
    parser.add_argument("--model", type=Path, default=root / "linux/target/speech-smoke/ggml-tiny.bin")
    parser.add_argument("--fixture", type=Path, default=root / "linux/vendor/whisper.cpp/samples/jfk.wav")
    parser.add_argument("--output", type=Path, help="New directory for interruption evidence")
    args = parser.parse_args()
    evidence = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="openwhisper-interruption-"))
    if args.output:
        evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    print("Interruption evidence:", evidence, flush=True)
    for signum in [signal.SIGTERM, signal.SIGINT]:
        session = evidence / signum.name.lower()
        command = [sys.executable, str(root / "linux/scripts/run-owned-desktop.py"),
                   "--session", "x11", "--output", str(session), "--",
                   sys.executable, str(root / "linux/scripts/test-session.py"), "--owned",
                   "--binary", str(args.binary.resolve()), "--model", str(args.model.resolve()),
                   "--fixture", str(args.fixture.resolve())]
        groups = set()
        cleanup_verified = False
        with (evidence / (signum.name.lower() + ".log")).open("w") as log:
            process = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
            try:
                deadline = time.monotonic() + 40
                capture = session / "command.log"
                while not capture.is_file() or "floating overlay appears" not in capture.read_text():
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Owned capture did not start before interruption")
                    time.sleep(0.1)
                groups = child_groups(process.pid)
                assert len(groups) >= 7, "Owned service/application groups were not found"
                process.send_signal(signum)  # Interrupt only the harness, not its child groups.
                assert process.wait(timeout=35) == 128 + signum, "Harness lost the interruption exit code"
                run = json.loads((session / "run.json").read_text())
                assert run["exit_code"] == 128 + signum, "Evidence lost the interruption exit code"
                runtime = Path((session / "runtime-path.txt").read_text().strip())
                assert not runtime.exists(), "Private runtime survived harness interruption"
                deadline = time.monotonic() + 5
                while any(group_exists(group) for group in groups) and time.monotonic() < deadline:
                    time.sleep(0.1)
                assert not any(group_exists(group) for group in groups), "Owned app/service group survived interruption"
                cleanup_verified = True
                print(f"PASS: {signum.name} exits {128 + signum}; app/service groups and runtime are gone", flush=True)
            finally:
                if process.poll() is None:
                    groups |= child_groups(process.pid)
                    process.terminate()
                    try:
                        process.wait(timeout=35)
                    except subprocess.TimeoutExpired:
                        groups |= child_groups(process.pid)
                # This regression owns every recorded group, including its independent app group.
                if not cleanup_verified:
                    for group in groups:
                        try:
                            os.killpg(group, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                if process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    main()
