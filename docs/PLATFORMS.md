# Platform architecture

The current 0.3.1 release uses the Electron app in `app/`. See [release status and evidence](ELECTRON-STATUS.md)
for exact package and test scope. The [immutable 0.2.5 source](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the former native hosts and their historical evidence.

| Platform | Current release | Status |
| --- | --- | --- |
| macOS 14+ | 0.3.1 Universal DMG and ZIP | Self-signed, not notarized; see status for tested scope |
| Linux x86_64 | 0.3.1 AppImage and Debian package | See status and [Linux evidence](LINUX.md) |
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
| `app/src/workers/{recording,speech,migration,platform}/` | Worker implementation by feature; six stable entry files remain at the worker root |
| `app/ui/` | Electron-only renderer, English/German locales, icon, and Inter font |
| `app/data/` | Production model catalog |
| `app/tests/fixtures/{text,local-processing}/` | Multilingual text rules and local-model endpoint/profile/response regression cases |
| `app/native/` | Pinned speech engine and focused capture/desktop bindings |

The renderer communicates only through the schema-validated Electron preload contract. Keep
settings and recording UI shared inside this renderer, and keep platform permissions and native
capabilities in host services. Validate every IPC boundary at runtime. Development storage and
identity are separate from stable storage; no development data is imported automatically.

The `shared` Linux platform area contains common Linux integration code; it does not hold a second
renderer or duplicate shared UI. GNOME and wlroots use these services according to detected
capabilities, with usable controls and clipboard fallback when desktop features are unavailable.

GPU selection belongs to speech: `services/speech/` owns backend resources, context lifetime and
window fallback; `workers/speech/` owns the isolated inference protocol. Vulkan/shaderc/header
pins in `app/native/` and `scripts/native-dependencies.ts` are build inputs, not another feature.

Recording level/time updates use a small validated, generation-bound telemetry event. Full state
still covers initialization, phase changes and other feature updates; telemetry never carries user
text. Keep stale-generation and delayed-initial-state regression coverage when changing this path.

## Reuse and interface decisions

The application already uses Zod for runtime contracts, `tar` for archives, Koffi for focused FFI,
and Noble hashes. Universal packaging and compilation reuse `@electron/universal` and esbuild.
New dependencies should remove a demonstrated maintenance burden while preserving capabilities.

- Use narrow interfaces for interchangeable process/platform effects, and schema-derived types
  for validated data. This follows the [TypeScript object model](https://www.typescriptlang.org/docs/handbook/2/objects.html)
  and the [Google guide's preference for object interfaces](https://google.github.io/styleguide/tsguide.html#prefer-interfaces-over-type-literal-aliases);
  it does not require a class or a file for every type.
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut) is a candidate
  for ordinary toggle shortcuts. Its activation callback does not provide our complete hold/release
  and mouse contract. Prove identity, consent/conflict and restart behavior on the pinned Electron
  version before retiring specialized adapters.
- [dbus-native](https://github.com/sidorares/dbus-native#unix-file-descriptor-passing) is a transport
  candidate, but its documented built-in FD transport is Bun-specific. Our Node/Electron portal
  integration uses Unix FDs; require a demonstrated Node-compatible ownership/cleanup path before
  replacing GIO. Type declarations alone do not establish this capability.
- [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) has no built-in Linux
  support. It is not a replacement for the current package/signature/rollback policy. Any future
  library change must retain existing update identities and strict archive/source checks.

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
