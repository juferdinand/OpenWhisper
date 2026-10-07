#!/usr/bin/env python3
"""Accept a local AppImage installation in run-owned-desktop.py's private session.

Uses the unchanged local installer and generated GIO desktop launcher. No public
release, signature acceptance, actual login, or physical device is exercised.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True, help="Repository root or exact installer/resource subset")
parser.add_argument("--appimage", type=Path, required=True)
parser.add_argument("--sha256", required=True)
parser.add_argument("--native-sha256", required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
runtime = os.environ.get("XDG_RUNTIME_DIR")
assert os.getuid() != 0 and runtime and os.environ.get("WF_OWNED_DESKTOP_TEST") == runtime, "Owned desktop required"
assert os.environ.get("PULSE_SERVER") == "unix:" + str(Path(runtime) / "pulse/native"), "Private audio required"
for key in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]:
    path = Path(os.environ[key])
    assert path.is_dir() and path.stat().st_uid == os.getuid(), "Owned directories required"
assert hashlib.sha256(args.appimage.read_bytes()).hexdigest() == args.sha256
args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
home, config, data = [Path(os.environ[key]) for key in ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]]
installed = home / ".local/lib/whisperfree/OpenWhisper.AppImage"
desktop = data / "applications/io.github.whisperfree.desktop"
autostart = config / "autostart/io.github.whisperfree.desktop"
settings = config / "whisperfree/settings.json"
history = config / "whisperfree/history.json"
settings.parent.mkdir(mode=0o700)
settings.write_text(json.dumps(dict(ui_language="en", setup_completed=True,
    auto_check_updates=False, model="tiny", language="de", microphone="", vocabulary="",
    snippets=[], output="clipboard", hold_to_record=False, native_trigger=None,
    gpu=False, gpu_configured=True, keep_history=True, show_idle_overlay=False,
    launch_at_login=False)))
history.write_text(json.dumps(["Owned installation fixture"]))
model = data / "whisperfree/models/owned-sentinel.bin"
model.parent.mkdir(parents=True, mode=0o700)
model.write_bytes(b"Non-model owned fixture; never loaded.\n")
preserved = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in [history, model]}
groups = []
report = {"status": "FAIL", "checks": [], "appimage_sha256": args.sha256,
          "native_sha256": args.native_sha256, "uid": os.getuid()}


def passed(name):
    report["checks"].append(name)
    print("PASS:", name, flush=True)


def descendants(node):
    if node is None:
        return
    yield node
    try:
        count = node.get_child_count()
    except GLib.Error:
        return
    for index in range(count):
        try:
            yield from descendants(node.get_child_at_index(index))
        except GLib.Error:
            pass


def application(group):
    for node in descendants(Atspi.get_desktop(0)):
        try:
            if node.get_role_name() == "application" and os.getpgid(node.get_process_id()) == group:
                return node
        except (GLib.Error, ProcessLookupError):
            pass
    return None


def button(group, label):
    for item in descendants(application(group)):
        try:
            if item.get_role_name() in ["button", "push button", "toggle button", "check box"] and item.get_name().startswith(label):
                return item
        except GLib.Error:
            pass
    return None


def wait_button(group, label):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        item = button(group, label)
        if item:
            return item
        time.sleep(0.1)
    raise AssertionError("Owned installed UI did not expose " + label)


def click(item):
    assert item.get_action_iface().do_action(0), "Native UI action failed"


def stop(group):
    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    try:
        os.killpg(group, signal.SIGKILL)
    except ProcessLookupError:
        pass


try:
    with (args.output / "installation.log").open("w") as log:
        subprocess.run(["bash", str(args.source / "linux/scripts/install-local.sh"),
                        "--appimage", str(args.appimage.resolve())], stdout=log,
                       stderr=subprocess.STDOUT, check=True, timeout=40)
    assert hashlib.sha256(installed.read_bytes()).hexdigest() == args.sha256
    assert installed.stat().st_mode & 0o777 == 0o755
    text = desktop.read_text()
    assert str(installed) in text and "squashfs-root" not in text and "appimage_extracted_" not in text
    assert "Icon=io.github.whisperfree" in text and "StartupWMClass=io.github.whisperfree" in text
    assert (data / "icons/hicolor/256x256/apps/io.github.whisperfree.png").read_bytes() == (args.source / "linux/src-tauri/icons/icon.png").read_bytes()
    assert (installed.parent / "THIRD_PARTY_NOTICES.md").read_bytes() == (args.source / "linux/THIRD_PARTY_NOTICES.md").read_bytes()
    (args.output / "generated.desktop").write_bytes(desktop.read_bytes())
    passed("local installer preserves exact AppImage, identity, original icon and notices at permanent paths")
    with (args.output / "launcher.log").open("w") as log:
        first = subprocess.Popen(["gio", "launch", str(desktop)], stdout=log,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        groups.append(first.pid)
        assert first.wait(timeout=10) == 0
        wait_button(first.pid, "Start dictation")
        pid = application(first.pid).get_process_id()
        assert hashlib.sha256(Path(f"/proc/{pid}/exe").read_bytes()).hexdigest() == args.native_sha256
        assert Path(f"/proc/{pid}").stat().st_uid == os.getuid()
        environment = dict(value.split(b"=", 1) for value in Path(f"/proc/{pid}/environ").read_bytes().split(b"\0") if b"=" in value)
        assert environment[b"APPIMAGE"].decode() == str(installed)
        report["native_pid"] = pid
        report["installed_path"] = str(installed)
        second = subprocess.Popen(["gio", "launch", str(desktop)], stdout=log,
                                  stderr=subprocess.STDOUT, start_new_session=True)
        groups.append(second.pid)
        assert second.wait(timeout=10) == 0
        time.sleep(0.5)
        wait_button(first.pid, "Start dictation")
        assert application(first.pid).get_process_id() == pid
        passed("unchanged GIO desktop launcher reactivates the same verified native app")
        click(wait_button(first.pid, "General"))
        click(wait_button(first.pid, "Launch at login"))
        deadline = time.monotonic() + 8
        while not autostart.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert autostart.is_file(), "Native launch-at-login did not create its entry"
        value = autostart.read_text()
        assert str(installed) in value and "appimage_extracted_" not in value and "squashfs-root" not in value
        assert json.loads(settings.read_text())["launch_at_login"] is True
        (args.output / "generated-autostart.desktop").write_text(value)
        stop(first.pid)
        restart = subprocess.Popen(["gio", "launch", str(autostart)], stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        groups.append(restart.pid)
        wait_button(restart.pid, "Start dictation")
        assert json.loads(settings.read_text())["setup_completed"] is True
        click(wait_button(restart.pid, "General"))
        click(wait_button(restart.pid, "Launch at login"))
        deadline = time.monotonic() + 8
        while "Hidden=true" not in autostart.read_text() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert "Hidden=true" in autostart.read_text() and "Exec=" not in autostart.read_text()
        assert json.loads(settings.read_text())["launch_at_login"] is False
        passed("native autostart enable, exact entry launch and disable use the permanent AppImage and retain onboarding")
    for path, digest in preserved.items():
        assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    assert not subprocess.check_output(["pactl", "list", "short", "source-outputs"], text=True).strip()
    passed("installation, reactivation and autostart retain owned history/model data and never start capture")
    report["status"] = "PASS"
finally:
    for group in reversed(groups):
        stop(group)
    (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
