#!/usr/bin/env python3
"""Manual KDE/Wayland acceptance test. Uses isolated XDG data and a silent virtual sink; never records the real microphone.
Requires PyGObject/AT-SPI and PulseAudio tools. Replaces the clipboard with the public JFK fixture.
"""
import argparse, gi, json, os, pathlib, shutil, signal, subprocess, tempfile, time
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

root = pathlib.Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description="Exercise the native Linux UI with an isolated virtual microphone and public speech fixture.")
parser.add_argument("--binary", type=pathlib.Path, default=root/"desktop/target/release/whisperfree-desktop")
parser.add_argument("--model", type=pathlib.Path, default=root/"desktop/target/speech-smoke/ggml-tiny.bin")
parser.add_argument("--model-id", choices=["tiny", "parakeet-v3-q4"], default="tiny")
parser.add_argument("--duration", type=int, default=126, help="Seconds for the recording-duration check (126 tests the former two-minute cutoff)")
parser.add_argument("--portals", action="store_true", help="Also request keyboard permission, bind a shortcut, and verify insertion into a private GTK test field")
args = parser.parse_args()
if args.duration < 1: parser.error("--duration must be at least one second.")
if not args.model.is_file() or not args.binary.is_file():
    parser.error("Build the app and run test-recognition.sh first, or supply --binary and --model.")
for command in ["pactl", "paplay", "wl-paste", "gdbus"] + (["qdbus6"] if args.portals else []):
    if not shutil.which(command): parser.error(f"Missing test dependency: {command}")
