# Plattformen: macOS heute, Linux & Windows später

## Kurzfassung

| Plattform | Umsetzung | Status |
|---|---|---|
| macOS 14+ | Native App in Swift (`macos/`) | ✅ fertig |
| Linux | **Tauri-App** (Rust + Web-UI) in `desktop/` | geplant |
| Windows | **dieselbe Tauri-App** wie Linux | geplant |

**Empfehlung:** macOS bleibt nativ, Linux und Windows teilen sich *eine* Tauri-App.
Gemeinsam für alle sind das Modell (whisper.cpp), der Modellkatalog und das Verhalten der
Textverarbeitung (`shared/`).

## Warum nicht alles in einer App?

Der größte Teil einer Diktier-App ist Betriebssystem-Integration, nicht UI:

| Aufgabe | macOS | Windows | Linux |
|---|---|---|---|
| Globaler Auslöser inkl. Loslassen (Push-to-Talk) | CGEvent-Tap | `RegisterHotKey` / Low-Level-Hook | X11: `XGrabKey` · Wayland: `evdev` oder Desktop-Portal |
| Text in fremde App einfügen | Zwischenablage + ⌘V via CGEvent | Zwischenablage + `SendInput` (Strg+V) | X11: `xdotool` · Wayland: `wtype` / `ydotool` |
| Overlay ohne Fokus-Diebstahl | `NSPanel` (`.nonactivatingPanel`) | `WS_EX_NOACTIVATE` | X11 ok · Wayland je nach Compositor (`layer-shell`) |
| Mikrofon | AVAudioEngine | WASAPI | PipeWire/PulseAudio |
| GPU für whisper.cpp | Metal | CUDA / Vulkan | CUDA / Vulkan |

Diese Teile müssen *in jedem Fall* pro Betriebssystem geschrieben werden. Ein gemeinsames UI-Framework
spart nur das Einstellungsfenster – auf dem Mac würde es die Integration sogar verschlechtern.

## Warum Tauri statt Electron?

| | Tauri | Electron |
|---|---|---|
| Downloadgröße | ~10 MB | ~150–250 MB |
| RAM im Leerlauf | ~30–60 MB | ~150–300 MB |
| Backend-Sprache | Rust – whisper.cpp direkt via [`whisper-rs`](https://github.com/tazz4843/whisper-rs) | Node – whisper.cpp nur über native Addons |
| Globaler Shortcut mit Loslassen | ✅ (`tauri-plugin-global-shortcut`, Pressed/Released) | ❌ (`globalShortcut` kennt nur Drücken) |
| Auto-Update | ✅ `tauri-plugin-updater` (signiert, GitHub Releases) | ✅ electron-updater |

Für eine App, die permanent im Hintergrund läuft, sind Größe und RAM entscheidend – und Push-to-Talk
ist mit Electron nicht sauber machbar.

## Geplanter Aufbau von `desktop/`

```
desktop/
  src-tauri/          Rust: Audio (cpal), whisper-rs, Hotkeys, Einfügen, Overlay-Fenster, Updater
    src/text/         Port von WhisperFreeCore (Cleaner, Vokabular, Snippets)
  src/                Web-UI (Einstellungen, Overlay) – z. B. Svelte oder plain TS
```

Verbindlich für die Portierung:

- **`shared/models.json`** ist der Modellkatalog (auch die Hardware-Empfehlungen `strong`/`weak`/`cpuOnly`).
- **`shared/test-vectors.json`** – die Rust-Umsetzung von Cleaner, Vokabular-Korrektur und Snippets
  muss alle Fälle bestehen (die Swift-Tests prüfen dieselbe Datei).
- Speicherorte analog zu macOS: `%APPDATA%\WhisperFree` bzw. `~/.local/share/whisperfree`
  (Modelle, `snippets.json` im selben JSON-Format).

## Linux-Besonderheit: Wayland

Unter Wayland dürfen Apps aus Sicherheitsgründen weder global Tasten abgreifen noch Eingaben simulieren.
Realistische Optionen:

1. **`evdev` + `uinput`** (funktioniert überall, Nutzer muss in die Gruppe `input`) – so machen es die
   meisten Diktier-Tools.
2. **XDG Desktop Portal** `GlobalShortcuts` (GNOME 47+/KDE 6) für den Auslöser, `wtype`/`ydotool` zum Einfügen.
3. Fallback: nur Zwischenablage + Benachrichtigung.

Unter X11 reichen `XGrabKey` und `xdotool`.

## Releases

Ein GitHub-Release (`vX.Y.Z`) enthält die Artefakte aller Plattformen:

- `WhisperFree-macOS.zip`
- `WhisperFree-Linux.AppImage` / `.deb` (später)
- `WhisperFree-Windows.msi` (später)

`.github/workflows/release.yml` bekommt dafür pro Plattform einen Job (Tauri bietet mit
`tauri-apps/tauri-action` fertige Linux/Windows-Builds). Der macOS-Updater wählt gezielt das
`macOS`-Asset; der Tauri-Updater bekommt ein eigenes `latest.json`.

## Reihenfolge, falls es losgeht

1. `desktop/` mit Tauri anlegen, Text-Verarbeitung nach Rust portieren, gegen `shared/test-vectors.json` testen.
2. Audio + whisper-rs + Modell-Download (Katalog aus `shared/models.json`).
3. **Windows zuerst** (Hotkeys und Einfügen sind dort unkompliziert), dann Linux X11, dann Wayland.
4. Release-Job ergänzen.
