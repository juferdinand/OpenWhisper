# WhisperFree – Hinweise für Claude Code

Kostenlose, 100 % lokale Diktier-App (Open Source, MIT) nach dem Prinzip von WhisperBar / Wispr Flow:
Auslöser drücken → sprechen → Text landet an der Cursor-Position. Keine Cloud, kein Konto, kein Abo.
Sprache der UI, Kommentare und weiterer Doku: **Deutsch**. Die README ist zweisprachig:
`README.md` auf Englisch, `README.de.md` auf Deutsch; beide gegenseitig verlinken und inhaltlich synchron halten.

## Struktur

- `macos/` – native App (Swift 5.10-Sprachmodus, SwiftPM, macOS 14+). Baut **ohne Xcode** (nur Command Line Tools).
  - `Sources/WhisperFreeCore/` – reine Logik, getestet: `TranscriptCleaner`, `VocabularyCorrector`, `SnippetExpander`, `ModelCatalog`
  - `Sources/WhisperFree/App` – `AppState` (Zustandsmaschine idle→recording→transcribing→done/error), Prefs, App/AppDelegate
  - `Sources/WhisperFree/Services` – `SpeechEngine` (whisper.cpp C-API für Whisper **und** NVIDIA Parakeet), `AudioRecorder`,
    `HotkeyService` (CGEvent-Tap: Tastenkombis, Fn/Modifier, Maustasten; Carbon-Fallback), `TextInjector` (⌘V / Zwischenablage / Editor),
    `ModelManager`, `UpdateService` (GitHub Releases, prüft Code-Signatur), `Permissions`, `SnippetStore`
  - `Sources/WhisperFree/UI` – Overlay (nicht aktivierendes NSPanel), Einstellungsfenster (eigenes NSWindow, kein SwiftUI-Settings)
  - `Vendor/whisper.xcframework` – wird von `scripts/fetch-whisper.sh` geladen (gepinnt: b5130, enthält Parakeet-API)
- `shared/` – **plattformübergreifend verbindlich**: `models.json` (Katalog + Hardware-Empfehlungen), `test-vectors.json`
- `docs/PLATFORMS.md` – Plan für Linux/Windows (Tauri in `desktop/`, noch nicht begonnen)
- `VERSION` – eine Version für alle Plattformen

## Befehle

```bash
make test          # swift test gegen shared/test-vectors.json
make mac           # macos/build/WhisperFree.app
make mac-install   # nach /Applications kopieren und starten
make -C macos app UNIVERSAL=1   # arm64 + x86_64 per lipo
```

Logs live mitlesen (in zsh ist `log` ggf. eine Shell-Funktion → `/usr/bin/log` nutzen):
`/usr/bin/log stream --info --predicate 'subsystem == "io.github.whisperfree"' --style compact`

## Stolpersteine (alle schon einmal passiert)

- **Signatur & Berechtigungen:** Ad-hoc-Signatur → macOS verwirft die Bedienungshilfen-Berechtigung nach jedem Build.
  Lösung: `macos/scripts/create-dev-cert.sh` (lokales Zertifikat „WhisperFree Dev“), `build-app.sh` nutzt es automatisch.
  Releases müssen IMMER mit demselben Zertifikat signiert sein (CI-Secret `SIGNING_CERT_P12`), sonst lehnt der Updater ab.
- **ggml-metal** stürzt beim Prozessende ab, wenn noch ein Kontext geladen ist → `SpeechEngine.shutdown()` in `applicationWillTerminate`.
- **XCTest gibt es ohne Xcode nicht** → swift-testing, Makefile verlinkt das Testing-Framework der CLT.
- **KeyboardShortcuts (sindresorhus)** kompiliert ohne Xcode nicht (#Preview-Makros) → eigener `HotkeyService`.
- SwiftUI nimmt einem NSView-Recorder den First Responder weg → Kürzel werden über den Event-Tap aufgenommen, nicht über ein Textfeld.
- `NSEvent.keyCode` bei Maus-Events abzufragen wirft eine Exception.
- Sprache „auto“ erkennt kurze deutsche Sätze oft als Englisch → Standard ist die Systemsprache.
- Parakeet hat keinen Text-Prompt → Vokabular wirkt über `VocabularyCorrector` nach der Erkennung (für alle Modelle).

## Offene Punkte

Repository: https://github.com/juferdinand/WhisperFree (öffentlich).
`WFUpdateRepository` wird beim Release über `UPDATE_REPO` gesetzt.

1. Signier-Zertifikat als Secret hinterlegen: `macos/scripts/export-dev-cert.sh juferdinand/WhisperFree` (Export-Skript noch ungetestet).
2. Erstes Release über *Actions → Release* (Workflow noch nie gelaufen – erster Lauf kann Nacharbeit brauchen).
3. Später: `desktop/` (Tauri) für Windows/Linux laut `docs/PLATFORMS.md`.
