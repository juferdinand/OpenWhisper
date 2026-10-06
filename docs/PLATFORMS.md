# Platform architecture

| Platform | Implementation | Status |
|---|---|---|
| macOS 14+ | Native Swift services + shared UI in WKWebView | Public DMG and ZIP releases |
| Linux x86_64 | Shared UI in Tauri 2 + Rust and C++ speech services | Source / AppImage / `.deb` preview; see [validation status](LINUX.md#validation-status) |
| Windows | Not implemented | Future work |

Both implementations use `shared/models.json`, the same pinned whisper.cpp release, and
`shared/test-vectors.json`. The Rust core passes the same cleanup, vocabulary, and snippet cases
as Swift. The Linux C++ bridge exposes both Whisper and Parakeet; contexts belong to one worker.

Both platforms share General, Models, Snippets, History, and About, with Setup shown only until
first-run completion. The shared English/German language choice also applies to native menus.
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
| GPU | Metal | Vulkan in new builds; RTX 3060 tested with both engines; CPU fallback |
| Launch at login | ServiceManagement, including pending approval | Per-user XDG autostart in new builds |
| Updates | Release ZIP with signing-identity verification | Signed, version-bound AppImage/Debian updates (0.2.1+) |

Linux does not use unrestricted device input access, root helpers, or input-group membership.
Without suitable portals, the Record button and clipboard output remain the fallback. Portal
availability alone is not a successful permission or insertion test. See the [support matrix](LINUX.md).

## Next validation stages

1. Complete microphone, permission, shortcut, and insertion tests on CachyOS / KDE Wayland.
2. Verify packaging and installation on Ubuntu / Debian and Arch-family systems.
3. Test GNOME, Fedora KDE, and X11 independently; add a native X11 fallback if needed.
4. Validate the floating recording indicator on more compositors, GPU builds, and signed Linux updates.
5. Implement Windows-specific audio, shortcuts, insertion, packaging, and update verification.

Public Linux previews require desktop acceptance of the release packages. The manual Release
workflow builds macOS and Linux in parallel, then creates the version commit/tag and uploads both
platforms with combined checksums only after both builds pass. It prepares a complete draft by default
for desktop acceptance before publication. See [Linux release policy](LINUX.md#packaging-and-release-policy).
