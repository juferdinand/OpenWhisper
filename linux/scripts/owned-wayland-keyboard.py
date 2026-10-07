#!/usr/bin/env python3
"""Send fixed clear/paste keys with a standard keymap in a private owned Wayland test.

Uses the virtual-keyboard-v1 protocol, never evdev/uinput or a physical device.
The acceptance caller bounds this helper with subprocess timeout=10.
Protocol: https://github.com/swaywm/wlroots/blob/master/protocol/virtual-keyboard-unstable-v1.xml
"""
import argparse
import ctypes as c
import os
from pathlib import Path
import runpy
import stat
import time


class Interface(c.Structure):
    pass


class Message(c.Structure):
    _fields_ = [('name', c.c_char_p), ('signature', c.c_char_p), ('types', c.POINTER(c.POINTER(Interface)))]


Interface._fields_ = [('name', c.c_char_p), ('version', c.c_int), ('method_count', c.c_int),
    ('methods', c.POINTER(Message)), ('event_count', c.c_int), ('events', c.POINTER(Message))]
wayland = c.CDLL('libwayland-client.so.0')
wayland.wl_display_connect.argtypes = [c.c_char_p]
wayland.wl_display_connect.restype = c.c_void_p
wayland.wl_display_roundtrip.argtypes = [c.c_void_p]
wayland.wl_display_roundtrip.restype = c.c_int
wayland.wl_display_flush.argtypes = [c.c_void_p]
wayland.wl_display_flush.restype = c.c_int
wayland.wl_display_disconnect.argtypes = [c.c_void_p]
wayland.wl_proxy_add_listener.argtypes = [c.c_void_p, c.POINTER(c.c_void_p), c.c_void_p]
wayland.wl_proxy_add_listener.restype = c.c_int
wayland.wl_proxy_marshal_flags.argtypes = [c.c_void_p, c.c_uint, c.POINTER(Interface), c.c_uint, c.c_uint]
wayland.wl_proxy_marshal_flags.restype = c.c_void_p
registry_interface = Interface.in_dll(wayland, 'wl_registry_interface')
seat_interface = Interface.in_dll(wayland, 'wl_seat_interface')
keyboard_methods = (Message * 4)(Message(b'keymap', b'uhu', None), Message(b'key', b'uuu', None),
    Message(b'modifiers', b'uuuu', None), Message(b'destroy', b'', None))
keyboard_interface = Interface(b'zwp_virtual_keyboard_v1', 1, 4, keyboard_methods, 0, None)
create_types = (c.POINTER(Interface) * 2)(c.pointer(seat_interface), c.pointer(keyboard_interface))
manager_methods = (Message * 1)(Message(b'create_virtual_keyboard', b'on', create_types))
manager_interface = Interface(b'zwp_virtual_keyboard_manager_v1', 1, 1, manager_methods, 0, None)


def marshal(proxy, opcode, interface=None, *arguments, destroy=False):
    return wayland.wl_proxy_marshal_flags(proxy, opcode,
        c.pointer(interface) if interface is not None else None, 1, int(destroy), *arguments)


def require_owned_wayland():
    helpers = runpy.run_path(str(Path(__file__).with_name('test-owned-portals.py')))
    runtime = helpers['require_owned']()
    display_name = os.environ.get('WAYLAND_DISPLAY', '')
    socket = (runtime / display_name).resolve()
    if ('WAYLAND_SOCKET' in os.environ or not display_name or socket.parent != runtime.resolve()
            or socket.stat().st_uid != os.getuid() or not stat.S_ISSOCK(socket.stat().st_mode)):
        raise RuntimeError('The Wayland socket must belong to this private runtime')
    return socket


