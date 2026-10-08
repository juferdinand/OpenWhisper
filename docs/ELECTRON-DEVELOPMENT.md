# Isolated Electron development

The [migration plan](ELECTRON-MIGRATION.md) defines replacement and acceptance gates.
The default build starts **OpenWhisper Dev** with the existing settings UI,
a schema-validated sandboxed bridge and private settings/session directories. An explicit
CPU recording build connects the shared controls to native capture and clipboard output on
Linux and macOS. The target version is **0.3.0**; see [current status](ELECTRON-STATUS.md).
The default lightweight preview leaves recording disabled. The CPU Dev supports explicit
Linux F8 setup and optional keyboard-only paste; autostart and stable updates remain disabled.
It does not replace the released 0.2.5 application or establish desktop/speech parity.
The About view shows the Dev build's source commit and whether the checkout was modified;
the Models view exposes the selected private model directory.

## Build and run

Use Node.js 24–26 and npm. Install the locked shared UI dependencies, then the Electron
development dependencies and explicitly download the pinned Electron runtime:

```bash
cd shared/ui
npm ci
cd ../../electron
npm ci
npm run setup
npm run dev
```

The development launcher resolves the already installed pinned binary; launching does
not automatically download a missing runtime. `setup` uses the pinned package's official
download and checksum verification. Runtime/download override variables are removed.

The default Dev profile is `io.github.whisperfree.dev` beneath separate configuration,
data and cache bases. An explicit absolute private root can be selected:

```bash
npm run dev -- --dev-profile /absolute/private/path/openwhisper-dev
```

Existing Dev directories must be owned by the current user with mode `0700`; stored
preferences use `0600`. Stable storage, overlapping bases, symlink paths and unsafe
existing directories are refused. No stable preferences, models or recovery files are
imported automatically. Closing the main window quits this Dev host so it stays
reachable without assuming a working tray host.

## Desktop controls

The tray uses the existing app icon and shared English/German labels. Its Settings,
Start/Stop, Cancel and Quit actions use the same recording handlers as the shared UI.
Unavailable recording actions stay disabled; closing the main window still quits.
Native tray presentation on each desktop remains an acceptance item.

The floating control loads the same trusted shared UI through a sandboxed, restricted
overlay bridge. It shows during recording/transcription/recovery, or when the existing
idle-overlay preference is enabled. Built-in non-activating presentation is enabled on
macOS and X11, including an explicitly selected XWayland backend. The owned KDE XWayland
test covers actual pointer Cancel without moving keyboard focus.

