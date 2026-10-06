# Linux implementation and support

The Linux app in `desktop/` is available as source and public AppImage / `.deb` releases.
CI also provides development packages.
A working build does not by itself establish support for
global shortcuts, text insertion, microphone devices, or every desktop environment.

## First target

The first acceptance target is **CachyOS x86_64 with KDE Plasma 6 on Wayland and PipeWire**.
The development machine has a Ryzen 5 5600X, 64 GB of RAM, and an NVIDIA RTX 3060.
On 2026-10-05, host inspection confirmed KDE Plasma 6.7.5, PipeWire 1.6.9, and version 2
of both the GlobalShortcuts and RemoteDesktop portals. The native settings window launched
on this machine, and Whisper Tiny / Parakeet v3 q4 each transcribed the pinned upstream JFK
fixture twice with one loaded context. On 2026-10-06, the full native capture pipeline was also exercised
with a private virtual microphone, including a 126-second recording, cancellation, silence, and clipboard output.
This avoids recording the real microphone during automated checks.
The settings and floating recording control use the same custom UI, settings navigation, bundled font, and original icon
as macOS. Tauri hosts these assets on Linux; WKWebView hosts them on macOS.

## Compatibility targets

| Distribution family | Desktop/session | Target | Current evidence |
|---|---|---|---|
| CachyOS | KDE Plasma 6 / Wayland | Primary acceptance system | Native UI, virtual-microphone capture beyond two minutes, floating stop/cancel, both CPU engines, clipboard, and AppImage launch verified |
| Arch Linux and derivatives | KDE Plasma 6 / Wayland | Same integration path | Not yet tested |
| Ubuntu LTS and Debian | GNOME / Wayland | Portal integration, clipboard fallback | Not yet tested |
| Fedora | GNOME or KDE / Wayland | Portal integration, clipboard fallback | Not yet tested |
| Common desktop distributions | X11 | Record button, `xclip`, and available portals; no native X11 shortcut fallback yet | Not yet tested |
| wlroots compositors | Sway / Hyprland / Wayland | Capability-dependent integration | Not yet tested; no blanket support claim |
| Other architectures | ARM64 / 32-bit | Outside the initial release scope | No Linux packages yet |

Actual features depend on the desktop and its portal backend, not just the distribution name.
The app must report detected capabilities and any fallback it uses.

## Implemented features

- Tauri 2 with the shared English custom interface and a Rust backend. macOS renders the same
  UI assets with a native Swift bridge while preserving its existing services.
- Text cleanup, vocabulary correction, and snippets pass the existing shared test vectors.
- Uses the shared model catalog and the same pinned whisper.cpp source for Whisper and Parakeet.
  Model contexts stay loaded and inference is serialized. Version 0.2.2 includes Vulkan GPU acceleration
  with a portable CPU fallback. Hardware coverage is listed below; 0.2.1 packages remain CPU-only.
- Captures the selected microphone locally and converts audio to 16 kHz mono. Keeps recordings in
  memory. Includes error handling, a silence threshold and cancellation before transcription, with
  no fixed recording duration limit. Stop or cancel explicitly when finished. Audio is held in RAM, so longer recordings use more memory. Microphone acceptance testing is still required.
- KDE Plasma 6 supports direct keyboard capture, including single keys without Ctrl. On KDE
  Wayland, extra mouse buttons are supported; the middle button requires Plasma 6.3+. Saved
  bindings reconnect at startup. Other desktops use the GlobalShortcuts portal. Toggle and
  push-to-talk are supported; modifier-only KDE triggers use toggle mode. These direct bindings
  are a source change after 0.2.2 and are not included in the published 0.2.2 packages.
- For automatic pasting on Wayland, request keyboard control through the RemoteDesktop portal.
  Request keyboard access only; do not request screen capture. Clipboard output remains available
  if permission is denied or the backend is unsupported. Do not require root or input-group access.
- Tray controls remain available when the settings window is closed. The Linux app uses an
  in-window recording control and the same floating recording UI as macOS. KDE and other
  layer-shell Wayland compositors use `gtk-layer-shell` with keyboard focus disabled; X11 uses
  a non-focusable floating window. Unsupported compositors keep the in-window control.
