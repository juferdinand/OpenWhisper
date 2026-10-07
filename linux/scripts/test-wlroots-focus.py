#!/usr/bin/env python3
"""Check layer-shell focus, public-fixture paste and no-tray Close in an owned compositor."""
import argparse
import json
import os
from pathlib import Path
import runpy
import re
import signal
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--fixture', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--compositor', choices=['sway', 'hyprland'], required=True)
parser.add_argument('--duration', type=int, default=126)
parser.add_argument('--recognition-timeout', type=int, default=90)
args = parser.parse_args()
runtime = os.environ.get('XDG_RUNTIME_DIR')
if (os.getuid() == 0 or not runtime or os.environ.get('WF_OWNED_DESKTOP_TEST') != runtime
        or os.environ.get('PULSE_SERVER') != 'unix:' + str(Path(runtime) / 'pulse/native')):
    parser.error('A private run-owned-desktop.py session as a regular user is required.')
if not 1 <= args.duration <= 180 or not 1 <= args.recognition_timeout <= 600:
    parser.error('Duration must be 1–180 seconds; recognition deadline must be 1–600 seconds.')
for path in [args.binary, args.model, args.fixture]:
    if not path.is_file():
        parser.error('Missing binary or public fixture: ' + str(path))
helpers = runpy.run_path(str(Path(__file__).with_name('test-owned-portals.py')))
helpers['require_owned']()
keyboard_helpers = runpy.run_path(str(Path(__file__).with_name('owned-wayland-keyboard.py')))
keyboard_helpers['require_owned_wayland']()
wait_for = helpers['wait_for']
stop_owned = helpers['stop_owned']
descendants = helpers['descendants']
NativeUI = helpers['NativeUI']
Atspi = helpers['Atspi']
sources = subprocess.check_output(['pactl', 'list', 'short', 'sources'], text=True, timeout=15)
if any(row.split()[1] != 'auto_null.monitor' for row in sources.splitlines() if row.strip()):
    parser.error('Unexpected audio source; refusing capture.')
if args.compositor == 'sway':
    sockets = list(Path(runtime).glob('sway-ipc.*.sock'))
    if len(sockets) != 1:
        parser.error('Expected exactly one private Sway IPC socket.')
    os.environ['SWAYSOCK'] = str(sockets[0])
args.output.mkdir(parents=True, mode=0o700, exist_ok=False)
work = args.output.resolve()
config = work / 'config/whisperfree'
config.mkdir(parents=True, mode=0o700)
models = work / 'data/whisperfree/models'
models.mkdir(parents=True, mode=0o700)
(models / 'ggml-tiny.bin').symlink_to(args.model.resolve())
(config / 'settings.json').write_text(json.dumps(dict(model='tiny', language='en',
    setup_completed=True, output='clipboard', keep_history=True, gpu=False,
    gpu_configured=True, auto_check_updates=False, show_idle_overlay=False)))
sink = 'openwhisper_focus_' + str(os.getpid())
module = None
alsa = work / 'alsa.conf'
alsa.write_text('pcm.!default { type pulse device "' + sink + '.monitor" }\nctl.!default { type pulse }\n')
environment = os.environ | dict(XDG_CONFIG_HOME=str(work / 'config'),
    XDG_DATA_HOME=str(work / 'data'), ALSA_CONFIG_PATH=str(alsa))
binary = str(args.binary.resolve())
target_title = 'OpenWhisper Owned Typing Target'
process = target = None
log = (work / 'app.log').open('w')
checks = []
target_window = None
ipc_timeout = 20 if args.compositor == 'hyprland' else 5


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)


def passed(message):
    checks.append(message)
    (work / 'checks.json').write_text(json.dumps(checks, indent=2))
    print('PASS:', message, flush=True)


def control(action):
    result = subprocess.run([binary, '--control', action], env=environment,
        capture_output=True, text=True, check=True, timeout=15)
    value = json.loads(result.stdout)
    assert set(value) == {'status', 'elapsed', 'recovery_available'}
    return value


def windows():
    if args.compositor == 'hyprland':
        return json.loads(subprocess.check_output(['hyprctl', '-j', 'clients'], text=True, timeout=ipc_timeout))
    tree = json.loads(subprocess.check_output(['swaymsg', '-t', 'get_tree', '-r'], text=True, timeout=ipc_timeout))
    def flatten(node):
        yield node
        for child in node.get('nodes', []) + node.get('floating_nodes', []):
            yield from flatten(child)
    return list(flatten(tree))


def window_title(node):
    return node.get('title' if args.compositor == 'hyprland' else 'name')


def selector(node):
    if args.compositor == 'hyprland':
        address = node.get('address', '')
        assert re.fullmatch(r'0x[0-9a-fA-F]+', address), 'Invalid owned window address'
        return 'address:' + address
    identity = node.get('id')
    assert isinstance(identity, int) and identity > 0, 'Invalid owned container identity'
    return '[con_id=' + str(identity) + ']'


def focused_target():
    if args.compositor == 'hyprland':
        value = json.loads(subprocess.check_output(['hyprctl', '-j', 'activewindow'], text=True, timeout=ipc_timeout))
        return value.get('pid') == target.pid and value.get('address') == target_window['address']
    return any(node.get('focused') and node.get('pid') == target.pid and node.get('id') == target_window['id']
        for node in windows())


