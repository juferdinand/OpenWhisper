# Linux implementation and support

The Linux app in `desktop/` is an early source-build preview. A working build does not by itself establish support for
global shortcuts, text insertion, microphone devices, or every desktop environment.

## First target

The first acceptance target is **CachyOS x86_64 with KDE Plasma 6 on Wayland and PipeWire**.
The development machine has a Ryzen 5 5600X, 64 GB of RAM, and an NVIDIA RTX 3060.
On 2026-10-05, host inspection confirmed KDE Plasma 6.7.5, PipeWire 1.6.9, and version 2
of both the GlobalShortcuts and RemoteDesktop portals. The native settings window launched
on this machine, and Whisper Tiny / Parakeet v3 q4 each transcribed the pinned upstream JFK
fixture twice with one loaded context. Microphone and cross-application tests remain separate.
The settings use the same custom UI, six-section navigation, bundled font, and original icon
as macOS. Tauri hosts these assets on Linux; WKWebView hosts them on macOS.

## Compatibility targets

| Distribution family | Desktop/session | Target | Current evidence |
|---|---|---|---|
| CachyOS | KDE Plasma 6 / Wayland | Primary acceptance system | Native window, audio device enumeration, portal interfaces, and CPU fixture recognition verified |
| Arch Linux and derivatives | KDE Plasma 6 / Wayland | Same integration path | Not yet tested |
| Ubuntu LTS and Debian | GNOME / Wayland | Portal integration, clipboard fallback | Not yet tested |
| Fedora | GNOME or KDE / Wayland | Portal integration, clipboard fallback | Not yet tested |
| Common desktop distributions | X11 | Record button, `xclip`, and available portals; no native X11 shortcut fallback yet | Not yet tested |
| wlroots compositors | Sway / Hyprland / Wayland | Capability-dependent integration | Not yet tested; no blanket support claim |
| Other architectures | ARM64 / 32-bit | Outside the initial release scope | No Linux packages yet |

Actual features depend on the desktop and its portal backend, not just the distribution name.
The app must report detected capabilities and any fallback it uses.

## Implemented preview

- Tauri 2 with the shared English custom interface and a Rust backend. macOS renders the same
  UI assets with a native Swift bridge while preserving its existing services.
- Text cleanup, vocabulary correction, and snippets pass the existing shared test vectors.
- Uses the shared model catalog and the same pinned whisper.cpp source for Whisper and Parakeet.
  Model contexts stay loaded and inference is serialized. CPU support is the baseline; GPU acceleration
  is optional and must be tested separately.
- Captures the selected microphone locally and convert audio to 16 kHz mono. Keep recordings in
  memory. Includes error handling, a silence threshold, cancellation before transcription, and
  a two-minute recording limit. Microphone acceptance testing is still required.
- Uses the GlobalShortcuts portal when available. Offers toggle and hold-to-record when release
  events are available. Provide clear setup and failure states rather than silently ignoring keys.
- For automatic pasting on Wayland, request keyboard control through the RemoteDesktop portal.
  Request keyboard access only; do not request screen capture. Clipboard output remains available
  if permission is denied or the backend is unsupported. Do not require root or input-group access.
- Tray controls remain available when the settings window is closed. The preview uses an
  in-window recording control; a separate floating overlay is not implemented.
- Store configuration and models in the user's XDG directories. Do not migrate or delete existing
  files without a documented migration. Avoid logging dictated text or private audio.
- Start with local builds and development packages. Public Linux releases remain a manual action,
  with package checksums and accurate support notes. Linux auto-update needs its own verified
  distribution design; do not reuse the macOS certificate checks as if they applied to Linux.

## Validation status

Verified on the primary host:

- Shared multilingual processing vectors and 44.1 / 48 / 96 kHz resampling tests.
- TypeScript production build, Rust build, and Clippy without warnings.
- Native settings window on KDE Wayland with the NVIDIA compatibility workaround below.
- Real ALSA/PipeWire device enumeration and both version-2 portal interfaces.
- Whisper Tiny and Parakeet v3 q4 recognize the known JFK fixture twice per loaded context.
- The Linux PNG icon exactly matches the 256px image embedded in the macOS ICNS.

Still required before calling a distribution fully supported:

- Actual microphone speech, cancellation, silence, and device disconnect checks.
- Portal grant / denial, toggle / hold shortcut events, and session restart.
- Clipboard and automatic insertion into both native Wayland and XWayland apps.
- Installer, relaunch, tray behavior, and uninstall on each target distribution.
- GPU builds and non-CachyOS desktop combinations.

## Acceptance checks

1. Pass the shared multilingual text-processing cases and Linux backend tests.
2. Build on the primary host and a conservative Linux CI baseline using locked dependencies.
3. Launch the native app on KDE Wayland, enumerate the real microphone, and check permission flows.
4. Transcribe known audio with Whisper and Parakeet; then test an actual microphone recording.
5. Exercise start, stop, cancel, silence, and repeated dictations without reloading the model.
6. Check shortcuts, release events, clipboard output, and insertion into both a native Wayland app
   and an XWayland app. Explicitly test permission denial and unavailable portals.
7. Verify that recording and the overlay do not steal focus from the target text field.
8. Test installation, relaunch, persistence, and uninstall behavior before claiming distro support.

## Build from source

Initial scope: x86_64 Linux with GTK 3, WebKitGTK 4.1, an ALSA-compatible microphone service,
and a graphical desktop session. PipeWire through its ALSA compatibility layer is the primary
path. The source build was checked with Rust 1.99.0 and Node 26; CI uses Rust 1.99.0 and Node 22.
Install Rust/Cargo, Node.js/npm, Python 3, a C++ compiler, CMake, pkg-config, and curl first.

