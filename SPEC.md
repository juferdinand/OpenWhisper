# OpenWhisper specification

OpenWhisper provides local dictation on macOS and Linux: start recording, speak, stop, and
deliver the recognized text to the cursor or clipboard. Windows is not implemented.
This specification describes the current implementation. Proposed integrations are tracked
in the [roadmap](docs/ROADMAP.md); [README.md](README.md) is the documentation entry point.

## Guiding principles

1. **Local recognition**: Whisper and Parakeet run on the device without recognition servers or telemetry.
2. **Free and open**: MIT License, no required account, subscription, or API key.
3. **Common interface**: one English/German UI, with native services and explicit capability fallbacks.
4. **User-controlled capture**: no fixed recording-duration limit; stop or cancel explicitly.

## Shared behavior

| Area | Current behavior |
| --- | --- |
| Interface | `shared/ui/src/` supplies the same compiled settings and recording UI to both hosts. English/German interface language is independent of dictation language; user text is never translated by the UI. |
| Speech models | Both hosts use `shared/models.json` and the pinned whisper.cpp implementation for Whisper and NVIDIA Parakeet. Whisper supports fixed language or automatic detection; Parakeet detects language automatically and does not accept vocabulary prompts. |
| Recording | Capture is converted to 16 kHz mono samples in RAM. No automatic duration cutoff or audio truncation. Longer recordings consume more RAM. Cancellation discards the active recording before inference. |
| Text processing | Cleanup, vocabulary correction, and snippet expansion follow `shared/test-vectors.json`. Vocabulary correction runs after recognition for both model families. |
| Output | Clipboard delivery and optional automatic insertion. Unavailable or denied input permissions leave clipboard output usable. macOS also supports text editor output. |
| Preferences | Setup completion, language, model choice, snippets, and other settings persist locally. Edits are patches against current host state. First-run setup stays completed across upgrades. |
| History | Optional local history of the last 20 dictations. History can be disabled or cleared. |
| Updates | Explicit installation after version, source, archive/package, and signature checks. macOS and Linux packages share one project version. Source/CI builds do not enable in-app installation. |

## Native services

| Area | macOS | Linux |
| --- | --- | --- |
| Host | Swift app with WKWebView | Tauri 2 with Rust services and WebKitGTK |
| Audio | AVAudioEngine; converter and synchronized buffer owned by each recording | CPAL with sample conversion; synthetic tests use private virtual sources |
| Recognition | In-process XCFramework; Metal/CPU | Disposable speech helper; Vulkan/CPU; bounded inference windows, adaptive retry, manual CPU choice retained |
| Recovery | Capture is in memory; audio-device changes stop capture and process collected samples | Stopped audio is privately saved before inference. Failed recordings survive restarts until delivery or explicit discard; active capture before Stop remains in RAM |
| Triggers | CGEvent tap: keyboard combinations, modifiers, Fn, extra mouse buttons; Carbon combination fallback | Plasma 6 KGlobalAccel keys; KWin mouse rebindings on Wayland; GlobalShortcuts portal fallback elsewhere |
| Trigger limits | Advanced triggers require Accessibility; toggle and hold modes | Middle mouse requires Plasma 6.3+; modifier-only keys are toggle-only; direct mouse triggers outside KDE Wayland are not implemented |
| Insertion | Clipboard and CGEvent paste with Accessibility permission; optional clipboard restoration | `wl-copy`/`xclip`; keyboard-only RemoteDesktop portal for automatic paste |
| Floating control | Non-activating NSPanel | Non-focusable layer-shell on compatible Wayland compositors; floating window on X11; in-window fallback |
| Background operation | Menu bar | Tray where AppIndicator is displayed; settings window remains a usable fallback |
| Login | ServiceManagement, including pending system approval | Per-user XDG autostart using the permanent executable/AppImage path |

Linux integration is selected through available desktop services and protocols, not a
distribution name. The current KDE implementation can be used beyond CachyOS when its required
Plasma 6 capabilities exist. That is an implementation path, not evidence of completed
acceptance on those distributions. See [Linux validation](docs/LINUX.md#validation-status).

## State and failure behavior

```text
idle -> recording -> transcribing -> done/error -> idle
          |
          +-- cancel -> idle
```

State details and notices are host-specific. A Linux inference failure can retain a saved
recording for explicit retry or discard. GPU fallback must preserve the captured audio and a
deliberate CPU preference. Speech contexts stay on one worker thread, and helper requests,
audio, transcripts, vocabulary, and clipboard contents must never be logged.

## Validation boundaries

CI checks processing logic, shared UI adapters, native webview smoke tests, packaging, and
release verification. A passing CI run does not prove physical microphone quality, permission
flows, global input handling, or insertion on every desktop. Each linux/package combination
needs the acceptance evidence described in [docs/LINUX.md](docs/LINUX.md#acceptance-checks).

## Planned extensions

Obsidian output, optional local or explicitly configured cloud LLM processing, agent actions,
spoken responses, streaming previews, Windows services, and Apple notarization are future work.
Plain dictation must remain usable independently of optional integrations. Speech recognition
remains local; any future remote text-processing or speech-output provider must be configured
explicitly and disclosed separately. No roadmap item guarantees a release date.

## Document history

`SPEC.md` was included in the initial import, commit
[`49978a7`](https://github.com/juferdinand/OpenWhisper/commit/49978a7348ce6dbe94712aa500375b13aac5cd41),
on 2026-10-05, authored and committed as Justin Ferdinand (`juferdinand`). Commit
[`7cfa0c0`](https://github.com/juferdinand/OpenWhisper/commit/7cfa0c0) translated it into English.
Git records those identities, but does not establish whether the prose was written manually
or with an assistant. The original macOS-focused specification predates the shared Linux UI;
this revision reconciles it with the current implementation.
