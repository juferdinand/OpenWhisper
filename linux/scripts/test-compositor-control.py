#!/usr/bin/env python3
"""Test session command control with private virtual audio and owned compositor bindings."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--model', type=Path, required=True)
parser.add_argument('--fixture', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--sway-bindings', action='store_true')
args = parser.parse_args()
runtime = os.environ.get('XDG_RUNTIME_DIR')
if (not runtime or os.environ.get('WF_OWNED_DESKTOP_TEST') != runtime
        or os.environ.get('PULSE_SERVER') != 'unix:' + str(Path(runtime) / 'pulse/native')
        or os.getuid() == 0):
    parser.error('Requires an owned run-owned-desktop.py session as a regular user.')
for path in [args.binary, args.model, args.fixture]:
    if not path.is_file():
        parser.error('Missing binary or public fixture: ' + str(path))
# Only virtual sources created in this owned audio server may exist.
sources = subprocess.check_output(['pactl', 'list', 'short', 'sources'], text=True)
if any(row.split()[1] != 'auto_null.monitor' for row in sources.splitlines() if row.strip()):
    parser.error('Unexpected audio source; refusing capture.')
args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
work = args.output.resolve()
config = work / 'config/whisperfree'
config.mkdir(parents=True, mode=0o700)
models = work / 'data/whisperfree/models'
models.mkdir(parents=True, mode=0o700)
(config / 'settings.json').write_text(json.dumps(dict(model='tiny', language='en',
    setup_completed=True, output='clipboard', keep_history=False, gpu=False,
    gpu_configured=True, auto_check_updates=False)))
sink = 'openwhisper_control_' + str(os.getpid())
module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink',
    'sink_name=' + sink, 'rate=48000'], text=True).strip()
alsa = work / 'alsa.conf'
alsa.write_text('pcm.!default { type pulse device "' + sink + '.monitor" }\nctl.!default { type pulse }\n')
environment = os.environ | dict(XDG_CONFIG_HOME=str(work / 'config'),
    XDG_DATA_HOME=str(work / 'data'), ALSA_CONFIG_PATH=str(alsa))
binary = str(args.binary.resolve())
process = None
log = (work / 'app.log').open('w')
checks = []


def control(action, success=True):
    result = subprocess.run([binary, '--control', action], env=environment,
        text=True, capture_output=True, timeout=8)
    assert (result.returncode == 0) == success, 'Unexpected control result: ' + action + ': ' + result.stderr
    if success:
        value = json.loads(result.stdout)
        assert set(value) == {'status', 'elapsed', 'recovery_available'}, 'Control exposes private app content'
        return value
    return result


def wait_status(expected, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError('Owned app exited')
        value = control('status')
        if value['status'] == expected:
            return value
        time.sleep(.1)
    raise RuntimeError('Expected control status: ' + expected)


def passed(message):
    checks.append(message)
    print('PASS: ' + message, flush=True)


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    result = control('status', False)
    assert 'not running' in result.stderr
    passed('No running service fails without activating the app or audio')
    process = subprocess.Popen([binary], env=environment, stdout=log,
        stderr=log, start_new_session=True)
    (work / 'application-pid.txt').write_text(str(process.pid) + '\n')
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        result = subprocess.run([binary, '--control', 'status'], env=environment,
            text=True, capture_output=True, timeout=8)
        if result.returncode == 0:
            break
        time.sleep(.2)
    else:
        raise RuntimeError('Control service did not become available')
    passed('Running app offers content-free status on its owned session bus')
    result = control('start', False)
    assert 'model' in result.stderr.lower()
    assert control('status')['status'] != 'recording'
    passed('Missing selected model rejects start without opening audio')
    (models / 'ggml-tiny.bin').symlink_to(args.model.resolve())
    assert control('stop')['status'] != 'recording'
    assert control('cancel')['status'] != 'recording'
    assert control('start')['status'] == 'recording'
    assert control('start')['status'] == 'recording'
    assert control('cancel')['status'] == 'idle'
    assert control('cancel')['status'] == 'idle'
    passed('Explicit start, stop, and cancel are idempotent; repeated start does not stop capture')
    assert control('toggle')['status'] == 'recording'
    time.sleep(.4)
    assert control('stop')['status'] == 'transcribing'
    wait_status('idle')
    passed('Explicit stop ends silent capture and acknowledges transcription before completion')
    if args.sway_bindings:
        sockets = list(Path(runtime).glob('sway-ipc.*.sock'))
        assert len(sockets) == 1, 'Expected exactly one owned Sway socket'
        sway_env = environment | {'SWAYSOCK': str(sockets[0])}
        for binding in [
            'bindsym --no-repeat F8 exec ' + binary + ' --control toggle',
            'bindsym --no-repeat F9 exec ' + binary + ' --control start',
            'bindsym --release F9 exec ' + binary + ' --control stop',
        ]:
            subprocess.run(['swaymsg', binding], env=sway_env, check=True, capture_output=True)
        subprocess.run(['wtype', '-k', 'F8'], env=sway_env, check=True)
        wait_status('recording')
        subprocess.run(['wtype', '-k', 'F8'], env=sway_env, check=True)
        wait_status('idle')
        passed('Actual owned Sway F8 toggle binding starts and stops capture')
        held = subprocess.Popen(['wtype', '-P', 'F9', '-s', '2000', '-p', 'F9'], env=sway_env)
        wait_status('recording')
        held.wait(timeout=5)
        assert held.returncode == 0
        wait_status('idle')
        passed('Actual owned Sway F9 press/release bindings provide hold-to-record')
    assert control('start')['status'] == 'recording'
    subprocess.run(['paplay', '--device', sink, str(args.fixture.resolve())], check=True)
    time.sleep(.4)
    assert control('stop')['status'] == 'transcribing'
    wait_status('done', 90)
    clipboard = subprocess.check_output(['wl-paste', '--no-newline'], env=environment, text=True, timeout=5)
    assert 'country' in clipboard.lower(), 'Public speech fixture was not delivered'
    passed('Command-controlled virtual capture recognizes the public JFK fixture and delivers clipboard text')
    assert not list((config / 'recovery').glob('*.wav')), 'Successful delivery left a recovery recording'
    assert control('stop')['status'] == 'done'
    assert control('cancel')['status'] == 'done'
    passed('Idle stop/cancel preserve the delivered result and successful delivery clears its backup')
finally:
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    subprocess.run(['pactl', 'unload-module', module], check=False,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log.close()
    (work / 'checks.json').write_text(json.dumps(checks, indent=2) + '\n')
