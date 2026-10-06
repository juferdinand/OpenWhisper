# OpenWhisper — Agent Instructions

OpenWhisper is a free, fully local dictation app, inspired by tools such as WhisperBar and Wispr Flow:
press a trigger, speak, and insert the recognized text at the cursor. No cloud recognition, account,
or subscription. The project is open source under the MIT License.

## Documentation and language

- Keep `AGENTS.md` and `CLAUDE.md` in English and synchronized.
- Keep source comments, logs, scripts, workflows, and project documentation in English.
- Default the shared app interface to English; maintain the requested English/German switch in
  `shared/locales/`. Keep translation keys and placeholders synchronized, and never translate user text.
- `README.md` is the single documentation entry point.
- Preserve multilingual speech-processing patterns and test inputs; use English test names and comments.

## Project structure

- `macos/`: native Swift app, SwiftPM, Swift 5.10 language mode, macOS 14+.
  It can be built with the Xcode Command Line Tools without a full Xcode installation.
  - `Sources/OpenWhisperCore/`: testable logic: `TranscriptCleaner`, `VocabularyCorrector`,
    `SnippetExpander`, and `ModelCatalog`.
  - `Sources/OpenWhisper/App/`: `AppState` state machine
    (`idle → recording → transcribing → done/error`), preferences, app, and app delegate.
  - `Sources/OpenWhisper/Services/`: `SpeechEngine` (whisper.cpp C API for Whisper and NVIDIA Parakeet),
    `AudioRecorder`, `HotkeyService` (CGEvent tap, Fn/modifier/mouse triggers, Carbon fallback,
    push-to-talk), `TextInjector` (paste, clipboard, or editor), `ModelManager`,
    `UpdateService` (GitHub Releases with signature verification), `Permissions`, and `SnippetStore`.
  - `Sources/OpenWhisper/UI/`: native non-activating `NSPanel` overlay and a dedicated
    `NSWindow` hosting `SharedSettingsView` (WKWebView). The settings use the same compiled
    UI assets as Linux, including the floating recording controls. Only trusted bundle files
    can navigate or invoke the native bridge.
  - `Vendor/whisper.xcframework`: downloaded by `scripts/fetch-whisper.sh`;
    pinned to `b5130`, including the Parakeet API.
- `shared/`: authoritative cross-platform model catalog (`models.json`) and test cases
  (`test-vectors.json`).
- `desktop/src/`: shared custom settings and recording UI for macOS and Linux. Keep one layout, icon set,
  font, and navigation structure. `bridge.ts` selects Tauri IPC or the native WebKit reply handler.
- `desktop/src-tauri/`: Linux Rust backend (CPAL audio, KDE native triggers, portals, clipboard, downloads, and history).
- `desktop/crates/core/`: text processing against the same shared fixtures as Swift.
- `desktop/crates/speech/` and `desktop/native/`: pinned whisper.cpp / Parakeet C++ bridge.
  Speech contexts stay on one worker thread. Packages include Vulkan with a portable CPU fallback;
  detect real devices at runtime and preserve a manual CPU choice. Khronos headers are checksum-pinned.
- `desktop/public/app-icon.png` and `src-tauri/icons/icon.png`: exact 256px PNG from the existing
  Mac ICNS. Do not redesign one platform's logo independently. Inter is bundled with its license.
- `docs/LINUX.md`: build dependencies, support matrix, validation evidence, and remaining tests.
- `docs/PLATFORMS.md`: architecture and remaining platform work. Windows is not implemented.
- `VERSION`: one project version for all platforms.

## Commands

```bash
make linux-test                   # Check Linux frontend, Rust tests, Clippy, and shared assets
make linux                        # Build Linux with Vulkan and CPU fallback
make linux-install                # Install the local Linux build for this user
cd desktop && npm run test:ui      # Shared UI tests (install Playwright Chromium first)
make test                         # Run Swift tests against shared/test-vectors.json
make mac                          # Build macos/build/OpenWhisper.app
make mac-install                  # Replace the app in /Applications and launch it
make -C macos app UNIVERSAL=1      # Build arm64 and x86_64, then combine with lipo
make -C macos zip UNIVERSAL=1      # Build and package OpenWhisper-macOS.zip
make -C macos dmg UNIVERSAL=1      # Build a drag-to-Applications installation image
```

For live logs, use the absolute path because `log` may be a shell function in zsh:

