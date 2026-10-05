# WhisperFree specification

## Goal

A lightweight macOS menu bar app for system-wide dictation. Users press a global shortcut,
speak, and receive the recognized text at the cursor in the active app.

Guiding principles:

1. **Local** — inference on the device, no recognition servers, no telemetry.
2. **Free and open** — MIT License, no account or license key.
3. **Small** — everyday essentials: shortcuts, snippets, and multiple languages.

## Features

| Area | Behavior |
|---|---|
| Trigger | System-wide `CGEvent` tap with Accessibility permission: keyboard shortcut, individual modifier key (Fn, right ⌥, etc., distinguishing left and right), or mouse button 3 and above. Trigger capture also uses the tap, regardless of window focus. Trigger events are consumed. Without permission, Carbon `RegisterEventHotKey` provides a fallback for key combinations. Modes: toggle or hold (push-to-talk). Pressing another key while holding a modifier, such as ⌥E, discards the recording. |
| Overlay | Non-activating, borderless `NSPanel` at `.statusBar` level, visible across Spaces and above full-screen apps. Shows a microphone, pulsing dot, waveform, timer, spinner, success, or error. Click to start or stop; drag to move (position is saved); ✕ discards a recording. |
| Recording | `AVAudioEngine` input tap with `AVAudioConverter` to 16 kHz mono Float32 in memory. Recordings shorter than 0.3 seconds are ignored. Recordings without a meaningful audio level report no audio detected to reduce hallucinations during silence. |
| Transcription | In-process whisper.cpp XCFramework. The context stays loaded; model loading starts when recording begins. Greedy decoding, no timestamps, optional `initial_prompt` from the vocabulary field. Fixed language or `auto` for Whisper; automatic detection for Parakeet. |
| Post-processing | Removes non-speech markers such as `[BLANK_AUDIO]` and `(Music)`, known subtitle hallucinations, and extra whitespace; applies vocabulary corrections and snippets. |
| Snippets | Trigger → expansion. Case-insensitive, spaces and hyphens interchangeable, whole words only. If the dictation consists only of the trigger, returns just the expansion. |
| Output | Copies text to the clipboard, then simulates ⌘V through `CGEvent` (requires Accessibility access). Restores the previous clipboard after 0.5 seconds if its contents have not changed. Without permission, copies text and shows a notice. Optional output to a text editor. |
| Models | Whisper and Parakeet catalog with downloads from Hugging Face, progress, cancellation, deletion, and import of custom ggml files. Stored in `~/Library/Application Support/WhisperFree/Models`. |
| Settings | Setup checklist, General, Models, Snippets, History, and About. The interface is in English; dictation supports multiple languages. |

## State machine

```
idle ──start──► recording ──stop──► transcribing ──ok──► done(msg) ──1.2 s──► idle
  ▲                 │                     └──error──► error(msg) ──2.5 s──► idle
  └────cancel───────┘
```

## Out of scope for now

Live streaming transcription, cloud sync, AI rewriting, command mode, and sandboxing/App Store distribution.

## Future ideas

- Streaming preview during recording.
- Automatic capitalization and spoken punctuation commands, such as “new line” and “period”.
- Text insertion through AX selection ranges instead of ⌘V.
- Optional local LLM post-processing, for example through Ollama.
- Apple Developer ID signing and notarization for GitHub releases.
