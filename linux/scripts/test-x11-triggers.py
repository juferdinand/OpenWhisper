#!/usr/bin/env python3
"""Exercise native X11 helper contracts only in run-owned-desktop.py's private session."""
import argparse
import ctypes as c
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
args = parser.parse_args()
runtime = os.environ.get('XDG_RUNTIME_DIR')
if (os.getuid() == 0 or not runtime or os.environ.get('WF_OWNED_DESKTOP_TEST') != runtime
        or os.environ.get('XDG_SESSION_TYPE') != 'x11' or os.environ.get('WAYLAND_DISPLAY')
        or os.environ.get('PULSE_SERVER') != 'unix:' + runtime + '/pulse/native'):
    parser.error('Refusing live desktop/input: use an owned non-root X11 session.')
if not args.binary.is_file():
    parser.error('Missing native binary')

import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib, Gdk

x = c.CDLL('libX11.so.6')
t = c.CDLL('libXtst.so.6')
def function(lib, name, restype, argtypes):
    value = getattr(lib, name); value.restype = restype; value.argtypes = argtypes
    return value
open_display = function(x, 'XOpenDisplay', c.c_void_p, [c.c_char_p])
close_display = function(x, 'XCloseDisplay', c.c_int, [c.c_void_p])
keysym_code = function(x, 'XKeysymToKeycode', c.c_ubyte, [c.c_void_p, c.c_ulong])
sync = function(x, 'XSync', c.c_int, [c.c_void_p, c.c_int])
fake_key = function(t, 'XTestFakeKeyEvent', c.c_int, [c.c_void_p, c.c_uint, c.c_int, c.c_ulong])
query_keys = function(x, 'XQueryKeymap', c.c_int, [c.c_void_p, c.c_void_p])
get_mapping = function(x, 'XGetKeyboardMapping', c.POINTER(c.c_ulong), [c.c_void_p, c.c_ubyte, c.c_int, c.POINTER(c.c_int)])
change_mapping = function(x, 'XChangeKeyboardMapping', c.c_int, [c.c_void_p, c.c_int, c.c_int, c.POINTER(c.c_ulong), c.c_int])
free = function(x, 'XFree', c.c_int, [c.c_void_p])
enabled_controls = function(x, 'XkbChangeEnabledControls', c.c_int, [c.c_void_p, c.c_uint, c.c_uint, c.c_uint])
latch = function(x, 'XkbLatchModifiers', c.c_int, [c.c_void_p, c.c_uint, c.c_uint, c.c_uint])
lock = function(x, 'XkbLockModifiers', c.c_int, [c.c_void_p, c.c_uint, c.c_uint, c.c_uint])
get_state = function(x, 'XkbGetState', c.c_int, [c.c_void_p, c.c_uint, c.c_void_p])
lookup = function(x, 'XkbLookupKeySym', c.c_int, [c.c_void_p, c.c_ubyte, c.c_uint, c.POINTER(c.c_uint), c.POINTER(c.c_ulong)])
class State(c.Structure):
    _fields_ = [('group', c.c_ubyte), ('locked_group', c.c_ubyte), ('base_group', c.c_ushort), ('latched_group', c.c_ushort)] + [(name, c.c_ubyte) for name in ['mods', 'base_mods', 'latched_mods', 'locked_mods', 'compat_state', 'grab_mods', 'compat_grab_mods', 'lookup_mods', 'compat_lookup_mods']] + [('ptr_buttons', c.c_ushort)]

display = open_display(os.environ['DISPLAY'].encode())
assert display, 'Owned X display unavailable'
children = []
held = set()

def pump():
    while GLib.MainContext.default().pending():
        GLib.MainContext.default().iteration(False)

def key(code, down):
    assert fake_key(display, code, int(down), 0)
    sync(display, 0)
    (held.add if down else held.discard)(code)
    pump()

