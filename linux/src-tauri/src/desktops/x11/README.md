# X11 desktops integration boundary

X11 uses `xclip` through `../shared/clipboard.rs` and the window fallback in `../shared/overlay.rs`. KDE may additionally expose KGlobalAccel. Other X11 desktops have no separate native global trigger or input-injection adapter; keep the Record button, transcript and clipboard usable.

Acceptance is tracked in [X11 desktops validation](https://github.com/juferdinand/OpenWhisper/issues/6). These directories document adapter ownership and remaining work; they do not claim tested distribution support. Keep additional native bindings here when they are implemented, and keep reusable portal code in `../shared/`.

Never run unattended input injection on the real desktop. Use owned test sessions and fields; record manual checks separately.