CachyOS / Arch build and runtime dependencies:

```bash
sudo pacman -S --needed rust nodejs npm base-devel cmake python curl webkit2gtk-4.1 gtk3 libappindicator-gtk3 alsa-lib pipewire-alsa wl-clipboard xclip
```

Ubuntu 22.04+ / Debian build dependencies (desktop validation is still pending):

```bash
sudo apt install build-essential cmake pkg-config python3 curl libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libasound2-dev librsvg2-dev libssl-dev patchelf wl-clipboard xclip
```

Install a current Rust toolchain and Node.js separately if the distribution packages are too old.
For Wayland shortcuts and automatic pasting, install `xdg-desktop-portal` and the backend for
your actual desktop, such as `xdg-desktop-portal-kde`. Merely installing a backend does not
establish that all its portal interfaces work in your session.

From the repository root:

```bash
make linux-test
make linux
make linux-install
```

The local installer needs no root access. It places the executable and licenses under
`~/.local/lib/whisperfree`, and an application launcher and the original Mac icon under
`$XDG_DATA_HOME` (default `~/.local/share`). Open WhisperFree from your application launcher.
`make linux-run` runs the build directly. Builds made on a rolling distribution are not portable
binaries for older distributions; the CI package baseline is Ubuntu 22.04.

For development: run `bash desktop/scripts/fetch-native.sh`, then `npm ci` and
`npm run tauri dev` inside `desktop/`. For the known-audio smoke test, install `ffmpeg` and run
`bash desktop/scripts/test-recognition.sh`; this downloads the checksum-pinned Whisper Tiny model.
An optional `--features vulkan` build is experimental and needs Vulkan headers, a shader compiler,
and a working Vulkan driver. The default CPU build does not require a GPU.

## First use

1. In **Models**, download a model and select **Use**.
2. In **General**, select the system default microphone and your usual language.
3. Click the recording control, speak, and click again. Inspect the result in **History**.
4. In **Setup**, use **Set trigger …** to request a desktop-managed shortcut.
5. For automatic insertion, choose **Allow** keyboard access and **Paste at the cursor**.
   This requests keyboard control only. No screen capture is requested.
6. Focus a text field in another app and try the shortcut. With clipboard output, paste manually.

Portal setup is session-scoped in this preview; enable it again after restarting the app.
If your desktop lacks a portal, keep using the Record button and clipboard output. No root,
`input` group membership, `evdev`, or `uinput` access is required. The app never disables Wayland
security controls. Linux automatic updates, custom model import, clipboard restoration, text
editor output, start/stop sounds, autostart, and the floating overlay are not implemented yet.

## Data storage

- Models: `$XDG_DATA_HOME/whisperfree/models` (default `~/.local/share/whisperfree/models`).
- Preferences and snippets: `$XDG_CONFIG_HOME/whisperfree/settings.json`.
- Optional last 20 transcripts: `$XDG_CONFIG_HOME/whisperfree/history.json`.
  History is enabled by default, as on macOS. Turning it off clears saved history.
- Configuration defaults to `~/.config/whisperfree`. App-created directories use mode 0700;
  settings, history, and model downloads use mode 0600. Audio remains in memory.
- Model downloads use HTTPS, validate the server’s SHA-256 and file size, and rename completed
  files atomically. The hash verifies transfer integrity; it does not independently authenticate
  the model publisher. Interrupted downloads do not replace an installed model.

Uninstall the local build by removing the app’s executable directory, desktop entry, and icon
listed above. Settings and models remain until you deliberately delete their separate directories.
There is no service or launch-at-login entry to remove.

## Troubleshooting

Run `~/.local/lib/whisperfree/whisperfree-desktop --diagnose` to report the session, input devices,
portal versions, clipboard helper, and whether Vulkan was compiled in. It does not record audio
or print your settings, transcripts, or model contents. Device names can still be identifying;
review them before posting diagnostics publicly.

- **NVIDIA + Wayland startup failure:** WebKitGTK can fail with `Error 71 (Protocol error)`.
  On hosts with the NVIDIA kernel driver and a Wayland session, WhisperFree sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` before GTK starts unless the user already set it.
  This changes UI rendering, not speech inference. It fixed startup on the primary host.
  See the [upstream WebKit report](https://bugs.webkit.org/show_bug.cgi?id=324551).
- **No microphone signal:** choose **System default**, then select the intended input in your
  desktop’s audio settings. On PipeWire systems, check that ALSA compatibility is installed.
  ALSA’s device list can include compatibility endpoints that are not physical microphones.
- **No global shortcut:** check the GlobalShortcuts capability in **General**. The initial
  preferred combination is Ctrl+Alt+Space; the desktop chooses and manages the actual binding.
- **No pasted text:** enable keyboard access in **Setup**, select paste output, and focus a text
  field. Targets with a different paste binding (including many terminals) may require manual paste.
- **Clipboard unavailable:** install `wl-clipboard` on Wayland or `xclip` on X11. You can also
  select text directly in **History**. Clipboard contents may be saved by your desktop’s clipboard manager.
- **No tray icon on GNOME:** support depends on the desktop’s AppIndicator integration. Keep the
  settings window open if a tray is unavailable; tray registration alone cannot prove it is visible.

## Packaging and release policy

CI on `main` builds development `.deb` and AppImage packages and retains artifacts for 14 days.
A main push does not change the version, create a tag, or publish a GitHub Release. Linux is not
added to the public Release workflow until installation and desktop acceptance checks pass.
The macOS workflow remains manual. Its version step also synchronizes the Linux manifests.

## References

- [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [GlobalShortcuts portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [Pinned whisper.cpp source](https://github.com/ggml-org/whisper.cpp/tree/927cfce34f31707e17f2bff35c349632fb9e2c3a)