def send(action):
    if action not in ['clear', 'paste'] or os.getuid() == 0:
        raise RuntimeError('Only fixed owned clear/paste actions as a regular user are allowed')
    socket = require_owned_wayland()
    display = wayland.wl_display_connect(str(socket).encode())
    if not display:
        raise RuntimeError('Could not connect to the owned Wayland compositor')
    keyboard = None
    keymap_ready = False
    try:
        globals = {}
        @c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint, c.c_char_p, c.c_uint)
        def global_added(_data, _registry, name, interface, version):
            globals.setdefault(interface, []).append((name, version))
        @c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint)
        def global_removed(_data, _registry, _name):
            pass
        registry = marshal(display, 1, registry_interface, c.c_void_p())
        listener = (c.c_void_p * 2)(c.cast(global_added, c.c_void_p), c.cast(global_removed, c.c_void_p))
        assert wayland.wl_proxy_add_listener(registry, listener, None) == 0
        assert wayland.wl_display_roundtrip(display) >= 0
        seats = globals.get(b'wl_seat', [])
        managers = globals.get(b'zwp_virtual_keyboard_manager_v1', [])
        if len(seats) != 1 or len(managers) != 1:
            raise RuntimeError('Expected one owned seat and virtual keyboard manager')
        seat = marshal(registry, 0, seat_interface, c.c_uint(seats[0][0]),
            c.c_char_p(seat_interface.name), c.c_uint(1), c.c_void_p())
        @c.CFUNCTYPE(None, c.c_void_p, c.c_void_p, c.c_uint)
        def capabilities(_data, _seat, _flags):
            pass
        seat_listener = (c.c_void_p * 1)(c.cast(capabilities, c.c_void_p))
        assert wayland.wl_proxy_add_listener(seat, seat_listener, None) == 0
        manager = marshal(registry, 0, manager_interface, c.c_uint(managers[0][0]),
            c.c_char_p(manager_interface.name), c.c_uint(1), c.c_void_p())
        keyboard = marshal(manager, 0, keyboard_interface, c.c_void_p(seat), c.c_void_p())
        xkb = c.CDLL('libxkbcommon.so.0')
        class Names(c.Structure):
            _fields_ = [(name, c.c_char_p) for name in ['rules', 'model', 'layout', 'variant', 'options']]
        xkb.xkb_context_new.argtypes = [c.c_int]
        xkb.xkb_context_new.restype = c.c_void_p
        xkb.xkb_context_unref.argtypes = [c.c_void_p]
        xkb.xkb_keymap_new_from_names.argtypes = [c.c_void_p, c.POINTER(Names), c.c_int]
        xkb.xkb_keymap_new_from_names.restype = c.c_void_p
        xkb.xkb_keymap_get_as_string.argtypes = [c.c_void_p, c.c_int]
        xkb.xkb_keymap_get_as_string.restype = c.c_void_p
        xkb.xkb_keymap_key_by_name.argtypes = [c.c_void_p, c.c_char_p]
        xkb.xkb_keymap_key_by_name.restype = c.c_uint
        xkb.xkb_keymap_mod_get_index.argtypes = [c.c_void_p, c.c_char_p]
        xkb.xkb_keymap_mod_get_index.restype = c.c_uint
        xkb.xkb_keymap_unref.argtypes = [c.c_void_p]
        context = xkb.xkb_context_new(2)  # Ignore environment rule names.
        if not context:
            raise RuntimeError('Could not allocate the owned keymap context')
        names = Names(b'evdev', b'pc105', b'us', b'', b'')
        keymap = xkb.xkb_keymap_new_from_names(context, c.byref(names), 0)
        if not keymap:
            xkb.xkb_context_unref(context)
            raise RuntimeError('Could not create the standard owned test keymap')
        try:
            raw = xkb.xkb_keymap_get_as_string(keymap, 1)
            if not raw:
                raise RuntimeError('Could not serialize the owned test keymap')
            try:
                text = c.string_at(raw) + b'\0'
            finally:
                libc = c.CDLL(None)
                libc.free.argtypes = [c.c_void_p]
                libc.free(raw)
            keys = {name: xkb.xkb_keymap_key_by_name(keymap, name.encode()) - 8
                for name in ['LCTL', 'AC01', 'AB04', 'BKSP']}
            control_index = xkb.xkb_keymap_mod_get_index(keymap, b'Control')
            assert all(0 <= value < 256 for value in keys.values()) and control_index < 32
        finally:
            xkb.xkb_keymap_unref(keymap)
            xkb.xkb_context_unref(context)
        fd = os.memfd_create('owned-test-keymap', os.MFD_CLOEXEC)
        try:
            assert os.write(fd, text) == len(text)
            marshal(keyboard, 0, None, c.c_uint(1), c.c_int(fd), c.c_uint(len(text)))
            assert wayland.wl_display_roundtrip(display) >= 0
            keymap_ready = True
        finally:
            os.close(fd)
        time.sleep(.3)  # Let the owned GTK target consume its keyboard map/focus events.
        def key(name, pressed):
            marshal(keyboard, 1, None, c.c_uint(int(time.monotonic() * 1000) & 0xffffffff),
                c.c_uint(keys[name]), c.c_uint(pressed))
            assert wayland.wl_display_roundtrip(display) >= 0
            time.sleep(.1)
        key('LCTL', 1)
        marshal(keyboard, 2, None, c.c_uint(1 << control_index), c.c_uint(0), c.c_uint(0), c.c_uint(0))
        key('AC01' if action == 'clear' else 'AB04', 1)
        key('AC01' if action == 'clear' else 'AB04', 0)
        key('LCTL', 0)
        marshal(keyboard, 2, None, c.c_uint(0), c.c_uint(0), c.c_uint(0), c.c_uint(0))
        if action == 'clear':
            key('BKSP', 1)
            key('BKSP', 0)
        assert wayland.wl_display_roundtrip(display) >= 0
    finally:
        if keyboard:
            if keymap_ready:
                marshal(keyboard, 2, None, c.c_uint(0), c.c_uint(0), c.c_uint(0), c.c_uint(0))
            marshal(keyboard, 3, destroy=True)
            # Flush is nonblocking; disconnect also destroys the owned virtual device.
            wayland.wl_display_flush(display)
        wayland.wl_display_disconnect(display)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['clear', 'paste'])
    send(parser.parse_args().action)
