# GNOME integration boundary

GNOME uses the common GlobalShortcuts and RemoteDesktop portal clients in `../shared/portals.rs`, clipboard helpers in `../shared/clipboard.rs`, and the in-window control when layer-shell is unavailable. No GNOME-specific native trigger adapter is implemented. Detect service capabilities rather than assuming support from the desktop name.

Acceptance is tracked in [GNOME validation](https://github.com/juferdinand/OpenWhisper/issues/5). These directories document adapter ownership and remaining work; they do not claim tested distribution support. Keep additional native bindings here when they are implemented, and keep reusable portal code in `../shared/`.

Never run unattended input injection on the real desktop. Use owned test sessions and fields; record manual checks separately.