def focus_target():
    global target_window
    def mapped():
        try:
            matches = [node for node in windows() if window_title(node) == target_title and node.get('pid') == target.pid]
            assert len(matches) <= 1, 'Ambiguous owned target window'
            return matches[0] if matches else None
        except subprocess.TimeoutExpired:
            # A TCG guest can pause IPC during GTK startup; the outer deadline stays bounded.
            return None
    target_window = wait_for(mapped, 'Mapped owned target window', timeout=60 if args.compositor == 'hyprland' else 30)
    identity = selector(target_window)
    if args.compositor == 'hyprland':
        result = subprocess.check_output(['hyprctl', 'dispatch', 'focuswindow', identity], text=True, timeout=ipc_timeout)
        assert result.strip() == 'ok'
    else:
        result = json.loads(subprocess.check_output(['swaymsg', '-r', identity + ' focus'], text=True, timeout=ipc_timeout))
        assert result and all(item['success'] for item in result)
    wait_for(focused_target, 'Owned target focus', timeout=30)


def overlay_button(label):
    for node in ui.nodes():
        if (node.get_role_name() == 'frame' and node.get_name() == 'OpenWhisper Recording'
                and node.get_state_set().contains(Atspi.StateType.SHOWING)):
            for item in descendants(node):
                if (item.get_role_name() in ['button', 'push button', 'toggle button']
                        and item.get_name().startswith(label)
                        and item.get_state_set().contains(Atspi.StateType.SHOWING)
                        and item.get_state_set().contains(Atspi.StateType.SENSITIVE)):
                    return item
    return None


try:
    module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink',
        'sink_name=' + sink, 'rate=48000'], text=True, timeout=15).strip()
    process = subprocess.Popen([binary], env=environment, stdout=log, stderr=log, start_new_session=True)
    ui = NativeUI(process)
    wait_for(lambda: ui.find('Start dictation'), 'Main recording control', timeout=45)
    target_text = work / 'target.txt'
    target = subprocess.Popen([sys.executable, str(Path(__file__).with_name('test-owned-portals.py')),
        '--typing-target', str(target_text)], env=environment, stdout=log, stderr=log, start_new_session=True)
    focus_target()
    subprocess.run(['wtype', '-s', '300', 'Owned focus probe'], env=environment, check=True, timeout=10)
    wait_for(lambda: target_text.exists() and target_text.read_text() == 'Owned focus probe', 'Actual target typing')
    subprocess.run([sys.executable, str(Path(__file__).with_name('owned-wayland-keyboard.py')), 'clear'],
        env=environment, check=True, timeout=10)
    wait_for(lambda: target_text.read_text() == '', 'Empty owned target')
    assert control('start')['status'] == 'recording'
    cancel = wait_for(lambda: overlay_button('Discard recording'), 'Visible floating Cancel', timeout=30)
    assert focused_target(), 'Floating recording overlay stole focus'
    deadline = time.monotonic() + args.duration
    while time.monotonic() < deadline:
        assert control('status')['status'] == 'recording', 'Capture stopped without explicit input'
        assert focused_target(), 'Overlay changed the focused target'
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    assert cancel.get_action_iface().do_action(0)
    wait_for(lambda: control('status')['status'] == 'idle', 'Floating Cancel stops capture', timeout=30)
    assert focused_target()
    passed('Visible floating Cancel preserves target focus and ends an explicit ' + str(args.duration) + '-second capture')
    assert control('start')['status'] == 'recording'
    stop = wait_for(lambda: overlay_button('Recording'), 'Visible floating Stop', timeout=30)
    assert focused_target()
    subprocess.run(['paplay', '--device', sink, str(args.fixture.resolve())], env=environment, check=True, timeout=30)
    time.sleep(.4)
    assert stop.get_action_iface().do_action(0)
    wait_for(lambda: control('status')['status'] == 'done', 'Public-fixture recognition', timeout=args.recognition_timeout)
    assert focused_target(), 'Transcription overlay stole target focus'
    clipboard = subprocess.check_output(['wl-paste', '--no-newline'], env=environment, text=True, timeout=10)
    history = json.loads((config / 'history.json').read_text())
    assert history and 'country' in history[0].lower() and clipboard == history[0]
    subprocess.run([sys.executable, str(Path(__file__).with_name('owned-wayland-keyboard.py')), 'paste'],
        env=environment, check=True, timeout=10)
    wait_for(lambda: target_text.read_text() == clipboard, 'Exact manual paste into focused owned field')
    assert not list((config / 'recovery').glob('*.wav'))
    passed('Floating Stop preserves focus; public recognition equals clipboard/history and actual manual Ctrl+V target')
    owner = subprocess.check_output(['gdbus', 'call', '--session', '--dest', 'org.freedesktop.DBus',
        '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner',
        'org.kde.StatusNotifierWatcher'], text=True, timeout=5)
    assert 'false' in owner, 'This check requires an absent tray host'
    def owned_main(node):
        try:
            return window_title(node) == 'OpenWhisper' and os.getpgid(node.get('pid', 0)) == process.pid
        except (ProcessLookupError, PermissionError):
            return False
    main_windows = [node for node in windows() if owned_main(node)]
    assert len(main_windows) == 1, 'Expected one exact main window in the owned app process group'
    identity = selector(main_windows[0])
    if args.compositor == 'hyprland':
        result = subprocess.check_output(['hyprctl', 'dispatch', 'closewindow', identity], text=True, timeout=ipc_timeout)
        assert result.strip() == 'ok'
    else:
        result = json.loads(subprocess.check_output(['swaymsg', '-r', identity + ' kill'], text=True, timeout=ipc_timeout))
        assert result and all(item['success'] for item in result)
    assert process.wait(timeout=20) == 0, 'No-tray Close did not exit cleanly'
    assert target.poll() is None, 'Close unexpectedly destroyed the owned target app'
    passed('Actual compositor Close exits the full app when no tray can reopen its hidden recording window')
finally:
    stop_owned(target)
    stop_owned(process)
    log.close()
    if module is not None:
        subprocess.run(['pactl', 'unload-module', module], check=True, timeout=15)
