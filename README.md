# OpenWhisper

**Press. Speak. Keep writing. Local dictation for macOS and Linux.**

[![CI](https://github.com/juferdinand/OpenWhisper/actions/workflows/ci.yml/badge.svg)](https://github.com/juferdinand/OpenWhisper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

OpenWhisper turns speech into text on your computer. The public app runs speech recognition
locally and needs no account, API key, or subscription. The interface supports English and
German; dictation can use multiple languages.

## Project status

The current release is **0.3.0**, a shared Electron app for macOS and Linux. Automated package,
update, and owned-runtime checks cover the scopes listed in [release status](docs/ELECTRON-STATUS.md);
they do not establish every desktop, device, or distribution combination. The older native 0.2.5
source and evidence remain available as an immutable reference.

| Platform | Current release | Notes |
| --- | --- | --- |
| macOS 14+ | 0.3.0 DMG and ZIP | Self-signed and not Apple-notarized; see [signing](docs/SIGNING.md) |
| Linux x86_64 | 0.3.0 AppImage and Debian package | Automated evidence and boundaries in [Linux status](docs/LINUX.md) |
| Windows | None | Not implemented; tracked by [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35) |

The immutable [0.2.5 source snapshot](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the legacy hosts and their historical evidence.

## Features

The app provides local Whisper and Parakeet recognition, model selection,
vocabulary correction, snippets, history, a shared settings interface, and English/German
interface translations. Platform integrations and validation differ; consult the applicable
[Linux evidence](docs/LINUX.md) and [platform overview](docs/PLATFORMS.md).

Recording continues until you stop or cancel it. Audio remains in memory while recording, so
longer sessions use more RAM. Model downloads require a network connection. Recognition runs
locally and can work offline once a model is present.

## Installation

Download 0.3.0 only from the [official Releases page](https://github.com/juferdinand/OpenWhisper/releases)
and verify files against its `SHA256SUMS`.

### macOS

Download the [macOS DMG](https://github.com/juferdinand/OpenWhisper/releases/download/v0.3.0/OpenWhisper-macOS.dmg),
drag OpenWhisper to Applications, eject the volume, then launch it from Applications. The
[ZIP](https://github.com/juferdinand/OpenWhisper/releases/download/v0.3.0/OpenWhisper-macOS.zip)
is also available. The app requires macOS 14 or later and microphone
permission. Its release signature is self-signed and the app is not notarized; see
[signing details](docs/SIGNING.md).

### Linux x86_64

Download and run the [AppImage](https://github.com/juferdinand/OpenWhisper/releases/download/v0.3.0/OpenWhisper-Linux-x86_64.AppImage):

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
```

If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1` for that launch. On Debian or Ubuntu,
install the [Debian package](https://github.com/juferdinand/OpenWhisper/releases/download/v0.3.0/OpenWhisper-Linux-amd64.deb):

```bash
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

Verify downloads against the release's `SHA256SUMS`. Linux desktop and package evidence is
summarized in [Linux status](docs/LINUX.md).

When moving from 0.2.5, download and install 0.3.0 manually. The original app's GUI updater has
not been demonstrated to update to Electron; back up data you need before changing installations.

For a per-user install of the **legacy 0.2.5 AppImage only**, review and download the installer
from the immutable 0.2.5 source commit:
[install-release.py](https://raw.githubusercontent.com/juferdinand/OpenWhisper/d69b43bf6e7017c61089e117e79af34f57f297c4/linux/scripts/install-release.py).
It requires Python 3.10+, OpenSSL 3, and `unsquashfs`; it verifies and installs the signed 0.2.5
AppImage. This legacy script does not install or update the Electron app; see [Linux status](docs/LINUX.md)
for the tested scope of the package transition.

## Privacy and safety

Speech recognition is local. OpenWhisper does not send recordings to a cloud recognition service.
Model downloads require an internet connection; recognition can run offline once a model is present.
Keep confidential audio and transcripts out of issue reports and logs. Do not use a real
microphone or physical input in unattended tests.

An in-app history is local and can be disabled. Model files, preferences, recordings, and
application data remain on the user's machine. Finish active recordings and model downloads
before installing updates. Do not install a development candidate over a working release.

## Development

The Electron source is in `app/`; its renderer is in `app/ui/`; the production catalog is in
`app/data/`; and test fixtures are in `app/tests/fixtures/`. Native speech bindings and focused OS
adapters are in `app/native/`. Legacy 0.2.5 hosts remain at the immutable source link above.

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
