# Linux release and acceptance

OpenWhisper's latest public Linux release is **0.2.5**. It uses the original Tauri/Rust host.
The Electron replacement targets 0.3.0 and is not yet a public release. Current package and
runtime evidence, limitations, and remaining gates are maintained in
[Electron implementation status](ELECTRON-STATUS.md).

## Published 0.2.5 packages

The release provides x86_64 AppImage and Debian packages:

- [OpenWhisper-Linux-x86_64.AppImage](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-Linux-x86_64.AppImage)
- [OpenWhisper-Linux-amd64.deb](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-Linux-amd64.deb)

Run the AppImage directly, or install the Debian package:

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

When FUSE is unavailable, `APPIMAGE_EXTRACT_AND_RUN=1` can be prefixed to the AppImage launch.
Verify assets against the release `SHA256SUMS`. The optional per-user terminal installer is
specific to this legacy 0.2.5 AppImage. Review the immutable
[0.2.5 installer source](https://raw.githubusercontent.com/juferdinand/OpenWhisper/d69b43bf6e7017c61089e117e79af34f57f297c4/linux/scripts/install-release.py)
and use only a matching 0.2.5 release. It does not install or update an Electron package.

The historical Linux architecture, desktop compatibility notes, and 0.2.5 test records are in
the immutable [0.2.5 Linux documentation](https://github.com/juferdinand/OpenWhisper/blob/d69b43bf6e7017c61089e117e79af34f57f297c4/docs/LINUX.md)
and [source tree](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4).
Those records describe that release, not the Electron replacement.

## Electron 0.3.0 candidate

The replacement source lives in `app/`, with its renderer in `app/ui/` and model catalog,
schemas, and test vectors in `app/data/`. The candidate builds AppImage and Debian formats. It is
not published and must not replace an installed 0.2.5 application. A successful build or a
container/owned-desktop check does not establish physical microphone, permission, compositor,
or distribution support. The [status page](ELECTRON-STATUS.md) identifies each passing scope
and remaining gate.

For a locally built candidate, use the project commands below. They write build output only:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
make linux
```

To run the development app, see [Electron development](ELECTRON-DEVELOPMENT.md). Renderer tests
run with:

```bash
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
```

After an Electron release is approved and downloaded, its package formats use the ordinary
AppImage and Debian commands:

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

The names and commands describe the package formats; they are not a claim that 0.3.0 is currently
available. Do not use the pinned legacy Python installer for Electron packages. Cross-host data
migration and update continuity require explicit acceptance evidence before being claimed.

## Checks and evidence

`make test` runs the Electron application typecheck and tests. `npm run preflight --prefix app`
checks workflow syntax, embedded shell, strict typing, formatting, and whitespace. `make linux`
builds the Linux candidate; it does not install it or by itself certify a desktop environment.
CI receipts and exact acceptance boundaries are linked from
[Electron implementation status](ELECTRON-STATUS.md). Keep container, synthetic audio, nested
compositor, and physical-device results separate. Never use the real microphone or the user's
desktop, input devices, sockets, or audio session for unattended tests.

The published 0.2.5 Linux update key is distinct from the macOS certificate. Preserve its
version-bound signature checks and continuity; see [release signing](SIGNING.md). Report security
issues privately through the [GitHub security advisory form](https://github.com/juferdinand/OpenWhisper/security/advisories/new).
