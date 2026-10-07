#!/usr/bin/env python3
"""Native desktop acceptance test using a silent virtual sink; never records the real microphone.
Requires PyGObject/AT-SPI and PulseAudio tools. Replaces this session's clipboard with the public JFK fixture.
Use run-owned-desktop.py with --owned for a private owned desktop session.
"""
import argparse, gi, hashlib, json, os, pathlib, shutil, signal, subprocess, sys, tempfile, time
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

root = next((parent for parent in pathlib.Path(__file__).resolve().parents if (parent/'VERSION').is_file() and (parent/'linux').is_dir()), pathlib.Path.cwd())
parser = argparse.ArgumentParser(description="Exercise the native Linux UI with an isolated virtual microphone and public speech fixture.")
parser.add_argument("--binary", type=pathlib.Path, default=root/"linux/target/release/openwhisper-desktop")
parser.add_argument("--model", type=pathlib.Path, default=root/"linux/target/speech-smoke/ggml-tiny.bin")
parser.add_argument("--model-id", choices=["tiny", "parakeet-v3-q4"], default="tiny")
parser.add_argument("--fixture", type=pathlib.Path, default=root/"linux/vendor/whisper.cpp/samples/jfk.wav", help="Public pinned speech fixture (useful with a binary built in another checkout)")
parser.add_argument("--owned", action="store_true", help="Require run-owned-desktop.py's private display, D-Bus and audio session")
parser.add_argument("--expect-no-overlay", action="store_true", help="In an owned session, require the unsupported-overlay notice and main-window Stop/Cancel fallback")
parser.add_argument("--expect-no-portals", action="store_true", help="In an owned session, require disabled shortcut and paste permission actions")
parser.add_argument("--expect-clipboard-unavailable", action="store_true", help="In an owned no-focus Wayland session, require bounded clipboard failure, responsive Copy controls and retained audio/text recovery")
parser.add_argument("--recovery", action="store_true", help="In an owned session, fail inference with a disposable invalid model and verify retry after restart")
parser.add_argument("--duration", type=int, default=126, help="Seconds for the recording-duration check (126 tests the former two-minute cutoff)")
parser.add_argument("--portals", action="store_true", help="Also request keyboard permission, bind a shortcut, and verify insertion into a private GTK test field")
args = parser.parse_args()
if args.duration < 1: parser.error("--duration must be at least one second.")
if not args.model.is_file() or not args.binary.is_file():
    parser.error("Build the app and run test-recognition.sh first, or supply --binary and --model.")
if not args.fixture.is_file(): parser.error("The public speech fixture is missing; fetch native sources or supply --fixture.")
if args.owned:
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime or os.environ.get("WF_OWNED_DESKTOP_TEST") != runtime or os.environ.get("PULSE_SERVER") != "unix:" + str(pathlib.Path(runtime)/"pulse/native"):
        parser.error("--owned requires run-owned-desktop.py; refusing the live desktop/audio session.")
    if args.portals: parser.error("Owned sessions do not include permission-portal acceptance; run that flow with a supervised tester.")
if args.recovery and not args.owned: parser.error("--recovery requires --owned; restart/failure regression must not use the live session.")
if (args.expect_no_overlay or args.expect_no_portals) and not args.owned: parser.error("Fallback capability assertions require --owned; refusing the live session.")
wayland = bool(os.environ.get("WAYLAND_DISPLAY"))
if args.expect_clipboard_unavailable and (not args.owned or not wayland or args.recovery or args.portals):
    parser.error("--expect-clipboard-unavailable requires an owned Wayland session without --recovery or --portals.")
clipboard_command = ["wl-paste", "--no-newline"] if wayland else ["xclip", "-selection", "clipboard", "-o"]
for command in ["pactl", "paplay", clipboard_command[0], "gdbus"] + (["qdbus6"] if args.portals else []):
    if not shutil.which(command): parser.error(f"Missing test dependency: {command}")
