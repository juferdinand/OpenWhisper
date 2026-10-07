# Platform architecture

| Platform | Implementation | Status |
|---|---|---|
| macOS 14+ | Native Swift services + shared UI in WKWebView | Public DMG and ZIP releases |
| Linux x86_64 | Shared UI in Tauri 2 + Rust and C++ speech services | Source / AppImage / `.deb` releases; see [validation status](LINUX.md#validation-status) |
| Windows | Not implemented | Future work |

Both implementations use `shared/models.json`, the same pinned whisper.cpp release, and
`shared/test-vectors.json`. The Rust core passes the same cleanup, vocabulary, and snippet cases
as Swift. The Linux C++ bridge exposes both Whisper and Parakeet; contexts stay on one thread
in a disposable speech helper process. The Rust worker saves stopped audio before inference,
retries failed sections with smaller windows and CPU fallback, and supports recovery after restart.

Both platforms share General, Models, Snippets, History, and About, with Setup shown only until
first-run completion. The shared English/German language choice also applies to native menus.
Its app icon is extracted unchanged from the existing Mac ICNS. `linux/scripts/check-assets.py`
checks branding, section order, project version, and speech source tag agreement. Both apps load the same compiled HTML/CSS/JavaScript and bundled Inter font.
`shared/ui/src/bridge.ts` adapts Tauri IPC and the native WebKit reply handler. Mac recording,
hotkeys, output, storage, and signed updates remain native Swift services. The shared floating
recording UI is hosted in a non-activating NSPanel on macOS and a non-focusable native window
on Linux. Neither backend imposes a recording-duration cutoff. No local
HTTP server or remote content is used for the production settings UI. Native window decorations
and platform-specific permission dialogs are controlled by the operating system.

## OS integration

The Linux KDE adapter detects KWin/KGlobalAccel capabilities at runtime, independently of the
distribution name. Other KDE distributions can use it when the required Plasma services exist;
their installation and desktop acceptance are still separate tests.

The integration table describes current source and development builds. Native X11 keyboard
triggers, session-only X11 paste, compositor command control, and tray-host detection are
newer than the published 0.2.4 packages. See the [Linux validation matrix](LINUX.md#validation-status)
for exact build/package evidence and the distinction between owned and physical sessions.

| Feature | macOS | Linux |
|---|---|---|
| Microphone | AVAudioEngine | CPAL / ALSA compatibility, with Rubato conversion to 16 kHz mono |
| Global trigger | CGEvent tap and Carbon fallback | KDE Plasma 6 keys and KDE Wayland mouse buttons; native X11 keyboard fallback; GlobalShortcuts portals |
| User-configured command bindings | Native hotkey setup | `--control toggle` or explicit `start`/`stop` for the existing app on the current user's session bus; no activation |
| Automatic insertion | Clipboard and CGEvent | Keyboard-only RemoteDesktop portal sessions; separately enabled session-only X11 Ctrl+V paste |
| Clipboard helper | NSPasteboard | `wl-copy` on Wayland, `xclip` on X11 |
| Background operation | Menu bar app | AppIndicator tray with registered-host detection; close hides only with a host, and host loss restores a hidden window |
| Overlay | Shared floating UI in non-activating NSPanel | Shared floating UI; non-focusable layer-shell on compatible Wayland compositors, floating window on X11 |
| GPU | Metal | Vulkan in new builds; RTX 3060 tested with both engines; CPU fallback |
| Launch at login | ServiceManagement, including pending approval | Per-user XDG autostart in new builds |
| Updates | Release ZIP with signing-identity verification | Signed, version-bound AppImage/Debian updates (0.2.1+) |

Linux does not use unrestricted device input access, root helpers, or input-group membership.
On an actual X11 session, explicit key setup uses a disposable helper with conflict-preserving
Xlib grabs and real release edges. KDE remains preferred when its adapter is available.
The saved X11 and KDE trigger profiles remain separate; an inactive profile does not change
the active backend's recording-mode restrictions. XWayland on a Wayland session does not
enable the native X11 fallback. X11 paste requires an explicit Allow action for each app session
and preserves held, latched, and locked modifiers instead of forcing an unsafe paste.

Wayland compositors without suitable shortcut portals can bind `openwhisper-desktop --control toggle`
or explicit `start`/`stop` commands themselves. Open the app normally first; the command client
contacts only its existing same-user session-bus owner and never launches or activates it.
The other commands are `cancel` and `status`; status contains no transcript or audio.
AppImage bindings must use the permanent installed path. The Record button and clipboard
output remain available when desktop input integration is missing or denied. Portal
availability alone is not a successful permission or insertion test. See the [support matrix](LINUX.md).

## Next validation stages

The [roadmap](ROADMAP.md) tracks the desktop test work and optional application integrations.

1. Complete microphone, permission, shortcut, and insertion tests on CachyOS / KDE Wayland.
2. Verify packaging and installation on Ubuntu / Debian and Arch-family systems.
3. Extend exact-package acceptance on GNOME, Fedora KDE, Xfce, Cinnamon, MATE, KDE X11, and wlroots compositors; keep owned and physical checks separate.
4. Validate the floating recording indicator on more compositors, GPU builds, and signed Linux updates.
5. Implement Windows-specific audio, shortcuts, insertion, packaging, and update verification.

Public Linux releases require desktop acceptance of the release packages. The manual Release
workflow builds macOS and Linux in parallel, then creates the version commit/tag and uploads both
platforms with combined checksums only after both builds pass. It prepares a complete draft by default
for desktop acceptance before publication. See [Linux release policy](LINUX.md#packaging-and-release-policy).

## Source ownership

| Source | Responsibility | Host ownership |
| --- | --- | --- |
| `shared/` | Model catalog, speech fixtures, English/German strings | Both hosts |
| `shared/ui/src/`, `shared/ui/public/` | Settings and floating recording UI, icon, font | Both hosts; macOS Makefile builds these assets too |
| `shared/ui/src/bridge.ts` | Tauri/native WebKit IPC adaptation | Both hosts |
| `macos/Sources/` | Audio, triggers, output, windows, storage, signed updates | macOS |
| `linux/src-tauri/src/` | Audio, worker/recovery, windows, storage, signed updates | Linux host |
| `linux/src-tauri/src/desktops/kde/` | KGlobalAccel/KWin capability detection and mouse leases | KDE adapter |
| `linux/src-tauri/src/desktops/x11/` | Explicit GTK keyboard setup, helper-owned Xlib/XKB grabs and session-only XTEST paste | Actual X11 sessions; independent of the KDE trigger schema |
| `linux/src-tauri/src/desktops/shared/portals.rs` | Shortcut and keyboard portals | Common Linux integration; capabilities vary by desktop |
| `linux/src-tauri/src/desktops/shared/portal_capabilities.rs` | Bounded interface/property probes | Common Linux capability detection |
| `linux/src-tauri/src/desktops/shared/paste.rs` | Mutually exclusive portal/native paste facade | Common Linux output integration |
| `linux/src-tauri/src/desktops/shared/control.rs` | Bounded same-user commands for an already running app | Common Linux integration; user-configured compositor bindings |
| `linux/src-tauri/src/desktops/shared/tray.rs` | Registered tray-host detection and hidden-window recovery | Common Linux window lifecycle |
| `linux/src-tauri/src/desktops/shared/overlay.rs` | Layer-shell or X11 overlay with in-window fallback | Common Linux window integration |
| `linux/src-tauri/src/desktops/shared/clipboard.rs` | Wayland/X11 clipboard helpers | Common Linux integration |
| `linux/crates/`, `linux/native/` | Rust processing/speech wrappers and pinned C++ sources | Linux build today; speech engines and fixtures shared with macOS |

GNOME, Sway, and Hyprland use shared Linux services where their capabilities are available;
X11 additionally has its own keyboard/paste adapter. These boundaries do not establish full
desktop support. Future adapters should implement small capability-specific services for
triggers, insertion, and overlays. Keep one settings
layout and common recording/recovery logic. The [architecture roadmap](ROADMAP.md#platform-structure-and-electron)
records the implemented source split and the remaining desktop validation work.
