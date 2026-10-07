#!/usr/bin/env python3
"""Real KDE keyboard portal and paste into an owned GTK target, virtual audio only."""
import argparse,hashlib,importlib.util,json,os
from pathlib import Path
import subprocess,time
import gi
gi.require_version('Gtk','3.0')
gi.require_version('Atspi','2.0')
from gi.repository import Gio,GLib,Atspi
spec=importlib.util.spec_from_file_location('owned_portals',Path(__file__).with_name('test-owned-portals.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary',type=Path,required=True)
parser.add_argument('--model',type=Path,required=True)
parser.add_argument('--fixture',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
m.require_owned()
assert os.getuid()!=0,'Regular user required'
assert os.environ.get('WAYLAND_DISPLAY')=='openwhisper-owned' and os.environ.get('XDG_CURRENT_DESKTOP')=='KDE','Owned KWin required'
for path in [args.binary,args.model,args.fixture]:assert path.is_file(),'Missing candidate or public fixture'
root=args.output.resolve();root.mkdir(mode=0o700,parents=True,exist_ok=False)
(root/'input-sha256.json').write_text(json.dumps({str(path.resolve()):hashlib.sha256(path.read_bytes()).hexdigest() for path in [args.binary,args.model,args.fixture,Path(__file__),Path(__file__).with_name('test-owned-portals.py')]},indent=2)+'\n')
config=Path(os.environ['XDG_CONFIG_HOME'])/'whisperfree';config.mkdir(mode=0o700)
models=Path(os.environ['XDG_DATA_HOME'])/'whisperfree/models';models.mkdir(parents=True,mode=0o700)
(models/'ggml-tiny.bin').symlink_to(args.model.resolve())
(config/'settings.json').write_text(json.dumps(dict(model='tiny',language='en',ui_language='en',setup_completed=True,microphone='',output='paste',keep_history=True,gpu=False,gpu_configured=True,auto_check_updates=False)))
sink='openwhisper_kde_paste_'+str(os.getpid())
module=subprocess.check_output(['pactl','load-module','module-null-sink','sink_name='+sink,'rate=48000'],text=True).strip()
alsa=root/'alsa.conf';alsa.write_text('pcm.!default { type pulse device "'+sink+'.monitor" }\nctl.!default { type pulse }\n')
app_process=None;target_process=None
checks=[]
def passed(value):checks.append(value);print('PASS:',value,flush=True)
def focus(title):
    script=root/'focus-owned.js'
    script.write_text('for (const w of workspace.windowList()) { if (w.caption === '+json.dumps(title)+') workspace.activeWindow = w; }')
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    result=bus.call_sync('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','loadScript',GLib.Variant('(ss)',(str(script),'owned-paste-focus')),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None)
    number=result.unpack()[0]
    bus.call_sync('org.kde.KWin','/Scripting/Script'+str(number),'org.kde.kwin.Script','run',None,None,Gio.DBusCallFlags.NO_AUTO_START,5000,None)
    bus.call_sync('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript',GLib.Variant('(s)',('owned-paste-focus',)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None)
with m.PortalServices('kde',root/'portals') as services,(root/'app.log').open('w') as log:
    try:
        app_process=subprocess.Popen([str(args.binary.resolve())],env=os.environ|{'ALSA_CONFIG_PATH':str(alsa)},stdout=log,stderr=log,start_new_session=True)
        app=m.NativeUI(app_process)
        app.click('General');app.click('Allow');portal=services.ui()
        restore=m.wait_for(lambda:portal.find('Allow restoring on future sessions',roles=('check box',)),'Keyboard consent')
        if restore.get_state_set().contains(Atspi.StateType.CHECKED):portal.click('Allow restoring on future sessions',roles=('check box',))
        portal.click('Approve');m.wait_for(lambda:app.find('Revoke'),'Keyboard permission')
        passed('real KDE RemoteDesktop keyboard-only session approved without persistent restoration')
        target=root/'typing-target.py'
        title='OpenWhisper Owned Paste '+str(os.getpid())
        target.write_text('''import gi,pathlib,sys
gi.require_version("Gtk","3.0")
from gi.repository import Gtk
path=pathlib.Path(sys.argv[1]);path.write_text("");path.chmod(0o600)
window=Gtk.Window(title=sys.argv[2]);window.set_default_size(600,220)
view=Gtk.TextView();window.add(view);buffer=view.get_buffer()
buffer.connect("changed",lambda text:path.write_text(text.get_text(text.get_start_iter(),text.get_end_iter(),True)))
window.show_all();view.grab_focus();Gtk.main()
''')
        pasted=root/'pasted.txt'
        target_environment=os.environ.copy()
        inner_file=os.environ.get('WF_OWNED_XWAYLAND_ENV_FILE')
        if inner_file:
            inner=m.wait_for(lambda:json.loads(Path(inner_file).read_text()) if Path(inner_file).is_file() else None,'Private inner Xwayland environment')
            assert inner['DISPLAY'] and inner['DISPLAY']!=os.environ['DISPLAY']
            assert Path(inner_file).stat().st_uid==os.getuid()
            import stat
            number=inner['DISPLAY'].removeprefix(':').split('.')[0]
            assert number.isdigit()
            socket=Path('/tmp/.X11-unix')/('X'+number)
            assert stat.S_ISSOCK(socket.stat().st_mode) and socket.stat().st_uid==os.getuid()
            # KWin starts Xwayland lazily on its owned listening socket. Open an
            # inert display connection before verifying the actual descendant.
            probe_env=os.environ|{'DISPLAY':inner['DISPLAY'],'XAUTHORITY':inner['XAUTHORITY'] or ''}
            subprocess.run(['python3','-c',"import ctypes,os;lib=ctypes.CDLL('libX11.so.6');lib.XOpenDisplay.argtypes=[ctypes.c_char_p];lib.XOpenDisplay.restype=ctypes.c_void_p;lib.XCloseDisplay.argtypes=[ctypes.c_void_p];ptr=lib.XOpenDisplay(os.environ['DISPLAY'].encode());assert ptr;lib.XCloseDisplay(ptr)"],env=probe_env,check=True,timeout=15)
            bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
            compositor_pid=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',GLib.Variant('(s)',('org.kde.KWin',)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
            pending=[compositor_pid];seen=set();xwayland=None
            while pending and len(seen)<64:
                current=pending.pop()
                if current in seen:continue
                seen.add(current)
                proc=Path('/proc')/str(current)
                try:
                    assert proc.stat().st_uid==os.getuid()
                    argv=proc.joinpath('cmdline').read_bytes().decode().split('\0')[:-1]
                    if argv and Path(argv[0]).name=='Xwayland' and inner['DISPLAY'] in argv:
                        xwayland=(current,argv);break
                    pending.extend(int(value) for value in proc.joinpath('task',str(current),'children').read_text().split())
                except (FileNotFoundError,ProcessLookupError):pass
            assert xwayland,'Inner DISPLAY did not belong to the owned KWin descendant Xwayland'
            if inner['XAUTHORITY']:
                assert Path(inner['XAUTHORITY']).stat().st_uid==os.getuid()
                assert '-auth' in xwayland[1] and xwayland[1][xwayland[1].index('-auth')+1]==inner['XAUTHORITY']
            else:assert '-auth' not in xwayland[1],'Missing configured inner Xwayland cookie'
            (root/'inner-xwayland-ownership.json').write_text(json.dumps({'kwin_pid':compositor_pid,'xwayland_pid':xwayland[0],'argv':xwayland[1],'display':inner['DISPLAY'],'xauthority':inner['XAUTHORITY'],'uid':os.getuid()},indent=2)+'\n')
            target_environment.update(DISPLAY=inner['DISPLAY'],XAUTHORITY=inner['XAUTHORITY'],GDK_BACKEND='x11')
        target_process=subprocess.Popen(['python3',str(target),str(pasted),title],env=target_environment,stdout=log,stderr=log,start_new_session=True)
        m.wait_for(lambda:pasted.exists(),'Owned GTK target')
        time.sleep(.5);focus(title);time.sleep(.5)
        app.click('Start dictation');m.wait_for(lambda:app.find('Recording'),'Virtual recording')
        subprocess.run(['paplay','--device',sink,str(args.fixture.resolve())],check=True)
        time.sleep(.4);app.click('Recording')
        m.wait_for(lambda:pasted.read_text() if pasted.exists() else None,'Automatic paste into owned GTK target',timeout=90)
        text=pasted.read_text();history=json.loads((config/'history.json').read_text())
        assert history and 'country' in history[0].lower() and text==history[0], 'Recognized fixture differs from actual pasted text'
        assert subprocess.check_output(['wl-paste','--no-newline'],text=True,timeout=10)==text
        assert not list((config/'recovery').glob('*.wav')), 'Successful paste left recovery WAV'
        passed('public virtual speech is recognized and exactly pasted via actual portal Ctrl+V into the focused owned target')
        app.click('Revoke');m.wait_for(lambda:app.find('Allow'),'Revocation')
        passed('actual keyboard-session revocation returns Allow after successful paste')
    finally:
        m.stop_owned(target_process);m.stop_owned(app_process)
        subprocess.run(['pactl','unload-module',module],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        (root/'checks.json').write_text(json.dumps(checks,indent=2)+'\n')