Native Wayland uses the main recording control for now: Electron's
[inactive-show API is unsupported there](https://www.electronjs.org/docs/latest/api/browser-window#winshowinactive),
and the real KDE probe lost focus. The known unsafe path is guarded, without globally
forcing XWayland. A native layer-shell surface using shared renderer output remains
required by the full migration plan; GNOME needs usable fallback controls.

The isolated `--experimental-wayland-overlay` switch tests a strict TypeScript
GTK/layer-shell utility that paints the existing offscreen shared renderer.
On stock KDE 5.27, its dock role passes actual pointer Cancel/Stop and foreground
editor keyboard delivery without refocusing. That role stacks below active
fullscreen and keep-above windows; those cases and other compositors remain
open, so the prototype is not enabled by default. See the
[exact owned evidence](ELECTRON-DEV-EVIDENCE.md).

## Linux CPU recording Dev build

Build and start the normal shared UI with recording explicitly enabled:

```bash
cd electron
npm run dev -- --recording --dev-profile /absolute/private/path/openwhisper-dev
```

This opt-in build requires CMake, Ninja, a C/C++ compiler and a local Pulse-compatible
server (PulseAudio or PipeWire-Pulse). Pinned native sources and headers are verified before
compilation. Linux command control also requires the GLib/GIO development libraries and pkg-config.
Wayland output requires the installed `wl-clipboard` tools (`wl-copy`, `wl-paste`).
Build-time descriptors capture the expected capture entry, native addon and speech
dependency graph; the runtime does not refresh expected hashes from whatever files it finds.
These development descriptors are integrity checks, not release signing or publisher identity.

In **Models**, download a catalog model or import a local compatible `.bin` file into the
private Dev inventory. Select CPU and clipboard output. Choose a microphone in **General**,
or leave the system default; the current concrete default is resolved on each Start. Opening
settings and enumerating devices does not open an audio stream. Start/Stop and Cancel use
the shared controls. The speech engine runs in a separately supervised utility, with retained
stopped audio saved privately before inference. Retry does not reopen a microphone; explicit
Discard removes its recovery WAV. There is no fixed recording duration limit.

Successful output is copied completely and verified by readback before recovery removal.
On Wayland, a foreground `wl-copy` process retains the selection and a separate
`wl-paste` client confirms the exact bytes. Text is supplied through stdin and is
never included in arguments or logs. The helper is retired before replacement and
at Quit; missing tools or failed publication leave stopped audio available for retry.
Large output is not cut to fit the bounded UI preview: Copy retrieves the complete text;
with history enabled it is also saved as a private `.txt` in the Dev transcripts directory.
History and models remain separate from the installed release. Recording is independent
of the optional text-model preview. Packaged/signed replacement remains separate migration work.

The recording build also connects an authenticated, same-user D-Bus control service to the
same recording owner used by the window. Its Dev name is `io.github.whisperfree.dev.Control`,
object `/io/github/whisperfree/dev/Control`, interface `io.github.whisperfree.Control1`.
`Status()` returns a finite status; `Execute(string)` accepts `start`, `stop`, `toggle` or
`cancel`. An immutable recording lease prevents a delayed command from stopping a later
recording. This Dev service is separate from the planned packaged `--control` launcher.

On KDE with a running KWin/KGlobalAccel service, **General → Set trigger** captures
a keyboard key or chord inside the window. Release the selected key to confirm;
Escape, Cancel or window focus loss leave the existing binding in place. Conflicts
are refused. Registration is session-only and begins after explicit setup, with
the selected profile saved privately. A saved Dev profile does not bind on startup.
Modifier-only keys use toggle mode; direct mouse support is not yet ported. A private
recovery journal precedes registration and only dead owners can be recovered.
Explicit setup recovers a crashed session action before asking for the next key,
so KDE cannot consume that key first. Startup itself leaves the journal untouched.
**Remove trigger** releases the owned action. The normal stock KDE F8 setup,
toggle dictation, held-key/GUI cancellation, Quit with an active binding and
same-profile crash recovery paths have owned runtime evidence.

Genuine X11 now has a separate TypeScript/native-keyboard implementation inside
the existing platform utility; it does not run on Wayland or XWayland. Explicit
setup uses native X11 focus and preserves the legacy X11 profile independently of
KDE settings. The owned Xvfb run passes actual F8 setup, Escape preservation,
held/repeated keys, CPU dictation, clipboard/history, trigger removal and
Retry/Discard. Registration remains session-only after explicit setup; a saved
profile does not bind on startup. Named-desktop/layout coverage and automatic
X11 paste remain follow-up work rather than established support.

On remaining desktops, **Set trigger** creates a GlobalShortcuts portal session. Setup
opens only after an explicit click; no global binding is registered on Dev startup.
The desktop chooses the combination, and the UI shows its confirmed description.
Pending consent has a **Cancel** action. Toggle uses activation edges; push to talk
uses actual activation/release edges. A release during pending Start cancels that
same acquisition. Session loss, binding removal and application shutdown close
owned recordings and portal resources; an unrelated GUI recording is preserved.
An unavailable portal leaves the main recording controls usable.

On Linux, **Allow automatic paste** explicitly opens a keyboard-only RemoteDesktop
portal session. Pending setup exposes **Cancel**; denial permits an explicit retry.
Select paste output after granting permission. Permission loss or an uncertain paste
reply leaves confirmed clipboard output and a visible fallback notice; it cannot
cause another automatic insertion. Revoke closes the session. No screen capture is
requested. The stock KDE native Wayland target case passes with its legacy immediate
grant; GNOME dialogs and inner XWayland target delivery remain separate checks.

The portal connection registers the separate `io.github.whisperfree.dev` identity.
Its matching `.desktop` launcher must be discoverable by the desktop frontend;
Dev permissions and bindings must not use the stable application's identity.
Automated evidence includes a synthetic frontend on a real private D-Bus, virtual
audio and normal UI. Stock KDE 5.27 regular-key control is also checked through
actual virtual key edges in nested KWin. Specialized KDE/X11, GNOME and remaining
replacement gates still need validation; see [the evidence](ELECTRON-DEV-EVIDENCE.md).

## Linux Dev package preview

An existing Linux x64 build can be copied into a separate Dev directory and Debian
archive without building, downloading, installing or launching it:

```bash
cd electron
node --import tsx scripts/package-linux-preview.ts --output /absolute/fresh/output
```

This requires `readelf` and `dpkg-deb`; use `--directory-only` when only the directory
is needed. The script preserves package/build metadata, checks captured native
inputs, copies the locked production dependencies and retains notices. It uses
the separate Dev package, launcher and `/opt/openwhisper-dev` destination. Archives
are unsigned previews and do not replace the stable application.

Native inputs must be built on the intended distribution baseline. A fresh private
Ubuntu22 build of the existing production recording scripts now produces a Dev
package whose native ELF requirements are at most GLIBC2.34/GLIBCXX3.4.29. Its
actual executable passes the owned X11 dictation/recovery case with its captured
inputs intact. A newer host build may require newer libraries; the package metadata
declares the inspected floor. Host installation, AppImage, updates and release
acceptance remain separate checks. See the [exact evidence](ELECTRON-DEV-EVIDENCE.md).

## Linux stable validation package

A fresh Linux x64 build can capture the persistent stable identity explicitly:

```bash
cd electron
npm run build -- --stable --recording
node --import tsx scripts/package-linux-preview.ts --output /absolute/fresh/output
```

Use the intended native distribution baseline, as for the recording Dev build.
The captured `APPLICATION_BUILD` selects `OpenWhisper`, executable `openwhisper`
and `io.github.whisperfree`; the package requires matching recording inputs and
launches normally without Dev flags. It opens existing stable data. Use disposable
owned HOME/XDG roots for this validation package; the Dev installer does not handle it.

The normal main awaits Linux migration before Electron path/readiness/service setup.
Exact legacy JSON and WAV originals are preserved, existing models remain in place,
and new Electron state is private. Pre-UI recording configuration restores saved
Retry without resolving/opening a microphone. The owned package passes saved-WAV
Retry, native X11 CPU dictation/clipboard/history and restart after edits/Discard
in 47.29s, with no Dev control owner and an unchanged separate Dev sentinel. The
same stable package passes the embedded Node startup fixture; a fresh default Dev
package from the same frozen source passes the X11 regression in 43.22s.

The tested `.deb` is unsigned `0.3.0~dev.58169b3a8cc1.modified`; producer metadata
remains 58169b3a8cc167e7538f434e02f95fe437f46d68+modified. This is a validation build,
with no installer, release/update channel or changes to current installations.
Mac stable filesystem data, autostart, stable command control, updater and release
continuity remain pending. The [evidence](ELECTRON-DEV-EVIDENCE.md) retains the first
failed saved-WAV startup attempt and the corrected package result.

## Install a separate local Dev copy

The compiled `dist/cli/install-dev.js` installs an already assembled recording Dev
directory or `OpenWhisper Dev.app` into a fresh directory under the current user's
home. It uses the package's embedded Node runtime; a system Node installation is
unnecessary. Supply an absolute source, a nonexistent installation root and a
nonexistent private profile. All destination parent directories must already exist.

For Linux x64, also supply a fresh `io.github.whisperfree.dev.desktop` file:

```bash
ELECTRON_RUN_AS_NODE=1 /absolute/OpenWhisper-Dev-Linux-x64/openwhisper-dev \
  /absolute/OpenWhisper-Dev-Linux-x64/resources/app/dist/cli/install-dev.js \
  --source /absolute/OpenWhisper-Dev-Linux-x64 \
  --installation-root /home/you/OpenWhisper-Dev-030 \
  --profile /home/you/OpenWhisper-Dev-030-profile \
  --desktop-file /home/you/.local/share/applications/io.github.whisperfree.dev.desktop
```

For a matching Apple Silicon or Intel Mac package:

```bash
ELECTRON_RUN_AS_NODE=1 "/absolute/OpenWhisper Dev.app/Contents/MacOS/OpenWhisper Dev" \
  "/absolute/OpenWhisper Dev.app/Contents/Resources/app/dist/cli/install-dev.js" \
  --source "/absolute/OpenWhisper Dev.app" \
  --installation-root /Users/you/OpenWhisper-Dev-030 \
  --profile /Users/you/OpenWhisper-Dev-030-profile
```

The command verifies captured recording inputs, locked dependencies, architecture
and copied bytes. Mac copies use `ditto` and retain the existing signature, verified
again after copying. Existing installations, profiles, launchers, stable storage,
symlink ancestors and overlapping paths are refused. It does not create the profile
or launch the app. Its JSON result supplies `executable` and `launchArguments` for
an explicit later launch; Linux's new desktop launcher includes the profile argument.
The ordinary installed package passes the owned Linux X11 recording/recovery check
and both Apple Silicon/Intel Mac startup, sandbox, signed-utility and shortcut checks.

This is a local Dev copy, not a signed release download or updater. Source metadata
and the inventory digest describe the selected local bytes; they do not authenticate
an unsigned Linux package. Archive downloads, replacing an existing Dev version,
stable installation/update transitions and Mac stable-data migration remain separate work. The owned Mac and
Linux package runners exercise the installed payload; see the current
[evidence](ELECTRON-DEV-EVIDENCE.md) for actual pass or pending results.

## macOS CPU recording Dev build

Use the same explicit `npm run dev -- --recording --dev-profile /absolute/private/path/openwhisper-dev`
command on macOS 14 or later with the Xcode Command Line Tools, CMake and Ninja installed.
The build compiles the Apple capture edge and production process-retirement addon, then
captures their expected bytes before launch. Select a private model, CPU and clipboard output.
The existing microphone button requests permission only when clicked. Denied permission
opens the microphone section of System Settings; focus refreshes the current permission state.

Each recording owns a fresh AVFoundation capture session in a utility process. Stopped
audio remains in RAM for Retry/Discard; it is never written to a Mac recovery WAV. Quit is
refused while a stopped recording still needs delivery or explicit discard. There is no
fixed recording duration limit. CPU recognition uses the continuing supervisor with the
actual original child identity and full process retirement before replacement.

The Mac recording Dev exposes **Set trigger** for a regular key or chord through
Electron globalShortcut. Confirm on release; Escape, Cancel and main-window focus
loss restore the previous binding. Conflicts are refused and **Remove trigger**
removes only this adapter's binding/profile. Dev registration starts only after
explicit setup. This adapter uses toggle mode; Fn, modifier-only, mouse and hold
triggers remain unavailable. The shared UI explains that restriction.

Mac **Allow Accessibility access** requests permission only after an explicit click.
Paste output confirms the complete clipboard before requesting one Command+V pair.
It refuses insertion into the app itself, a changed foreground application or while
modifier keys are held. Missing permission or a refused attempt leaves clipboard
output available. Clipboard restoration is unavailable in this adapter; its control
is hidden without changing the legacy Swift interface.

The normal Mac composition is implemented and covered by synthetic/unit tests. Signed
production capture and speech helpers load and exit in both actual packaged CI apps.
Physical microphone permission and default-device changes still require their acceptance
checks; do not treat native CI conversion tests as hardware validation.
Global Fn/modifier/mouse triggers, actual target paste, assembled overlay behavior,
Metal selection and signed release packages remain incomplete.

The existing Apple Silicon and Intel CI jobs now build a separate, per-architecture
`OpenWhisper Dev.app` and ZIP with ad-hoc signing. Packaging verifies native signed
bytes, bundle identity and the extracted archive. An owned CI driver launches that
actual package with a private profile, checks the sandboxed shared UI, exercises
regular-key setup/removal and exits through normal Quit. It requests no microphone
or Accessibility permission and sends input only to its own Chromium window.
The same smoke passes real recognition of checksum-pinned public audio with Tiny
through the signed CPU speech helper on both architectures in CI37842623817.
This does not replace physical microphone/device acceptance.
These artifacts are Dev previews; universal/release signing and stable updates
remain separate work. See the [evidence](ELECTRON-DEV-EVIDENCE.md).

## Automated checks

```bash
cd electron
npm run typecheck
npm test
npm run build
node --import tsx tests/owned-stable-startup.ts # Linux only; compiled worker, disposable legacy home
cd ../shared/ui
npm run test:ui
```

The ordinary Electron tests do not launch a display or microphone. The explicit owned
UI launcher uses a separate container, UID 1000, private Xvfb and synthetic stable-data
sentinels. It exposes no host display, session bus, audio/input devices or stable profile;
Chromium sandboxing stays enabled. Its retained screenshots and runtime evidence cover
the Dev UI and bridge, not KDE/GNOME shortcuts, target-app paste or dictation.

After `npm run setup` and `npm run build`, run it on x86_64 Linux with Docker available:

```bash
cd electron
node --import tsx scripts/test-owned-ui.ts --output /absolute/path/new-evidence-directory
```

The evidence destination must not exist. The image recipe pins its base digest, core
runtime package versions and Node archive checksum; the launcher pins and retains the
upstream seccomp policy/license, selective namespace allowances and all tested input hashes.
It removes its test container after collecting evidence. Image provisioning runs as root
inside the container; the test application and display run as UID 1000 without capabilities.

The initial 2026-10-08 evidence includes 47 foundation unit tests, all 42 shared UI tests
for the existing macOS/Linux adapters, and a real Electron 44.7.0 Dev launch/restart in
the owned Debian 13 container. The runtime checks observed the renderer's Chromium
seccomp filter, nested PID namespace, zero effective capabilities and enabled sandbox;
validated the isolated preload, denied network/navigation/popups, preserved focused
fields and switch nodes, and checked EN/DE persistence, Dev build/profile identification
and unchanged synthetic stable settings/models/history/recovery/autostart files.
These historical checks cover P1 only. Later recording, platform and package checks,
including the owned Linux stable bootstrap above, have their own retained scope.
The later checks and exact candidate provenance are in the
[development evidence record](ELECTRON-DEV-EVIDENCE.md).

## CPU speech and lifecycle work

P2 ports the shared text fixtures, model catalog and recording state machine to strict
TypeScript. Synthetic lifecycle tests cover final sample fencing before Stop acknowledgement,
expired callers, stale results, Linux retained-audio recovery, Mac RAM-only recovery and
confirmed delivery before removal. Their logical clock/sample ledger exceeds one hour.
Separate owned Pulse capture exceeded 300 seconds; its long-run artifact and the later
Stop-error followup artifact are distinguished in the evidence record.

The native CPU binding uses checksum-pinned whisper.cpp/Parakeet source and Node-API 8
headers. It is loaded in a disposable worker, never in the application main. No new native
module is loaded when the default lightweight Dev preview starts. CPU remains the default distribution
artifact. Explicit CPU/Vulkan/Metal build profiles have separate output directories and
artifact manifests; GPU profiles are acceptance inputs, without automatic runtime selection
or release packaging. The owned Linux probes exercise real public Whisper and Parakeet
models, including absent-device, software-only Vulkan and absent-loader cases. Hardware
GPU execution and the macOS Metal profile remain separate gates.

```bash
cd electron
npm run build
npm run build:native
node --import tsx scripts/fetch-speech-fixtures.ts
OPENWHISPER_NATIVE_TEST_MODEL="$PWD/.local/speech-fixtures/ggml-tiny.bin" \
OPENWHISPER_NATIVE_TEST_AUDIO="$PWD/.local/speech-fixtures/jfk.f32" \
  node --import tsx --test tests/native-speech.test.ts
```

The public test model/audio are checksum-pinned and never use a microphone. The probe
recognizes the fixture twice in one context, rejects reuse under an incorrect model family,
reloads the original model and releases the context. CI runs this CPU probe on Linux and
macOS. Build requires CMake, Ninja and a C/C++ compiler. `npm run build` cleans `dist`, so
run `build:native` afterward when exercising native workers.

Optional native primitives and GPU profiles can be built explicitly:

```bash
cd electron
node --import tsx scripts/build-native.ts --backend vulkan
node --import tsx scripts/build-linux-bus.ts
node --import tsx scripts/build-capture.ts
OPENWHISPER_CAPTURE_SYNTHETIC_ADDON="$PWD/native/capture/build/openwhisper_capture.node" \
  node --import tsx --test tests/capture.test.ts
```

Vulkan builds also need the platform Vulkan loader and the pinned shader compiler graph.
The portable CPU instruction profile does not remove dynamic library requirements.
The last command uses synthetic native samples and never opens audio. The owned
[capture](../electron/tests/owned-capture/README.md),
[control](../electron/tests/owned-control/README.md) and
[composed recording](../electron/tests/owned-recording/README.md) procedures isolate
their services in disposable containers. They do not use the running desktop or profile.

The separate [owned utility probe](../electron/tests/owned-speech/README.md) exercises the
compiled transport in actual Electron 44.7.0 on Ubuntu 22.04, including incompatible-host
ABI containment, context reuse, native failures, crashes, an intentionally stopped helper,
confirmed force-reap before replacement and malformed frames. Its Node utility process
is not an OS sandbox; the private, unprivileged test container is the isolation boundary.
No desktop, capture, GPU or complete replacement claim follows from these checks.

## Private model inventory and Apple capture checkpoint

The host-only inventory service enumerates private catalog/custom models, captures an
immutable CPU/GPU preference with a file lease and imports complete files atomically.
Mutation is refused while a lease is held; a failed process-retirement Promise retains it.
Bounded copying, exact names, private file identity and durable publication are tested.
`private-file` verification means safe storage, not publisher authenticity or valid weights.
The recording Dev host now exposes catalog downloads and host-owned imports through the
shared UI; the renderer never selects an arbitrary destination or native model path.
The later Linux stable bootstrap retains safe legacy models in place; this Dev
import service does not perform migration. Mac stable filesystem migration remains open.

An opt-in Apple capture edge uses AVAudioEngine/AVAudioConverter behind Node-API 8.
The shared Linux capture implementation is unchanged. Its owned CI fixture feeds generated
PCM in an actual Electron utility and checks full tails, format changes and Stop ownership
without allocating an input engine or querying/requesting microphone permission.
The separate jobs use `macos-15` and `macos-15-intel`, compile with a macOS 14 deployment
target and retain architecture, Mach-O and categorical runtime evidence. They do not prove
a macOS 14 runtime, hardware/default-input behavior, TCC, signed-helper loading or OS
retirement from a generic Electron exit event. Reproduce only in the owned Apple CI VM using
the [synthetic capture procedure](../electron/tests/owned-macos-capture/README.md).

## Optional text-model preview

P5 adds a disabled-by-default manual preview at the end of **Models**. Its numeric-loopback
LM Studio/Ollama requests originate in the host and use separate private settings. Input
and replies are transient and are not persisted by the host; the renderer retains them for
that session and the selected server receives the submitted input. They do not change dictation, history,
clipboard delivery or recovery. See [manual model preview](LOCAL_MODELS.md) for setup,
privacy, limits and acceptance steps. This development feature is absent from release 0.2.5.

The owned UI fixture also exercises actual Dev IPC against its own synthetic model server:
send, cancel, retry, categorical HTTP errors, transient multilingual text, English/German
controls, private profile persistence and unchanged synthetic stable data. These fixtures
prove protocol/UI behavior, not the quality of a user-selected model. Native capture,
platform adapters, universal packaging, existing-data migration and signed old-client
updates remain separate gates. Keep the existing application hosts until those gates pass.
