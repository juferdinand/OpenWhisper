#!/usr/bin/env python3
"""Test stock GNOME custom shortcuts executing OpenWhisper's session control.

Run only through run-owned-desktop.py. GNOME Settings Daemon is real; all
bindings, input, audio, windows, configuration and buses belong to that session.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location("owned", Path(__file__).with_name("test-owned-portals.py"))
owned = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owned)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    owned.require_owned()
    if os.environ.get("XDG_CURRENT_DESKTOP") != "GNOME":
        parser.error("Owned GNOME session required")
    for path in [args.binary, args.model, args.fixture]:
        if not path.is_file():
            parser.error("Missing owned test input: " + str(path))
    args.output.mkdir(mode=0o700)
    config = Path(os.environ["XDG_CONFIG_HOME"]) / "whisperfree"
    config.mkdir()
    (config / "settings.json").write_text(json.dumps(dict(model="tiny", language="en", ui_language="en",
        setup_completed=True, microphone="", output="clipboard", keep_history=True,
        gpu=False, gpu_configured=True, auto_check_updates=False)))
    models = Path(os.environ["XDG_DATA_HOME"]) / "whisperfree/models"
    models.mkdir(parents=True)
    (models / "ggml-tiny.bin").symlink_to(args.model.resolve())
    applications = Path(os.environ["XDG_DATA_HOME"]) / "applications"
    applications.mkdir()
    (applications / "io.github.whisperfree.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=OpenWhisper\nExec=" + str(args.binary.resolve()) + "\n")
    sink = "openwhisper_custom_" + str(os.getpid())
    sink_module = subprocess.check_output(["pactl", "load-module", "module-null-sink", "sink_name=" + sink, "rate=48000"], text=True).strip()
    alsa = args.output / "alsa-private.conf"
    alsa.write_text(f'pcm.!default {{ type pulse device "{sink}.monitor" }}\nctl.!default {{ type pulse }}\n')
    os.environ["ALSA_CONFIG_PATH"] = str(alsa)
    app_process = target = daemon = input_device = None
    with owned.PortalServices("gnome", args.output / "portals") as services, (args.output / "app.log").open("w") as app_log, (args.output / "media-keys.log").open("w") as daemon_log:
        try:
            app_process = subprocess.Popen([str(args.binary.resolve())], stdout=app_log, stderr=app_log, start_new_session=True)
            app = owned.NativeUI(app_process)
            app.click("General")
            owned.wait_for(lambda: services.has_owner("io.github.whisperfree.Control"), "Real session control service")
            paths = []
            for action, key in [("toggle", "F8"), ("start", "F9"), ("stop", "F10")]:
                path = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/openwhisper-" + action + "/"
                schema = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:" + path
                for name, value in [("name", "OpenWhisper " + action),
                        ("command", shlex.join([str(args.binary.resolve()), "--control", action])),
                        ("binding", "<Control><Shift>" + key)]:
                    subprocess.run(["gsettings", "set", schema, name, value], check=True, timeout=5)
                paths.append(path)
            subprocess.run(["gsettings", "set", "org.gnome.settings-daemon.plugins.media-keys", "custom-keybindings", repr(paths)], check=True, timeout=5)
            executable = services.executable("gsd-media-keys")
            if executable is None:
                raise RuntimeError("Installed GNOME media-key daemon missing")
            daemon = subprocess.Popen([str(executable)], stdout=daemon_log, stderr=daemon_log, start_new_session=True)
            owned.wait_for(lambda: services.has_owner("org.gnome.SettingsDaemon.MediaKeys"), "Real GNOME media-key daemon")
            input_device = owned.GnomeInput()
            pasted = args.output / "owned-input.txt"
            target = subprocess.Popen([sys.executable, str(Path(owned.__file__).resolve()), "--typing-target", str(pasted)], start_new_session=True)
            owned.wait_for(lambda: pasted.exists(), "Owned GTK field")
            target_ui = owned.NativeUI(target)
            field = owned.wait_for(lambda: next((node for node in target_ui.nodes() if node.get_name() == "Owned dictation field"), None), "Owned field accessibility")
            input_device.focus_field(field)
            owned.wait_for(lambda: field.get_state_set().contains(owned.Atspi.StateType.FOCUSED), "Owned field focus")
            time.sleep(1)
            def chord(key):
                for pressed, keys in [(True, [29, 42, key]), (False, [key, 42, 29])]:
                    for code in keys:
                        input_device.call("NotifyKeyboardKeycode", owned.GLib.Variant("(ub)", (code, pressed)))
                        time.sleep(0.05)
            chord(66)
            owned.wait_for(lambda: app.find("Recording"), "Actual GNOME custom toggle starts recording")
            app.click("Discard recording")
            owned.wait_for(lambda: app.find("Start dictation"), "Custom toggle capture cancelled")
            print("PASS: actual GNOME custom key binding executes --control toggle", flush=True)
            chord(67)
            owned.wait_for(lambda: app.find("Recording"), "Actual GNOME custom start records")
            subprocess.run(["paplay", "--device", sink, str(args.fixture.resolve())], check=True, timeout=20)
            chord(68)
            owned.wait_for(lambda: app.find("Start dictation"), "Actual GNOME custom stop finishes recognition", timeout=90)
            history = json.loads((config / "history.json").read_text())
            assert history and "country" in history[0].lower(), "Public fixture recognition failed"
            clipboard = subprocess.check_output(["wl-paste", "--no-newline"], text=True, timeout=5)
            assert clipboard == history[0], "Custom-binding recognition differs from clipboard"
            assert not app.find("Revoke", sensitive=False), "Ordinary custom binding unexpectedly granted keyboard permission"
            print("PASS: actual GNOME custom --control start/stop delivers the virtual fixture to clipboard without a portal shortcut grant", flush=True)
        finally:
            owned.stop_owned(daemon)
            owned.stop_owned(target)
            if input_device is not None:
                try:
                    input_device.stop()
                except owned.GLib.Error:
                    pass
            owned.stop_owned(app_process)
            subprocess.run(["pactl", "unload-module", sink_module], check=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
