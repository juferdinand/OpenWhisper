#!/usr/bin/env python3
"""Exercise real portal backends and native controls in a private owned desktop.

Run through run-owned-desktop.py. No portal, input, audio or clipboard operation
is permitted against the user's live session. Backend dialogs are real; the
optional status notifier fixture is separately labelled synthetic evidence.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib


def require_owned():
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", "/nonexistent"))
    if (os.environ.get("WF_OWNED_DESKTOP_TEST") != str(runtime)
            or os.environ.get("PULSE_SERVER") != "unix:" + str(runtime / "pulse/native")
            or not os.environ.get("DBUS_SESSION_BUS_ADDRESS", "").startswith("unix:path=" + str(runtime / "session-bus"))
            or not os.environ.get("AT_SPI_BUS_ADDRESS", "").startswith("unix:path=" + str(runtime / "accessibility-bus"))
            or runtime.stat().st_uid != os.getuid()
            or runtime.stat().st_mode & 0o077):
        raise RuntimeError("Private run-owned-desktop.py session required; refusing live desktop")
    return runtime


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


def stop_owned(process):
    if process is None or process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def wait_for(predicate, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise RuntimeError(description + " timed out")


class GnomeInput:
    """Synthetic input through the actual Mutter service on the owned bus."""
    def __init__(self):
        require_owned()
        from gi.repository import Gio
        self.Gio = Gio
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        self.path = self.bus.call_sync("org.gnome.Mutter.RemoteDesktop",
            "/org/gnome/Mutter/RemoteDesktop", "org.gnome.Mutter.RemoteDesktop",
            "CreateSession", None, None, Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        self.call("Start")

    def call(self, method, parameters=None):
        require_owned()
        return self.bus.call_sync("org.gnome.Mutter.RemoteDesktop", self.path,
            "org.gnome.Mutter.RemoteDesktop.Session", method, parameters, None,
            self.Gio.DBusCallFlags.NONE, 3000, None)

    def keys(self, pressed):
        for key in ([65507, 65513, 32] if pressed else [32, 65513, 65507]):
            self.call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (key, pressed)))
            time.sleep(0.05)

    def xwayland_environment(self):
        runtime = require_owned()
        if os.environ.get("WF_OWNED_GNOME_XWAYLAND") != "1":
            raise RuntimeError("Owned GNOME Xwayland was not requested")
        shell_pid = self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetConnectionUnixProcessID", GLib.Variant("(s)", ("org.gnome.Shell",)),
            None, self.Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
        def environment():
            for status in Path("/proc").glob("[0-9]*/status"):
                try:
                    if f"PPid:\t{shell_pid}\n" not in status.read_text():
                        continue
                    values = (status.parent / "cmdline").read_bytes().decode().rstrip("\0").split("\0")
                    if not values or Path(values[0]).name != "Xwayland":
                        continue
                    display = values[1]
                    authority = Path(values[values.index("-auth") + 1]).resolve()
                    if not display.startswith(":") or not display[1:].isdigit() or authority.parent != runtime:
                        raise RuntimeError("Xwayland child does not have an owned display and cookie")
                    return os.environ | {"GDK_BACKEND": "x11", "DISPLAY": display, "XAUTHORITY": str(authority)}
                except (OSError, ValueError):
                    continue
        return wait_for(environment, "Owned Mutter Xwayland child")

    def focus_field(self, field):
        rect = field.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        if rect.width < 1 or rect.height < 1:
            raise RuntimeError("Owned typing field has no displayed extent")
        # Move only the compositor's synthetic pointer. No XTEST or physical
        # input device is opened. Clamp to the owned monitor then click its field.
        self.call("NotifyPointerMotionRelative", GLib.Variant("(dd)", (-10000.0, -10000.0)))
        self.call("NotifyPointerMotionRelative", GLib.Variant("(dd)", (float(rect.x + rect.width / 2), float(rect.y + rect.height / 2))))
        self.call("NotifyPointerButton", GLib.Variant("(ib)", (272, True)))
        self.call("NotifyPointerButton", GLib.Variant("(ib)", (272, False)))

    def stop(self):
        self.call("Stop")


def typing_target(path):
    require_owned()
    gi.require_version("Gtk", "3.0")
    from gi.repository import Gtk
    path = Path(path)
    path.touch(mode=0o600)
    window = Gtk.Window(title="OpenWhisper Owned Typing Target")
    view = Gtk.TextView()
    view.get_accessible().set_name("Owned dictation field")
    buffer = view.get_buffer()
    buffer.connect("changed", lambda text: path.write_text(text.get_text(text.get_start_iter(), text.get_end_iter(), True)))
    window.add(view)
    window.maximize()
    window.show_all()
    view.grab_focus()
    Gtk.main()


def tray_fixture():
    """Synthetic registered-host fixture; it is not a GNOME tray extension."""
    require_owned()
    from gi.repository import Gio
    interface = Gio.DBusNodeInfo.new_for_xml(
        '<node><interface name="org.kde.StatusNotifierWatcher">'
        '<method name="RegisterStatusNotifierItem"><arg name="service" type="s" direction="in"/></method>'
        '<method name="RegisterStatusNotifierHost"><arg name="service" type="s" direction="in"/></method>'
        '<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>'
        '<property name="ProtocolVersion" type="i" access="read"/>'
        '<property name="RegisteredStatusNotifierItems" type="as" access="read"/>'
        '<signal name="StatusNotifierHostRegistered"/>'
        '</interface></node>').interfaces[0]
    def acquired(connection, _name):
        def property_value(_connection, _sender, _path, _interface, name):
            return {"IsStatusNotifierHostRegistered": GLib.Variant("b", True),
                "ProtocolVersion": GLib.Variant("i", 0),
                "RegisteredStatusNotifierItems": GLib.Variant("as", [])}[name]
        connection.register_object("/StatusNotifierWatcher", interface,
            lambda _c, _s, _p, _i, _n, _v, invocation: invocation.return_value(None), property_value, None)
    Gio.bus_own_name(Gio.BusType.SESSION, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE,
        acquired, lambda *_args: None, lambda *_args: sys.exit(1))
    GLib.MainLoop().run()


class NativeUI:
    def __init__(self, process):
        self.process = process

    def nodes(self):
        for node in descendants(Atspi.get_desktop(0)):
            try:
                if os.getpgid(node.get_process_id()) == self.process.pid:
                    yield node
            except (GLib.Error, ProcessLookupError, PermissionError):
                pass

    def find(self, name, roles=("button", "push button", "toggle button"), sensitive=True):
        for node in self.nodes():
            try:
                if (node.get_role_name() in roles and node.get_name().startswith(name)
                        and node.get_action_iface().get_n_actions() > 0
                        and (not sensitive or node.get_state_set().contains(Atspi.StateType.SENSITIVE))):
                    return node
            except GLib.Error:
                pass
        return None

    def click(self, name, roles=("button", "push button", "toggle button")):
        node = wait_for(lambda: self.find(name, roles), "Native control " + name)
        try:
            component = node.get_component_iface()
            if component is not None:
                component.scroll_to(Atspi.ScrollType.ANYWHERE)
        except GLib.Error:
            # GTK4 portal buttons need no scrolling and do not implement it.
            pass
        time.sleep(0.1)
        if not node.get_action_iface().do_action(0):
            raise RuntimeError("Native action rejected: " + name)

    def text(self):
        text = []
        for node in self.nodes():
            try:
                text.append(node.get_name())
                if "Text" in node.get_interfaces():
                    text.append(Atspi.Text.get_text(node, 0, -1))
            except GLib.Error:
                pass
        return "\n".join(text)


class PortalServices:
    """Start installed backends on the bus owned by run-owned-desktop.py."""
    def __init__(self, backend, output):
        require_owned()
        self.backend = backend
        self.output = Path(output)
        self.output.mkdir(mode=0o700)
        self.processes = []
        self.logs = []
        self.backend_process = None
        self.provider_process = None

    @staticmethod
    def executable(name):
        paths = [Path("/usr/libexec") / name, Path("/usr/lib") / name]
        paths += list(Path("/usr/lib").glob("*/libexec/" + name))
        return next((path for path in paths if path.is_file()), None)

    def spawn(self, name, path):
        log = (self.output / (name + ".log")).open("w")
        self.logs.append(log)
        process = subprocess.Popen([str(path)], stdout=log, stderr=log, start_new_session=True)
        self.processes.append(process)
        return process

    def has_owner(self, name):
        result = subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus",
            "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", name],
            text=True, capture_output=True, timeout=3)
        return result.returncode == 0 and "true" in result.stdout

    def __enter__(self):
        config = Path(os.environ["XDG_CONFIG_HOME"]) / "xdg-desktop-portal"
        config.mkdir(exist_ok=True)
        (config / "portals.conf").write_text("[preferred]\ndefault=none\n" + "".join(
            f"org.freedesktop.impl.portal.{interface}={self.backend}\n"
            for interface in ["GlobalShortcuts", "RemoteDesktop", "Clipboard", "Settings"]))
        try:
            if self.backend == "gnome":
                dconf = self.executable("dconf-service")
                if dconf:
                    self.spawn("dconf", dconf)
                    wait_for(lambda: self.has_owner("ca.desrt.dconf"), "Private GNOME settings store")
                provider = self.executable("gnome-control-center-global-shortcuts-provider")
                if provider:
                    self.provider_process = self.spawn("shortcut-provider", provider)
                    wait_for(lambda: self.has_owner("org.gnome.Settings.GlobalShortcutsProvider"), "Real shortcut provider")
            store = self.executable("xdg-permission-store")
            if store:
                self.spawn("permission-store", store)
            name = "xdg-desktop-portal-" + self.backend
            path = self.executable(name)
            if not path:
                raise RuntimeError("Installed portal backend missing: " + name)
            self.backend_process = self.spawn("backend", path)
            wait_for(lambda: self.has_owner("org.freedesktop.impl.portal.desktop." + self.backend), "Real backend")
            frontend = self.executable("xdg-desktop-portal")
            if not frontend:
                raise RuntimeError("Installed xdg-desktop-portal missing")
            self.spawn("frontend", frontend)
            if shutil.which("dbus-monitor"):
                monitor_log = (self.output / "shortcut-signals.log").open("w")
                self.logs.append(monitor_log)
                monitor = subprocess.Popen(["dbus-monitor", "--session", "interface='org.freedesktop.portal.GlobalShortcuts'", "sender='org.gnome.Shell'"],
                    stdout=monitor_log, stderr=monitor_log, start_new_session=True)
                self.processes.append(monitor)
            wait_for(lambda: self.has_owner("org.freedesktop.portal.Desktop"), "Real portal frontend")
            for interface in ["GlobalShortcuts", "RemoteDesktop"]:
                result = subprocess.run(["gdbus", "call", "--session", "--dest", "org.freedesktop.portal.Desktop",
                    "--object-path", "/org/freedesktop/portal/desktop", "--method", "org.freedesktop.DBus.Properties.Get",
                    "org.freedesktop.portal." + interface, "version"], text=True, capture_output=True, timeout=3)
                (self.output / (interface + "-version.txt")).write_text(result.stdout if result.returncode == 0 else "UNAVAILABLE\n" + result.stderr)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_args):
        for process in reversed(self.processes):
            stop_owned(process)
        for log in self.logs:
            log.close()

    def ui(self):
        return NativeUI(self.backend_process)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", choices=["gnome", "kde"], required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--shortcut-profile", choices=["supported", "error", "unavailable"], default="supported")
    parser.add_argument("--synthetic-tray", action="store_true", help="Separately labelled host-loss fixture after actual no-tray checks")
    parser.add_argument("--model", type=Path)
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require_owned()
    args.output.mkdir(mode=0o700)
    config = Path(os.environ["XDG_CONFIG_HOME"]) / "whisperfree"
    config.mkdir()
    preferences = dict(model="tiny", language="en", ui_language="en", setup_completed=True,
        microphone="", output="clipboard", keep_history=True, gpu=False, gpu_configured=True, auto_check_updates=False)
    (config / "settings.json").write_text(json.dumps(preferences))
    process = None
    target = None
    watcher = None
    sink_module = None
    input_device = None
    if args.model or args.fixture:
        if not args.model or not args.fixture or not args.model.is_file() or not args.fixture.is_file():
            parser.error("Provide existing --model and --fixture together")
        models = Path(os.environ["XDG_DATA_HOME"]) / "whisperfree/models"
        models.mkdir(parents=True)
        (models / "ggml-tiny.bin").symlink_to(args.model.resolve())
        sink = "openwhisper_portal_" + str(os.getpid())
        sink_module = subprocess.check_output(["pactl", "load-module", "module-null-sink", "sink_name=" + sink, "rate=48000"], text=True).strip()
        alsa = args.output / "alsa-private.conf"
        alsa.write_text(f'pcm.!default {{ type pulse device "{sink}.monitor" }}\nctl.!default {{ type pulse }}\n')
        os.environ["ALSA_CONFIG_PATH"] = str(alsa)
    # Give the real Registry a host identity, as an installed desktop file does.
    applications = Path(os.environ["XDG_DATA_HOME"]) / "applications"
    applications.mkdir()
    (applications / "io.github.whisperfree.desktop").write_text(
        "[Desktop Entry]\nType=Application\nName=OpenWhisper\nExec=" + str(args.binary.resolve()) + "\n")
    with PortalServices(args.backend, args.output / "portals") as services, (args.output / "app.log").open("w") as log:
        try:
            process = subprocess.Popen([str(args.binary.resolve())], stdout=log, stderr=log, start_new_session=True)
            app = NativeUI(process)
            app.click("General")
            wait_for(lambda: app.find("Allow"), "Available keyboard portal")
            app.click("Allow")
            portal = services.ui()
            if args.backend == "gnome":
                portal.click("Cancel")
                wait_for(lambda: app.find("Allow"), "Permission retry after actual Cancel")
                assert not app.find("Revoke", sensitive=False), "Cancelled request became permitted"
                print("PASS: actual GNOME permission Cancel re-enables Allow without navigation", flush=True)
                app.click("Allow")
                share = wait_for(lambda: portal.find("Share", sensitive=False), "Keyboard consent dialog")
                assert not share.get_state_set().contains(Atspi.StateType.SENSITIVE), "Unapproved keyboard interaction can be shared"
                portal.click("Allow Remote Interaction", roles=("check box",))
                portal.click("Share")
            else:
                portal.click("Deny")
                wait_for(lambda: app.find("Allow"), "Permission retry after actual Deny")
                assert not app.find("Revoke", sensitive=False), "Denied request became permitted"
                print("PASS: actual KDE permission Deny re-enables Allow without navigation", flush=True)
                app.click("Allow")
                restore = wait_for(lambda: portal.find("Allow restoring on future sessions", roles=("check box",)), "Transient keyboard consent")
                if restore.get_state_set().contains(Atspi.StateType.CHECKED):
                    portal.click("Allow restoring on future sessions", roles=("check box",))
                portal.click("Approve")
            wait_for(lambda: app.find("Revoke"), "Permitted keyboard session")
            print("PASS: real keyboard-only RemoteDesktop consent enables this session", flush=True)
            if args.backend == "gnome" and args.model:
                if args.shortcut_profile == "unavailable":
                    select = wait_for(lambda: app.find("Set trigger", sensitive=False), "Unavailable shortcut action")
                    assert not select.get_state_set().contains(Atspi.StateType.SENSITIVE)
                    assert "Global shortcuts portal" in app.text() and "Unavailable" in app.text()
                    print("PASS: unavailable stock GNOME shortcut portal disables setup and retains Record", flush=True)
                else:
                    provider = NativeUI(services.provider_process)
                    app.click("Set trigger")
                    provider.click("Cancel")
                    wait_for(lambda: app.find("Set trigger"), "Shortcut retry after actual Cancel")
                    app.click("Set trigger")
                    provider.click("Add")
                    if args.shortcut_profile == "error":
                        wait_for(lambda: "Shortcut setup cancelled or denied:" in app.text(), "Stock backend failure")
                        wait_for(lambda: app.find("Set trigger"), "Failed binding retry")
                        print("PASS: stock GNOME backend binding error remains visible and retryable", flush=True)
                    else:
                        wait_for(lambda: "Global shortcut enabled." in app.text(), "Real GNOME binding")
                        print("PASS: actual GNOME shortcut Cancel and Add bind the preferred combination", flush=True)
                        input_device = GnomeInput()
                        probe_path = args.output / "virtual-keyboard-probe.txt"
                        target = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--typing-target", str(probe_path)], start_new_session=True)
                        wait_for(lambda: probe_path.exists(), "Owned virtual-keyboard field")
                        target_ui = NativeUI(target)
                        probe_field = wait_for(lambda: next((node for node in target_ui.nodes() if node.get_name() == "Owned dictation field"), None), "Virtual keyboard field accessibility")
                        rect = probe_field.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
                        (args.output / "probe-geometry.json").write_text(json.dumps(dict(x=rect.x, y=rect.y, width=rect.width, height=rect.height,
                            before_focus=probe_field.get_state_set().contains(Atspi.StateType.FOCUSED))))
                        input_device.focus_field(probe_field)
                        wait_for(lambda: probe_field.get_state_set().contains(Atspi.StateType.FOCUSED), "Probe field focus")
                        for pressed in [True, False]:
                            input_device.call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (112, pressed)))
                        wait_for(lambda: probe_path.read_text() == "p", "Owned virtual keyboard sends text")
                        print("PASS: real Mutter virtual keyboard inserts a fixed probe in the owned field", flush=True)
                        # Owned Shell may start in Overview before any pointer input.
                        # Escape dismisses that startup mode; the real backend binds
                        # application shortcuts only in normal desktop mode.
                        for pressed in [True, False]:
                            input_device.call("NotifyKeyboardKeysym", GLib.Variant("(ub)", (65307, pressed)))
                        time.sleep(0.5)
                        input_device.keys(True)
                        input_device.keys(False)
                        try:
                            wait_for(lambda: app.find("Recording"), "Global shortcut activation")
                        except RuntimeError:
                            (args.output / "shortcut-debug.txt").write_text(app.text())
                            (args.output / "shortcut-dconf.txt").write_text(subprocess.check_output(["dconf", "dump", "/org/gnome/settings-daemon/plugins/media-keys/"], text=True))
                            raise
                        app.click("Discard recording")
                        wait_for(lambda: app.find("Start dictation"), "Shortcut capture cancellation")
                        app.click("Push to talk", roles=("radio button",))
                        input_device.keys(True)
                        try:
                            wait_for(lambda: app.find("Recording"), "Push-to-talk press")
                        finally:
                            input_device.keys(False)
                        wait_for(lambda: app.find("Start dictation"), "Push-to-talk release")
                        assert not (config / "history.json").exists() or json.loads((config / "history.json").read_text()) == []
                        print("PASS: real GNOME global shortcut press/release starts and stops silent virtual capture", flush=True)
                        app.click("Toggle", roles=("radio button",))
                        stop_owned(target)
                        target = None
                app.click("Paste at the cursor", roles=("radio button",))
                if input_device is None:
                    input_device = GnomeInput()
                targets = ["wayland", "xwayland"] if os.environ.get("WF_OWNED_GNOME_XWAYLAND") == "1" else ["wayland"]
                for target_backend in targets:
                    pasted = args.output / ("pasted-" + target_backend + ".txt")
                    target = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--typing-target", str(pasted)], env=input_device.xwayland_environment() if target_backend == "xwayland" else os.environ, start_new_session=True)
                    wait_for(lambda: pasted.exists(), "Owned GTK " + target_backend + " typing field")
                    time.sleep(1)
                    target_ui = NativeUI(target)
                    field = wait_for(lambda: next((node for node in target_ui.nodes()
                        if node.get_name() == "Owned dictation field"), None), "Owned typing field accessibility")
                    input_device.focus_field(field)
                    assert field.get_component_iface().grab_focus(), "Owned typing field refused focus"
                    wait_for(lambda: field.get_state_set().contains(Atspi.StateType.FOCUSED), "Owned typing field focus")
                    app.click("Start dictation")
                    wait_for(lambda: app.find("Recording"), "Private fixture recording")
                    subprocess.run(["paplay", "--device", sink, str(args.fixture.resolve())], check=True, timeout=20)
                    time.sleep(0.3)
                    app.click("Recording")
                    wait_for(lambda: app.find("Start dictation"), "Fixture recognition and delivery", timeout=90)
                    history = json.loads((config / "history.json").read_text())
                    assert history and "country" in history[0].lower(), "Public fixture recognition failed"
                    clipboard = subprocess.check_output(["wl-paste", "--no-newline"], text=True, timeout=5)
                    assert clipboard == history[0], "Focused GNOME clipboard differs from recognized fixture"
                    wait_for(lambda: pasted.read_text() == history[0], "Native " + target_backend + " portal insertion")
                    print("PASS: private virtual fixture recognition equals GNOME clipboard and native " + target_backend + " target", flush=True)
                    stop_owned(target)
                    target = None
            app.click("Revoke")
            wait_for(lambda: app.find("Allow"), "Permission revocation")
            print("PASS: revocation ends keyboard permission and restores Allow", flush=True)
            if args.backend == "gnome":
                assert not services.has_owner("org.kde.StatusNotifierWatcher"), "No-tray fixture unexpectedly has a watcher"
                expected = json.loads((config / "settings.json").read_text())
                app.click("Close")
                wait_for(lambda: process.poll() is not None, "Closing without a tray host must exit")
                print("PASS: native Close does not hide an inaccessible app without a tray host", flush=True)
                process = subprocess.Popen([str(args.binary.resolve())], stdout=log, stderr=log, start_new_session=True)
                app = NativeUI(process)
                app.click("General")
                wait_for(lambda: app.find("Allow"), "Fresh launch has no retained keyboard grant")
                assert not app.find("Revoke", sensitive=False), "Restart retained a keyboard session"
                saved = json.loads((config / "settings.json").read_text())
                assert saved == expected, "Clean restart changed persisted preferences"
                print("PASS: clean restart preserves preferences and requires fresh keyboard consent", flush=True)
                if args.synthetic_tray:
                    watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--tray-fixture"], start_new_session=True)
                    wait_for(lambda: services.has_owner("org.kde.StatusNotifierWatcher"), "Synthetic registered tray host")
                    time.sleep(1.5)
                    app.click("Close")
                    showing = lambda: any(node.get_role_name() == "frame" and node.get_state_set().contains(Atspi.StateType.SHOWING) for node in app.nodes())
                    wait_for(lambda: not showing(), "Hiding to synthetic registered host")
                    assert process.poll() is None, "Registered host Close unexpectedly exited"
                    stop_owned(watcher)
                    watcher = None
                    wait_for(showing, "Lost host restores hidden main window")
                    print("PASS: synthetic registered-host loss restores the hidden native window", flush=True)
        finally:
            stop_owned(watcher)
            if input_device is not None:
                with contextlib.suppress(GLib.Error):
                    input_device.stop()
            stop_owned(target)
            stop_owned(process)
            if sink_module is not None:
                subprocess.run(["pactl", "unload-module", sink_module], check=True)
    return 0


if __name__ == "__main__":
    if sys.argv[1:2] == ["--tray-fixture"]:
        tray_fixture()
    elif sys.argv[1:2] == ["--typing-target"]:
        typing_target(sys.argv[2])
    else:
        sys.exit(main())
