# Platform architecture

| Platform | Implementation | Status |
|---|---|---|
| macOS 14+ | Native Swift services + shared UI in WKWebView | Public DMG and ZIP releases |
| Linux x86_64 | Shared UI in Tauri 2 + Rust and C++ speech services | Source / AppImage / `.deb` development preview; see [validation status](LINUX.md#validation-status) |
| Windows | Not implemented | Future work |

Both implementations use `shared/models.json`, the same pinned whisper.cpp release, and
`shared/test-vectors.json`. The Rust core passes the same cleanup, vocabulary, and snippet cases
as Swift. The Linux C++ bridge exposes both Whisper and Parakeet; contexts belong to one worker.

The Linux settings follow the same Setup, General, Models, Snippets, History, and About order.
Its app icon is extracted unchanged from the existing Mac ICNS. `desktop/scripts/check-assets.py`
checks branding, section order, project version, and speech source tag agreement. Both apps load the same compiled HTML/CSS/JavaScript and bundled Inter font.
`desktop/src/bridge.ts` adapts Tauri IPC and the native WebKit reply handler. Mac recording,
hotkeys, output, storage, and signed updates remain native Swift services. The shared floating
recording UI is hosted in a non-activating NSPanel on macOS and a non-focusable native window
on Linux. Neither backend imposes a recording-duration cutoff. No local
HTTP server or remote content is used for the production settings UI. Native window decorations
and platform-specific permission dialogs are controlled by the operating system.

## OS integration

| Feature | macOS | Linux preview |
|---|---|---|
| Microphone | AVAudioEngine | CPAL / ALSA compatibility, with Rubato conversion to 16 kHz mono |
| Global trigger | CGEvent tap and Carbon fallback | GlobalShortcuts portal; no direct X11 fallback yet |
| Automatic insertion | Clipboard and CGEvent | Clipboard and keyboard-only RemoteDesktop portal session |
| Clipboard helper | NSPasteboard | `wl-copy` on Wayland, `xclip` on X11 |
| Background operation | Menu bar app | AppIndicator tray when the desktop displays it |
| Overlay | Shared floating UI in non-activating NSPanel | Shared floating UI; non-focusable layer-shell on compatible Wayland compositors, floating window on X11 |
| GPU | Metal | Optional, unverified Vulkan build; CPU is the tested baseline |
| Updates | Release ZIP with signing-identity verification | No updater yet |

Linux does not use unrestricted device input access, root helpers, or input-group membership.
Without suitable portals, the Record button and clipboard output remain the fallback. Portal
availability alone is not a successful permission or insertion test. See the [support matrix](LINUX.md).

## Next validation stages

1. Complete microphone, permission, shortcut, and insertion tests on CachyOS / KDE Wayland.
2. Verify packaging and installation on Ubuntu / Debian and Arch-family systems.
3. Test GNOME, Fedora KDE, and X11 independently; add a native X11 fallback if needed.
4. Validate the floating recording indicator on more compositors, GPU builds, and signed Linux updates.
5. Implement Windows-specific audio, shortcuts, insertion, packaging, and update verification.

Public Linux releases remain manual and separate from development artifacts. The public macOS
Release workflow remains unchanged in scope. See [Linux build instructions](LINUX.md#build-from-source).
