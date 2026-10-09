# Electron migration plan

Status: implementation in progress on isolated draft PR #34; target release **0.3.0**.
See [implementation status](ELECTRON-STATUS.md) for delivered behavior and remaining work.
Prepared 2026-10-08 against signed public `v0.2.5`
(`d69b43bf6e7017c61089e117e79af34f57f297c4`). This is the authoritative record of
the requested architecture, research answers, development-build strategy and issue/PR disposition.
Complete and independently review this plan before creating its implementation issue; then
implement it on an isolated branch with reviewable packages and automated evidence.

## Decision and scope

Owner priority update, 2026-10-08: finish the current genuine-X11 increment, then
defer expanded Linux desktop and special-input coverage to existing bug reports.
Basic dictation, controls and installation must work on both macOS and Linux for
0.3.0. The broader gates below remain the architecture/backlog record, rather
than requiring exhaustive Linux matrices before the basic replacement is usable.
Keep actual known basic-function failures blocking, unsupported controls explicit,
strict update/data/signing guarantees intact and user acceptance before merging
or replacing an installation.

Owner scope update, 2026-10-09: live LM Studio/Ollama trials are follow-up work
in [#11](https://github.com/juferdinand/OpenWhisper/issues/11), outside the 0.3.0
release gates. Retain the existing disabled manual preview and deterministic
regression checks; ordinary dictation remains independent of model servers.

Replace the Swift/WebKit macOS host and Rust/Tauri Linux host with one Electron application.
Keep the current `shared/ui` design, icon, Inter font, navigation and English/German interface.
Use shared Chromium renderer code and one set of typed application services, with explicit platform
adapters. A later design change is separate work. Windows remains unimplemented.
Retain macOS 14+ on Apple Silicon and Intel and Linux x86_64 packaging from Ubuntu 22.04.
Verify the selected Electron/native dependencies on the minimum supported OS and each shipped
architecture; a universal archive alone does not establish minimum-OS compatibility.

Author new application code, main/preload processes, IPC, workers, platform orchestration,
tests and build tools in **strict TypeScript**. Enable `strict`, `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes`; prohibit authored JavaScript, unchecked IPC casts and
untyped application dependencies. Generated JavaScript is a build artifact. Type annotations
alone are insufficient at process boundaries: validate unknown input and output with runtime
schemas and derive TypeScript command/event types from those schemas.

Native OS APIs and pinned whisper.cpp remain a narrow compiled dependency boundary.
Use typed Node-API bindings and isolated C++ helpers, with Objective-C++ only where macOS
frameworks require it. Keep application policy, state, permissions and orchestration in TS.
This boundary covers native speech, global event edges, protected target-app injection,
native audio conversion, signature checks and any unavoidable overlay/restart primitive;
it is not a second application host. Audit and minimize it rather than copying an untyped
third-party application. Remove all Swift/Rust application sources and obsolete build paths
after their replacement gates pass. Wrapping the existing hosts permanently is outside this plan.

### Why are C/C++ files present?

Electron does not require our own C/C++ application code. The current boundary contains:

- `electron/native/speech_*.cpp`: bindings to the pinned whisper.cpp/Parakeet library for local
  CPU/GPU inference. These engines are native dependencies; TypeScript orchestrates them.
- `electron/native/capture/` and `macos-capture/`: miniaudio and CoreAudio bindings for capture
  and conversion. Browser audio APIs are an alternative subject to the M-CAPTURE parity gate.
- `electron/native/linux-bus/`: the chosen D-Bus transport binding; KDE/portal policy remains
  TypeScript. A custom addon is an implementation choice, not an Electron requirement.
- `electron/native/macos-retirement/`: a process-lifecycle probe and separately gated production
  source role. This custom kernel boundary is also an implementation choice.

Prefer existing Electron/Node APIs or maintained typed adapters where they meet the same
behavioral requirements. Keep application logic, new scripts and tests in strict TypeScript.
The user's preference is to avoid custom C/C++ where possible. Before adding any new native
source, identify the required capability and explain why an existing API or executable
does not meet it. A chosen custom transport is not proof that the transport requires C++.
C++ is statically typed but does not provide automatic memory safety; native bindings require
their own validation and lifetime checks. Native libraries may be used through a separate
executable instead of a custom Node addon; that still leaves a native dependency.

OpenWhispr also uses native components: its
[Whisper service](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/whisperServer.js)
starts a compiled server, and its
[Linux paste helper](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/resources/linux-fast-paste.c)
is written in C. This supports the need for some native dependencies, not the necessity of
every custom binding chosen here.

Pin a supported Electron patch and its lockfile. The audited starting point is
[Electron 44.7.0](https://github.com/electron/electron/releases/tag/v44.7.0), released
2026-10-07 with Node 24.21.0. Recheck the patch before implementing. The inspected OpenWhispr
commit declares Electron 41; do not assume its behavior matches current documentation.

## Answers about OpenWhispr

The read-only audit used OpenWhispr commit
[`7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb`](https://github.com/OpenWhispr/openwhispr/tree/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb),
package version 1.10.2. Its code was inspected without running its installers, inference,
authentication, billing or native input helpers. Source observations are not desktop acceptance.

### Does Electron solve every Linux desktop?

It supplies a common renderer, window/tray primitives and some shortcut support, but does
not establish equivalent KDE, GNOME, X11 and wlroots behavior. Global shortcut activation
does not expose our full key/button press-release contract. Wayland window placement and
inactive overlays depend on compositor protocols; target-app paste remains permission-dependent.
These are documented API boundaries, not a reason to retain two UI hosts.
[Electron shortcuts](https://github.com/electron/electron/blob/v44.7.0/docs/api/global-shortcut.md),
[window options](https://github.com/electron/electron/blob/v44.7.0/docs/api/structures/base-window-options.md).

OpenWhispr has additional KDE/GNOME/Hyprland trigger paths and native helpers; it does not
rely on Electron alone. Its Linux implementation also includes a raw `/dev/input` fallback,
rejects Linux mouse triggers, forces XWayland for window behavior, and ends Linux hold recording
after five minutes. Those choices do not meet our requirements: no root/raw-input access,
preserved KDE mouse behavior, explicit native Wayland coverage and no fixed recording cutoff.
Retain our stricter contracts and test the new packages.
[Linux input helper](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/resources/linux-key-listener.c),
[Linux triggers](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/linuxKeyManager.js),
[XWayland choice](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/xwayland.js),
[Linux hold call path](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/windowManager.js#L742-L748),
[hold timeout](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/windowManager.js#L920-L937).

### Is an account required? Can the client be modified?

The inspected client already offers **Continue without account**. That intended guest flow
leads to local or bring-your-own-key setup. Personal local Whisper/Parakeet and local reasoning
have separate routes from authenticated vendor-cloud processing; using them needs no bypass.
BYOK can still use a paid remote provider unless its selected endpoint is local. Enterprise
managed policy and cloud synchronization are separate scopes.
[Guest button](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/components/AuthenticationStep.tsx#L869-L877),
[guest setup flow](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/components/onboarding/flow.ts#L229-L261),
[local routing](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/audioManager.js#L2038-L2090).

The root MIT license permits modification and commercial redistribution of covered software
with its copyright and permission notice. It does not grant access to paid hosting or rights
to every model, dependency, font or trademark. Changing a client subscription flag does not
create the credential required by the separately authenticated hosted request protocol. That
last conclusion is an inference from the client protocol, not a live server test.
[MIT license](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/LICENSE),
[cloud authentication](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/ipcHandlers.js#L6550-L6562).

### How do they earn money? Is the whole product open source?

Their [advertised pricing](https://openwhispr.com/pricing), checked 2026-10-08, offers free
unlimited local dictation/models and BYOK transcription, limited free hosted use, paid Pro/Business subscriptions and custom
Enterprise offerings. Paid hosting and team/workflow services can coexist with an MIT client.
Actual revenue and the live quota implementation were not verified.

A deployable vendor-hosted authentication/transcription/billing backend was not identified
in the audited tree or public organization inventory. It might exist privately or elsewhere;
therefore a claim that the complete service is 100% open source is unproven. The repository
also explicitly excludes commercial Yowza fonts and supports a public fallback. Keep our
existing Inter/design/assets; no private OpenWhispr assets are needed.
[Hosted API client](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/helpers/ipcHandlers.js#L10123-L10203),
[public repositories](https://api.github.com/orgs/OpenWhispr/repos?per_page=100&type=public),
[private font boundary](https://github.com/OpenWhispr/openwhispr/blob/7ba7a37bf8340cc474cdcb3f5643e8d207fa9dbb/src/assets/fonts/yowza/README.md#L3-L13).

These are primary sources from the same project, not independent confirmations of its claims.
Recheck changing prices, other client versions and any dependency/assets actually reused.
OpenWhisper remains MIT, account-free and local for ordinary recognition. Future Enterprise
sync ideas remain private planning; this migration creates no Enterprise feature issues.

## Target structure and contracts

The transitional application lives in `electron/` while the existing hosts remain.
The final application directory will be `app/`, as requested. Rename it together
with P6 host retirement and path consumers, rather than changing package roots in
the middle of the data/update transition. Windows remains separate follow-up work
in [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35).

```text
electron/
  src/main/                 App lifecycle, trusted windows, tray and service wiring
  src/preload/              Minimal schema-backed renderer API
  src/contracts/            Commands, events, worker messages and runtime schemas
  src/core/                 Text processing, models and shared recording state
  src/services/             Settings, models, history, recovery, delivery and updates
  src/workers/              Disposable speech/model work and bounded protocols
  src/platforms/macos/      Permission, capture, trigger, injection and signing adapters
  src/platforms/linux/
    kde/                    KGlobalAccel and owned KWin leases
    gnome/                  Portal capabilities and consent lifecycle
    x11/                    Real X11 grabs/XKB and opted-in XTEST
    wlroots/                Explicit compositor-command integration
    shared/                 Session, portal, clipboard, tray and overlay fallbacks
  native/                   Minimal compiled bindings/helpers; no Swift/Rust host
  scripts/                  TypeScript build, packaging and development commands
  tests/                    Contract, service, package and native acceptance checks
shared/
  ui/                       Existing authoritative renderer, layout and assets
  locales/                  Existing synchronized English/German messages
  models.json               Existing authoritative model catalog
  test-vectors.json         Existing multilingual text-processing fixtures
```

### Code quality and final repository layout

Track the reviewed cleanup in [issue #36](https://github.com/juferdinand/OpenWhisper/issues/36)
alongside the original P6 replacement scope.

The bounded Luna review at `40805be` counted tracked authored files from Git,
excluding vendored/generated inputs: 104 application TypeScript files with
14,791 lines, 262 test/harness/fixture TypeScript files with 30,418 lines,
18 TypeScript build scripts with 1,702 lines, and nine Markdown guides with
4,156 lines. These counts distinguish application code from test infrastructure;
they do not make file count or test count a quality target.

Keep process boundaries (`main`, `preload`, `workers`, runtime contracts) explicit.
Within `core`, `services`, `contracts` and ordinary tests, group cohesive existing
features such as recording, speech, models, preferences and optional integrations.
Mirror those feature folders under `tests/` so tests are easy to find and excluded
from production compilation. Keep owned desktop/package harnesses distinct from
unit tests. Do not add empty platform/feature folders.

The concrete cleanup order is:

1. Move the platform-neutral recording lease/port currently imported by
   `main/macos-shortcut.ts` from `platforms/linux/shared` into a common recording
   area. Update both Mac and Linux consumers together.
2. Keep `main/index.ts` as the single composition entry, but extract focused
   recording/platform/UI setup functions. Move Mac and Linux adapters to their
   respective `platforms/` folders, preserving their APIs and fixed worker entry
   names. Group ordinary tests alongside the corresponding feature hierarchy.
3. At P6, rename `electron/` to `app/`, move the sole renderer/assets/locales to
   `app/ui/` and catalog/fixtures to `app/data/`, and remove the unused top-level
   `shared/` after all consumers migrate. Preserve the existing icon/font/model
   licenses before removing the old `macos/` and `linux/` source directories.
4. Update manifest/entry graphs, build paths, CI caches, version tooling,
   installers, release inputs and documentation in the same reviewed changes.
   Validate fresh packages; imports compiling alone do not establish package
   correctness.

Use small interfaces for genuine platform/process boundaries and stateful
services. Retain pure functions for text and model rules. Apply the Rule of Three
to demonstrated duplication; an abstract base class is justified only when its
implementations share behavior, rather than just method names. Avoid generic
repositories, DTO wrappers and dependency-injection frameworks that add no
required behavior.

README remains the documentation entry. Keep operational development, signing
and platform instructions through the transition; after acceptance, consolidate
durable instructions and replace the growing migration status/evidence diary
with the final result and exact CI/package references. Preserve evidence before
removing obsolete descriptions. Keep AGENTS/CLAUDE synchronized and concise.

Renovate already discovers the exact Electron/npm dependencies. Its custom
whisper.cpp manager currently watches the old Mac script, leaving the Electron
native source JSON pins outside that manager. Extend coverage for actual native
pins and coordinate their tag/commit/checksum/header expectations through human
review and package checks. Do not add a duplicate Electron npm regex manager,
enable automerge, or remove Cargo/Tauri rules before their manifests disappear.

The renderer invokes a fixed schema-derived command map, never arbitrary command strings,
shell commands or paths. Validate sender frame/origin, arguments, responses and events;
use context isolation, sandboxing and no renderer Node integration. Load trusted packaged
assets through an application origin; deny external navigation and unapproved new windows.
Keep optional model HTTP in the main/worker service, not unrestricted renderer networking.
[Electron security guidance](https://github.com/electron/electron/blob/v44.7.0/docs/tutorial/security.md).

Port pure text cleanup, vocabulary correction, snippets and model policy against the existing
shared fixtures before deleting old tests. Preserve all speech-language behavior and user
text. Preferences remain patches against the latest host state; saving must retain stable
switch nodes and edited-field focus. Keep capture IDs/generations so old callbacks cannot
change a later recording or overwrite a newly edited model preview.

Heavy capture conversion/inference runs outside the main/renderer event loops. Keep pinned
Whisper and Parakeet APIs, context ownership on one worker thread, GPU detection, manual CPU
selection and GPU/CPU retry windows. Native inference remains disposable and crash-contained;
never log requests/replies, audio, dictations, vocabulary or clipboard contents. Release native
Metal resources before normal shutdown, with a bounded kill path for hung workers.
[Utility processes](https://github.com/electron/electron/blob/v44.7.0/docs/api/utility-process.md),
[native module packaging](https://github.com/electron/electron/blob/v44.7.0/docs/tutorial/using-native-node-modules.md).

Record until explicit Stop/Cancel, with no cutoff or buffer truncation. Audio grows in RAM.
Keep the responsive Stop acknowledgement after stream closure/error checks and a generation-safe
final-sample fence, before duration-dependent preparation; then flush complete samples and
perform inference. On Linux, privately save stopped audio before inference and retain failed
WAVs across crashes/restarts until confirmed clipboard delivery or explicit
discard. Do not silently add macOS audio-file retention: preserve its current in-memory policy
unless a separately reviewed recovery feature enables it.

## Platform parity and feasibility gates

| Gate | Replacement behavior and evidence |
| --- | --- |
| L-KDE | Native root-free KGlobalAccel keys and KWin button leases, layout validation, modifier-only toggle semantics, conflicts/later edits and EOF/SIGTERM/SIGKILL recovery. Reproduce #21 held-surrogate state on stock/occupied/layout-changing maps. |
| L-GNOME | Accurate portal availability and explicit grant/revoke/cancel/retry. Preserve hold semantics only where true release edges exist. Repeat #30 combined consent, hold→toggle and actual native/XWayland target delivery with private audio. |
| L-X11 | Activate only on real X11, not Wayland through XWayland. Preserve key-down/up, repeats, lock variants, layout invalidation, capture cancellation, helper ownership and session-only opted-in XTEST with modifier guards. |
| L-WLROOTS | Packaged start/stop/toggle/cancel/status commands contact only an existing authenticated same-UID bus owner. No service activation, display/audio initialization or compositor edits. Bound replies/expiry; failed Start rolls back audio; Stop acknowledges closure before preparation. |
| L-OVERLAY | First probe the selected Electron version's built-in inactive-show and whole-window mouse-passthrough behavior on native Wayland and explicit XWayland compatibility paths. Current GTK layer-shell initialization cannot be applied to a Chromium BrowserWindow. If built-ins cannot provide the required placement/focus/interactive controls, test a minimal native layer-shell surface/helper using the shared renderer output before choosing the final primitive. Preserve focus-free Stop/Cancel and fallback controls; GNOME without layer-shell retains usable main controls. Never globally force XWayland or silently drop floating controls. |
| L-DELIVERY | Confirm clipboard ownership and actual target/history agreement, one delivery, truthful failure/recovery and permission fallback. Retain separate native Wayland and XWayland target evidence. |
| L-LIFECYCLE | Visible tray-host detection, reachable Close fallback and restoration on host loss. Exact AppImage/installed launcher repeated secondary activation including #29, common private TMPDIR/default cleanup, primary controls and intact helpers. |
| M-TRIGGERS | CGEvent-based Fn, individual left/right modifiers, mouse buttons, real release/interrupt edges, repeat suppression, setup ownership and available permission-gated fallback. Electron activation-only shortcuts are insufficient. |
| M-CAPTURE | Native capture/conversion preserves each recording's buffer/converter owner, device interruption, complete 16 kHz mono Float32 samples, fresh engine and contained Objective-C exceptions. WebAudio is an alternative only after background/device/shutdown parity is demonstrated. Synthetic tests never open a microphone. |
| M-DELIVERY | Accessibility-gated target-app Cmd+V, clipboard/editor fallbacks and all-format restoration guarded against a later user copy. Preserve foreground target focus; renderer key injection is not cross-app injection. |
| M-UI | Non-activating panel, Spaces/fullscreen, screen changes and Stop/Cancel; main controls survive overlay failure. Permission status and pending login approval remain distinct. |
| SPEECH | Both model families and pinned model hashes; multilingual vectors; a clock-driven duration regression beyond one hour and at least one actual owned recording over 300 seconds with full sample coverage; worker crash/retry, real GPU detection, manual CPU choice and no loss of saved Linux audio. |

Before replacing any adapter, inventory its existing serialized preferences, events, errors,
permissions and fixtures. Port behavior and tests together. A feasibility probe that fails
keeps the old production release intact and records the replacement gap; it does not redefine
an existing capability as unsupported to make migration appear complete.

Carry forward the retained version/profile matrix from [Linux validation](LINUX.md#validation-status):
stock Fedora/Arch/openSUSE Plasma 6 and Ubuntu/Kubuntu Plasma 5.27; GNOME 46/48/49; actual
Xfce/Cinnamon/MATE/KDE X11; headless Sway and an owned virtual-graphics Hyprland guest.
Preserve unavailable-portal and unsupported-stock-keymap fallbacks. Modified synthetic keymaps
are separate evidence from stock maps. Repeat install/reactivation/autostart/removal with the
exact AppImage and Debian payload in private homes, and inspect recursively shipped helpers,
ABI requirements, dependency licenses/notices and CPU fallback. Include no-tray and no-XWayland
profiles. Pin image/package/harness hashes; none of these inherited profiles is an Electron result yet.

The CLI needs a no-UI bootstrap/companion with a packaged runtime; do not require users to
install system Node and do not substitute Electron second-instance argv forwarding for its
authenticated, bounded control protocol. Probe `ELECTRON_RUN_AS_NODE` packaging/fuse constraints
or bundle a dedicated runtime before selecting that bootstrap.

Select a typed D-Bus transport only after its wire signatures, Unix-FD support, unique-owner
pinning, caller UID checks, cancellable bounded requests, license and Electron compatibility
pass owned-session probes. Each packaged helper has a versioned schema, trusted path, bounded
frames/readiness/deadlines and owned cleanup. Keep keymap observation metadata-only and
compare-before-restore lease journals; a hard-coded spare-key list is not a valid replacement.
Use the selected Electron API's actual capabilities rather than assuming older upstream
helper requirements: Electron 44 documents whole-window mouse passthrough on Wayland, rather
than arbitrary rectangular input regions, while always-on-top and global positioning still
have limitations. Interactive Stop/Cancel need their own proven focus/input behavior.
[Versioned BaseWindow API](https://github.com/electron/electron/blob/v44.7.0/docs/api/base-window.md).

## Automatic update and existing data

Updating signed 0.2.5 to an Electron implementation is technically feasible: current verifiers
check identities, versions, archive structure and signatures, not the UI framework. It is
**not yet demonstrated**. Do not ask everyone to reinstall by default or promise automatic
compatibility without the following exact-old-client tests.

| Platform | Preserve and prove |
| --- | --- |
| macOS | `OpenWhisper-macOS.zip`, root `OpenWhisper.app`, `io.github.whisperfree`, canonical newer version and the existing designated signing requirement. Sign all Electron helpers/frameworks/native modules and universal slices. Run actual old 0.2.5 strict nested/all-architecture archive/signature validation, isolated replacement/relaunch and rollback. Wrong source/identity/version/certificate, tampering and unsafe symlinks must fail. |
| Linux AppImage | `OpenWhisper-Linux-x86_64.AppImage`, existing permanent install path, `latest.json` target `linux-x86_64-appimage`, existing Minisign key and version-bound trusted comment. Prove old 0.2.5 verification/install and in-place supervised restart. Autostart refers to the permanent path. |
| Linux Debian | `OpenWhisper-Linux-amd64.deb`, Debian identity `io-github-whisperfree`, `amd64`, canonical announced version, `linux-x86_64-deb` feed target and the same signature policy. Preserve administrator authorization/cancellation and the launch path captured before package replacement. |

Keep strict expected repository/tag/asset URLs, canonical newer-only versions, archive traversal
defenses and existing signing secrets. Never rotate either signing identity for this migration.
Electron's built-in updater has no Linux support and its macOS Squirrel feed is not our existing
trust/format policy. Implement the current policy in typed services with native verification
where required. [Electron updater](https://github.com/electron/electron/blob/v44.7.0/docs/api/auto-updater.md),
[current signing policy](SIGNING.md).

The initial strict TS policy projects canonical UInt64 versions and exact Mac/Linux
release sources into explicitly unauthenticated candidates. It preserves the fixed
asset/feed targets and bounded required metadata. Transport, signature verification,
installation and automatic checks remain disabled until their actual adapters pass
acceptance; matching metadata alone does not authenticate an update.

On Linux, release windows, clipboard, bus/shortcut sessions, capture and workers explicitly,
then replace the supervised process in place. Do not use `app.relaunch()` plus exit. Node
24.21 `process.execve` is experimental and runs no cleanup handlers; test availability and
explicit cleanup in the packaged AppImage and owned systemd session, otherwise use the narrow
native exec boundary. [Node execve](https://github.com/nodejs/node/blob/v24.21.0/doc/api/process.md#processexecvefile-args-env).

Schema-validate, privately back up and idempotently migrate existing Linux XDG data and macOS
`io.github.whisperfree` preferences/Application Support data. Preserve models, trigger profiles,
snippets, history, vocabulary, saved Linux recordings, onboarding and interface language.
Do not adopt Electron's default product-named userData path accidentally. Test empty/old/partial
profiles and repeat migration, interrupted updates and rollback. Keep published legacy binaries
immutable. The already documented 0.2.4 manual update is separate from this future 0.2.5 transition.

The stable profile keeps legacy model locations and their safe existing permissions.
New Electron state lives in private sibling children. On Linux, prepare a complete
`config/electron` unit privately before publishing it with a no-replace rename:
exact source backups, normalized settings/history and mapped recording copies.
An existing completed migration must retain later edits and discarded recordings;
an incomplete destination must be preserved and refused. Run this transition before
model/download/transcript consumers can prepare their directories. Audio copying
belongs in an isolated worker and must stream without a recording-duration limit.
macOS conversion receives native model/hardware/login facts explicitly and preserves
opaque native trigger data; an Electron accelerator must never be guessed from it.
Stable preference stores require migrated state. Dev stores retain their separate
defaults and restrictions. These helpers do not establish update or release acceptance.
The startup boundary resolves the stable profile in main without preparation,
passes only validated profile inputs to a fixed compiled Node worker, and waits
for its original clean exit before opening stores. Migration audio never passes
through main or the renderer. The packaged build must establish stable identity
before selecting this boundary; Dev packages must continue to reject stable startup.

## Safe development builds and first AI preview

Create the development bootstrap before inviting side-by-side testing. A different binary
path is insufficient: current hosts otherwise share stable settings and support directories.

- Identity/product: `io.github.whisperfree.dev` / **OpenWhisper Dev**, visibly identified by
  commit/build and profile. Separate desktop name, single-instance/control IDs and Mac preferences.
- Resolve the private profile before any service or window: settings, models/downloads, snippets,
  history/transcripts, recovery, logs, caches, Chromium session and locks are all isolated.
- Defaults: no registered global triggers, automatic paste, autostart, stable updater or automatic
  microphone capture. Explicitly imported/read-only selected stable models may be used; never
  overwrite/delete stable files. Dev must not select the stable profile automatically.
- Provide a TypeScript local `dev` command. Later provide an explicit CI artifact download/run
  command bound to repository, run, commit and artifact digest. CI packages use development
  signing and no stable update channel; downloads never replace the stable installation.
- Prove stable files/preferences/locks/autostart and running 0.2.5 remain intact in an owned
  fixture. Do not silently migrate the user's current installation for a preview.

Port PR17's disabled-by-default manual LM Studio/Ollama preview into this profile: choose a
local server/model, show the exact text, send only after **Send preview**, review/copy output,
cancel/timeout/retry and retain edited input. Preserve validated numeric loopback addresses,
no redirects/proxies/implicit credentials, bounded messages and request generations. Ordinary
dictation/history/clipboard/recovery continue with both servers stopped. No automatic cloud
fallback, agent execution, TTS or Obsidian is introduced by this slice.

Review English/German examples with the user's actual local models later under #11,
after automated fake-server and UI checks. The live trial does not block 0.3.0.
Those fixtures prove protocol/failure behavior, not generated-text quality.
Optional additional/cloud models follow explicit provider consent and secure credential storage.
The feature order stays **model communication → optional speech output → structured Obsidian**;
agent handoff has its own explicit, reviewed action boundary.

Optional local-server startup is a later model-communication feature. Electron's main
process can launch installed programs with typed Node `spawn`/`execFile`, without opening
a terminal or adding native bindings. Detect and reuse an existing server first; offer an
explicit start action for [Ollama `serve`](https://github.com/ollama/ollama/blob/main/docs/cli.mdx)
or [LM Studio `lms server start`](https://lmstudio.ai/docs/developer/core/server).
Use fixed executable/argument boundaries and the local API for subsequent communication.
Ordinary dictation must not start a model server implicitly.

## Implementation sequence and completion evidence

| Stage | Deliverable | Required evidence before advancing |
| --- | --- | --- |
| P0 | This complete plan, source-backed answers, full issue/PR matrix and German reading copy; independent review; then one linked implementation issue | Requirement coverage and documentation/link checks. No premature bug closures. |
| P1 | Strict TS Electron foundation, schema-backed preload/IPC, stable/dev bootstrap and current renderer/tray | Typecheck, malformed/unknown IPC and sender rejection, profile isolation, shared UI screenshots/focus/switch/locales checks. Dev capability gaps are shown truthfully. |
| P2 | Shared text/state/settings/model/history services and disposable speech/audio/recovery pipeline | Existing shared vectors, cancellation/generation races, Stop ordering, no cutoff, long private audio, worker failures and both CPU engines; no ordinary dictation dependency on LLMs. |
| P3 | Linux and macOS adapters, native boundaries and complete current UI behavior | Each L-/M-/SPEECH gate above, exact packages and owned compositor sessions; no root/raw input/real unattended microphone. Universal Mac native loads and CI smoke; focused user Mac permission/input checks where synthetic evidence cannot establish behavior. |
| P4 | AppImage/.deb/universal DMG+ZIP, version/signing/feed, existing data migration and old-client update | Actual signed 0.2.5 positive/adversarial updater checks, exact assets/checksums/signatures, rollback and supervised restart; no relabelled old package. |
| P5 | Retain the ported manual local-model preview and isolated development package | PR17 contract/UI/failure fixture equivalence and local server off/cancel/retry regressions. Live LM Studio/Ollama trials and remaining #11 scope are follow-up work outside 0.3.0. |
| P6 | Remove Swift/Rust hosts/tests/builds and obsolete Tauri/WebKit paths; update docs/commands/CI/Renovate/notices | Full replacement regression matrix, no orphaned manifests/source/build references, synchronized AGENTS/CLAUDE, README as entry point, dependency/license audit, independent review and user acceptance of the functional migration. |

P3 overlay/native-hook probes may run early to expose feasibility risks. P5 may be offered in
Dev before release parity completes once P1 isolation and its required services pass. Keep
milestones independently reviewable; do not merge an incomplete replacement as the normal app.
Do not replace the running installation without explicit user instruction. Preserve production
0.2.5 throughout development. Release version/publication is a separate final release decision.

Retain test run/commit/package hashes and distinguish unit/synthetic, container, nested desktop,
VM and physical-device evidence. Reuse the owned Linux harnesses for actual Electron packages;
port implementation-specific fixtures rather than delete their requirements. Linux checks use
private audio/displays/bus/runtime directories with no inherited user desktop/input/audio sockets.
The user waived proactive manual Linux acceptance in favor of concrete bug reports; do not
reinstate a physical-device release gate or claim hardware coverage that was not tested.

For CI, separate fast TS/contracts/UI checks from native/package/desktop gates without weakening
release checks. Cache pinned native builds by source/checksum/compiler/target/features; keep one
speech build graph. PR31 measured duplicate compilation, not slow inference. Add Electron/native
load/overlay smoke and exact package reuse; retire Cargo/Swift jobs only at P6.

## Complete open issue and PR disposition

Read-only inventory checked 2026-10-08: nine issues and two draft PRs. A planned host change
does not by itself fix a concrete bug or implement a feature. Each future closure must explain
whether it is **fixed**, **old path obsolete**, or **superseded**, and link evidence/replacement.

| Issue | Disposition and closure condition |
| --- | --- |
| [#1 Dependency Dashboard](https://github.com/juferdinand/OpenWhisper/issues/1) | Keep active maintenance. Update Renovate to Electron/npm/native pins and remove retired Cargo/Tauri entries at P6; verify the subsequent bot run. |
| [#9 Shared UI/desktop boundaries](https://github.com/juferdinand/OpenWhisper/issues/9) | Supersede after this plan is completed/reviewed and its implementation issue exists. Transfer unfinished capability contracts, measurements and parity checks; explain that the new architecture decision replaces the old host-comparison proposal, without claiming implementation. |
| [#10 Obsidian](https://github.com/juferdinand/OpenWhisper/issues/10) | Keep a later feature: structured editable preview, safe scoped vault writes, concurrency/idempotency and raw text preservation. A new host supplies no vault integration. |
| [#11 LM Studio/Ollama](https://github.com/juferdinand/OpenWhisper/issues/11) | Keep. P5 ports the bounded manual slice, not every provider/workflow criterion. Close only after agreed remaining functionality is delivered. |
| [#12 Agent actions](https://github.com/juferdinand/OpenWhisper/issues/12) | Keep a later feature: reviewed briefs/profiles, scoped handoff and returned questions/results. Typed IPC alone implements no agent actions; no automatic shell/terminal Enter. |
| [#13 Spoken replies](https://github.com/juferdinand/OpenWhisper/issues/13) | Keep after model communication: optional turns, licensing/quality, interruption/playback separation, text fallback and device/language failures. |
| [#21 KDE held mouse/keymap](https://github.com/juferdinand/OpenWhisper/issues/21) | Keep until fresh L-KDE package proof checks the actual held-surrogate/repeat state, stock/conflicting/layout-changing maps and lease cleanup. Deleting mouse support is a gap, not a fix. |
| [#29 KDE X11 secondary startup](https://github.com/juferdinand/OpenWhisper/issues/29) | Keep until repeated exact AppImage/installed-launcher activation passes in fresh owned KDE X11 with common private TMPDIR and default cleanup, bounded exit, usable primary and intact resources. State old-path obsolescence if that is what the evidence establishes; its old cause is unknown. |
| [#30 GNOME combined hold/paste](https://github.com/juferdinand/OpenWhisper/issues/30) | Keep until full GNOME49 consent cancel/retry, binding, hold→toggle, target refocus, private recording/Stop and clipboard==history==target checks pass without duplicate delivery, with honest retry/discard recovery. Separate paste tests or removing paste do not close it. |

| PR | Disposition and evidence |
| --- | --- |
| [#17 Manual local-model preview](https://github.com/juferdinand/OpenWhisper/pull/17) | Exact head `aa973986c6b1be8fdf62b1e83acfa144cb07b976`; both host checks passed. Port useful schemas/vectors/UI/transport contracts to strict TS at P5. Close the old host implementation only with an independently reviewed equivalent port and fixture evidence. Do not merge Swift/Rust solely to enable AI testing; keep #11 open. |
| [#31 Linux CI compilation reuse](https://github.com/juferdinand/OpenWhisper/pull/31) | Exact head `8565c8b4e0a412fda7f0d2fb9a2e4dd794615089`; both host checks passed in [CI37695386768](https://github.com/juferdinand/OpenWhisper/actions/runs/37695386768). Prior development [CI37686256158](https://github.com/juferdinand/OpenWhisper/actions/runs/37686256158) CPU stage 5m05s versus candidate 20s; candidate-first owned paired check 13.721s versus 225.543s. The signed 0.2.5 release had a different 4m51s baseline. Whole-job changes have cache/runner confounders. Keep draft while Cargo remains relevant; retire only after actual P6 Cargo removal or an explicit reviewed cancellation of legacy optimization. Preserve its independent release-note correction. |

Previously closed Linux acceptance issues #3–7 remain closed for their documented old-package
scope. New Electron packages need fresh evidence; do not reopen broad physical acceptance solely
because of a host change. Transfer concrete defects, not stale implementation work. If a required
capability is intentionally excluded later, keep its requirement as a documented gap rather than
calling it fixed or declaring full desktop support.

## Open engineering questions to resolve through probes

The native binding choice/packaged ABI, Mac TCC attribution and self-signed login-item continuity,
Wayland focus-free overlay primitive, no-UI CLI runtime, strict old-client signature compatibility
and supervised exec lifecycle remain unproven. They are explicit implementation gates above,
not reasons to ask for broad permission or to promise unsupported behavior. Retain failed-probe
evidence and choose a tested replacement before retiring its old path. Any actual user-only
acceptance blocker is reported with a concrete package and focused steps after independently
runnable checks complete.