owned = subprocess.check_output(["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "io.github.whisperfree"], text=True)
if "true" in owned: parser.error("Quit WhisperFree before running this isolated session test.")
work = pathlib.Path(tempfile.mkdtemp(prefix='whisperfree-desktop-test-'))
sink = 'whisperfree_test_' + str(os.getpid())
module = subprocess.check_output(['pactl','load-module','module-null-sink',f'sink_name={sink}','rate=48000'], text=True).strip()
process = None
target_process = None

def descendants(node):
    if node is None: return
    yield node
    for i in range(node.get_child_count()):
        try: yield from descendants(node.get_child_at_index(i))
        except Exception: pass

def app():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        node = desktop.get_child_at_index(i)
        if node is None: continue
        try:
            if os.getpgid(node.get_process_id()) == process.pid: return node
        except ProcessLookupError: pass
    return None

def button(prefix, frame='WhisperFree'):
    node = app()
    if node:
        for child in descendants(node):
            if child.get_role_name() == 'frame' and child.get_name() == frame:
                for item in descendants(child):
                    if item.get_role_name() == 'button' and item.get_name().startswith(prefix): return item
    return None

def wait_button(prefix, seconds=20, frame='WhisperFree'):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None: raise RuntimeError('App exited')
        found = button(prefix, frame)
        if found: return found
        time.sleep(.2)
    raise RuntimeError('Button did not appear: ' + prefix)

def click(item):
    deadline = time.monotonic() + 10
    while not item.get_state_set().contains(Atspi.StateType.SENSITIVE) and time.monotonic() < deadline:
        time.sleep(.1)
    assert item.get_state_set().contains(Atspi.StateType.SENSITIVE), 'Control is disabled: ' + item.get_name()
    item.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
    time.sleep(.2)  # Let WebKit scroll an off-screen control before invoking its accessibility action.
    assert item.get_action_iface().do_action(0)

try:
    config = work/'config/whisperfree'; config.mkdir(parents=True)
    data = work/'data/whisperfree/models'; data.mkdir(parents=True)
    model_file = 'ggml-tiny.bin' if args.model_id == 'tiny' else 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin'
    (data/model_file).symlink_to(args.model.resolve())
    (config/'settings.json').write_text(json.dumps(dict(model=args.model_id, language='en', microphone='', output='clipboard', keep_history=True)))
    alsa = work/'alsa.conf'
    alsa.write_text(f'pcm.!default {{ type pulse device "{sink}.monitor" }}\nctl.!default {{ type pulse }}\n')
    environment = os.environ | dict(XDG_CONFIG_HOME=str(work/'config'), XDG_DATA_HOME=str(work/'data'), ALSA_CONFIG_PATH=str(alsa))
    log = (work/'app.log').open('w')
    process = subprocess.Popen([str(args.binary.resolve())], env=environment, stdout=log, stderr=log, start_new_session=True)
    wait_button('Start dictation')
    subprocess.run([str(args.binary.resolve())], env=environment, stdout=log, stderr=log, timeout=20, check=True)
    time.sleep(.5)
    wait_button('Start dictation')
    print('PASS: launcher reactivation preserves the existing app and UI', flush=True)
    click(wait_button('Start dictation'))
    wait_button('Recording')
    indicator = wait_button('Recording', frame='WhisperFree Recording')
    assert not indicator.get_state_set().contains(Atspi.StateType.FOCUSED), 'Overlay stole keyboard focus'
    print('PASS: native record control starts CPAL capture and floating overlay appears', flush=True)
    started = time.monotonic()
    while time.monotonic() - started < args.duration:
        assert button('Recording'), 'Recording stopped unexpectedly'
        time.sleep(1)
        elapsed = int(time.monotonic() - started)
        if elapsed in [30, 60, 90, 120]: print(f'Recording duration check: {elapsed}s', flush=True)
    assert button('Recording'), 'Recording stopped before the explicit cancel action'
    print(f'PASS: recording remains active after {args.duration} seconds', flush=True)
    click(wait_button('Discard recording', frame='WhisperFree Recording'))
    wait_button('Start dictation')
    print('PASS: floating Cancel discards the recording', flush=True)
    if args.portals:
        click(wait_button('General'))
        click(wait_button('Allow'))
        print('Waiting for KDE keyboard permission, if a consent dialog is shown…', flush=True)
        wait_button('Revoke', seconds=120)
        print('PASS: keyboard-only RemoteDesktop portal session', flush=True)
        time.sleep(.5)  # Portal state is published before its IPC reply re-enables permission controls.
        click(wait_button('Set trigger'))
        deadline = time.monotonic() + 120
        while button('Set trigger') and time.monotonic() < deadline:
            time.sleep(.2)
        assert not button('Set trigger'), 'Global shortcut binding did not complete'
        print('PASS: GlobalShortcuts portal binding', flush=True)
        for item in descendants(app()):
            if item.get_role_name() == 'radio button' and item.get_name() == 'Paste at the cursor':
                click(item)
                break
        target_script = work/'typing-target.py'
        target_script.write_text('''import gi, pathlib, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window=Gtk.Window(title="WhisperFree Typing Test")
window.set_default_size(600,220)
view=Gtk.TextView()
window.add(view)
buffer=view.get_buffer()
buffer.connect("changed", lambda text: pathlib.Path(sys.argv[1]).write_text(text.get_text(text.get_start_iter(), text.get_end_iter(), True)))
window.show_all()
view.grab_focus()
Gtk.main()
''')
        target_process = subprocess.Popen(['python3', str(target_script), str(work/'pasted.txt')])
        time.sleep(1)
        focus = work/'focus.js'
        focus.write_text('for (const w of workspace.windowList()) { if (w.caption === "WhisperFree Typing Test") workspace.activeWindow = w; }')
        script_id = subprocess.check_output(['qdbus6','org.kde.KWin','/Scripting','org.kde.kwin.Scripting.loadScript',str(focus),'whisperfree-typing-test'],text=True).strip()
        assert script_id.isdigit()
        subprocess.run(['qdbus6','org.kde.KWin',f'/Scripting/Script{script_id}','org.kde.kwin.Script.run'],check=True)
        subprocess.run(['qdbus6','org.kde.KWin','/Scripting','org.kde.kwin.Scripting.unloadScript','whisperfree-typing-test'],check=True,stdout=subprocess.DEVNULL)
    click(wait_button('Start dictation'))
    wait_button('Recording')
    subprocess.run(['paplay', '--device', sink, str(root/'desktop/vendor/whisper.cpp/samples/jfk.wav')], check=True)
    time.sleep(.4)
    click(wait_button('Recording', frame='WhisperFree Recording'))
    wait_button('Start dictation', seconds=90)
    history = json.loads((config/'history.json').read_text())
    assert history and 'country' in history[0].lower(), 'Known speech fixture not recognized'
    clipboard = subprocess.check_output(['wl-paste','--no-newline'], text=True)
    assert clipboard == history[0], 'Clipboard differs from recognized fixture'
    print('PASS: floating Stop → CPAL/PipeWire → Whisper → history → Wayland clipboard', flush=True)
    if args.portals:
        time.sleep(.5)
        assert (work/'pasted.txt').read_text() == history[0], 'Automatic paste did not reach the focused test field'
        print('PASS: keyboard portal inserts recognized text into the focused native Wayland app', flush=True)
    click(wait_button('Start dictation'))
    wait_button('Recording')
    time.sleep(1)
    click(wait_button('Recording'))
    wait_button('Start dictation')
    assert json.loads((config/'history.json').read_text()) == history, 'Silence unexpectedly created a transcript'
    print('PASS: silent audio does not create a transcript', flush=True)
finally:
    if target_process and target_process.poll() is None:
        target_process.terminate()
        target_process.wait(timeout=10)
    if process:
        # AppImage launchers can spawn the app as a child. Keep capture and cleanup in our own group.
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    subprocess.run(['pactl','unload-module',module], check=True)
    print('Isolated test files:', work, flush=True)
