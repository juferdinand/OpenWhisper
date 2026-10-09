# OpenWhisper specification

OpenWhisper provides local dictation on macOS and Linux: start recording, speak, stop, then deliver
the recognized text to the cursor or clipboard. Windows is not implemented. Version 0.2.5 is the
current public release and uses the original native hosts. The Electron 0.3.0 replacement is in
development and acceptance; its implementation status is tracked in
[Electron status](docs/ELECTRON-STATUS.md). The [roadmap](docs/ROADMAP.md) describes proposed
integrations, and the [README](README.md) is the documentation entry point.

The behavior summary below describes the public 0.2.5 applications and does not establish that
the Electron replacement has passed platform parity or release acceptance.

## Guiding principles

1. **Local recognition**: Whisper and Parakeet run on the device without recognition servers or telemetry.
2. **Free and open**: MIT License, no required account, subscription, or API key.
3. **Common interface**: an English/German interface with native services and capability fallbacks.
4. **User-controlled capture**: no fixed recording-duration limit; stop or cancel explicitly.

## Shared behavior in public 0.2.5

| Area | Behavior |
| --- | --- |
| Interface | English/German interface language is independent of dictation language; user text is never translated by the UI. |
| Speech models | Local Whisper and NVIDIA Parakeet recognition with model selection. Whisper supports a fixed language or automatic detection; Parakeet detects language automatically and does not accept vocabulary prompts. |
| Recording | Capture is converted to 16 kHz mono samples in RAM. No automatic duration cutoff or audio truncation. Longer recordings consume more RAM. Cancellation discards the active recording before inference. |
| Text processing | Cleanup, vocabulary correction, and snippet expansion use the shared multilingual behavior fixtures. Vocabulary correction runs after recognition for both model families. |
| Output | Clipboard delivery and optional automatic insertion. Unavailable or denied input permissions leave clipboard output usable. macOS also supports text editor output. |
| Preferences | Setup completion, language, model choice, snippets, and other settings persist locally. Edits are patches against current host state. First-run setup stays completed across upgrades. |
| History | Optional local history of the last 20 dictations. History can be disabled or cleared. |
| Updates | Explicit installation after version, source, archive/package, and signature checks. macOS and Linux packages share one project version. Source and CI builds do not enable in-app installation. |

## Historical 0.2.5 host services

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

These rows document the published native release and its historical architecture. Keep its detailed
acceptance record attached to the immutable [0.2.5 Linux source](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4); do not attribute those results to Electron.

## Electron source layout

The Electron replacement is implemented in strict TypeScript in `app/`:

| Path | Responsibility |
| --- | --- |
| `app/src/main/` | Electron main process, application lifecycle, and composition |
| `app/src/preload/` | Sandboxed renderer bridge with a narrow API |
| `app/src/contracts/` | Runtime-validated IPC, application, and platform contracts |
| `app/src/core/{recording,speech,models,text}/` | Platform-neutral recording, speech, model, and text logic |
| `app/src/services/{recording,speech,models,settings,update}/` | Feature services for recording, speech, models, settings/history, and updates |
| `app/src/platforms/linux/{kde,x11,shared}/` | KDE, X11, and common Linux desktop integration |
| `app/src/workers/` | Isolated speech work and process supervision |
| `app/ui/` | Electron renderer, English/German locales, icon, and Inter font |
| `app/data/` | Model catalog, schemas, and multilingual test vectors |
| `app/native/` | Pinned speech engine and focused capture/desktop bindings |

The renderer communicates through the schema-validated preload contract. Platform permissions and
native capabilities stay in host services, and every IPC boundary is validated at runtime. Dev
storage and identity are separate from stable storage; Dev data is not imported automatically.
The Linux `shared` platform area contains common Linux integration code, not a second renderer or
duplicated shared UI. GNOME and wlroots use these services according to detected capabilities.

## Development commands

Use Node.js 24–26 and npm. Run the app in its separate Dev profile:

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
npm run dev --prefix app -- --dev-profile /absolute/private/path/openwhisper-dev
```

For checks, run the commands relevant to the change:

```bash
npm run preflight --prefix app
npm run typecheck --prefix app
npm test --prefix app
npm run build --prefix app/ui
npm run test:ui --prefix app/ui
make test
```

`make linux` and `make mac` produce stable-profile validation candidates; they do not install or
isolate the app. Do not launch a candidate against an active profile. See
[development guidance](CONTRIBUTING.md) and the detailed
[Electron development guide](docs/ELECTRON-DEVELOPMENT.md).

## Runtime and validation boundaries

Speech recognition is local. Plain dictation does not depend on optional text-model communication
or later integrations. Audio, transcripts, vocabulary, clipboard contents, and device names must
not appear in logs or automated receipts.

Electron tests and CI cover their documented source, adapter, and package scopes; a passing check
does not establish physical microphone quality, permission flows, global input handling, or
insertion on every desktop. The Electron replacement remains under acceptance. Consult
[Electron status](docs/ELECTRON-STATUS.md) for its current evidence and gates. Keep container,
synthetic audio, nested compositor, and physical-device evidence separate. Never use the real
microphone or the user's desktop, input devices, sockets, or audio session for unattended tests.

The legacy [Linux acceptance record](docs/LINUX.md#checks-and-evidence) and current
[platform architecture](docs/PLATFORMS.md#electron-source-layout) document their respective scopes.
Optional LM Studio/Ollama communication is a development preview and remains separate from
ordinary dictation. Further integrations follow the [roadmap](docs/ROADMAP.md); they are not
claims about current capabilities.

## Document history

`SPEC.md` was included in the initial import, commit
[`49978a7`](https://github.com/juferdinand/OpenWhisper/commit/49978a7348ce6dbe94712aa500375b13aac5cd41),
on 2026-10-05, authored and committed as Justin Ferdinand (`juferdinand`). Commit
[`7cfa0c0`](https://github.com/juferdinand/OpenWhisper/commit/7cfa0c0) translated it into English.
Git records those identities, but does not establish whether the prose was written manually or
with an assistant. The original macOS-focused specification predates the shared Linux UI; this
revision preserves that provenance, identifies the 0.2.5 public behavior as historical, and
documents the current Electron replacement layout and its pending acceptance.