- Store configuration and models in the user's XDG directories. Do not migrate or delete existing
  files without a documented migration. Avoid logging dictated text or private audio.
- Public Linux packages remain a manual action after desktop acceptance,
  with package checksums and accurate support notes. Release builds use a separate persistent Linux
  signing key, verified with the embedded public key and signed package version before installation.

## Validation status

The update restart correction was checked on 2026-10-06 in isolated X11 sessions on CachyOS.
An unmodified public 0.2.1 AppImage installed the public 0.2.2 package but failed to relaunch under
a transient systemd user service with the default `ExitType=main` / `KillMode=control-group`.
An isolated build of the corrected source, carrying test version 0.2.1, then installed that same
signed public 0.2.2 package and relaunched successfully, both directly and under that service.
The installed file matched the public package byte for byte; German UI, completed setup, model
storage, snippets, and history fixtures survived. No real microphone or user data was used.
Unit tests also check that process replacement preserves the PID and literal arguments. The
native WebKitGTK smoke test passes with the event loop returning before process replacement.
These checks do not replace Debian installation acceptance or a physical Wayland shortcut test.

Verified on the primary host:

- Shared multilingual processing vectors and 44.1 / 48 / 96 kHz resampling tests.
- TypeScript production build, Rust build, and Clippy without warnings.
- Native settings window on KDE Wayland with the NVIDIA compatibility workaround below.
- Floating recording indicator over other windows, including its stop and cancel controls.
- A 126-second uninterrupted CPAL recording through a private PipeWire/PulseAudio monitor source,
  explicitly cancelled after passing the old two-minute cutoff.
- Public speech fixture through native recording controls, CPAL, Whisper Tiny / Parakeet v3 q4,
  history, and the Wayland clipboard. Silent input does not add a history entry.
- Keyboard-only RemoteDesktop permission, GlobalShortcuts binding, and automatic insertion of
  the recognized public fixture into an owned native GTK Wayland text field.
- Real ALSA/PipeWire device enumeration and both version-2 portal interfaces.
- Whisper Tiny and Parakeet v3 q4 recognize the known JFK fixture twice per loaded context.
- The Linux PNG icon exactly matches the 256px image embedded in the macOS ICNS.
- Local installer, GTK application identity, and KDE taskbar desktop-file association.
- Ubuntu 22.04 CI `.deb` / AppImage builds, package checksums and launcher metadata; the downloaded
  AppImage also passes the native WebKitGTK UI smoke test and virtual-source recording,
  floating controls, Whisper recognition, silence, and clipboard checks on CachyOS.
- Shared UI tests cover both native adapters, every section in light/dark themes, minimum window
  size, original icon, bundled font, recording controls, and identical shared navigation rendering.
- macOS CI builds the universal app and verifies both settings and the non-activating recording
  panel in real WKWebView. This does not replace microphone/permission testing on a physical Mac.

Release 0.2.1 additionally passed its native UI/onboarding/language checks and virtual-source
recognition, floating controls, silence, and clipboard tests in an isolated X11 session on CachyOS.
The regular KDE desktop was locked during final verification, so this does not replace a fresh
KDE/Wayland permission check or physical microphone testing. The same source passed a 126-second
recording in that isolated session.

An updater-enabled test build carrying version 0.2.0 fetched the **public 0.2.1** release, verified it,
replaced its AppImage with the exact published SHA-256, and restarted successfully. German interface
language, dictation language, completed setup, snippets, history, and model storage survived; a second
check correctly reported the current version. This test build contained the new updater code: the
original public Linux 0.2.0 release still requires a manual first upgrade to 0.2.1.

Still required before calling a distribution fully supported:

