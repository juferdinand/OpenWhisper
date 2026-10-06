#!/usr/bin/env python3
"""Bounded fixture startup preflight. No model request, user data, or audio is involved."""
import argparse
import os
from pathlib import Path
import selectors
import subprocess
import sys
import time


def startup_line(process):
    deadline = time.monotonic() + 5
    line = bytearray()
    os.set_blocking(process.stdout.fileno(), False)
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        while len(line) < 16:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                raise TimeoutError("startup port deadline expired")
            chunk = os.read(process.stdout.fileno(), 16 - len(line))
            if not chunk:
                raise EOFError("fixture exited before its startup port")
            line.extend(chunk)
            if b"\n" in line:
                port = bytes(line).split(b"\n", 1)[0]
                if not port.isdigit() or not 1 <= int(port) <= 65535:
                    raise ValueError("fixture emitted an invalid startup port")
                return
    raise ValueError("fixture startup line exceeded its limit")


def check_fixture(fixture):
    process = None
    try:
        print(f"Owned fixture startup preflight: Python {sys.version.split()[0]}; executable={sys.executable}; fixture={fixture}", flush=True)
        if not fixture.is_file():
            raise FileNotFoundError(f"fixture script is missing: {fixture}")
        # Match the command and pipe arrangement used by the native Swift helpers.
        process = subprocess.Popen(
            ["/usr/bin/env", "python3", str(fixture), "--startup-diagnostics"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        startup_line(process)
        print(f"Owned fixture startup preflight passed: {fixture}; Python {sys.version.split()[0]}; synthetic loopback port only.")
    except Exception as error:
        status = "not launched" if process is None else process.poll()
        status = "running" if status is None else status
        detail = b""
        if process is not None:
            os.set_blocking(process.stderr.fileno(), False)
            try:
                detail = os.read(process.stderr.fileno(), 4096)
            except BlockingIOError:
                pass
        print(f"Owned fixture startup preflight failed: {error}; process={status}; stderr={detail.decode(errors='replace')!r}", file=sys.stderr)
        return 1
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)
            process.stdout.close()
            process.stderr.close()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=Path(__file__).resolve().with_name("local-processing-server.py"))
    args = parser.parse_args()
    raise SystemExit(check_fixture(args.fixture.resolve()))
