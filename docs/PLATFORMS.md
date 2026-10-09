# Platform architecture

The current public release is 0.2.5 and uses the original native hosts. The Electron application
in `app/` is the replacement target for 0.3.0; its acceptance is still in progress. See
[current status and evidence](ELECTRON-STATUS.md) before treating a candidate feature or package
as supported.

| Platform | Public release | Replacement target |
| --- | --- | --- |
| macOS 14+ | 0.2.5 native app | Electron with native capture, platform adapters, signed update path; acceptance pending |
| Linux x86_64 | 0.2.5 AppImage and Debian package | Electron AppImage and Debian package; acceptance pending |
| Windows | None | Not implemented; tracked by [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35) |

## Electron source layout

| Path | Responsibility |
| --- | --- |
| `app/src/main/` | Electron main process and application lifecycle |
| `app/src/preload/` | Sandboxed renderer bridge with a narrow API |
| `app/src/contracts/` | Runtime-validated IPC and build/platform contracts |
| `app/src/core/{recording,speech,models,text}/` | Platform-neutral recording, speech, model, and text logic |
| `app/src/services/{recording,speech,models,settings,update}/` | Feature services for recording, speech, models, settings/history, and updates |
| `app/src/platforms/linux/{kde,x11,shared}/` | Linux desktop adapters for KDE, X11, and common Linux integration |
| `app/src/workers/` | Isolated speech work and process supervision |
| `app/ui/` | Electron-only renderer, English/German locales, icon, and Inter font |
| `app/data/` | Model catalog, local-processing schemas, and multilingual test vectors |
| `app/native/` | Pinned speech engine and focused capture/desktop bindings |

The renderer communicates only through the schema-validated Electron preload contract. Keep
settings and recording UI shared inside this renderer, and keep platform permissions and native
capabilities in host services. Validate every IPC boundary at runtime. Dev storage and identity
are separate from stable storage; no Dev data is imported automatically.

The `shared` Linux platform area contains common Linux integration code; it does not hold a second
renderer or duplicate shared UI. GNOME and wlroots use these services according to detected
capabilities, with usable controls and clipboard fallback when desktop features are unavailable.

## Runtime boundaries

Speech recognition is local and runs through the pinned native speech dependency. Ordinary
dictation must not depend on optional text-model communication or later integrations. Audio,
transcripts, vocabulary, clipboard contents, and device names must not appear in logs or
automated receipts.

Linux packages use AppImage and Debian formats. Desktop capabilities vary; preserve usable
recording controls and clipboard fallback if global shortcuts, paste permissions, tray support, or
overlays are unavailable. macOS requires microphone permission and may require user approval for
input automation. Passing a source test or a container build does not establish physical-device
or full desktop support.

The 0.2.5 native implementation and its detailed historical behavior/evidence are preserved at
the immutable [release source commit](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4),
including its [Linux acceptance record](https://github.com/juferdinand/OpenWhisper/blob/d69b43bf6e7017c61089e117e79af34f57f297c4/docs/LINUX.md).
Do not attribute those legacy results to the Electron replacement.

Optional LM Studio/Ollama communication is a development preview and remains separate from
ordinary dictation. Further integrations follow the [roadmap](ROADMAP.md). Windows implementation,
Apple Developer ID signing, and notarization are future work.