- Actual microphone speech and device disconnect checks (virtual-source cancellation and silence pass).
- Permission denial, physical toggle / hold shortcut events, and session restart.
- Automatic insertion into XWayland apps and applications with nonstandard paste bindings.
- Installer, relaunch, tray behavior, and uninstall on each target distribution.
- AMD/Intel GPU validation and non-CachyOS desktop combinations.

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
sudo pacman -S --needed rust nodejs npm base-devel cmake python curl webkit2gtk-4.1 gtk3 libappindicator-gtk3 alsa-lib pipewire-alsa gtk-layer-shell wl-clipboard xclip vulkan-icd-loader shaderc
```

Ubuntu 22.04+ / Debian build dependencies (desktop validation is still pending):

```bash
sudo apt install build-essential cmake ninja-build pkg-config python3 curl libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libasound2-dev librsvg2-dev libssl-dev libgtk-layer-shell0 libvulkan-dev patchelf wl-clipboard xclip
python3 desktop/scripts/build-glslc.py
export PATH="$PWD/desktop/vendor/shaderc/bin:$PATH"
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
New packages and `make linux` include Vulkan. Install a Vulkan loader and a graphics driver with
Vulkan support (NVIDIA's driver, or the appropriate Mesa driver for AMD/Intel). Build dependencies
also include `glslc` and the Vulkan loader development library. Ubuntu 22.04 does not package
`glslc`; the commands above build it locally from checksum-pinned Shaderc sources and dependencies,
without changing the runtime distribution baseline. A recent distribution-provided `glslc` can
also be used. The build script downloads
checksum-pinned Khronos headers into `desktop/vendor/vulkan`; it does not install system packages.
Use `make linux LINUX_FEATURES=custom-protocol` for a CPU-only development build.

In **General → Appearance & system**, **Use GPU acceleration when available** is on by default.
The detected GPU is shown there. Existing CPU-only installations migrate to automatic GPU use;
a deliberate CPU choice in the new version is preserved. No detected GPU uses the CPU, and
recoverable GPU loading/inference errors retry the same captured audio on the CPU. A defective
driver that terminates the process cannot be recovered in-process.

On 2026-10-06, Whisper Tiny and Parakeet v3 q4 both recognized the public JFK fixture twice using
the **Vulkan0 backend on an NVIDIA RTX 3060 (12 GB, driver 615.71.09)**. The same Vulkan-enabled
build also passed repeated Whisper recognition with Vulkan disabled. AMD and Intel GPUs and
other drivers still need hardware acceptance. The first GPU inference can take longer while
shaders compile; CPU work for audio conversion and other orchestration is still expected.

**Launch at login** is available on both platforms from 0.2.2. On Linux it manages
only this user's XDG autostart file. AppImages use their persistent installed path, not a temporary
extraction path. Moving an AppImage requires turning this setting off and on at its new location.
No administrator access is needed. Automatic launch after a full desktop logout/login still needs
manual acceptance; creation, disabling, path escaping, and native IPC are covered by tests.
The installed AppImage also passed enabling/disabling through the native settings UI and launching
its generated desktop entry in an isolated X11 session on CachyOS.

### Native desktop acceptance test

After building, quit the running app and run this inside the graphical KDE Wayland session:

```bash
bash desktop/scripts/test-recognition.sh
python3 desktop/scripts/test-session.py
```

The session test needs Python PyGObject/AT-SPI, `pactl`, `paplay`, `gdbus`, and `wl-paste`.
It checks launcher reactivation, then uses isolated temporary settings/model paths and a private virtual audio monitor, never
the physical microphone. The default 126-second capture checks the former two-minute cutoff;
it also checks floating stop/cancel, silence, fixture transcription, and clipboard output.
It replaces the clipboard with the public upstream speech fixture. Temporary logs remain at the
printed path; the test app and virtual audio sink are stopped when the test exits.

Use `--model /path/to/model.bin --model-id parakeet-v3-q4` to check Parakeet. Add `--portals`
to request keyboard permission, bind the shortcut, and check insertion into a private GTK test
field. This optional check requires `qdbus6`, KDE, and approval of any desktop permission dialogs;
its shortcut binding can persist in KDE's settings. Launch it with the correct app identity:

```bash
systemd-run --user --wait --pipe --collect --unit=app-io.github.whisperfree \
  python3 "$PWD/desktop/scripts/test-session.py" --portals
```

Do not start a second instance while the test owns WhisperFree's application ID. A recording
test with a virtual source proves the capture/inference/output path, not physical microphone quality.

## First use

1. In **Models**, download a model and select **Use**.
2. In **General**, select the system default microphone and your usual language.
3. Click the recording control, speak, and click again. Inspect the result in **History**.
4. In **General**, click **Set trigger …**, then press and release a key or supported mouse button
   on KDE Plasma 6. Other desktops open their shortcut portal dialog.
5. For automatic insertion, choose **Allow** keyboard access and **Paste at the cursor**.
   This requests keyboard control only. No screen capture is requested.
6. Focus a text field in another app and try the shortcut. With clipboard output, paste manually.

On KDE Plasma 6, direct keyboard triggers do not require Ctrl or another modifier. A function
key such as F8 avoids reserving a letter used in normal typing. A single modifier (Ctrl, Alt,
Shift, or Super) activates on release and uses toggle mode; left/right variants are not
independently assignable. Reserved desktop shortcuts are rejected. Fn, DPI/profile buttons,
and vendor-specific mouse buttons work only if the hardware exposes them as supported input
events. Primary left/right clicks and scrolling are intentionally excluded.

On KDE Wayland, direct mouse capture supports Back, Forward, and other extra buttons;
Middle requires Plasma 6.3+. `kreadconfig6`, `kwriteconfig6`, and KWin's `buttonsrebind` plugin
must be available. The selected button is reserved for dictation while the app runs. Existing
KDE remappings are rejected rather than overwritten. WhisperFree registers a free internal
key chord and temporarily maps the chosen mouse button to it using KDE's configuration API.
A helper restores the mapping on normal exit or when the app crashes. Later user edits are
preserved. If the helper itself is forcibly killed (SIGKILL, including an entire process group),
its recovery file restores the mapping on the next app start; until then, remove that button's
mapping in KDE System Settings if necessary. **Remove trigger** also restores the normal binding.
No root, input-device access, or additional permission prompt is required for these KDE bindings.

**Desktop shortcut dialog** selects the portal alternative on KDE. Other desktops use it by
default; their recorder determines the accepted keys. Portal setup remains session-scoped and
must be enabled again after restart. WhisperFree suggests Ctrl+Alt+Space but does not require
Ctrl. Direct mouse capture on GNOME, Sway, Hyprland, and X11 is not implemented.

If your desktop has neither native shortcut support nor a shortcut portal, keep using the Record
button and clipboard output. No root,
`input` group membership, `evdev`, or `uinput` access is required. The app never disables Wayland
security controls. Linux custom model import, clipboard restoration, text
editor output and start/stop sounds are not implemented yet. The floating indicator
requires `gtk-layer-shell` on a Wayland compositor supporting layer-shell; GNOME does not
provide that protocol. Its availability is shown in General.

## Updates and first-run setup

From 0.2.1, release AppImages and Debian packages offer **About → Check now** and optional daily
checks. Installation is explicit. The updater requires an exact repository/tag/asset URL, a newer
X.Y.Z version, the embedded public key, and a matching cryptographically signed package version.
Tampered packages, foreign signatures, and replaying an old package as a newer version are rejected.

AppImages update in place and must be writable by the current user. Debian updates request system
authorization through `pkexec /usr/bin/dpkg --install`; a cancelled prompt is not retried using another
authentication mechanism. The Debian package name, version, and architecture are checked first.
The Debian authorization/install path still requires desktop acceptance on a Debian/Ubuntu machine.
Source/CI builds disable installation. Linux 0.2.0 users must install 0.2.1 manually once.
See [release signing](SIGNING.md#linux-update-signatures) for key continuity.

Use the sidebar to choose English or German independently of dictation language. Setup stays hidden
once completed and existing settings migrate as completed. Permissions and triggers are in General.
Updating the app preserves settings, models, snippets, and history; it does not rerun onboarding.
The Linux restart replaces the current process after native event-loop cleanup, keeping its PID
and any supervising AppImage parent alive. Spawning a child and exiting instead can cause a
systemd desktop service to stop the new process along with the old one.

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
If launch at login was enabled, also remove `~/.config/autostart/io.github.whisperfree.desktop`
(or the corresponding file below `$XDG_CONFIG_HOME`). Disabling it writes a `Hidden=true` override.

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
- **No global shortcut:** on KDE Plasma 6, set the trigger in **General**. Other desktops require
  the GlobalShortcuts portal; its initial suggestion is Ctrl+Alt+Space. Check for desktop conflicts.
- **Mouse button unavailable:** direct capture requires KDE Wayland and its configuration utilities.
  Buttons already remapped in KDE are rejected; hardware-only DPI/profile switches may not emit
  usable input events. After forcibly killing both app and helper, start WhisperFree again to
  recover its temporary mouse mapping.
- **No pasted text:** enable keyboard access in **General**, select paste output, and focus a text
  field. Targets with a different paste binding (including many terminals) may require manual paste.
- **Clipboard unavailable:** install `wl-clipboard` on Wayland or `xclip` on X11. You can also
  select text directly in **History**. Clipboard contents may be saved by your desktop’s clipboard manager.
- **No tray icon on GNOME:** support depends on the desktop’s AppIndicator integration. Keep the
  settings window open if a tray is unavailable; tray registration alone cannot prove it is visible.

## Known dependency risk

The GTK 3 dependency chain includes an open `glib` advisory. See the
[security policy](../SECURITY.md#known-linux-dependency-advisory) for the affected code, review scope,
and upstream constraint. Release publication does not mean the dependency graph is free of advisories.

## Packaging and release policy

CI on `main` builds development `.deb` and AppImage packages and retains artifacts for 14 days.
A main push does not change the version, create a tag, or publish a GitHub Release.
The manual Release workflow applies the requested version to both platform builds and runs them
in parallel. CI and Release call the same reusable Linux build workflow. After both platforms pass,
a publication job creates the version commit/tag, verifies both artifact checksum files, and uploads
all packages with combined checksums. There is no separate CI dispatch or manual Linux attachment.
The complete release is a draft by default so its AppImage can receive desktop acceptance before
publication. Public downloads use the stable asset names
`WhisperFree-Linux-x86_64.AppImage` and `WhisperFree-Linux-amd64.deb`; their internal version still
matches the tag. `SHA256SUMS` covers both Linux packages, signatures, update feed, and the macOS DMG/ZIP.
Publishing Linux packages does not establish support for untested distributions.

Both platforms currently share a version and public release. A platform-only fix can ship in the
next joint patch release; the other platform still receives the same version and shared UI.
Linux-only releases are technically possible, but require platform-aware update discovery first:
the macOS updater currently expects its ZIP in GitHub's latest release. Publishing a Linux-only
latest release would make that check fail. Keep both platform assets until the feeds are separated.

## References

- [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [GlobalShortcuts portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [KDE shortcut dialog](https://github.com/KDE/xdg-desktop-portal-kde/blob/master/src/GlobalShortcutsDialog.qml) and [key recorder patterns](https://api.kde.org/qml-org-kde-kquickcontrols-keysequenceitem.html)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [Pinned whisper.cpp source](https://github.com/ggml-org/whisper.cpp/tree/927cfce34f31707e17f2bff35c349632fb9e2c3a)

## Native KDE trigger regression test

After building with `make linux`, run:

```bash
python3 desktop/scripts/test-kde-triggers.py --binary desktop/target/release/whisperfree-desktop
```

This optional desktop test requires Plasma 6.3+, Xvfb, libei, Python PyGObject, and the KDE
configuration utilities. It creates a private D-Bus session, nested KWin, and disposable XDG
settings. Synthetic events are sent only to that owned compositor. It checks single keys,
modifier release behavior, middle/extra mouse buttons, conflicting shortcuts, EOF/SIGTERM cleanup,
SIGKILL recovery, and preservation of existing or later user mappings. It never opens a microphone.
The test passed with Plasma 6.7.5 on the primary host; it does not establish physical-device or
other-desktop coverage. The native GTK capture path was also exercised in an isolated Wayland session: key/mouse capture,
Escape cancellation, virtual-source toggle/push-to-talk recording, app-crash cleanup, saved binding restoration,
and trigger removal. Physical-device checks remain outstanding.
