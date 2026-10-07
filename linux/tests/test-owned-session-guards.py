#!/usr/bin/env python3
"""Check that unsafe acceptance-test combinations stop before desktop/audio calls."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class OwnedSessionGuards(unittest.TestCase):
    def test_unowned_and_portal_combinations_stop_before_external_calls(self):
        script = Path(__file__).resolve().parents[1] / "scripts/test-session.py"
        with tempfile.TemporaryDirectory(prefix="openwhisper-guard-test-") as temporary:
            root = Path(temporary)
            spies = root / "bin"
            spies.mkdir()
            marker = root / "unexpected-call"
            # A failed guard cannot accidentally fall through into a live D-Bus/audio call.
            for command in ["gdbus", "pactl", "paplay", "wl-paste", "xclip", "qdbus6"]:
                executable = spies / command
                executable.write_text('#!/bin/sh\n: > "$WF_GUARD_MARKER"\nexit 99\n')
                executable.chmod(0o700)
            fixture = root / "fixture"
            fixture.touch()
            environment = {key: value for key, value in os.environ.items() if not key.startswith(
                ("PULSE_", "PIPEWIRE_", "DBUS_", "AT_SPI_", "WF_OWNED_")
            ) and key not in ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET"]}
            environment.update(
                HOME=str(root), XDG_CONFIG_HOME=str(root / "config"),
                XDG_DATA_HOME=str(root / "data"), XDG_RUNTIME_DIR=str(root / "runtime"),
                PATH=str(spies) + os.pathsep + environment.get("PATH", ""),
                WF_GUARD_MARKER=str(marker),
            )
            base = [sys.executable, str(script), "--binary", str(fixture),
                    "--model", str(fixture), "--fixture", str(fixture)]
            cases = [
                (["--owned"], {}, "--owned requires run-owned-desktop.py"),
                (["--recovery"], {}, "--recovery requires --owned"),
                (["--expect-no-overlay"], {}, "Fallback capability assertions require --owned"),
                (["--expect-no-portals"], {}, "Fallback capability assertions require --owned"),
                (["--expect-clipboard-unavailable"], {}, "--expect-clipboard-unavailable requires an owned Wayland session"),
                (["--owned", "--expect-clipboard-unavailable"], {
                    "WF_OWNED_DESKTOP_TEST": environment["XDG_RUNTIME_DIR"],
                    "PULSE_SERVER": "unix:" + str(root / "runtime/pulse/native"),
                }, "--expect-clipboard-unavailable requires an owned Wayland session"),
                (["--owned", "--recovery", "--expect-clipboard-unavailable"], {
                    "WF_OWNED_DESKTOP_TEST": environment["XDG_RUNTIME_DIR"],
                    "PULSE_SERVER": "unix:" + str(root / "runtime/pulse/native"),
                    "WAYLAND_DISPLAY": "private-unused-test-socket",
                }, "--expect-clipboard-unavailable requires an owned Wayland session"),
                (["--owned", "--portals"], {
                    "WF_OWNED_DESKTOP_TEST": environment["XDG_RUNTIME_DIR"],
                    "PULSE_SERVER": "unix:" + str(root / "runtime/pulse/native"),
                }, "Owned sessions do not include permission-portal acceptance"),
            ]
            for arguments, extra, message in cases:
                with self.subTest(arguments=arguments):
                    result = subprocess.run(base + arguments, env=environment | extra,
                                            capture_output=True, text=True, timeout=15)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn(message, result.stderr)
                    self.assertFalse(marker.exists(), "Guard invoked desktop/audio tools")


if __name__ == "__main__":
    unittest.main()