```bash
/usr/bin/log stream --info --predicate 'subsystem == "io.github.whisperfree"' --style compact
```

Run `make test` for Swift logic changes and build the Mac app for application changes.
Mac builds now also require Node.js/npm to build the shared UI.
Run `make linux-test` for Linux changes and shared UI tests for UI changes.
The macOS app supports `--ui-smoke-test` and `--overlay-smoke-test` for native WebKit checks in CI.
`desktop/scripts/test-session.py` exercises Linux capture through a private virtual audio source,
including a recording beyond two minutes, floating controls, recognition, and clipboard output.
Its optional `--portals` mode also checks KDE shortcut binding and pasting into an owned test field.
See `docs/LINUX.md` for dependencies and permission details. Never use the real microphone for unattended tests.
Recording, permissions, hotkeys, and pasting also need manual testing on macOS.
For documentation-only changes, check content, links, and formatting.

## Known pitfalls

- **Persistent identities:** keep `io.github.whisperfree`, the Debian package identity, existing data
  directories, and signing keys stable. Public branding and new package names use OpenWhisper.
  Never relabel old release binaries. Preserve strict source/signature validation when
  configuring the repository and expected asset names.

- **Recording duration:** the user explicitly requires no fixed time limit. Do not reintroduce
  an automatic cutoff or truncate the audio buffer. Record until explicit stop/cancel; explain
  that recordings stay in RAM and grow with duration.
- **Linux inference recovery:** keep native inference in the disposable speech helper. Bound
  individual inference windows, retry failed windows at smaller sizes on GPU/CPU, and preserve
  the manual CPU choice. Save stopped audio privately before inference; keep failed WAV backups
  across restarts until successful delivery or explicit discard. Never log helper requests or replies.
- **Settings:** persist edited fields as patches against the current host state, and keep switch DOM
  nodes stable while saving. Login-item pending approval is distinct from disabled on macOS.
  Linux autostart must point to the installed AppImage, never its extraction directory.
- **Linux app identity:** install and launch `io.github.whisperfree.desktop` so GTK, KDE's taskbar,
  and portals agree on the application identity. Starting from a terminal can associate portal
  permissions with that terminal. Preserve the package-specific bundler config and desktop template.
  Keep the main window's `create: false` and create it in the one-shot setup hook: GTK activation
  emits another Ready event in Tao, and automatic window creation would crash on a duplicate label.
  Native UI and session tests cover reactivation.
- **Linux update restart:** keep the supervised process alive with an in-place `exec` after
  native event-loop cleanup. Do not use Tauri's spawn-and-exit restart: systemd desktop services
  may kill the replacement with the old process. Capture the permanent executable before updating,
  since a Debian replacement can make `current_exe()` point to a deleted inode.
- **Wayland overlay:** initialize layer-shell before Wry realizes the GTK window. Keep keyboard
  focus disabled. A missing compositor protocol must leave the main recording control usable.
- **macOS WebKit:** use the original bundle file URL and a document-start flag for overlay mode.
  Applying `underPageBackgroundColor` before loading caused a startup hang in native CI. The
  overlay uses WKWebView's `drawsBackground` configuration, also used by Wry, and transparent CSS.
- **Signing and permissions:** an ad-hoc signature can cause macOS to discard Accessibility
  permission after a rebuild. `macos/scripts/create-dev-cert.sh` creates a local
  `WhisperFree Dev` certificate that the build detects automatically.
  Public releases must keep the same signing identity in `SIGNING_CERT_P12`;
  the updater rejects apps whose signatures do not meet the running app's designated requirement.
  A self-signed certificate does not provide Apple notarization.
- **macOS capture:** each recording owns its converter and synchronized sample buffer. Never
  reset a converter concurrently with the tap callback or reuse an engine after a device change.
  `OpenWhisperAudio` catches AVAudioEngine Objective-C exceptions before they cross Swift.
  Synthetic capture tests must never open the microphone. Lifecycle diagnostics are bounded and
  local; never log audio, transcripts, vocabulary, clipboard content, or device names.
- **Metal shutdown:** ggml-metal can crash during process exit while a context remains loaded.
  Call `SpeechEngine.shutdown()` from `applicationWillTerminate`.
- **Testing with Command Line Tools:** use Swift Testing. The Makefile supplies the Testing
  framework paths needed for a Command Line Tools-only setup.
