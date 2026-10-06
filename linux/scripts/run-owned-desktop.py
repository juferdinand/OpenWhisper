#!/usr/bin/env python3
"""Run a command in an owned X11 or nested KWin session with private audio and D-Bus.

Requires Xvfb, PipeWire/PulseAudio compatibility, WirePlumber 0.5+, Python
PyGObject, and AT-SPI. KWin is required only for kde-wayland. No physical audio
devices, live desktop input, user configuration, or user clipboard are used.
Logs and disposable configuration remain in the printed output directory.
"""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time


def accessibility_router(address):
    from gi.repository import Gio, GLib

    interface = Gio.DBusNodeInfo.new_for_xml(
        '<node><interface name="org.a11y.Bus"><method name="GetAddress">'
        '<arg name="address" type="s" direction="out"/>'
        '</method></interface></node>'
    ).interfaces[0]
    status = Gio.DBusNodeInfo.new_for_xml(
        '<node><interface name="org.a11y.Status">'
        '<property name="IsEnabled" type="b" access="read"/>'
        '<property name="ScreenReaderEnabled" type="b" access="read"/>'
        '</interface></node>'
    ).interfaces[0]

    def acquired(connection, _name):
        connection.register_object(
            "/org/a11y/bus", interface,
            lambda _c, _s, _p, _i, _n, _v, invocation:
                invocation.return_value(GLib.Variant("(s)", (address,))),
            None, None,
        )
        connection.register_object(
            "/org/a11y/status", status, None,
            lambda *_args: GLib.Variant("b", True), None,
        )

    Gio.bus_own_name(
        Gio.BusType.SESSION, "org.a11y.Bus", Gio.BusNameOwnerFlags.NONE,
        acquired, lambda *_args: print("READY", flush=True),
        lambda *_args: sys.exit(1),
    )
    GLib.MainLoop().run()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session", choices=["x11", "kde-wayland"], required=True)
    parser.add_argument("--output", type=Path, help="New directory for private logs/configuration")
    parser.add_argument("--timeout", type=int, default=360, help="Command timeout in seconds")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.timeout < 1:
        parser.error("Supply a command after -- and a positive timeout")
    for name in ["Xvfb", "dbus-daemon", "pipewire", "pipewire-pulse", "wireplumber", "pactl"] + (
        ["kwin_wayland"] if args.session == "kde-wayland" else []
    ):
        if not shutil.which(name):
            parser.error("Missing dependency: " + name)
    root = args.output.resolve() if args.output else Path(tempfile.mkdtemp(prefix="openwhisper-owned-"))
    if args.output:
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
    else:
        root.chmod(0o700)
    print("Owned session evidence:", root, flush=True)
    metadata = {
        "session": args.session, "command": command, "timeout_seconds": args.timeout,
        "started_utc": datetime.now(timezone.utc).isoformat(),
    }
    (root / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")
    env = os.environ.copy()
    for key in list(env):
        if key.startswith(("PULSE_", "PIPEWIRE_", "WIREPLUMBER_", "ALSA_", "DBUS_", "AT_SPI_")):
            env.pop(key)
    for key in [
        "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "AT_SPI_BUS_ADDRESS",
        "ALSA_CONFIG_PATH", "PULSE_SERVER", "PULSE_COOKIE", "PIPEWIRE_REMOTE",
        "PIPEWIRE_RUNTIME_DIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "QT_QPA_PLATFORM",
        "NO_AT_BRIDGE", "SESSION_MANAGER", "XAUTHORITY", "WAYLAND_SOCKET",
        "XDG_SESSION_ID", "XDG_SEAT", "XDG_VTNR", "DESKTOP_STARTUP_ID",
    ]:
        env.pop(key, None)
    for key, name in [
        ("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
        ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"),
    ]:
        (root / name).mkdir(mode=0o700)
        env[key] = str(root / name)
    # Unix socket names have a short fixed limit; evidence paths can be much longer.
    runtime = Path(tempfile.mkdtemp(prefix="ow-runtime-"))
    env["XDG_RUNTIME_DIR"] = str(runtime)
    (root / "runtime-path.txt").write_text(str(runtime) + "\n")
    env.update(
        DBUS_SYSTEM_BUS_ADDRESS="unix:path=" + str(runtime / "no-system-bus"),
        WF_OWNED_DESKTOP_TEST=str(runtime),
        PIPEWIRE_RUNTIME_DIR=str(runtime), PIPEWIRE_REMOTE="pipewire-0",
        PULSE_SERVER="unix:" + str(runtime / "pulse/native"),
        XDG_SESSION_TYPE="wayland" if args.session == "kde-wayland" else "x11",
        XDG_CURRENT_DESKTOP="KDE" if args.session == "kde-wayland" else "OpenWhisperTest",
        GDK_BACKEND="wayland" if args.session == "kde-wayland" else "x11",
        GTK_USE_PORTAL="0", LIBGL_ALWAYS_SOFTWARE="1", GALLIUM_DRIVER="llvmpipe",
        __GLX_VENDOR_LIBRARY_NAME="mesa", WEBKIT_DISABLE_DMABUF_RENDERER="1",
        GGML_DISABLE_VULKAN="1",
    )
    alsa = root / "alsa-private.conf"
    alsa.write_text('pcm.!default { type pulse }\nctl.!default { type pulse }\n')
    env["ALSA_CONFIG_PATH"] = str(alsa)
    # Only policy runs: no ALSA, Bluetooth, camera, or physical-device monitor.
    # The only audio devices will be explicitly created virtual PulseAudio sinks.
    processes = []
    logs = []
    result = None
    command_process = None

    def start(name, values, pipe=False):
        log = (root / (name + ".log")).open("w")
        logs.append(log)
        process = subprocess.Popen(
            values, env=env, stdout=subprocess.PIPE if pipe else log,
            stderr=log, text=True, start_new_session=True,
        )
        processes.append(process)
        return process

    def line(process):
        if not select.select([process.stdout], [], [], 15)[0]:
            raise RuntimeError("Owned service did not become ready")
        value = process.stdout.readline().strip()
        if not value:
            raise RuntimeError("Owned service exited before becoming ready")
        return value

    def wait_socket(path, process):
        deadline = time.monotonic() + 15
        while not path.exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("Owned service socket unavailable: " + str(path))
            time.sleep(0.1)

    try:
        display = start("xvfb", ["Xvfb", "-displayfd", "1", "-screen", "0", "1280x800x24", "-nolisten", "tcp"], True)
        number = line(display)
        if not number.isdigit():
            raise RuntimeError("Xvfb did not return an owned display number")
        env["DISPLAY"] = ":" + number
        # No service directories: portal/systemd services cannot activate against the real session.
        session_config = root / "session-bus.conf"
        session_config.write_text(
            '<busconfig><type>session</type><listen>unix:path=' + str(runtime / "session-bus") +
            '</listen><auth>EXTERNAL</auth><policy context="default">'
            '<allow own="*"/><allow send_destination="*"/><allow receive_sender="*"/>'
            '</policy></busconfig>'
        )
        bus = start("session-bus", ["dbus-daemon", "--config-file=" + str(session_config), "--nofork", "--print-address"], True)
        env["DBUS_SESSION_BUS_ADDRESS"] = line(bus)
        a11y_config = next((path for path in [
            Path("/usr/share/defaults/at-spi2/accessibility.conf"),
            Path("/usr/share/at-spi2/accessibility.conf"),
        ] if path.is_file()), None)
        if not a11y_config:
            raise RuntimeError("AT-SPI accessibility.conf not found")
        a11y = start("accessibility-bus", ["dbus-daemon", "--config-file=" + str(a11y_config),
            "--address=unix:path=" + str(runtime / "accessibility-bus"), "--nofork", "--print-address"], True)
        env["AT_SPI_BUS_ADDRESS"] = line(a11y)
        router = start("accessibility-router", [sys.executable, str(Path(__file__).resolve()),
            "--accessibility-router", env["AT_SPI_BUS_ADDRESS"]], True)
        if line(router) != "READY":
            raise RuntimeError("Private accessibility router did not start")
        audio = start("pipewire", ["pipewire"])
        wait_socket(runtime / "pipewire-0", audio)
        start("wireplumber-policy", ["wireplumber", "--profile=policy"])
        pulse = start("pipewire-pulse", ["pipewire-pulse"])
        wait_socket(runtime / "pulse/native", pulse)
        info = subprocess.check_output(["pactl", "info"], env=env, text=True)
        (root / "pulse-info.txt").write_text(info)
        # Abort if this server somehow discovered any physical audio source.
        sources = subprocess.check_output(["pactl", "list", "short", "sources"], env=env, text=True)
        (root / "audio-sources-before.txt").write_text(sources)
        # PipeWire-Pulse's module-always-sink can provide its virtual Dummy Output.
        if any(row.split()[1] != "auto_null.monitor" for row in sources.splitlines() if row.strip()):
            raise RuntimeError("Private audio server unexpectedly has a non-dummy source")
        if args.session == "kde-wayland":
            kwin = start("kwin", ["kwin_wayland", "--x11-display", env["DISPLAY"],
                "--socket", "openwhisper-owned", "--no-lockscreen", "--no-kactivities", "--width", "1100", "--height", "750"])
            wait_socket(runtime / "openwhisper-owned", kwin)
            env["WAYLAND_DISPLAY"] = "openwhisper-owned"
        with (root / "command.log").open("w") as output:
            process = subprocess.Popen(command, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            command_process = process
            processes.append(process)
            try:
                result = process.wait(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                print("FAIL: owned command exceeded timeout", flush=True)
                result = 124
        print(("PASS" if result == 0 else "FAIL") + ": owned " + args.session + " command, exit " + str(result), flush=True)
        return result
    finally:
        # Stop the owned service/command groups. test-session.py cleans its separate app group.
        for process in reversed(processes):
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=20 if process is command_process else 5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
        for log in logs:
            log.close()
        shutil.rmtree(runtime)
        metadata.update(
            finished_utc=datetime.now(timezone.utc).isoformat(),
            status="PASS" if result == 0 else "FAIL", exit_code=result,
        )
        (root / "run.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--accessibility-router"]:
        accessibility_router(sys.argv[2])
    else:
        sys.exit(main())
