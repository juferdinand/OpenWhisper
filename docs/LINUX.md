# Linux installation and evidence

OpenWhisper 0.3.0 provides x86_64 AppImage and Debian packages. Download them from the
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

If upgrading from the original 0.2.5 app, download and install 0.3.0 manually. The original app's
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
GPU inference, all compositor versions, or all distributions. The suite never uses the user's
microphone, desktop sockets, audio session, or input devices.

For current package and test details, see [release status](ELECTRON-STATUS.md). To build locally,
use the project commands; these produce build output and do not install the app:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
make linux
```

Renderer checks:

```bash
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
```

Linux update signatures use a persistent version-bound key distinct from the macOS certificate.
Preserve its public key and validation policy; details are in [release signing](SIGNING.md). Report
security issues privately through the [GitHub security advisory form](https://github.com/juferdinand/OpenWhisper/security/advisories/new).
