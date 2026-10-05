# Platforms: macOS today, Linux and Windows later

## Overview

| Platform | Implementation | Status |
|---|---|---|
| macOS 14+ | Native Swift app in `macos/` | Available |
| Linux | Tauri app (Rust + web UI) in `desktop/` | Planned |
| Windows | The same Tauri app as Linux | Planned |

The plan is to keep macOS native and share one Tauri app between Linux and Windows.
All platforms share whisper.cpp, the model catalog, and text processing behavior in `shared/`.
The options below are implementation plans, not features already available in WhisperFree.

## Why separate platform implementations?

Much of a dictation app depends on operating system integration:

| Task | macOS | Windows | Linux |
|---|---|---|---|
| Global trigger with release events (push-to-talk) | CGEvent tap | `RegisterHotKey` / low-level hook | X11: `XGrabKey`; Wayland: desktop portal or device access |
| Insert text into another app | Clipboard + ⌘V through CGEvent | Clipboard + `SendInput` (Ctrl+V) | X11: `xdotool`; Wayland: compositor-dependent tools such as `wtype` / `ydotool` |
| Overlay without taking focus | `NSPanel` with `.nonactivatingPanel` | `WS_EX_NOACTIVATE` | X11 supported; Wayland depends on compositor and `layer-shell` support |
| Microphone | AVAudioEngine | WASAPI | PipeWire/PulseAudio |
| GPU for whisper.cpp | Metal | CUDA / Vulkan | CUDA / Vulkan |

These integrations need platform-specific implementations even with a shared settings UI.
Keeping the Mac app native preserves its existing integration.

## Why Tauri?

Tauri is the planned choice for the Linux and Windows app because a Rust backend can integrate
with whisper.cpp through [`whisper-rs`](https://github.com/tazz4843/whisper-rs), while the settings
window can use a web UI. `tauri-plugin-global-shortcut` and `tauri-plugin-updater` are candidates
for shortcut handling and signed updates.

Download size, idle memory use, push-to-talk behavior, and platform compatibility must be measured
in the implementation before making performance claims or committing to these dependencies.

## Planned `desktop/` structure

```
desktop/
  src-tauri/          Rust: audio (cpal), whisper-rs, hotkeys, insertion, overlay, updater
    src/text/         Port of WhisperFreeCore (cleanup, vocabulary, snippets)
  src/                Web UI (settings, overlay), for example Svelte or plain TypeScript
```

Porting requirements:

- Use `shared/models.json` for the catalog and `strong` / `weak` / `cpuOnly` recommendations.
- The Rust cleanup, vocabulary, and snippet implementations must pass `shared/test-vectors.json`,
  the same cases used by Swift tests. Preserve multilingual input and expected output.
- Use equivalent storage locations, such as `%APPDATA%\WhisperFree` and
  `~/.local/share/whisperfree`, for models and `snippets.json` in the same JSON format.

## Linux and Wayland

Global input capture and simulated input require special handling on Wayland. Evaluate:

1. XDG Desktop Portal `GlobalShortcuts` for triggers and supported compositor tools for insertion.
2. `evdev` / `uinput` where appropriate permissions are available. Assess the access required before adopting this approach.
3. A clipboard-only fallback with a notification.

Under X11, evaluate `XGrabKey` and `xdotool`. Confirm the supported desktop environments during implementation.

## Releases

A GitHub release (`vX.Y.Z`) will eventually contain assets for all supported platforms:

- `WhisperFree-macOS.dmg` for installation and `WhisperFree-macOS.zip` for the updater.
- `WhisperFree-Linux.AppImage` / `.deb` (planned).
- `WhisperFree-Windows.msi` (planned).

Add a job per platform to `.github/workflows/release.yml`. Evaluate `tauri-apps/tauri-action`
for Linux and Windows builds. The macOS updater selects its exact ZIP asset;
a Tauri updater would use a separate `latest.json`.

## Implementation order

1. Create `desktop/` with Tauri, port text processing to Rust, and run the shared test vectors.
2. Add audio, whisper-rs, and model downloads using the shared catalog.
3. Implement Windows integration, then Linux X11, then Wayland.
4. Add release jobs and verify installation and updates on each platform.