owned = subprocess.check_output(["gdbus", "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "io.github.whisperfree"], text=True)
if "true" in owned: parser.error("Quit OpenWhisper before running this isolated session test.")
work = pathlib.Path(tempfile.mkdtemp(prefix='openwhisper-desktop-test-'))
sink = 'openwhisper_test_' + str(os.getpid())
module = subprocess.check_output(['pactl','load-module','module-null-sink',f'sink_name={sink}','rate=48000'], text=True).strip()
process = None
target_process = None

def descendants(node):
    if node is None: return
    yield node
    try: count = node.get_child_count()
    except GLib.Error: return  # An accessibility object can disappear during app restart.
    for i in range(count):
        try: yield from descendants(node.get_child_at_index(i))
        except Exception: pass

def app():
    desktop = Atspi.get_desktop(0)
    for i in range(desktop.get_child_count()):
        node = desktop.get_child_at_index(i)
        if node is None: continue
        try:
            if os.getpgid(node.get_process_id()) == process.pid: return node
        except (ProcessLookupError, GLib.Error): pass
    return None

def button(prefix, frame='OpenWhisper'):
    node = app()
    if node:
        for child in descendants(node):
            try:
                if child.get_role_name() == 'frame' and child.get_name() == frame:
                    for item in descendants(child):
                        try:
                            # AT-SPI 2.52 on Ubuntu LTS names this role "push button".
                            if item.get_role_name() in ['button', 'push button', 'toggle button'] and item.get_name().startswith(prefix): return item
                        except GLib.Error: pass
            except GLib.Error: pass
    return None

def wait_button(prefix, seconds=20, frame='OpenWhisper'):
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

def visible_app_text():
    values = []
    for item in descendants(app()):
        try:
            values.append(item.get_name())
            if 'Text' in item.get_interfaces():
                values.append(Atspi.Text.get_text(item, 0, -1))
        except GLib.Error: pass
    return '\n'.join(value for value in values if value)

def pending_clipboard(parent):
    # Read only process metadata for our application's own wl-copy child. No
    # helper argv, clipboard bytes, input events or live-session processes.
    children = set()
    for task in pathlib.Path(f'/proc/{parent}/task').glob('*/children'):
        try: children.update(task.read_text().split())
        except OSError: pass
    for child in children:
        entry = pathlib.Path('/proc')/child
        try:
            fields = dict(line.split(':', 1) for line in (entry/'status').read_text().splitlines() if ':' in line)
            if fields['Name'].strip() == 'wl-copy' and not fields['State'].strip().startswith('Z') and int(fields['PPid']) == parent:
                return True
        except (OSError, KeyError, ValueError): pass
    return False

def wait_text(expected, seconds=10):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if expected in visible_app_text(): return
        time.sleep(.1)
    raise RuntimeError('Expected native UI message did not appear')

def alert_texts():
    values = set()
    for item in descendants(app()):
        try:
            # WebKitGTK exposes the shared UI's role=alert as an AT-SPI
            # notification (confirmed in the owned Debian GNOME fixture).
            if item.get_role_name() not in ['alert', 'notification']: continue
            for child in descendants(item):
                values.add(child.get_name())
                if 'Text' in child.get_interfaces(): values.add(Atspi.Text.get_text(child, 0, -1))
        except GLib.Error: pass
    return values

def stop_app():
    if process:
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()

def start_app():
    application = subprocess.Popen([str(args.binary.resolve())], env=environment, stdout=log, stderr=log, start_new_session=True)
    with (work/'application-pids.txt').open('a') as pids:
        pids.write(str(application.pid) + '\n')
    return application

def interrupted(signum, _frame):
    # The owned harness must be able to stop this script without bypassing cleanup.
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, interrupted)

try:
    config = work/'config/whisperfree'; config.mkdir(parents=True)
    data = work/'data/whisperfree/models'; data.mkdir(parents=True)
    model_file = 'ggml-tiny.bin' if args.model_id == 'tiny' else 'ggml-parakeet-tdt-0.6b-v3-q4_0.bin'
    (data/model_file).symlink_to(args.model.resolve())
    (config/'settings.json').write_text(json.dumps(dict(model=args.model_id, language='en', ui_language='en', setup_completed=False, microphone='', output='clipboard', keep_history=True, gpu=False, gpu_configured=True, auto_check_updates=False)))
    alsa = work/'alsa.conf'
    alsa.write_text(f'pcm.!default {{ type pulse device "{sink}.monitor" }}\nctl.!default {{ type pulse }}\n')
    environment = os.environ | dict(XDG_CONFIG_HOME=str(work/'config'), XDG_DATA_HOME=str(work/'data'), ALSA_CONFIG_PATH=str(alsa))
    log = (work/'app.log').open('w')
    process = start_app()
    click(wait_button('Finish setup'))
    wait_button('Start dictation')
    assert json.loads((config/'settings.json').read_text())['setup_completed'] is True, 'Finish setup did not persist completion'
    print('PASS: native Finish setup persists completed onboarding', flush=True)
    subprocess.run([str(args.binary.resolve())], env=environment, stdout=log, stderr=log, timeout=20, check=True)
    time.sleep(.5)
    wait_button('Start dictation')
    print('PASS: launcher reactivation preserves the existing app and UI', flush=True)
    if args.expect_no_overlay or args.expect_no_portals:
        click(wait_button('General'))
        text = visible_app_text()
        if args.expect_no_overlay:
            assert 'Floating recording indicator' in text and 'Not supported by this desktop' in text, 'Unsupported overlay notice is missing'
            assert 'Show overlay when idle' not in text, 'Unsupported floating overlay is promised as available'
            print('PASS: unsupported layer-shell shows its capability notice and no overlay preference', flush=True)
        if args.expect_no_portals:
            assert not wait_button('Set trigger').get_state_set().contains(Atspi.StateType.SENSITIVE), 'Unavailable shortcut portal action is enabled'
            assert not wait_button('Allow').get_state_set().contains(Atspi.StateType.SENSITIVE), 'Unavailable keyboard portal permission action is enabled'
            assert 'Global shortcuts portal' in text and 'Keyboard portal' in text and text.count('Unavailable') >= 2, 'Missing unavailable portal capability notices'
            print('PASS: absent owned portals show capability notices and disable shortcut/paste permission actions', flush=True)
    click(wait_button('Start dictation'))
    wait_button('Recording')
    recording_frame = 'OpenWhisper' if args.expect_no_overlay else 'OpenWhisper Recording'
    if args.expect_no_overlay:
        assert not button('Recording', frame='OpenWhisper Recording'), 'Unsupported overlay appeared'
        print('PASS: native main-window recording control starts private CPAL capture without an overlay', flush=True)
    else:
        indicator = wait_button('Recording', frame=recording_frame)
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
    click(wait_button('Discard recording', frame=recording_frame))
    wait_button('Start dictation')
    print('PASS: ' + ('main-window' if args.expect_no_overlay else 'floating') + ' Cancel discards the recording', flush=True)
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
window=Gtk.Window(title="OpenWhisper Typing Test")
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
        focus.write_text('for (const w of workspace.windowList()) { if (w.caption === "OpenWhisper Typing Test") workspace.activeWindow = w; }')
        script_id = subprocess.check_output(['qdbus6','org.kde.KWin','/Scripting','org.kde.kwin.Scripting.loadScript',str(focus),'openwhisper-typing-test'],text=True).strip()
        assert script_id.isdigit()
        subprocess.run(['qdbus6','org.kde.KWin',f'/Scripting/Script{script_id}','org.kde.kwin.Script.run'],check=True)
        subprocess.run(['qdbus6','org.kde.KWin','/Scripting','org.kde.kwin.Scripting.unloadScript','openwhisper-typing-test'],check=True,stdout=subprocess.DEVNULL)
    if args.expect_clipboard_unavailable:
        # Native preference saves replace the current status message. Select
        # German before delivery so this asserts the actual localized failure.
        click(wait_button('Deutsch'))
        wait_button('Diktat starten')
    click(wait_button('Diktat starten' if args.expect_clipboard_unavailable else 'Start dictation'))
    wait_button('Aufnahme ·' if args.expect_clipboard_unavailable else 'Recording')
    subprocess.run(['paplay', '--device', sink, str(args.fixture.resolve())], check=True)
    time.sleep(.4)
    click(wait_button('Aufnahme ·' if args.expect_clipboard_unavailable else 'Recording', frame=recording_frame))
    if args.expect_clipboard_unavailable:
        wait_button('Erneut transkribieren', seconds=90)
        history = json.loads((config/'history.json').read_text())
        assert history and 'country' in history[0].lower(), 'Known speech fixture not recognized'
        english = 'Clipboard delivery timed out. Copy from the transcript or try again. Your recording is retained. Retry transcription or discard it.'
        assert 'Copied. Paste your text with Ctrl+V.' not in visible_app_text(), 'Failed delivery claimed success'
        backups = list((config/'recovery').glob('*.wav'))
        assert len(backups) == 1, 'Failed clipboard delivery did not retain one WAV'
        backup = backups[0]
        transcript = backup.with_suffix('.txt')
        assert transcript.read_text() == history[0], 'Retained transcript differs from recognized fixture'
        for path in [backup, transcript]:
            assert path.stat().st_mode & 0o777 == 0o600, 'Recovery file permissions are not private'
        assert backup.parent.stat().st_mode & 0o777 == 0o700, 'Recovery directory permissions are not private'
        saved_hashes = [hashlib.sha256(path.read_bytes()).hexdigest() for path in [backup, transcript]]
        print('PASS: bounded no-focus clipboard failure claims no delivery and retains private WAV plus transcript', flush=True)
        german = 'Die Übertragung in die Zwischenablage hat zu lange gedauert. Kopiere den Text aus der Transkription oder versuche es erneut. Deine Aufnahme bleibt erhalten. Versuche die Transkription erneut oder verwirf sie.'
        wait_text(german)
        assert english not in visible_app_text() and 'Your recording is retained.' not in visible_app_text(), 'Delivery failure was only partially translated'
        print('PASS: native German delivery failure and retained-recording message are fully localized', flush=True)
        for index, (prefix, label) in enumerate([('Diktat kopieren', 'History Copy'), ('Kopieren', 'Transcript Copy')]):
            if index:
                # A language shell refresh clears the previous IPC alert. The
                # next result must be a fresh alert, not the recording status.
                click(wait_button('Englisch'))
                wait_button('Retry transcription')
                click(wait_button('Deutsch'))
                wait_button('Erneut transkribieren')
            failure = 'Die Übertragung in die Zwischenablage hat zu lange gedauert. Kopiere den Text aus der Transkription oder versuche es erneut'
            assert failure not in alert_texts(), 'Previous Copy alert was not cleared'
            click(wait_button('Verlauf'))
            if index:
                # The shared UI exposes Transcript Copy only with history
                # disabled. Explicitly turning it off clears this owned
                # fixture's history, while the saved WAV/text stay retained.
                history_switch = next(item for item in descendants(app()) if item.get_role() == Atspi.Role.CHECK_BOX and item.get_name() == 'Die letzten 20 Diktate lokal speichern')
                click(history_switch)
                wait_button('Kopieren')
                assert json.loads((config/'settings.json').read_text())['keep_history'] is False
                history = json.loads((config/'history.json').read_text())
                assert history == [], 'Disabling history did not clear the owned fixture history'
            parent = app().get_process_id()
            click(wait_button(prefix))
            deadline = time.monotonic() + 1
            while not pending_clipboard(parent) and time.monotonic() < deadline: time.sleep(.02)
            assert pending_clipboard(parent), 'Copy IPC did not start its owned pending wl-copy helper'
            started = time.monotonic()
            click(wait_button('Allgemein'))
            wait_button('Auslöser festlegen', seconds=1)
            assert 'Ausgabe' in visible_app_text(), 'General navigation did not render while Copy was pending'
            assert time.monotonic() - started < 2 and pending_clipboard(parent), 'Copy IPC blocked native UI until helper completion'
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and (pending_clipboard(parent) or failure not in alert_texts()): time.sleep(.05)
            assert not pending_clipboard(parent), 'Timed-out clipboard helper was not cleaned up'
            assert failure in alert_texts(), 'Copy IPC did not report a fresh exact German error alert'
            print('PASS: ' + label + ' IPC remains responsive during no-focus helper wait, then reports German failure', flush=True)
        preferences = json.loads((config/'settings.json').read_text())
        assert preferences['ui_language'] == 'de' and preferences['setup_completed'] is True and preferences['gpu'] is False and preferences['gpu_configured'] is True
        stop_app()
        process = start_app()
        wait_button('Erneut transkribieren')
        assert [hashlib.sha256(path.read_bytes()).hexdigest() for path in [backup, transcript]] == saved_hashes, 'Restart changed retained audio or transcript'
        assert json.loads((config/'history.json').read_text()) == history, 'Restart changed recognized history'
        assert json.loads((config/'settings.json').read_text()) == preferences, 'Restart changed preferences'
        click(wait_button('Gesicherte Aufnahme verwerfen'))
        wait_button('Diktat starten')
        assert not backup.exists() and not transcript.exists(), 'Explicit discard did not remove retained audio and transcript'
        print('PASS: failed delivery retains exact WAV/text across restart; explicit discard removes both', flush=True)
        sys.exit(0)
    wait_button('Start dictation', seconds=90)
    history = json.loads((config/'history.json').read_text())
    assert history and 'country' in history[0].lower(), 'Known speech fixture not recognized'
    clipboard = subprocess.check_output(clipboard_command, text=True, timeout=10)
    assert clipboard == history[0], 'Clipboard differs from recognized fixture'
    print('PASS: ' + ('main-window' if args.expect_no_overlay else 'floating') + ' Stop → CPAL/PipeWire → recognition → history → ' + ('Wayland' if wayland else 'X11') + ' clipboard', flush=True)
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
    if args.owned:
        preferences = json.loads((config/'settings.json').read_text())
        assert preferences['setup_completed'] is True, 'Completed setup was lost'
        assert preferences['gpu'] is False and preferences['gpu_configured'] is True, 'Manual CPU choice was lost'
        stop_app()
        process = start_app()
        wait_button('Start dictation')
        assert json.loads((config/'settings.json').read_text()) == preferences, 'Restart changed saved preferences'
        assert json.loads((config/'history.json').read_text()) == history, 'Restart changed history'
        assert not list((config/'recovery').glob('*.wav')), 'Delivered audio backup was not removed'
        print('PASS: fresh launch preserves preferences, manual CPU choice, history and completed setup', flush=True)
    if args.recovery:
        stop_app()
        # The test owns this symlink, never the actual model or the user's model directory.
        (data/model_file).unlink()
        (data/model_file).write_bytes(b'Invalid model for the owned inference-failure regression')
        process = start_app()
        click(wait_button('Start dictation'))
        wait_button('Recording')
        subprocess.run(['paplay', '--device', sink, str(args.fixture.resolve())], check=True)
        time.sleep(.4)
        click(wait_button('Recording', frame=recording_frame))
        wait_button('Retry transcription', seconds=60)
        backups = list((config/'recovery').glob('*.wav'))
        assert len(backups) == 1, 'Failed inference did not retain one WAV backup'
        backup = backups[0]
        backup_hash = hashlib.sha256(backup.read_bytes()).hexdigest()
        assert backup.stat().st_mode & 0o777 == 0o600, 'Saved recording permissions are not private'
        stop_app()
        (data/model_file).unlink()
        (data/model_file).symlink_to(args.model.resolve())
        process = start_app()
        wait_button('Retry transcription')
        assert hashlib.sha256(backup.read_bytes()).hexdigest() == backup_hash, 'Restart changed the retained audio'
        assert json.loads((config/'history.json').read_text()) == history, 'Failed inference changed history'
        click(wait_button('Retry transcription'))
        wait_button('Start dictation', seconds=90)
        recovered = json.loads((config/'history.json').read_text())
        assert len(recovered) == len(history) + 1 and 'country' in recovered[0].lower(), 'Retry did not recover the fixture'
        assert subprocess.check_output(clipboard_command, text=True, timeout=10) == recovered[0], 'Recovered transcript was not delivered'
        assert not backup.exists(), 'Successful retry retained the recovered audio'
        print('PASS: failed inference retains a private WAV across restart; restored model retry delivers and removes it', flush=True)
    if args.owned:
        click(wait_button('Deutsch'))
        wait_button('Diktat starten')
        assert json.loads((config/'settings.json').read_text())['ui_language'] == 'de', 'Native language switch did not persist German'
        stop_app()
        process = start_app()
        wait_button('Diktat starten')
        persisted = json.loads((config/'settings.json').read_text())
        assert persisted['ui_language'] == 'de' and persisted['setup_completed'] is True, 'Restart lost German or completed setup'
        assert persisted['gpu'] is False and persisted['gpu_configured'] is True, 'Restart lost manual CPU choice'
        print('PASS: native German language selection and completed onboarding survive restart', flush=True)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if target_process and target_process.poll() is None:
        target_process.terminate()
        target_process.wait(timeout=10)
    # AppImage launchers can spawn the app as a child. Stop only our own group.
    stop_app()
    subprocess.run(['pactl','unload-module',module], check=True)
    print('Isolated test files:', work, flush=True)
