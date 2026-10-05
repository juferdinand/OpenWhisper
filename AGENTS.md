# WhisperFree — Agent Instructions

WhisperFree is a free, fully local dictation app, inspired by tools such as WhisperBar and Wispr Flow:
press a trigger, speak, and insert the recognized text at the cursor. No cloud recognition, account,
or subscription. The project is open source under the MIT License.

## Documentation and language

- Keep `AGENTS.md` and `CLAUDE.md` in English and synchronized.
- The app interface, source comments, and other existing project documentation are primarily German.
- `README.md` is the English entry point; `README.de.md` is the German version.
  Keep their content aligned and link them to each other.

## Project structure

- `macos/`: native Swift app, SwiftPM, Swift 5.10 language mode, macOS 14+.
  It can be built with the Xcode Command Line Tools without a full Xcode installation.
  - `Sources/WhisperFreeCore/`: testable logic: `TranscriptCleaner`, `VocabularyCorrector`,
    `SnippetExpander`, and `ModelCatalog`.
  - `Sources/WhisperFree/App/`: `AppState` state machine
    (`idle → recording → transcribing → done/error`), preferences, app, and app delegate.
  - `Sources/WhisperFree/Services/`: `SpeechEngine` (whisper.cpp C API for Whisper and NVIDIA Parakeet),
    `AudioRecorder`, `HotkeyService` (CGEvent tap, Fn/modifier/mouse triggers, Carbon fallback,
    push-to-talk), `TextInjector` (paste, clipboard, or editor), `ModelManager`,
    `UpdateService` (GitHub Releases with signature verification), `Permissions`, and `SnippetStore`.
  - `Sources/WhisperFree/UI/`: non-activating `NSPanel` overlay and a settings window implemented
    with a dedicated `NSWindow`, rather than a SwiftUI Settings scene.
  - `Vendor/whisper.xcframework`: downloaded by `scripts/fetch-whisper.sh`;
    pinned to `b5130`, including the Parakeet API.
- `shared/`: authoritative cross-platform model catalog (`models.json`) and test cases
  (`test-vectors.json`).
- `docs/PLATFORMS.md`: plans for a future Linux/Windows Tauri app in `desktop/`; not implemented yet.
- `VERSION`: one project version for all platforms.

## Commands

```bash
make test                         # Run Swift tests against shared/test-vectors.json
make mac                          # Build macos/build/WhisperFree.app
make mac-install                  # Replace the app in /Applications and launch it
make -C macos app UNIVERSAL=1      # Build arm64 and x86_64, then combine with lipo
make -C macos zip UNIVERSAL=1      # Build and package WhisperFree-macOS.zip
```

For live logs, use the absolute path because `log` may be a shell function in zsh:

```bash
/usr/bin/log stream --info --predicate 'subsystem == "io.github.whisperfree"' --style compact
```

Run `make test` for logic changes and build the app for application changes.
Recording, permissions, hotkeys, and pasting also need manual testing on macOS.
For documentation-only changes, check content, links, and formatting.

## Known pitfalls

- **Signing and permissions:** an ad-hoc signature can cause macOS to discard Accessibility
  permission after a rebuild. `macos/scripts/create-dev-cert.sh` creates a local
  `WhisperFree Dev` certificate that the build detects automatically.
  Public releases must keep the same signing identity in `SIGNING_CERT_P12`;
  the updater rejects apps whose signatures do not meet the running app's designated requirement.
  A self-signed certificate does not provide Apple notarization.
- **Metal shutdown:** ggml-metal can crash during process exit while a context remains loaded.
  Call `SpeechEngine.shutdown()` from `applicationWillTerminate`.
- **Testing with Command Line Tools:** use Swift Testing. The Makefile supplies the Testing
  framework paths needed for a Command Line Tools-only setup.
- **Keyboard shortcuts:** the previous KeyboardShortcuts dependency required preview macros
  unavailable in the Command Line Tools-only setup. Use the existing `HotkeyService`.
- **Shortcut capture:** SwiftUI can take first-responder status away from an NSView recorder.
  Capture shortcuts through the event tap instead of a text field.
- **Mouse events:** reading `NSEvent.keyCode` for a mouse event raises an exception.
- **Language detection:** automatic detection can mistake short German phrases for English.
  Default to the system language where supported.
- **Parakeet vocabulary:** Parakeet does not accept a text prompt.
  Apply `VocabularyCorrector` after recognition for all model families.

## CI and releases

Repository: https://github.com/juferdinand/WhisperFree (public).

- CI runs tests, builds a universal app, and uploads the packaged ZIP as an Actions artifact.
  CI builds use ad-hoc signing and do not enable the in-app updater.
- The manual Release workflow runs from `main`, checks the requested `X.Y.Z` version,
  imports the persistent signing identity, tests, builds, verifies, and publishes the ZIP
  and `SHA256SUMS` on GitHub Releases.
- `WFUpdateRepository` is set through `UPDATE_REPO` during release builds.
- Signing requires the repository secrets `SIGNING_CERT_P12` and `SIGNING_CERT_PASSWORD`.
  `macos/scripts/export-dev-cert.sh owner/repo` can export a local macOS development identity;
  the export helper has not yet been validated here.
- Do not rotate the release signing identity casually or commit signing material.
  Local signing backups belong under the ignored `.local/` directory.
- Release publication must follow successful tests, packaging, and signature verification.
  Preserve both README languages when changing installation or release instructions.

## Future work

- Apple Developer ID signing and notarization.
- Linux/Windows support in `desktop/` according to `docs/PLATFORMS.md`.