class Helper:
    def __init__(self, request):
        self.process = subprocess.Popen([str(args.binary.resolve()), '--linux-x11-helper'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        children.append(self)
        self.buffer = b''
        if request is not None:
            self.process.stdin.write(json.dumps(request).encode() + b'\n'); self.process.stdin.flush()
    def event(self, timeout=5):
        deadline = time.monotonic() + timeout
        while b'\n' not in self.buffer:
            pump()
            remaining = deadline - time.monotonic()
            if remaining <= 0: raise AssertionError('Owned X11 helper response timed out')
            if select.select([self.process.stdout], [], [], min(remaining, .02))[0]:
                data = os.read(self.process.stdout.fileno(), 2049)
                if not data: raise AssertionError('Owned X11 helper exited without a response')
                self.buffer += data
                assert len(self.buffer) <= 8192, 'Unbounded helper response'
        line, self.buffer = self.buffer.split(b'\n', 1)
        assert len(line) <= 2048
        return json.loads(line)
    def quiet(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            pump()
            assert not self.buffer and not select.select([self.process.stdout], [], [], .02)[0], 'Unexpected press/release while the key is held'
    def stop(self):
        if not self.process.stdin.closed: self.process.stdin.close()
        self.process.wait(timeout=5)
    def finish(self, expected=0):
        self.stop(); assert self.process.returncode == expected

def request(action, **fields):
    return Helper(dict(action=action, display=os.environ['DISPLAY'], **fields))
def profile(code, symbol, modifiers=0):
    return dict(keycode=code, keysym=symbol, modifiers=modifiers, group=0)
def bind(value):
    helper = request('bind', trigger=value)
    assert helper.event()['event'] == 'ready'
    return helper

def edges(helper, code):
    key(code, True); assert helper.event() == {'event': 'pressed'}
    key(code, False); assert helper.event() == {'event': 'released'}

window = Gtk.Window(title='Owned X11 trigger target')
entry = Gtk.Entry(); window.add(entry); window.show_all(); entry.grab_focus()
# A named WM is allowed to map/focus the synthetic target before testing grabs/paste.
window.present()
for _ in range(30): pump(); time.sleep(.02)

try:
    # Xvfb lazily announces its XTEST keycodes on first input. Initialize the
    # private synthetic keyboard before binding, as native capture already does.
    warmup = keysym_code(display, 0xffc9)
    key(warmup, True); key(warmup, False)
    probe = request('probe'); ready = probe.event(); assert ready['event'] == 'ready' and ready['paste']; probe.finish()
    f8 = keysym_code(display, 0xffc5); assert f8
    selected = profile(f8, 0xffc5)
    helper = bind(selected)
    key(f8, True); first = helper.event(); assert first == {'event': 'pressed'}, first
    helper.quiet(.9)  # The server's repeat interval must never manufacture a release.
    key(f8, False); assert helper.event() == {'event': 'released'}
    for symbol in [0xffe5, 0xff7f]:
        lock_code = keysym_code(display, symbol); assert lock_code
        key(lock_code, True); key(lock_code, False); edges(helper, f8)
        key(lock_code, True); key(lock_code, False)
    conflict = request('bind', trigger=selected)
    assert 'already reserved' in conflict.event()['message']; conflict.finish(1)
    edges(helper, f8)
    helper.finish()
    replacement = bind(selected); edges(replacement, f8); replacement.finish()
    print('PASS: real release, repeat, lock variants, conflict preservation and EOF rebind', flush=True)
    for shutdown in ['eof', 'sigterm', 'sigkill']:
        helper = bind(selected); key(f8, True); first = helper.event(); assert first == {'event': 'pressed'}, first
        if shutdown == 'eof': helper.process.stdin.close()
        elif shutdown == 'sigterm': helper.process.terminate()
        else: helper.process.kill()
        if shutdown != 'sigkill': assert helper.event() == {'event': 'released'}
        helper.process.wait(timeout=5); key(f8, False)
        replacement = bind(selected); replacement.finish()
    print('PASS: held-key EOF/SIGTERM release and SIGKILL server-owned ungrab', flush=True)
    count = c.c_int(); original = get_mapping(display, f8, 1, c.byref(count))
    assert original and 0 < count.value <= 64
    backup = (c.c_ulong * count.value)(*[original[i] for i in range(count.value)]); free(original)
    changed = (c.c_ulong * count.value)(*[0xffc6] * count.value)
    try:
        helper = bind(selected); key(f8, True); first = helper.event(); assert first == {'event': 'pressed'}, first
        change_mapping(display, f8, count.value, changed, 1); sync(display, 0)
        assert helper.event() == {'event': 'released'}
        assert 'layout changed' in helper.event()['message']; helper.finish(1)
    finally:
        key(f8, False); change_mapping(display, f8, count.value, backup, 1); sync(display, 0)
    replacement = bind(selected); replacement.finish()
    print('PASS: mapping invalidation releases held trigger and permits explicit rebind', flush=True)
    keypad = keysym_code(display, 0xffb1); assert keypad
    dependent = request('bind', trigger=profile(keypad, 0xffb1, 16))
    assert 'lock state' in dependent.event()['message']; dependent.finish(1)
    subprocess.run(['setxkbmap', '-layout', 'us', '-variant', 'intl'], check=True, timeout=5)
    try:
        current = open_display(os.environ['DISPLAY'].encode()); assert current
        try:
            e = keysym_code(current, ord('e')); altgr = keysym_code(current, 0xfe03)
            remaining = c.c_uint(); symbol = c.c_ulong()
            assert e and altgr and lookup(current, e, 128, c.byref(remaining), c.byref(symbol))
            assert symbol.value == 0xe9, 'Owned US intl AltGr fixture is unavailable'
        finally: close_display(current)
        helper = bind(profile(e, symbol.value, 128))
        key(altgr, True); edges(helper, e); key(altgr, False); helper.finish()
    finally:
        subprocess.run(['setxkbmap', '-layout', 'us'], check=True, timeout=5)
    print('PASS: AltGr level binding and rejection of a lock-dependent keypad identity', flush=True)

    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    expected = 'Owned X11 paste fixture'
    clipboard.set_text(expected, -1); pump(); entry.set_text(''); entry.grab_focus(); window.present()
    for _ in range(10): pump(); time.sleep(.02)
    paste = request('paste'); assert paste.event() == {'event': 'complete'}; paste.finish()
    deadline = time.monotonic() + 5
    while entry.get_text() != expected and time.monotonic() < deadline: pump(); time.sleep(.02)
    assert entry.get_text() == expected, 'Focused target clipboard equality failed'
    entry.set_text('')
    control = keysym_code(display, 0xffe4); key(control, True)
    paste = request('paste'); assert 'Release the keyboard modifiers' in paste.event()['message']; paste.finish(1)
    keys = (c.c_ubyte * 32)(); query_keys(display, keys)
    assert keys[control // 8] & (1 << (control % 8)), 'Physical held modifier was released'
    assert entry.get_text() == ''
    key(control, False)
    assert enabled_controls(display, 0x100, 8, 8); sync(display, 0)
    for change, field in [(latch, 'latched_mods'), (lock, 'locked_mods')]:
        try:
            assert change(display, 0x100, 4, 4); sync(display, 0)
            before = State(); assert get_state(display, 0x100, c.byref(before)) == 0
            assert getattr(before, field) & 4 and before.mods & 4, 'Owned sticky modifier fixture was not applied: ' + field + '=' + str(getattr(before, field)) + ',mods=' + str(before.mods)
            paste = request('paste'); assert 'Release the keyboard modifiers' in paste.event()['message']; paste.finish(1)
            state = State(); assert get_state(display, 0x100, c.byref(state)) == 0
            assert getattr(state, field) & 4, 'Sticky modifier was changed'
            assert entry.get_text() == ''
        finally:
            change(display, 0x100, 4, 0); sync(display, 0)
    enabled_controls(display, 0x100, 8, 0); sync(display, 0)
    print('PASS: focused paste equality and preservation of held/latched/locked modifiers', flush=True)
    invalid = Helper(dict(action='probe', display='localhost:0'))
    assert invalid.event()['event'] == 'error'; invalid.finish(1)
    invalid = Helper(dict(action='probe', display=os.environ['DISPLAY'], untrusted=True))
    assert invalid.event()['event'] == 'error'; invalid.finish(1)
    pending = Helper(None)
    assert 'timed out' in pending.event()['message']
    assert pending.process.wait(timeout=1) == 1
    pending.finish(1)
    print('PASS: nonlocal displays, unknown fields and finite startup with an open input pipe', flush=True)
    print('Native binary SHA256:', hashlib.sha256(args.binary.read_bytes()).hexdigest(), flush=True)
finally:
    for code in list(held): key(code, False)
    for helper in children:
        try: helper.stop()
        except (subprocess.TimeoutExpired, BrokenPipeError): helper.process.kill(); helper.process.wait(timeout=5)
    window.destroy(); pump(); close_display(display)
