# Input injection for an owned, nested KWin session only.
import ctypes as c, os, select, time
from gi.repository import Gio, GLib


class Input:
    def __init__(self, bus):
        assert (
            os.environ.get("WF_OWNED_TRIGGER_TEST") == os.environ["XDG_RUNTIME_DIR"]
        ), "An owned desktop is required"
        result, fds = bus.call_with_unix_fd_list_sync(
            "org.kde.KWin",
            "/org/kde/KWin/EIS/RemoteDesktop",
            "org.kde.KWin.EIS.RemoteDesktop",
            "connectToEIS",
            GLib.Variant("(i)", (3,)),
            None,
            Gio.DBusCallFlags.NONE,
            5000,
            None,
            None,
        )
        handle, self.cookie = result.unpack()
        fd = fds.get(handle)
        self.bus = bus
        self.lib = c.CDLL("libei.so.1")
        self.devices = {}
        for name, ret, args in [
            ("ei_new_sender", c.c_void_p, [c.c_void_p]),
            ("ei_setup_backend_fd", c.c_int, [c.c_void_p, c.c_int]),
            ("ei_get_fd", c.c_int, [c.c_void_p]),
            ("ei_dispatch", None, [c.c_void_p]),
            ("ei_get_event", c.c_void_p, [c.c_void_p]),
            ("ei_event_get_type", c.c_int, [c.c_void_p]),
            ("ei_event_get_seat", c.c_void_p, [c.c_void_p]),
            ("ei_event_get_device", c.c_void_p, [c.c_void_p]),
            ("ei_device_has_capability", c.c_bool, [c.c_void_p, c.c_int]),
            ("ei_device_ref", c.c_void_p, [c.c_void_p]),
            ("ei_event_unref", None, [c.c_void_p]),
            ("ei_device_start_emulating", None, [c.c_void_p, c.c_uint32]),
            ("ei_device_button_button", None, [c.c_void_p, c.c_uint32, c.c_bool]),
            ("ei_device_keyboard_key", None, [c.c_void_p, c.c_uint32, c.c_bool]),
            ("ei_device_frame", None, [c.c_void_p, c.c_uint64]),
            (
                "ei_device_pointer_motion_absolute",
                None,
                [c.c_void_p, c.c_double, c.c_double],
            ),
            ("ei_unref", None, [c.c_void_p]),
        ]:
            f = getattr(self.lib, name)
            f.restype = ret
            f.argtypes = args
        self.lib.ei_seat_bind_capabilities.argtypes = [c.c_void_p]
        self.ctx = self.lib.ei_new_sender(None)
        assert self.lib.ei_setup_backend_fd(self.ctx, fd) == 0
        self.fd = self.lib.ei_get_fd(self.ctx)
        deadline = time.monotonic() + 5
        while 32 not in self.devices or 4 not in self.devices:
            assert time.monotonic() < deadline, "EIS devices timed out"
            self.pump(0.1)

    def pump(self, timeout=0):
        select.select([self.fd], [], [], timeout)
        self.lib.ei_dispatch(self.ctx)
        while event := self.lib.ei_get_event(self.ctx):
            kind = self.lib.ei_event_get_type(event)
            if kind == 3:
                self.lib.ei_seat_bind_capabilities(
                    self.lib.ei_event_get_seat(event),
                    c.c_int(1),
                    c.c_int(2),
                    c.c_int(4),
                    c.c_int(32),
                    c.c_void_p(),
                )
            if kind == 8:
                device = self.lib.ei_event_get_device(event)
                self.lib.ei_device_start_emulating(device, 1)
                for cap in [1, 2, 4, 32]:
                    if self.lib.ei_device_has_capability(device, cap):
                        self.devices[cap] = self.lib.ei_device_ref(device)
            self.lib.ei_event_unref(event)

    def button(self, number, down):
        device = self.devices[32]
        self.lib.ei_device_button_button(device, number, down)
        self.lib.ei_device_frame(device, time.monotonic_ns() // 1000)
        self.pump()

    def key(self, number, down):
        device = self.devices[4]
        self.lib.ei_device_keyboard_key(device, number, down)
        self.lib.ei_device_frame(device, time.monotonic_ns() // 1000)
        self.pump()

    def move(self, x, y):
        device = self.devices[2]
        self.lib.ei_device_pointer_motion_absolute(device, x, y)
        self.lib.ei_device_frame(device, time.monotonic_ns() // 1000)
        self.pump()

    def close(self):
        self.lib.ei_unref(self.ctx)
