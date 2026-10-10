# Linux installation and evidence

OpenWhisper 0.3.1 provides x86_64 AppImage and Debian packages. Download them from the
[official Releases page](https://github.com/juferdinand/OpenWhisper/releases) and verify against
the release `SHA256SUMS`.

Run the AppImage:

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
```

If FUSE is unavailable, prefix the launch command with `APPIMAGE_EXTRACT_AND_RUN=1`. On Debian or
Ubuntu, install the package:

```bash
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

If upgrading from the original 0.2.5 app, download and install 0.3.1 manually. The original app's
GUI updater has not been demonstrated to update to Electron. A Debian package transition component
was checked against the exact signed 0.2.5 and 0.3.0 packages on one pinned Kubuntu 24 baseline;
this does not establish a GUI update or behavior on every distribution. Back up needed data before
changing installations. The old per-user installer applies only to the 0.2.5 AppImage; see its
[immutable source](https://raw.githubusercontent.com/juferdinand/OpenWhisper/d69b43bf6e7017c61089e117e79af34f57f297c4/linux/scripts/install-release.py).
Historical native-host documentation and evidence are preserved in the
[0.2.5 source snapshot](https://github.com/juferdinand/OpenWhisper/blob/d69b43bf6e7017c61089e117e79af34f57f297c4/docs/LINUX.md).

## Validation scope

Automated checks cover private virtual audio, CPU recognition, clipboard/history, recording
recovery controls, and owned package/runtime workflows. Nested KDE Wayland and X11 checks apply
only to the exact owned profiles recorded by CI. They do not establish physical-device behavior,
all GPUs, compositor versions, or distributions. Scoped GPU evidence is listed below. The suite
never uses the user's microphone, desktop sockets, audio session, or input devices.

For current package and test details, see [release status](ELECTRON-STATUS.md). To build locally,
use the project commands; these produce build output and do not install the app:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
make linux
```

## Linux 0.3.1

[Issue #43](https://github.com/juferdinand/OpenWhisper/issues/43) restores Vulkan plus a manual
CPU choice in Linux x86_64 recording builds, enables the native Wayland recording surface on
normal launches, and restores KDE mouse triggers. These changes are included in 0.3.1. Wayland
controls need GTK 3, gtk-layer-shell and the compositor's layer-shell protocol. Runtime initialization failures and missing protocol
support have distinct explanations; the main recording controls remain usable.

KDE mouse triggers require KWin 6 Wayland, its loaded button-rebinding plugin, and an available
action-free F19 or F24 key in the actual compositor keymap. Middle-button rebinding requires
Plasma 6.3+. Conflicting mappings are refused, later edits are preserved, and temporary mappings
are restored on removal, shutdown or dead-owner recovery. Remove the current trigger before
choosing a different mouse button. A layout without a safe surrogate leaves mouse setup disabled.

Owned checks cover the default overlay with Stop/Cancel and retained editor focus on KDE 5.27;
mouse binding/cleanup on Arch and openSUSE KWin 6.7.5; and synthetic middle-button dispatch on
Arch. The Fedora 43 fixture refused mouse binding because it lacked a safe surrogate. Injected
side-button dispatch remains unproven in the nested fixture. Native CPU/Vulkan recognition of
public test audio passed on one CachyOS host GPU; this does not establish every driver or model.

The compact recording controls keep status copy out of the timer/button layout in English and
German. Setup is shown only until completion, with inline model and microphone selection;
completion survives restarts. Recording admission covers GPU configuration, missing models and
saved-audio retry without opening a microphone. A 61-minute synthetic regression checks bounded
inference retries and complete final-sample coverage; CPU recognition also processed 30 minutes
of repeated public test audio. These checks do not establish a physical microphone session or
every model/backend combination.

Renderer checks:

```bash
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
```

Linux update signatures use a persistent version-bound key distinct from the macOS certificate.
Preserve its public key and validation policy; details are in [release signing](SIGNING.md). Report
security issues privately through the [GitHub security advisory form](https://github.com/juferdinand/OpenWhisper/security/advisories/new).
