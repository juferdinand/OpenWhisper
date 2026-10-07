#!/usr/bin/env python3
"""Native keyboard setup, hold recording and explicit paste in an owned X11 desktop."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--fixture', type=Path, required=True)
parser.add_argument('--expect-kde', action='store_true')
args = parser.parse_args()
runtime = os.environ.get('XDG_RUNTIME_DIR')
if (os.getuid() == 0 or not runtime or os.environ.get('WF_OWNED_DESKTOP_TEST') != runtime
        or os.environ.get('XDG_SESSION_TYPE') != 'x11' or os.environ.get('WAYLAND_DISPLAY')
        or os.environ.get('PULSE_SERVER') != 'unix:' + runtime + '/pulse/native'):
    parser.error('Refusing live desktop/audio/input: use an owned non-root X11 session.')
if not all(path.is_file() for path in [args.binary, args.model, args.fixture]):
    parser.error('Missing native binary or public fixture assets')
for command in ['pactl', 'paplay', 'xdotool', 'xprop', 'xclip']:
    if not shutil.which(command): parser.error('Missing test dependency: ' + command)

import gi
gi.require_version('Atspi', '2.0')
gi.require_version('Gtk', '3.0')
from gi.repository import Atspi, Gtk, GLib
work = Path(os.environ['HOME']).parent / 'native-x11'
work.mkdir(mode=0o700)
config = work / 'config' / 'whisperfree'; config.mkdir(parents=True)
data = work / 'data' / 'whisperfree' / 'models'; data.mkdir(parents=True)
(data / 'ggml-tiny.bin').symlink_to(args.model.resolve())
sink = 'openwhisper_x11_' + str(os.getpid())
module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink', 'sink_name=' + sink, 'rate=48000'], text=True, timeout=10).strip()
(config / 'settings.json').write_text(json.dumps(dict(model='tiny', language='en', ui_language='en', setup_completed=True, microphone='', output='paste', hold_to_record=False, gpu=False, gpu_configured=True, keep_history=True, auto_check_updates=False, native_trigger=dict(kind='key', key=0x01000021))))
alsa = work / 'alsa.conf'; alsa.write_text('pcm.!default { type pulse device "' + sink + '.monitor" }\nctl.!default { type pulse }\n')
environment = os.environ | dict(XDG_CONFIG_HOME=str(work / 'config'), XDG_DATA_HOME=str(work / 'data'), ALSA_CONFIG_PATH=str(alsa))
log = (work / 'app.log').open('w')
process = None
held = set()
window = Gtk.Window(title='Owned X11 dictation target')
entry = Gtk.Entry(); window.add(entry); window.show_all()

def pump():
    while GLib.MainContext.default().pending(): GLib.MainContext.default().iteration(False)

def descendants(node):
    if node is None: return
    yield node
    try: count = node.get_child_count()
    except GLib.Error: return
    for index in range(count):
        try: yield from descendants(node.get_child_at_index(index))
        except GLib.Error: pass

def application():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        node = desktop.get_child_at_index(index)
        try:
            if node and process and os.getpgid(node.get_process_id()) == process.pid: return node
        except (GLib.Error, ProcessLookupError): pass
    return None

def button(name, prefix=False):
    for node in descendants(application()):
        try:
            if node.get_role_name() in ['button', 'toggle button'] and (node.get_name().startswith(name) if prefix else node.get_name() == name): return node
        except GLib.Error: pass
    return None

def wait(predicate, message, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pump()
        if process and process.poll() is not None: raise AssertionError('Native app exited during acceptance')
        value = predicate()
        if value: return value
        time.sleep(.05)
    raise AssertionError(message)

def click(name):
    item = wait(lambda: button(name), 'Native button missing: ' + name)
    assert item.get_state_set().contains(Atspi.StateType.ENABLED), 'Native button disabled: ' + name
    component = item.get_component_iface()
    if component: component.scroll_to(Atspi.ScrollType.ANYWHERE)
    time.sleep(.15)
    assert item.get_action_iface().do_action(0)
    pump()

def key(name, down):
    subprocess.run(['xdotool', 'keydown' if down else 'keyup', name], check=True, timeout=5)
    (held.add if down else held.discard)(name)
    pump()

def tap(name): key(name, True); key(name, False)

def focus_app():
    found = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--pid', str(process.pid), '--name', '^OpenWhisper$'], text=True, timeout=5).splitlines()
    assert found, 'Owned native window missing'
    property_value = subprocess.check_output(['xprop', '-id', found[0], '_NET_WM_PID'], text=True, timeout=5)
    assert property_value.strip().endswith('= ' + str(process.pid)), 'Window does not belong to the owned native child'
    subprocess.run(['xdotool', 'windowactivate', '--sync', found[0]], check=True, timeout=5)
    pump()

def focus_target():
    window.present(); entry.grab_focus(); pump()
    found = subprocess.check_output(['xdotool', 'search', '--onlyvisible', '--pid', str(os.getpid()), '--name', '^Owned X11 dictation target$'], text=True, timeout=5).splitlines()
    assert found, 'Owned target window missing'
    owner = subprocess.check_output(['xprop', '-id', found[0], '_NET_WM_PID'], text=True, timeout=5)
    assert owner.strip().endswith('= ' + str(os.getpid())), 'Target window does not belong to the owned driver'
    subprocess.run(['xdotool', 'windowactivate', '--sync', found[0]], check=True, timeout=5)
    assert subprocess.check_output(['xdotool', 'getactivewindow'], text=True, timeout=5).strip() == found[0]
    pump()

def settings(): return json.loads((config / 'settings.json').read_text())
def started(): return button('Recording ·', prefix=True) is not None

def start_app():
    return subprocess.Popen([str(args.binary.resolve())], env=environment, stdout=log, stderr=log, start_new_session=True)

def stop_app():
    if process:
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)

def interrupted(_signum, _frame): raise SystemExit(143)
signal.signal(signal.SIGTERM, interrupted)

try:
    process = start_app()
    wait(lambda: button('General'), 'Native app did not reach shared UI')
    click('General')
    # A stored modifier-only KDE profile must not constrain a different active adapter.
    if args.expect_kde:
        wait(lambda: button('Ctrl'), 'Genuine KDE keyboard adapter did not restore its profile')
    else:
        wait(lambda: button('Set trigger …') and button('Set trigger …').get_state_set().contains(Atspi.StateType.ENABLED), 'Native X11 keyboard fallback unavailable')
    click('Allow')
    wait(lambda: button('Revoke'), 'Explicit native paste did not become enabled')
    focus_app()
    click('Ctrl' if args.expect_kde else 'Set trigger …')
    wait(lambda: button('Cancel'), 'Explicit keyboard capture did not start')
    tap('F8')
    wait(lambda: button('F8'), 'Trigger did not commit after release')
    profile_name = 'native_trigger' if args.expect_kde else 'x11_trigger'
    wait(lambda: settings().get(profile_name), 'Native trigger was not saved')
    if not args.expect_kde:
        assert settings()['native_trigger'] == dict(kind='key', key=0x01000021), 'Inactive KDE profile was overwritten'
    original = settings()[profile_name]
    focus_app(); click('F8'); wait(lambda: button('Cancel'), 'Capture retry missing'); tap('Escape')
    wait(lambda: button('F8'), 'Escape did not restore the previous trigger')
    assert settings()[profile_name] == original
    focus_app(); click('F8'); wait(lambda: button('Cancel'), 'Capture focus test missing')
    focus_target()
    wait(lambda: button('F8'), 'Focus loss did not cancel keyboard capture')
    assert settings()[profile_name] == original
    print('PASS: explicit keyboard setup, release commit, Escape/focus cancellation and inactive-profile preservation', flush=True)
    # Toggle starts on press and does not stop at release.
    tap('F8'); wait(started, 'Toggle trigger did not start virtual-source recording')
    time.sleep(.3); assert started(), 'Toggle release incorrectly stopped recording'
    click('Discard recording'); wait(lambda: button('Start dictation'), 'Toggle cancel did not restore recording controls')
    # Change mode through the actual shared native UI and require its persisted patch.
    focus_app()
    combo = wait(lambda: next((node for node in descendants(application()) if node.get_role_name() == 'combo box' and node.get_name() == 'Recording mode'), None), 'Recording mode combobox missing')
    assert combo.get_state_set().contains(Atspi.StateType.ENABLED), 'Inactive KDE modifier profile disabled X11 hold mode'
    combo.get_component_iface().grab_focus(); assert combo.get_action_iface().do_action(0); tap('Home'); tap('Down'); tap('Return')
    wait(lambda: settings()['hold_to_record'], 'Hold mode did not save through native IPC')
    focus_target()
    for _ in range(10): pump(); time.sleep(.02)
    key('F8', True); wait(started, 'Hold trigger did not start recording')
    time.sleep(.3); assert started(), 'Held key stopped recording early'
    subprocess.run(['paplay', '--device', sink, str(args.fixture.resolve())], check=True, timeout=30)
    assert started(), 'Recording ended before actual trigger release'
    key('F8', False)
    history_file = config / 'history.json'
    recognized = wait(lambda: history_file.is_file() and json.loads(history_file.read_text()), 'Release did not finish public fixture recognition', timeout=60)
    assert 'country' in recognized[0].lower(), 'Public fixture was not recognized'
    wait(lambda: entry.get_text() == recognized[0], 'Automatic paste differed from recognized public fixture')
    copied = subprocess.check_output(['xclip', '-selection', 'clipboard', '-o'], text=True, timeout=10)
    assert copied == recognized[0], 'Clipboard differs from recognized fixture'
    print('PASS: real hold/release recording, public-fixture recognition, clipboard and focused-target equality', flush=True)
    focus_app(); click('Revoke'); wait(lambda: button('Allow'), 'Native session paste could not be revoked')
    stop_app(); process = start_app(); wait(lambda: button('General'), 'Restart did not restore native UI'); click('General')
    wait(lambda: button('F8'), 'Saved trigger did not reconnect after restart')
    wait(lambda: button('Allow'), 'Native paste permission was retained across restart')
    assert settings()['hold_to_record']
    click('Remove trigger'); wait(lambda: button('Set trigger …'), 'Trigger removal did not restore setup control')
    assert settings().get(profile_name) is None
    tap('F8'); time.sleep(.3); assert not started(), 'Removed trigger still records'
    print('PASS: session-only paste revoke/restart, persistent trigger reconnect and removal', flush=True)
    print('Native binary SHA256:', hashlib.sha256(args.binary.read_bytes()).hexdigest(), flush=True)
finally:
    for name in list(held): key(name, False)
    stop_app(); window.destroy(); pump(); log.close()
    subprocess.run(['pactl', 'unload-module', module], check=False, timeout=10)
