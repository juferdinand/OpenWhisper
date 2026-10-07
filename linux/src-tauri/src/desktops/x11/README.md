# X11 desktop integration

`Service` owns a separate saved `x11_trigger`, explicit GTK keyboard capture, and a disposable
`--linux-x11-helper`. It is enabled only when GTK is actually using X11, never through a
Wayland session's XWayland display. Available KDE keyboard bindings remain the preferred adapter.
The Record button, common `xclip` delivery and recording recovery remain independent.

The helper uses passive `XGrabKey` bindings with Caps/Num/Scroll lock variants and checks each
binding for `BadAccess`. It releases only its own grabs on failure, EOF, SIGTERM or connection
loss; no desktop shortcut configuration is replaced. A selected regular key supports toggle or
actual-release hold mode through client-scoped detectable repeat. Modifier-only keys and mouse
buttons are not offered by this adapter. X11 temporarily grabs the keyboard while the selected
key is held; release the trigger before typing. A keymap/group change invalidates the binding.

Automatic paste requires the explicit **Allow** action for each app session and XTEST support.
It sends Ctrl+V to the focused application after clipboard delivery. Missing focus, unsupported
layout, a Ctrl+V trigger, or held/latched/locked input modifiers preserve clipboard output.
No screen capture, root privilege or raw input devices are used. The shared paste facade closes
the other backend before enabling this one, and serializes permission changes.

The local `KeyboardState` matches `X11/extensions/XKBstr.h`: `locked_group` is at offset 1,
`mods` at offset 6, and the record is 18 bytes. x11-dl 2.21.0 puts `locked_group` after the group
shorts, so its effective-modifier field reads the wrong byte. The ABI regression and owned
latched/locked-modifier checks guard this native boundary.

Primary contracts: [Xlib passive keyboard grabs](https://www.x.org/releases/current/doc/libX11/libX11/libX11.html),
[XKB lookup by group/modifier state](https://xorg.freedesktop.org/archive/X11R7.5/doc/man/man3/XkbLookupKeySym.3.html),
[XKB detectable repeat](https://xorg.freedesktop.org/archive/X11R7.5/doc/man/man3/XkbSetDetectableAutorepeat.3.html),
and [XTEST](https://www.x.org/releases/current/doc/libXtst/xtestlib.html).

Run `linux/scripts/test-x11-triggers.py` and `test-x11-session.py` only through the private
`run-owned-desktop.py --session x11` environment. The runner's optional `--x11-desktop` starts
actual Xfce, Cinnamon, MATE or Plasma sessions and identifies their window manager. Named
session buses activate only their packaged desktop services, excluding portals and host services.
Acceptance remains tracked in [X11 desktops validation #6](https://github.com/juferdinand/OpenWhisper/issues/6).
Record owned/synthetic and physical desktop evidence separately.
