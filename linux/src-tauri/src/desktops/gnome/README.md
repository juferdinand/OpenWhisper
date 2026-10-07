# GNOME integration boundary

GNOME uses the common GlobalShortcuts and RemoteDesktop portal clients in `../shared/portals.rs`, clipboard helpers in `../shared/clipboard.rs`, and the in-window control when layer-shell is unavailable. No GNOME-specific native trigger adapter is implemented. Detect service capabilities rather than assuming support from the desktop name.

Acceptance is tracked in [GNOME validation](https://github.com/juferdinand/OpenWhisper/issues/5). These directories document adapter ownership and remaining work; they do not claim tested distribution support. Keep additional native bindings here when they are implemented, and keep reusable portal code in `../shared/`.

Never run unattended input injection on the real desktop. Use owned test sessions and fields; record manual checks separately.

The common client registers the persistent application identifier on its portal connection when the host Registry interface is available. This covers direct launches that have no systemd application scope; registration identifies the application and does not grant keyboard or shortcut permission.

Creating an AppIndicator does not prove that GNOME displays a tray. Closing the settings window hides it only while a running StatusNotifier watcher reports a registered host. Otherwise Close quits the application. If the host disappears while the window is hidden, the window is shown again. Watcher polling resolves an existing unique bus owner and never activates an absent panel service.

Actual Debian 13 portal testing exposed an upstream `xdg-desktop-portal-gnome` 48.0 binding error after successful consent: its success callback leaves the response status uninitialized. The [49.0 implementation](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/49.0/src/globalshortcuts.c) sets the success status explicitly. OpenWhisper treats unsuccessful responses as failed setup and closes that new session, so it cannot leave a binding active without its signal monitor. Use the in-window control or an ordinary GNOME custom shortcut when the stock portal fails; do not interpret an error response as a permission grant.

For an ordinary GNOME custom shortcut, point its command to the installed executable with
`--control toggle`, or use separate `--control start` and `--control stop` bindings.
`--control cancel` discards the current recording. The app must already be running:
these commands use its authenticated service on the current session bus. A custom
shortcut does not grant automatic-paste permission; clipboard output remains usable
without a RemoteDesktop grant. The owned regression in
`linux/scripts/test-gnome-custom-shortcuts.py` uses the installed GNOME media-key daemon
and private settings, virtual input and audio rather than replacing the daemon with a mock.
