# WhisperFree

**English** | [Deutsch](README.de.md)

**Press. Speak. Keep writing. Local dictation for macOS.**

[![CI](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml/badge.svg)](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black.svg)](#requirements)

WhisperFree is a native menu bar app that turns speech into text locally on your Mac.
Press <kbd>⌥</kbd> + <kbd>Space</kbd>, speak, then press the shortcut again:
your text is pasted into the active text field. No account, API key, or subscription.

> **App language:** The interface is currently in German. This README is available in English and German.

[Installation](#installation) · [Features](#features) · [Privacy](#privacy) ·
[Contributing](#contributing) · [Report an issue](https://github.com/juferdinand/WhisperFree/issues)

## Project status

WhisperFree is in early development. The source code for version **0.1.0** is available;
a packaged app release is still pending. To get started, build the app from source.

| Platform | Status |
| --- | --- |
| macOS 14+ | Native Swift app; builds target Apple Silicon and Intel |
| Linux and Windows | Planned, not implemented yet — see the [platform plan](docs/PLATFORMS.md) (German) |

## Features

- **System-wide dictation:** Paste text into the active text field, copy it to the clipboard, or open it in a text editor.
- **Your preferred trigger:** Configurable keyboard shortcuts, individual modifier keys, Fn, or extra mouse buttons. Toggle recording or use push-to-talk.
- **Local speech recognition:** OpenAI Whisper and NVIDIA Parakeet through [whisper.cpp](https://github.com/ggml-org/whisper.cpp), with Metal support on Apple Silicon.
- **Model management:** Download, switch, delete, or import compatible custom ggml models. The app suggests models based on your hardware and system language.
- **Vocabulary and snippets:** Correct custom terms and replace spoken phrases with saved text, such as “my link” with a URL.
- **Floating overlay:** Recording level, timer, and processing status; draggable without taking focus away from your text field.
- **Everyday settings:** Launch at login, optional sound cues, clipboard restoration, and a local text history you can disable.

## Requirements

- A Mac running **macOS 14 or later**.
- A microphone and enough disk space for your chosen speech model; download sizes are shown in the app.
- To build from source: current **Xcode Command Line Tools** or Xcode with its Swift toolchain.
- Internet access for the initial build and model download. Dictation works offline after that.

## Installation

### Build from source

Install the Command Line Tools first if needed:

```bash
xcode-select --install
```

Clone the repository and build the app:

```bash
git clone https://github.com/juferdinand/WhisperFree.git
cd WhisperFree
make mac
open macos/build/WhisperFree.app
```

The build automatically downloads the pinned whisper.cpp XCFramework and verifies its SHA-256
checksum. You can then drag the resulting `WhisperFree.app` into `/Applications`.

Alternatively, `make mac-install` builds the app, replaces an existing installation in
`/Applications`, and launches it.

### Packaged downloads

Future app packages will be available on [GitHub Releases](https://github.com/juferdinand/WhisperFree/releases).
The planned macOS package is named `WhisperFree-macOS.zip`. The current release pipeline does
not include Apple notarization; code signing alone does not provide it.

## Your first dictation

The app currently uses German labels; English translations are included below.

1. Open WhisperFree. You can also access setup through the menu bar icon.
2. Download and select a model in **Einstellungen → Modelle** (Settings → Models).
3. Grant **Microphone** access.
4. Grant **Accessibility** access to paste text automatically. For manual pasting, select **Nur in die Zwischenablage kopieren** (Copy to clipboard only).
5. Place your cursor in a text field. Press <kbd>⌥</kbd> + <kbd>Space</kbd>, speak, then press the shortcut again.

Transcription starts once recording stops. You can change the trigger, recording mode, language,
and output in settings. Without Accessibility access, standard keyboard shortcuts are available
as global triggers; individual modifier keys and mouse buttons require that permission.

## Models and languages

| Model family | Available in WhisperFree | Language behavior |
| --- | --- | --- |
| OpenAI Whisper | Tiny, Base, Small, Medium, Large v3 Turbo; also a compressed Turbo model | Manual language selection or automatic detection; custom vocabulary is also passed as a recognition prompt |
| NVIDIA Parakeet TDT v3 | Full precision, q8, and q4 variants | Automatic language detection; manual language selection does not apply |

Vocabulary correction after recognition and snippets work with both model families.
Available files, download sizes, and the Parakeet language list are defined in the
[model catalog](shared/models.json). Recognition speed and quality depend on factors including
the model, hardware, language, and recording.

## Privacy

Speech recognition runs inside the app process on your Mac. WhisperFree does not upload audio
recordings or transcripts for recognition and has no telemetry integration.

| Data or connection | Behavior |
| --- | --- |
| Audio | The app processes samples in memory and does not write audio files. |
| Models | Downloaded on request from Hugging Face, including its download infrastructure; stored in `~/Library/Application Support/WhisperFree/Models`. |
| Settings and history | Local User Defaults. By default, history stores the last 20 text dictations; disable or clear it under **Verlauf** (History). |
| Snippets | Stored locally in `~/Library/Application Support/WhisperFree/snippets.json`. |
| Text editor output | Writes text files to `~/Library/Application Support/WhisperFree/Diktate`; these persist independently of history. |
| Updates | Only when an update repository is configured: optional automatic checks through the GitHub API, with an update downloaded after you click to install it. |

Output text goes to the clipboard and, depending on your settings, to the app you choose.
That app's storage and synchronization follow its own settings.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Text is not pasted | Grant Accessibility access to WhisperFree and focus a text field. Alternatively, use clipboard mode and paste manually with `⌘V`. |
| “Kein Mikrofonzugriff” (no microphone access) or “Nichts gehört” (nothing heard) | Check microphone permission, the default input device, and the input level in macOS. |
| The shortcut does not respond | Try another shortcut and check for conflicts with system or app shortcuts. Fn, individual modifiers, and mouse buttons require Accessibility access. |
| Short phrases are recognized in the wrong language | Set the language explicitly when using Whisper. Parakeet always detects the language automatically. |
| Permissions stop working after a local rebuild | A changing ad-hoc signature can require permissions to be granted again; a persistent local development certificate helps. See [Development](#development). |
| “Updates sind in diesem Build nicht konfiguriert” (updates are not configured in this build) | This is expected for normal source builds. Update the source code and build the app again. |

Still stuck? [Open an issue](https://github.com/juferdinand/WhisperFree/issues/new) with your macOS
version, Mac chip, WhisperFree version, selected model, and steps to reproduce the problem.
Remove personal dictations and other confidential information from any logs you attach.

## Limitations and roadmap

The current app transcribes after recording; a live text preview is not implemented yet.
Linux and Windows apps, cloud synchronization, and LLM post-processing are also not available.
Automatic pasting uses the clipboard and a simulated keyboard shortcut, so behavior can vary
between target apps.

Next steps include a first signed app release and further testing of the macOS app.
Ideas and platform plans are described in [SPEC.md](SPEC.md) and
[docs/PLATFORMS.md](docs/PLATFORMS.md), both in German.
These are plans, not promised release dates.

## Development

```bash
make test                      # Test text processing and the model catalog
make mac                       # Build a local app bundle
make -C macos app UNIVERSAL=1   # Build a universal bundle for Apple Silicon and Intel
```

The [CI workflow](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml) runs tests
and builds the universal bundle on macOS. Tests use shared cases from
[`shared/test-vectors.json`](shared/test-vectors.json).

For a consistent local signature, run `macos/scripts/create-dev-cert.sh` once on your Mac.
The build uses the **WhisperFree Dev** certificate when it is available in your keychain.

```text
macos/
  Sources/WhisperFree/       App, recording, hotkeys, output, and interface
  Sources/WhisperFreeCore/   Text cleanup, vocabulary, snippets, and model catalog
  Tests/                    Tests using Swift Testing
  scripts/                  Build, dependencies, and signing
shared/                     Shared model catalog and test cases
docs/                       Platform planning
.github/workflows/          CI and manual release workflow
VERSION                     Project version
```

<details>
<summary>Releases for maintainers</summary>

The [release workflow](.github/workflows/release.yml) requires a persistent signing identity
in the repository secrets `SIGNING_CERT_P12` and `SIGNING_CERT_PASSWORD`.
The helper script `macos/scripts/export-dev-cert.sh juferdinand/WhisperFree` is intended to export
the local development certificate on macOS and has not yet been validated through a first release run.

Then start the workflow under **Actions → Release → Run workflow**, supplying a new version
in `X.Y.Z` format. It updates `VERSION`, creates a commit and tag, builds the universal bundle,
and publishes the ZIP. The update repository is embedded in the bundle during the build.
The updater checks downloaded apps against the running app's signature requirement,
so the signing identity must be preserved across releases.

</details>

## Contributing

Bug reports, documentation improvements, and pull requests are welcome in English or German.
See [CONTRIBUTING.md](CONTRIBUTING.md) (currently in German) for contribution guidelines.
Reproducible reports covering different Macs, target apps, and languages are especially helpful.

## License and acknowledgments

WhisperFree is released under the [MIT License](LICENSE).
Speech recognition builds on [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
[OpenAI Whisper](https://github.com/openai/whisper), and
[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3).
Libraries and downloaded models are also subject to their respective licenses.
