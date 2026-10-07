#!/usr/bin/env python3
"""Actual Plasma 6 tray Close/Show/Quit in a disposable owned 1100x750 KWin session.

Imports the common real-portal ownership guards. Only private EIS pointer events
are used; the rendered Qt popup is not exported in PlasmaShell's AT-SPI tree.
"""
import argparse,hashlib,importlib.util,json,os
from pathlib import Path
import shutil,subprocess,time
import gi
gi.require_version('Atspi','2.0')
from gi.repository import Gio,GLib,Atspi
spec=importlib.util.spec_from_file_location('owned_portals',Path(__file__).with_name('test-owned-portals.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
m.require_owned();assert os.getuid()!=0 and Path('/.dockerenv').is_file(),'Disposable non-root container required'
assert os.environ.get('XDG_CURRENT_DESKTOP')=='KDE' and os.environ.get('WAYLAND_DISPLAY')=='openwhisper-owned','Owned KWin required'
root=args.output.resolve();root.mkdir(mode=0o700,parents=True,exist_ok=False)
(root/'input-sha256.json').write_text(json.dumps({str(path.resolve()):hashlib.sha256(path.read_bytes()).hexdigest() for path in [args.binary,Path(__file__),Path(__file__).with_name('test-owned-portals.py'),Path(__file__).with_name('kde-test-input.py')]},indent=2)+'\n')
os.environ['QT_LINUX_ACCESSIBILITY_ALWAYS_ON']='1';os.environ['QT_ACCESSIBILITY']='1';os.environ['QT_QPA_PLATFORM']='wayland'
settings=Path(os.environ['XDG_CONFIG_HOME'])/'whisperfree';settings.mkdir();(settings/'settings.json').write_text(json.dumps(dict(model='tiny',language='en',ui_language='en',setup_completed=True,microphone='',output='clipboard',keep_history=True,gpu=False,gpu_configured=True,auto_check_updates=False)))
children=[];logs=[]
def spawn(name,argv):
    log=(root/(name+'.log')).open('w');logs.append(log)
    p=subprocess.Popen(argv,stdout=log,stderr=log,start_new_session=True);children.append(p);return p
def has_owner(name):
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    return bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','NameHasOwner',GLib.Variant('(s)',(name,)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
try:
    plugins=[]
    for directory in [Path('/usr/lib64/qt6/plugins/kf6/kded'),Path('/usr/lib/qt6/plugins/kf6/kded')]:
        plugins.extend(path.stem for path in directory.glob('*.so'))
    config=Path(os.environ['XDG_CONFIG_HOME'])/'kded6rc';config.write_text(''.join('[Module-'+module+']\nautoload=false\n' for module in plugins if module!='statusnotifierwatcher'))
    activity=m.PortalServices.executable('kactivitymanagerd')
    if activity:spawn('activities',[str(activity)])
    kded=spawn('kded',[shutil.which('kded6')])
    m.wait_for(lambda:has_owner('org.kde.kded6'),'Actual owned kded6')
    bus=Gio.bus_get_sync(Gio.BusType.SESSION,None)
    result=bus.call_sync('org.kde.kded6','/kded','org.kde.kded6','loadModule',GLib.Variant('(s)',('statusnotifierwatcher',)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    assert result,'Real statusnotifierwatcher module could not load'
    panel=spawn('plasmashell',[shutil.which('plasmashell'),'--no-respawn'])
    m.wait_for(lambda:has_owner('org.kde.StatusNotifierWatcher'),'Actual KDE StatusNotifierWatcher')
    m.wait_for(lambda:has_owner('org.kde.plasmashell'),'Actual owned PlasmaShell')
    # Minimal container package sets may have no distribution first-login panel.
    # Create an explicitly labelled owned layout using the real installed widgets.
    # This is not a replacement watcher or a default-layout acceptance claim.
    layout=bus.call_sync('org.kde.plasmashell','/PlasmaShell','org.kde.PlasmaShell','evaluateScript',
        GLib.Variant('(s)',('if (panels().length === 0) { var p = new Panel; p.location = "bottom"; p.height = 44; p.addWidget("org.kde.plasma.panelspacer"); p.addWidget("org.kde.plasma.systemtray"); p.addWidget("org.kde.plasma.digitalclock"); print("owned real-widget panel fixture"); } else { print("existing distribution panel"); }',)),
        None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    (root/'panel-layout.txt').write_text(layout+'\n')
    app_process=spawn('app',[str(args.binary.resolve())]);app=m.NativeUI(app_process)
    m.wait_for(lambda:app.find('Start dictation'),'App ready')
    def rendered_items():
        nodes=[]
        for node in m.NativeUI(panel).nodes():
            try:
                name=node.get_name()
                if 'OpenWhisper' in name:nodes.append({'role':node.get_role_name(),'name':name,'actions':node.get_action_iface().get_n_actions() if node.get_action_iface() else 0})
            except GLib.Error:pass
        return nodes
    nodes=m.wait_for(rendered_items,'Actual rendered application tray icon',timeout=30)
    (root/'panel-controls.json').write_text(json.dumps(nodes,indent=2)+'\n')
    assert nodes, "Actual rendered app tray icon is absent"
    response=bus.call_sync('org.kde.StatusNotifierWatcher','/StatusNotifierWatcher','org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.kde.StatusNotifierWatcher','RegisteredStatusNotifierItems')),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    (root/'registered-items.json').write_text(json.dumps(response,indent=2)+'\n')
    assert len(response)==1, "Expected one owned application tray item"
    close_script=root/'close-owned-window.js'
    close_script.write_text('for (const w of workspace.windowList()) { if (w.pid === '+str(app_process.pid)+' && w.caption === "OpenWhisper") w.closeWindow(); }')
    number=bus.call_sync('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','loadScript',GLib.Variant('(ss)',(str(close_script),'owned-app-close')),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    bus.call_sync('org.kde.KWin','/Scripting/Script'+str(number),'org.kde.kwin.Script','run',None,None,Gio.DBusCallFlags.NO_AUTO_START,5000,None)
    bus.call_sync('org.kde.KWin','/Scripting','org.kde.kwin.Scripting','unloadScript',GLib.Variant('(s)',('owned-app-close',)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None)
    time.sleep(.5);assert app_process.poll() is None,'Close exited despite actual owned panel'
    def showing():
        for node in app.nodes():
            try:
                if node.get_role_name()=='frame' and node.get_name()=='OpenWhisper':return node.get_state_set().contains(Atspi.StateType.SHOWING)
            except GLib.Error:pass
        return False
    assert not showing(),'Owned compositor close did not hide the application window'
    print('PASS: actual KDE tray host retains the app after owned compositor window close')
    panel_ui=m.NativeUI(panel)
    os.environ['WF_OWNED_TRIGGER_TEST']=os.environ['XDG_RUNTIME_DIR']
    input_spec=importlib.util.spec_from_file_location('owned_kde_input',Path(__file__).with_name('kde-test-input.py'));input_module=importlib.util.module_from_spec(input_spec);input_spec.loader.exec_module(input_module)
    inputs=input_module.Input(bus)
    def visible_icon():
        for node in panel_ui.nodes():
            try:
                if node.get_role_name()=='button' and node.get_name()=='OpenWhisper' and node.get_state_set().contains(Atspi.StateType.SHOWING):
                    component=node.get_component_iface()
                    if component:
                        bounds=component.get_extents(Atspi.CoordType.SCREEN)
                        if bounds.x>550 and 16<=bounds.width<=32 and 16<=bounds.height<=40:return node
            except GLib.Error:pass
        return None
    def click_visible_icon():
        node=m.wait_for(visible_icon,'Visible actual rendered Plasma tray icon')
        bounds=node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        (root/'visible-panel-icon.json').write_text(json.dumps({'x':bounds.x,'y':bounds.y,'width':bounds.width,'height':bounds.height})+'\n')
        inputs.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);time.sleep(.2)
        inputs.button(273,True);time.sleep(.1);inputs.button(273,False);time.sleep(.3)
        return node
    icon=m.wait_for(visible_icon,'Visible actual rendered Plasma tray icon')
    action=icon.get_action_iface()
    names=[action.get_action_name(index) for index in range(action.get_n_actions())]
    (root/'panel-actions.json').write_text(json.dumps(names)+'\n')
    click_visible_icon()
    shot = root/'panel.png'
    subprocess.run(['python3','-c', 'import gi,sys;gi.require_version("Gdk","3.0");from gi.repository import Gdk;window=Gdk.get_default_root_window();box=window.get_geometry();image=Gdk.pixbuf_get_from_window(window,0,0,box.width,box.height);image.savev(sys.argv[1],"png",[],[])',str(shot)],env=os.environ|{'GDK_BACKEND':'x11'},check=True)
    scoped_menus=[]
    for kind,ui in [('panel',panel_ui),('app',app)]:
        for node in ui.nodes():
            try:
                role=node.get_role_name()
                if 'menu' in role:scoped_menus.append({'owner':kind,'role':role,'name':node.get_name(),'showing':node.get_state_set().contains(Atspi.StateType.SHOWING)})
            except GLib.Error:pass
    (root/'menu-controls.json').write_text(json.dumps(scoped_menus,indent=2)+'\n')
    item=response[0]
    service=item[:item.index('/',1)];path=item[item.index('/',1):]
    owner_pid=bus.call_sync('org.freedesktop.DBus','/org/freedesktop/DBus','org.freedesktop.DBus','GetConnectionUnixProcessID',GLib.Variant('(s)',(service,)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    assert owner_pid==app_process.pid,'Rendered tray item belongs to another application'
    properties=bus.call_sync(service,path,'org.freedesktop.DBus.Properties','GetAll',GLib.Variant('(s)',('org.kde.StatusNotifierItem',)),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()[0]
    (root/'item-protocol.json').write_text(json.dumps({key:str(value) for key,value in properties.items() if key in ['Id','Title','Menu','ItemIsMenu','Status']},indent=2)+'\n')
    layout=bus.call_sync(service,str(properties['Menu']),'com.canonical.dbusmenu','GetLayout',GLib.Variant('(iias)',(0,-1,['label','visible','enabled'])),None,Gio.DBusCallFlags.NO_AUTO_START,5000,None).unpack()
    (root/'menu-layout.txt').write_text(repr(layout)+'\n')
    assert 'Open OpenWhisper' in repr(layout) and 'Quit' in repr(layout),'Owned application menu labels differ'
    # This actual PlasmaShell popup is rendered but not exported in its AT-SPI
    # tree. The fixed default 1100x750 owned panel provides a bounded pixel fixture.
    bounds=icon.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
    inputs.move(bounds.x+bounds.width/2+65,bounds.y-76);time.sleep(.1)
    inputs.button(272,True);time.sleep(.1);inputs.button(272,False)
    m.wait_for(showing,'Actual panel menu reopens app')
    print('PASS: actual rendered Plasma tray icon restores the same application window')
    time.sleep(1)
    icon=m.wait_for(visible_icon,'Visible Plasma tray icon')
    action=icon.get_action_iface()
    names=[action.get_action_name(index) for index in range(action.get_n_actions())]
    click_visible_icon()
    subprocess.run(['python3','-c', 'import gi,sys;gi.require_version("Gdk","3.0");from gi.repository import Gdk;window=Gdk.get_default_root_window();box=window.get_geometry();image=Gdk.pixbuf_get_from_window(window,0,0,box.width,box.height);image.savev(sys.argv[1],"png",[],[])',str(root/'quit-menu.png')],env=os.environ|{'GDK_BACKEND':'x11'},check=True)
    bounds=icon.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
    inputs.move(bounds.x+bounds.width/2+65,bounds.y-19);time.sleep(.1)
    inputs.button(272,True);time.sleep(.1);inputs.button(272,False)
    m.wait_for(lambda:app_process.poll() is not None,'Actual tray Quit')
    assert app_process.returncode==0,'Tray Quit did not exit cleanly'
    print('PASS: actual Plasma tray menu Quit exits the app cleanly')
    inputs.close()
    (root/'result.json').write_text(json.dumps({'status':'PASS','checks':['actual PlasmaShell icon registration/rendering','Close hides while tray host exists','rendered context menu opens the same app','rendered menu Quit exits cleanly'],'uid':os.getuid()},indent=2)+'\n')
finally:
    for child in reversed(children):m.stop_owned(child)
    for log in logs:log.close()
