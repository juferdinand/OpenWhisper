# OpenWhisper

**Press. Speak. Keep writing. Local dictation for macOS and Linux.**

[![CI](https://github.com/juferdinand/OpenWhisper/actions/workflows/ci.yml/badge.svg)](https://github.com/juferdinand/OpenWhisper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OpenWhisper turns speech into text on your computer. The public app runs speech recognition
locally and needs no account, API key, or subscription. The interface supports English and
German; dictation can use multiple languages.

## Project status

The latest public release is **0.2.5**. It uses the original native macOS and Linux hosts.
The Electron **0.3.0** replacement is in development and acceptance; its builds and tests do not
make it a public release or establish full platform parity. See [current implementation status](docs/ELECTRON-STATUS.md)
and the [migration plan](docs/ELECTRON-MIGRATION.md).

| Platform | Public release | Electron replacement |
| --- | --- | --- |
| macOS 14+ | 0.2.5 DMG and ZIP | 0.3.0 acceptance in progress; physical microphone, permission, insertion, and update coverage remain open |
| Linux x86_64 | 0.2.5 AppImage and Debian package | 0.3.0 acceptance in progress; see [Linux status](docs/LINUX.md) |
| Windows | None | Not implemented; tracked by [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35) |

The immutable [0.2.5 source snapshot](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the legacy hosts and their historical evidence.

## Features

The public 0.2.5 applications provide local Whisper and Parakeet recognition, model selection,
vocabulary correction, snippets, history, a shared settings interface, and English/German
interface translations. Platform integrations and validation differ; consult the applicable
[Linux evidence](docs/LINUX.md) and [platform overview](docs/PLATFORMS.md).

Recording continues until you stop or cancel it. Audio remains in memory while recording, so
longer sessions use more RAM. Model downloads require a network connection. Recognition runs
locally and can work offline once a model is present.

## Installation

Download only from the [official Releases page](https://github.com/juferdinand/OpenWhisper/releases).
The currently published assets are for 0.2.5.

### macOS 0.2.5

Download the [macOS DMG](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-macOS.dmg),
drag OpenWhisper to Applications, eject the volume, then launch it from Applications. The
[ZIP](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-macOS.zip)
is also available. The app requires macOS 14 or later and microphone permission. Its release
signature is self-signed and the app is not notarized; see [signing details](docs/SIGNING.md).

### Linux 0.2.5

Download and run the [AppImage](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-Linux-x86_64.AppImage):

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
```

If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1` for that launch. On Debian or Ubuntu,
install the [Debian package](https://github.com/juferdinand/OpenWhisper/releases/download/v0.2.5/OpenWhisper-Linux-amd64.deb):

```bash
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

Verify downloads against the release's `SHA256SUMS`. Linux desktop and package evidence is
summarized in [Linux status](docs/LINUX.md).

For a per-user install of the **legacy 0.2.5 AppImage only**, review and download the installer
from the immutable 0.2.5 source commit:
[install-release.py](https://raw.githubusercontent.com/juferdinand/OpenWhisper/d69b43bf6e7017c61089e117e79af34f57f297c4/linux/scripts/install-release.py).
It requires Python 3.10+, OpenSSL 3, and `unsquashfs`; it verifies and installs the signed 0.2.5
AppImage. This legacy script does not install an Electron build. The 0.3.0 Electron release has
not been published.

Electron release artifacts, when approved for publication, use an AppImage and Debian package.
The normal package-manager/launcher commands are:

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

Those commands do not make a candidate artifact public or authorize replacing an installed app.
The legacy 0.2.5 updater does not establish cross-host migration to Electron.

## Privacy and safety

Speech recognition is local. OpenWhisper does not send recordings to a cloud recognition service.
Model downloads require an internet connection; recognition can run offline once a model is present.
Keep confidential audio and transcripts out of issue reports and logs. Do not use a real
microphone or physical input in unattended tests.

An in-app history is local and can be disabled. Model files, preferences, recordings, and
application data remain on the user's machine. Finish active recordings and model downloads
before installing updates. Do not install a development candidate over a working release.

## Development

The Electron source is in `app/`; the Electron-only renderer is in `app/ui/`; catalog, schemas,
and test vectors are in `app/data/`. Native speech bindings and focused OS adapters are in
`app/native/`. Legacy 0.2.5 hosts remain available at the immutable source link above.

Use Node.js 24–26 and npm. To run the isolated development app:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
npm run dev --prefix app
```

The renderer can be built and tested independently:

```bash
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
```

Common checks and package builds:

```bash
npm run preflight --prefix app
make test
make build
make linux                         # Build stable-profile validation candidate; does not install
make mac                           # Build stable-profile validation candidate; does not install
```

`make test` runs application typechecking and tests. `make linux` and `make mac` produce
stable-profile validation candidates; they neither install nor isolate the app. Do not launch a
candidate against an active profile. Use the explicit private Dev profile above for isolated
development. Release construction, signatures, and update transitions remain subject to the gates
in [Electron status](docs/ELECTRON-STATUS.md).

The local signing helper is `app/scripts/create-dev-cert.sh`; it creates the local development
certificate when the expected certificate is absent. Preserve the persistent public release
identity for signing continuity; never replace or rotate it with the development certificate.
Maintainers can upload an already-exported identity with `app/scripts/export-dev-cert.sh`; never
export all keychain identities or commit signing material.

## Further information

- [Linux implementation and acceptance](docs/LINUX.md)
- [Platform architecture](docs/PLATFORMS.md)
- [Release signing](docs/SIGNING.md)
- [Security policy](SECURITY.md)
- [Local model communication preview](docs/LOCAL_MODELS.md)
- [Roadmap](docs/ROADMAP.md)
- [Report an issue](https://github.com/juferdinand/OpenWhisper/issues)

OpenWhisper is open source under the MIT License. See [LICENSE](LICENSE).