- **Keyboard shortcuts:** the previous KeyboardShortcuts dependency required preview macros
  unavailable in the Command Line Tools-only setup. Use the existing `HotkeyService`.
- **Linux KDE triggers:** `shortcuts/` captures GTK input only during explicit trigger setup.
  KGlobalAccel handles keys; KWin button rebindings handle extra mouse buttons on Wayland
  (middle button: Plasma 6.3+). The same executable's `--linux-trigger-helper` owns the temporary
  binding, restores it on EOF/SIGTERM, and journals recovery after SIGKILL. Preserve conflicts
  and later user edits. Never use root, raw input devices, or unattended real-desktop input tests.
  Run `desktop/scripts/test-kde-triggers.py --binary <binary>` for owned nested-KWin regression
  coverage. Modifier-only triggers are toggle-only because KDE emits their edges on release.
- **Shortcut capture:** SwiftUI can take first-responder status away from an NSView recorder.
  Capture shortcuts through the event tap instead of a text field.
- **Mouse events:** reading `NSEvent.keyCode` for a mouse event raises an exception.
- **Language detection:** automatic detection can mistake short German phrases for English.
  Default to the system language where supported.
- **Parakeet vocabulary:** Parakeet does not accept a text prompt.
  Apply `VocabularyCorrector` after recognition for all model families.

## CI and releases

Repository: https://github.com/juferdinand/OpenWhisper (public).

Signing decision (2026-10-05): use persistent self-signing for the initial public releases to avoid
the annual Apple Developer Program fee during early development. Clearly document that the app
is not Apple-notarized and may need a first-launch exception. Follow [docs/SIGNING.md](docs/SIGNING.md)
for key continuity and a future Developer ID migration; changing identities requires an updater transition.

- CI runs tests, builds a universal app, verifies its DMG, and uploads the DMG and ZIP as Actions artifacts.
  CI builds use ad-hoc signing and do not enable the in-app updater.
- The manual Release workflow runs from `main`, checks the requested `X.Y.Z` version, and builds
  macOS and Linux in parallel with that version. macOS uses the persistent signing identity;
  CI and Release share `.github/workflows/linux-build.yml` for Linux tests and packaging.
  Only after both builds succeed does the publication job commit/tag the version, verify artifact
  checksums, and upload DMG, ZIP, AppImage, Debian package, Linux signatures, `latest.json`, and combined `SHA256SUMS`.
  It creates a complete draft by default for Linux desktop acceptance. The `draft` input controls
  publication. No separate CI dispatch or manual Linux attachment is needed. Do not relabel
  packages from an older version.
- Linux release signing uses `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
  Preserve the embedded public key and `requireSignedVersion`; never rotate the key casually.
  First-run completion and interface language must survive upgrades.
- `WFUpdateRepository` is set through `UPDATE_REPO` during release builds.
- The DMG is the primary installation download. The in-app updater still consumes the ZIP asset.
  Verify the mounted DMG and its contained app with `macos/scripts/verify-dmg.sh` before publication.
- Signing requires the repository secrets `SIGNING_CERT_P12` and `SIGNING_CERT_PASSWORD`.
  `macos/scripts/export-dev-cert.sh owner/repo /path/to/identity.p12` uploads one encrypted identity
  previously exported using Keychain Access. Never export all keychain identities or rotate the release key.
- Do not rotate the release signing identity casually or commit signing material.
  Local signing backups belong under the ignored `.local/` directory.
- Release publication must follow successful tests, packaging, and signature verification.
  Keep the README and release instructions aligned with the app.
- Linux CI builds on Ubuntu 22.04, checks both host UI adapters, and uploads development
  packages. A main push never changes versions, tags, or public releases. Linux public releases
  require separate desktop acceptance; do not present intended distro support as tested.
- The manual version step uses `desktop/scripts/set-version.py` to synchronize all manifests.
- CI repeats weekly. See `SECURITY.md` for the security policy.
- Renovate tracks Cargo, npm, Actions, and whisper.cpp versions; keep SHA pins and auto-merge disabled.
  A whisper.cpp update also needs a reviewed SHA-256 change; never bypass checksum verification.
- Preserve strict update-source, version, archive, and signature checks and their regression tests.

## Future work

- Apple Developer ID signing and notarization.
- Linux desktop acceptance, installation tests, compositor coverage, and GPU validation; Windows implementation.
- Keep shared UI changes common to both hosts while retaining platform-specific permissions and services.
