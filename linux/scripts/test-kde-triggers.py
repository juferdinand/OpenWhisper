#!/usr/bin/env python3
"""Test native trigger helpers in a disposable KWin session; never touches the user's inputs/settings.

Requires Plasma 6.3+, Xvfb, libei, Python PyGObject, and a built Linux binary.
No real microphone, clipboard, or desktop permissions are used.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--binary", type=Path, required=True)
parser.add_argument(
    "--expect-mouse-unsupported",
    action="store_true",
    help="Verify refusal before Ready or lease changes on an owned unsupported map",
)
parser.add_argument("--inside", action="store_true", help=argparse.SUPPRESS)
args = parser.parse_args()
binary = args.binary.resolve()
assert binary.is_file(), "Build the Linux binary first"
if not args.inside:
    for command in [
        "Xvfb",
        "kwin_wayland",
        "dbus-run-session",
        "kreadconfig6",
        "kwriteconfig6",
    ]:
        assert shutil.which(command), "Missing test dependency: " + command
    with tempfile.TemporaryDirectory(prefix="openwhisper-trigger-test-") as directory:
        root = Path(directory)
        env = os.environ.copy()
        for key in [
            "WAYLAND_DISPLAY",
            "DBUS_SESSION_BUS_ADDRESS",
            "AT_SPI_BUS_ADDRESS",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "QT_QPA_PLATFORM",
        ]:
            env.pop(key, None)
        for key, name in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_CACHE_HOME", "cache"),
            ("XDG_RUNTIME_DIR", "runtime"),
        ]:
            (root / name).mkdir(mode=0o700)
            env[key] = str(root / name)
        env.update(
            WF_OWNED_TRIGGER_TEST=env["XDG_RUNTIME_DIR"],
            XDG_CURRENT_DESKTOP="KDE",
            LIBGL_ALWAYS_SOFTWARE="1",
            GALLIUM_DRIVER="llvmpipe",
            __GLX_VENDOR_LIBRARY_NAME="mesa",
        )
        display = subprocess.Popen(
            [
                "Xvfb",
                "-displayfd",
                "1",
                "-screen",
                "0",
                "1280x800x24",
                "-nolisten",
                "tcp",
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            number = display.stdout.readline().strip()
            assert number.isdigit(), "Could not start an owned Xvfb display"
            env["DISPLAY"] = ":" + number
            command = [
                "dbus-run-session",
                "--",
                sys.executable,
                str(Path(__file__).resolve()),
                "--inside",
                "--binary",
                str(binary),
            ]
            if args.expect_mouse_unsupported:
                command.append("--expect-mouse-unsupported")
            result = subprocess.run(
                command,
                env=env,
            )
        finally:
            display.terminate()
            display.wait(timeout=10)
        sys.exit(result.returncode)

assert os.environ.get("WF_OWNED_TRIGGER_TEST") == os.environ["XDG_RUNTIME_DIR"]
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
root = Path(os.environ["XDG_CONFIG_HOME"]).parent
helpers = []
kwin = subprocess.Popen(
    [
        "kwin_wayland",
        "--x11-display",
        os.environ["DISPLAY"],
        "--socket",
        "openwhisper-test",
        "--no-lockscreen",
        "--no-kactivities",
        "--width",
        "1000",
        "--height",
        "700",
    ],
    stdout=(root / "kwin.log").open("w"),
    stderr=subprocess.STDOUT,
)
env = os.environ | {"WAYLAND_DISPLAY": "openwhisper-test", "GDK_BACKEND": "wayland"}
lease = root / "config/whisperfree/native-trigger-lease.json"


def receive(process, timeout=8):
    deadline = time.monotonic() + timeout
    data = b""
    while not data.endswith(b"\n"):
        assert select.select(
            [process.stdout], [], [], max(0, deadline - time.monotonic())
        )[0], "Helper response timed out"
        byte = os.read(process.stdout.fileno(), 1)
        assert byte, "Helper exited before responding"
        data += byte
    return json.loads(data)


def helper(trigger, error=None):
    process = subprocess.Popen(
        [str(binary), "--linux-trigger-helper"],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    helpers.append(process)
    process.stdin.write(json.dumps(trigger) + "\n")
    process.stdin.flush()
    reply = receive(process)
    if error:
        assert reply["event"] == "error" and error in reply["message"], reply
        assert process.wait(timeout=5) == 1
    else:
        assert reply == {"event": "ready"}, reply
        time.sleep(
            0.2
        )  # KDE applies configuration change notifications asynchronously.
    return process


def close(process):
    process.stdin.close()
    assert process.wait(timeout=5) == 0
    assert not lease.exists(), "The helper left a recovery lease after clean shutdown"


def mapping(key, value=None, read=False):
    command = [
        "kreadconfig6" if read else "kwriteconfig6",
        "--file",
        "kcminputrc",
        "--group",
        "ButtonRebinds",
        "--group",
        "Mouse",
        "--key",
        key,
    ]
    command += (
        ["--default", "<absent>"]
        if read
        else ["--notify", "--delete"]
        if value is None
        else ["--notify", value]
    )
    return subprocess.check_output(command, env=env, text=True).strip()


def edges(process, send, code):
    send(code, True)
    assert receive(process) == {"event": "pressed"}
    send(code, False)
    assert receive(process) == {"event": "released"}


try:
    for _ in range(100):
        ready = bus.call_sync(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "NameHasOwner",
            GLib.Variant("(s)", ("org.kde.KWin",)),
            None,
            Gio.DBusCallFlags.NONE,
            1000,
            None,
        ).unpack()[0]
        if (
            ready
            and (Path(os.environ["XDG_RUNTIME_DIR"]) / "openwhisper-test").exists()
        ):
            time.sleep(0.2)
            break
        assert kwin.poll() is None, (root / "kwin.log").read_text()
        time.sleep(0.1)
    else:
        raise AssertionError("No private Wayland socket")
    spec = importlib.util.spec_from_file_location(
        "kde_test_input", Path(__file__).with_name("kde-test-input.py")
    )
    inputs_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inputs_module)
    inputs = inputs_module.Input(bus)
    for key, code in [(0x01000037, 66), (ord("V"), 47)]:
        process = helper({"kind": "key", "key": key})
        edges(process, inputs.key, code)
        close(process)
    print("PASS: F8 and V without modifiers, including release events", flush=True)
    process = helper({"kind": "key", "key": 0x01000021})
    for _ in range(12):
        inputs.key(29, True)
        time.sleep(0.1)
        assert not select.select([process.stdout], [], [], 0)[0]
        inputs.key(29, False)
        assert receive(process) == {"event": "pressed"}
        assert receive(process) == {"event": "released"}
    close(process)
    print("PASS: modifier-only triggers activate on release (toggle mode)", flush=True)
    if args.expect_mouse_unsupported:
        config = root / "config/kcminputrc"
        original = config.read_bytes() if config.exists() else None
        for button in [2, 8, 9, 10, 31]:
            helper({"kind": "mouse", "button": button}, "cannot safely provide")
            assert not lease.exists(), "Unsupported metadata created a shortcut lease"
            assert (config.read_bytes() if config.exists() else None) == original
            assert kwin.poll() is None, "The compositor exited during metadata refusal"
        process = helper({"kind": "key", "key": 0x01000037})
        edges(process, inputs.key, 66)
        close(process)
        inputs.close()
        print(
            "PASS: unsupported mouse metadata rejected before Ready without a lease or mapping change; keyboard remains usable",
            flush=True,
        )
        sys.exit(0)
    for button, linux, key in [
        (2, 274, "MiddleButton"),
        (8, 275, "ExtraButton1"),
        (9, 276, "ExtraButton2"),
        (10, 277, "ExtraButton3"),
        (31, 303, "ExtraButton24"),
    ]:
        process = helper({"kind": "mouse", "button": button})
        edges(process, inputs.button, linux)
        close(process)
        assert mapping(key, read=True) == "<absent>"
    print(
        "PASS: middle, back, forward, and extra buttons; mappings restored on EOF",
        flush=True,
    )
    process = helper({"kind": "mouse", "button": 8})
    process.terminate()
    assert process.wait(timeout=5) == 0
    assert mapping("ExtraButton1", read=True) == "<absent>"
    process = helper({"kind": "mouse", "button": 8})
    process.kill()
    process.wait(timeout=5)
    assert lease.exists()
    process = helper({"kind": "key", "key": 0x01000037})
    assert mapping("ExtraButton1", read=True) == "<absent>"
    edges(process, inputs.key, 66)
    close(process)
    print("PASS: SIGTERM cleanup and recovery after SIGKILL", flush=True)
    mapping("ExtraButton1", "Key,F6")
    helper({"kind": "mouse", "button": 8}, "already remapped")
    assert mapping("ExtraButton1", read=True) == "Key,F6"
    mapping("ExtraButton1")
    process = helper({"kind": "mouse", "button": 8})
    mapping("ExtraButton1", "Key,F7")
    close(process)
    assert mapping("ExtraButton1", read=True) == "Key,F7"
    print("PASS: existing mappings and later user edits are preserved", flush=True)
    mapping("ExtraButton1")
    # Independent component: verify that another application's key is not stolen.
    action = [
        "openwhisper-test-conflict",
        "_k_session:test",
        "Owned test",
        "Conflict test",
    ]

    def accel(method, signature, values):
        return bus.call_sync(
            "org.kde.kglobalaccel",
            "/kglobalaccel",
            "org.kde.KGlobalAccel",
            method,
            GLib.Variant(signature, values),
            None,
            Gio.DBusCallFlags.NONE,
            5000,
            None,
        ).unpack()

    accel("doRegister", "(as)", (action,))
    accel("setShortcutKeys", "(asa(ai)u)", (action, [([0x01000037, 0, 0, 0],)], 6))
    helper({"kind": "key", "key": 0x01000037}, "conflicts")
    accel("unregister", "(ss)", (action[0], action[1]))
    process = helper({"kind": "key", "key": 0x01000037})
    edges(process, inputs.key, 66)
    close(process)
    process = helper({"kind": "mouse", "button": 8})
    inputs.button(275, True)
    assert receive(process) == {"event": "pressed"}
    close(process)
    time.sleep(0.3)
    inputs.button(275, False)
    process = helper({"kind": "key", "key": 0x01000037})
    edges(process, inputs.key, 66)
    close(process)
    process = helper({"kind": "mouse", "button": 8})
    edges(process, inputs.button, 275)
    close(process)
    print(
        "PASS: held-button exit leaves no stuck modifiers and the mouse can reconnect",
        flush=True,
    )
    accel("doRegister", "(as)", (action,))
    accel("setShortcutKeys", "(asa(ai)u)", (action, [([0x01000042, 0, 0, 0],)], 6))
    process = helper({"kind": "mouse", "button": 8})
    assert mapping("ExtraButton1", read=True) == "Key,F24"
    edges(process, inputs.button, 275)
    close(process)
    accel("unregister", "(ss)", (action[0], action[1]))
    print("PASS: occupied F19 uses the free F24 fallback", flush=True)
    # This changes only this test's disposable compositor configuration. Do not
    # hold a mouse button: binding removal does not prove compositor key release.
    process = helper({"kind": "mouse", "button": 8})
    subprocess.run(
        ["kwriteconfig6", "--file", "kxkbrc", "--group", "Layout", "--key", "LayoutList", "--notify", "us,de"],
        env=env,
        check=True,
    )
    bus.emit_signal(None, "/Layouts", "org.kde.keyboard", "reloadConfig", None)
    bus.flush_sync(None)
    reply = receive(process)
    assert reply["event"] == "error" and "keyboard layout changed" in reply["message"], reply
    assert process.wait(timeout=5) == 1
    assert not lease.exists(), "Metadata invalidation left a recovery lease"
    assert mapping("ExtraButton1", read=True) == "<absent>"
    layouts = bus.call_sync(
        "org.kde.keyboard", "/Layouts", "org.kde.KeyboardLayouts", "getLayoutsList",
        None, None, Gio.DBusCallFlags.NONE, 5000, None,
    ).unpack()[0]
    assert len(layouts) == 2, "The owned replacement map did not advertise both layouts"
    process = helper({"kind": "mouse", "button": 8})
    edges(process, inputs.button, 275)
    close(process)
    print("PASS: keymap replacement stops the helper and restores its lease; a fresh helper validates all layouts", flush=True)
    inputs.close()
    print(
        "PASS: keyboard conflicts rejected without taking another application’s binding",
        flush=True,
    )
finally:
    for process in helpers:
        if process.poll() is None:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    kwin.terminate()
    try:
        kwin.wait(timeout=10)
    except subprocess.TimeoutExpired:
        kwin.kill()
        kwin.wait()
