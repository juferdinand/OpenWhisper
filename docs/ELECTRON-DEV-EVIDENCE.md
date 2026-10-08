# Electron development evidence

This records the isolated P2/P5 implementation committed on 2026-10-08 at
`05170a1770843f34695d774f7b804dd84be3f0bf`, following the foundation commit
`351041cece1f49bfc858ff1d8a9c2cbf4f2dfff2`. Local checks below preceded that commit.
The clean shared-UI dependency-resolution correction is
`ae7c81eae830467a519b024993967ccec9fa042b`.
[CI 37707104579](https://github.com/juferdinand/OpenWhisper/actions/runs/37707104579)
passed all four jobs at that exact head: Electron TypeScript/native CPU checks on Ubuntu
22.04 and macOS, and the existing Linux/macOS packaging and native UI checks.
The [migration plan](ELECTRON-MIGRATION.md) retains the remaining acceptance gates.

| Check | Result and scope |
| --- | --- |
| Strict Electron/shared UI build | PASS; `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Ordinary Electron suite | 136 PASS, 3 explicit opt-in skips; 139 total, 3.90 seconds |
| Shared UI suite | 55 PASS, 5.3 seconds; existing host fixtures plus 13 typed preview tests |
| Public native CPU probe | 2 PASS, 7.97 seconds; three Whisper inferences, wrong-family rejection and context release |
| Actual Electron utility | Eight CPU groups PASS, 11.116 seconds; separate incompatible-host ABI negative PASS |
| Actual Electron Dev UI | PASS; real sandboxed renderer/IPC, owned fake model server, manual preview/cancel/retry/error, EN/DE, restart persistence |

The pure recording suite's one-hour clock/sample ledger is synthetic. There is no native
microphone/capture result here. The text core passes the shared fixtures and additional
Unicode cases; source comparisons identified existing Swift/Foundation versus Rust Unicode
and overlap differences. Those extra macOS cases still need execution before retiring Swift.
The common language schema accepts the pinned engine's `yue` code; this establishes source
compatibility, without claiming Cantonese recognition quality.

## Native utility provenance

The utility fixture uses Electron 44.7.0 / Node 24.21.0 and Node-API 8, in an owned Ubuntu
22.04 container as UID 1000. Its renderer retains sandbox/context isolation, no Node
integration, zero effective capabilities, `NoNewPrivs=1` and seccomp filtering. The Node
utility itself is not an OS sandbox. The container has no host mounts, devices, desktop,
audio/session-bus sockets or network. Test containers were removed after evidence collection.

| Input | SHA-256 |
| --- | --- |
| whisper.cpp b5130 archive, revision `927cfce34f31707e17f2bff35c349632fb9e2c3a` | `41b664fee09e79176ac277b5237debec34f8d74af3c7d71f333f1ec67989ecde` |
| Node 24.21.0 headers archive | `57c6bee2e30bbbee5bd51d6cc343eb992e174b56a2a1d0eab7a7510771c20ea2` |
| Public Tiny model | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| Complete public JFK float audio, 176000 samples | `ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0` |
| Speech transport source | `66cd0f0c0b8e7c96efe9b8cbe22fb0a5f8ff42b1ce8a217fc5b5514aa4d4e53c` |
| Speech client source | `3fe3a29627388d08f58601c1bebdc08d8a96c87a4882fd71704c9221877f3279` |
| Native bridge source | `b7a3094e4c21109305a4fe966969bd2d569dbc95af6fa251f1703eaa6d236af1` |
| Tested Ubuntu 22.04 addon | `e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3` |

The addon was compiled on Ubuntu 22.04 with the verified archives; its directly required
maximum symbol versions are GLIBC 2.34, GLIBCXX 3.4.29 and CXXABI 1.3.9. A separately
retained host-built addon requiring newer glibc fails before readiness, while the main
survives and the helper is removed. Host binaries were not relabelled as baseline builds.

The actual runtime verifies context reuse, wrong-family failure and fresh reload, native
missing-file failure, an in-flight helper crash, a stopped-helper watchdog with confirmed
force-reap before replacement, idle shutdown, early cancellation and malformed-frame exit.
Only the fixture signals its own verified helper PID; production uses Electron's owned
`UtilityProcess.kill()` and waits for exit. The startup transaction also prevents a late
cancelled factory from overlapping a new owner, with focused inert race regressions.

## Preview and data isolation

The unchanged PR17 shared schema/vectors, 23 owned HTTP tests and 13 typed browser tests
cover manual numeric-loopback model transport and UI behavior. An independent wiring
review found and verified a fix for stale cancellation feedback after a newer result.

Actual Dev UI tests use a separate Debian 13 container, private Xvfb and synthetic stable
settings/models/history/recovery/autostart sentinels. Their hashes remain identical after
the test. Original multilingual input reaches the owned model server intact; output is
plain textarea text. Input/results do not enter app-state transcript/history or the private
profile file and disappear on renderer restart. Settings persist at mode `0600`; invalid
optional content remains untouched while startup uses disabled defaults and displays a warning.
A valid explicit edit replaces only that optional profile and clears the warning, without
sending a request or changing ordinary preferences. No user model server was used.

Reproduce using [development commands](ELECTRON-DEVELOPMENT.md) and the
[owned utility procedure](../electron/tests/owned-speech/README.md). Exact source/compiled
hashes, package inventories, container/image configuration, command logs and visible EN/DE
screenshots are retained in the local `p2-owned-speech/run-4` and `p5-owned-ui/run-4` packets.
These local packets are not GitHub Actions artifacts. No real microphone, running installation
or stable user profile was changed.

The initial committed evidence above does not close KDE/GNOME/X11/wlroots bugs or validate
packages/updaters or real model quality. Subsequent scoped evidence is recorded below.
Full replacement remains explicit work in #33 and the linked issues. User acceptance
remains required before the functional migration is merged or the installed app is replaced.

## PR disposition

[PR #17](https://github.com/juferdinand/OpenWhisper/pull/17#issuecomment-6049824267)
is closed as superseded by the reviewed TypeScript manual-preview port and its fresh
evidence. Its shared contracts and useful regressions are preserved; [issue #11](https://github.com/juferdinand/OpenWhisper/issues/11)
remains open for real provider/model acceptance and the broader requirements.
[PR #31](https://github.com/juferdinand/OpenWhisper/pull/31) remains relevant while the
Cargo packaging/fallback path still exists. The migration [PR #34](https://github.com/juferdinand/OpenWhisper/pull/34)
remains a draft. KDE/GNOME/X11 bug issues remain open until their exact replacement
behavior is demonstrated. Closure of duplicate work does not establish desktop support.

## Composed recording and recovery followup

The separately exported candidate index passes 262 ordinary tests, with seven explicit
opt-in skips (269 total, 3.96 seconds), and the strict Electron/shared UI build. This excludes
the later model-inventory and macOS-edge work. Native/owned checks below are separate
scoped executions, not additional ordinary-suite passes.

The next isolated slice combines native sample ownership, complete utility-side preparation,
Linux silence classification, private WAV/RF64 storage and adaptive inference. Duration-sized
audio never reaches main/renderer. Native windows use the existing Rust policy: contiguous
30-second maxima, quiet boundary selection and smaller GPU/CPU retry windows. The fixtures
include complete logical-hour coverage and actual unchanged Rust WAV/RF64 header comparisons.
The complete processed transcript is delivered intact, including the focused case above 4 MiB.

| Check | Scoped result |
| --- | --- |
| Owned virtual Pulse capture | 305.152 seconds; 14,660,608 frames at 48 kHz → 4,886,869 samples at 16 kHz, full tail retained; Stop 0.542 ms before preparation 711.542 ms |
| Final Stop error followup | 11 native tests, 30 immediate restarts, source unload → immediate Stop and daemon-loss nonzero salvage |
| Composed actual Electron utility | Three capture-helper epochs, 528,017 samples, contiguous 401,600 + 126,417 windows, private WAV before every native request |
| Failed delivery/restart | WAV retained after explicit failed output and helper reap; restored helpers create no capture |
| Lost confirmed reply | Actual private-Xvfb clipboard write/read, intentionally dropped reply, same-token retry confirmed without a second write; WAV removed only afterward |
| IPC backing-buffer guard | Actual 128-byte-offset view over 16 MiB normalized to exactly the requested window; main refuses malformed offset/over-backed frames before opening speech |
| Independent lifecycle review | Reproduced/fixed late Stop/release, cancellation handoff, unbounded backing buffer and receipt eviction; focused regressions retained |

The long capture and final Stop followup use different native artifacts. Long-run addon
`f966224ff9fd05d3f00f06116cf6533e7200f05d1070e3ec37b506397acb831e` uses C++ source
`351332866a46bf5459a9b6119406d7495695a8dd26f748f899686593a549c53b`; final addon
`68050249bc5c419f6a20b8715bb8461eafb8f1a90ba751e45adade4a4b71f67c` uses C++ source
`c6985ad83c0ff76834a56954136adc850009267508cc245180a5f298bcd268bd`. Its additional
Stop-time error/snapshot checks leave the ledger/conversion unchanged. This is no claim
that the final binary completed the long run. The pinned miniaudio read shim retains exact
positive-length Pulse hole duration as bounded zero samples; it never silently removes time.

Private recovery checks include 600/700 modes, atomic exclusive writes, file/directory sync,
post-rename durability retry on the same token, finite complete samples, RIFF/RF64 size,
cancel/discard ownership and deterministic release. The composed test loads capture only
in its capture utility and speech only in its disposable speech utility; main mappings stay
clear. Renderer sandbox/Node isolation is checked separately. It uses synthetic native input,
not the Pulse long-run source or a microphone.

Receipt storage is bounded and belongs to one continuing main/private profile. It reserves
capacity before native delivery and retains confirmed or uncertain entries; full capacity
fails before another output. It does not evict unfinished recovery. Proven retirement after
recovery removal is required before normal/high-volume wiring. This does not establish
durable receipt behavior after the whole app exits. Mac recovery remains in RAM.

The corrected composed packet is local `p2-owned-recording/run-3`, with source manifest
`1699ee9ced83d137d0815f7753e86b4aac2001859fe29e6a9bc8f8a1b60e5705` and evidence
`7fc6a16088825cc5ce510683048be437ca9627e1ee9cf56dc275a013a3b9b049`. Earlier runtime
and independent-review failures remain retained. The old post-long restart failure's cause
is unknown; later successful long/short evidence is not presented as its diagnosis.

The normal Dev UI still has no recording command wiring. This evidence does not establish
desktop grants, real target-app paste, CoreAudio capture, exact packages, signed updates or
complete stable-data migration. Existing production hosts and desktop bugs remain.

## Native build profiles and public models

Fresh Ubuntu 22.04 build graphs produce separate portable CPU and Vulkan artifacts.
Eight checksum-pinned archives also pass fresh download, inventory/type/path validation
and extraction into empty owned directories. That extraction result uses GNU tar;
macOS bsdtar and Metal build/runtime acceptance remain separate checks.

| Check | Scoped result |
| --- | --- |
| Public Parakeet CPU | Three actual inferences, wrong-family rejection, fresh reload and utility-side postprocessing; helper disposed, main has no native speech mapping |
| Vulkan without a device | Four actual inferences: Whisper/Parakeet with CPU and GPU requested; detected device is null, matching complete fixture transcript hashes |
| Software-only Vulkan | Four actual inferences; llvmpipe is excluded from the hardware-device result; matching complete fixture transcript hashes |
| Vulkan loader absent | Actual startup failure and disposal, followed by an explicit fixture-only CPU artifact replacement and successful Whisper inference |

The three current-wrapper GPU runs contain nine successful inferences in total.
Historical runs are retained separately and are not added to this count. The CPU artifact
hash is `e1b4c2c738285eb50cea155e65fc0b1eb4481e80a1849ded23bb2a8a679308c3`;
the Vulkan artifact hash is
`84797393e5a1efb453945c32a26a7d4158490e53074dcd2fdbacc47b887dff05`.
Both use CMake source `2435203d4801cde82605cf0dd338dfa930d930ae952cda69d45e58022405ade8`.
The CPU artifact requires GLIBCXX 3.4.29; Vulkan requires GLIBCXX 3.4.30 and GLIBC 2.34.
The tested image supplies libstdc++6 12.3.0-1ubuntu1~22.04.3 and Vulkan loader 1.3.204.1-2.
Portable instruction flags are distinct from these runtime dependencies.

The public Parakeet Q4 fixture is 355,615,679 bytes with SHA-256
`aa7fe2f5fb47d863ca23e8b1d490632d63a2599f515268b6d6bd656158dad45e`.
Its NVIDIA model terms apply to the weights; the conversion repository's MIT label does
not relicense them. Test models are downloaded explicitly and are not bundled in the app.

The local `p6-proposal/GPU-ACCEPTANCE.json` packet has hash
`03f4946e2f970caeca09d954726a7c7493cc808e31bd2490c5a7ecbd14a10bf3`.
It retains current/historical wrapper hashes, artifact manifests, loader/device evidence,
container disposal and the separate empty-source archive checks. All runtime cases use
UID 1000, no host devices/mounts/network, a sandboxed renderer and an unsandboxed Node
utility inside the owned container. These results establish neither physical GPU execution
nor automatic application fallback, packaging or macOS Metal support.

## Private Linux control and early CLI feasibility

A separate GDBus Node-API primitive and TypeScript Dev control owner are opt-in.
Ordinary startup opens no bus through this owner and has no capture capability.
The owned primitive probe passes 19 groups; the content-free control probe passes 13
groups covering UID checks, pinned unique callers, deadlines, rollback before accepted
Start, preservation after accepted Start, Stop fencing and disposal. The native reply
boundary means successful local queue acceptance, not proof that the remote client read it.
The Dev status enum is a spike; production Status JSON parity remains required.

The corrected fatal platform run passes 15 actual groups in 4.131 seconds and all 22
focused pure bus/control/transport tests. A correlated cleanup failure retains the pending
request until the parent termination boundary and permanently closes the failed owner.
The checked old PID is absent before rejection. Local source snapshots are
`p3-owned-control/run-7`; its evidence JSON hash is
`8aeaadc6dbfb448c56bda73fa5aa63bf39f1fa14f59f462e5ef64adc2036c414`.
Earlier compile/runtime failures remain retained; the process-event limitation below still
applies to general lifecycle claims.

An unmodified Electron 44.7.0 binary can finish a genuine asynchronous private-bus call
from an early ESM entry and exit before app readiness without a display or external Node.
The owned probe completes in 0.109 seconds, with a 10.43 ms native call and confirmed bus
closure. It uses a two-second internal deadline and eight-second outer bound. Chromium
also attempts deliberately disabled ambient private bus addresses; this does not prove
zero ambient activation attempts on a real desktop. The local `p3-control-async` packet
retains the exact binary, fuse wire, pinned upstream bootstrap source and disposal.

Production CLI dispatch, ambient-service prevention, hardened packaged fuses/ASAR,
installed AppImage/DEB commands and actual compositor bindings remain separate gates.
These control primitives do not close desktop bugs or claim a working released CLI.

## Process retirement limitation

The owned tests observe process absence at their checked replacement boundaries; this
does not establish that Electron's generic utility `exit` event always follows OS retirement.
A fatal-control fixture found the old process still present as a zombie at rejection.
Pinned Electron source sends a reasoned exit notification before its default Node exit
handler; Chromium's separate reaper completion is not exposed by that JavaScript event.
The narrow fatal-control correction keeps the helper closed until the parent terminates it.
Normal shutdown and the speech helper's self-exit paths still need a bounded independent
owned-process retirement witness before live replacement wiring. Failed/ambiguous cleanup
must retain ownership and block replacement. No raw PID signals are introduced.

## Model inventory and Apple compile checkpoint

The next separately exported candidate index passes 286 ordinary tests, with eight
explicit opt-in skips (294 total, 3.96 seconds), strict TypeScript and the shared UI/Electron
build. Its private inventory has 24 focused filesystem/lease tests. Independent review
reproduced a catalog filename alias resolving to a differently named inventory ID; the
correction rejects acquisition/removal through that alias while preserving exact-filename
import mapping. Complete-copy/hash, deferred/rejected lease retirement, atomic no-replace,
replacement, private identity and uncertain publication/removal are tested separately.
Publisher verification, persistent import journal and normal host/UI wiring remain gates.

The Apple edge checkpoint contains a fresh AVAudioEngine owner, serial control executor,
complete raw format ledger, accepted-callback fence and EOF-drained Apple conversion.
The opt-in fixture uses generated PCM and independent coalesced Apple conversion, including
305 represented seconds with a final tail, format/layout transitions, held callbacks,
cancellation, allocation failures and raising Objective-C stand-ins. Local strict/build and
generated-fixture syntax checks pass. Native Apple compilation/runtime is pending CI;
no hardware capture or permission acceptance follows from source checks.

The compile-ready source manifest hash is
`37c16b28f0bfa67d69e416f7a47c23f65f2ddd51b9482937f82a589d01d6e9da`.
Native source is `9afeb1470a5b5d9908228a363aa6ee02dee9d781e3ba62d5b4eb12e68eeab70d`;
builder source is `7e0ac5f7284d2ec812c31ebbc39a6063ba8cf4534399ab286509bcd57df26677`.
The dedicated CI jobs use [official Apple Silicon/Intel runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
`macos-15` and `macos-15-intel`, with an explicit macOS 14 build deployment target.
Actual minimum-OS runtime, default-input/device changes, TCC responsibility, signed-helper
loading and the independent retirement witness remain separate gates.
The fixture reports only `helperExitObserved` and `actualOSRetirementVerified:false`.

Before/after build guards cover source, pinned headers, scripts and notices. The exact
upstream Node 24.21.0 full license snapshot is preserved, including its inherited whitespace;
source whitespace checking excludes that verbatim notice only. Native artifacts, categorical
runtime phases and manifests are retained by the two owned Apple CI jobs. No PCM, user
profile, TCC database, signing material or full diagnostic report is uploaded.

### macOS bootstrap correction and standalone retirement observer

CI 37717368789 tested PR merge tree `8a3005e3676789b8085a5b6f0eca99dab00dc3a1`, identical to branch commit `7323eaf`. Both macOS native addons compiled with Node-API 8 and a macOS 14 deployment target for arm64/x86_64. Both synthetic fixtures failed at the unchanged 150-second outer deadline, with no helper result, runtime failure, lifecycle or phase packet. This supports a pre-helper bootstrap stall, not an observed native capture hang. Complete failed job logs, ZIP hashes, build manifests and categorical retained markers are preserved privately. Deployment metadata does not establish macOS 14 runtime behavior.

The fixture now retains a categorical startup milestone, keeps private directory preparation and `app.setPath` before module completion, and runs the readiness wait and fixture body through a caught asynchronous function. It no longer awaits `app.whenReady()` at ESM top level. Pinned Electron ESM loading waits for module evaluation before signaling app-code completion, while the browser joins that completion during startup. The readiness deadlock is the source-supported diagnosis; successful actual native fixture execution still needs new CI evidence. No timeout, permission policy, native capture bytes or production adapter was changed.

A separate strict TypeScript Linux process observer was independently reviewed. It checks genuine procfs, bounded fixed-path NOFOLLOW stat/status/stat identity, current UID/direct parent, and numeric birth. Zombie/dead state remains non-running rather than reaped; absence or a different bound birth may establish original retirement. Deadline, cancellation, refusal or ambiguity poisons that witness and retains late reader completion. It never signals, reaps, creates a replacement, or releases a model lease. The initial live candidate is provisional: a future original-channel fresh nonce and matching birth must precede workload admission.

The independent queued-reader regression initially failed because a settlement barrier omitted already accepted operations whose reads had not begun. The corrected ordinal barrier waits those operations and their actual late read/FD closure; later admissions are outside that snapshot. Focused observer tests pass 27/27, including the unchanged independent regression. These are inert/private filesystem tests; actual Node/Electron topology and OS retirement remain separate owned execution gates. Existing factory/channel semantics are not changed by this standalone service.

### Verified Apple synthetic runtime

[CI 37718566759](https://github.com/juferdinand/OpenWhisper/actions/runs/37718566759)
passes all six jobs at `db6616d`; its merge tree matches the branch tree. Independent
artifact review verifies both downloaded ZIP digests and 15 tracked source hashes.
Apple Silicon and Intel each pass all nine generated-PCM cases in 4.731 and 7.496
seconds respectively. The long ledger contains 14,640,017 input frames at 48 kHz
(305 seconds plus 17 end frames), producing 4,880,006 samples. Each architecture's
coalesced independent Apple-converter reference has the same sample count and zero
maximum difference. Cross-architecture bit identity is not claimed.

Both packets report zero engine allocations, input-node access, permission queries,
permission requests and audio-file writes. They retain startup readiness, nine categorical
case phases and helper exit. The native addon hashes are unchanged from the failed
bootstrap run. The local result packet is `macos-capture-ci/run-37718566759`, with
evidence hash `74db94cb207e80ec0acb1fbafdd22c5402396eeae17430642fbe78412c13792b`.
This is generated audio on macOS 15, with a macOS 14 deployment target. It does not
prove physical microphone/TCC/device behavior, minimum-OS runtime, signed production
helper loading or OS retirement. The CI-only unsigned-library allowance remains
separate from production packaging.

### Bounded ambient diagnostic and pure control client

The separately frozen run-9 early-ESM diagnostic passes three owned profiles: empty
private buses, a fixed login-manager owner, and fixed login/systemd/portal owners.
The unmodified Electron runtime dwells for about 1.4 seconds around a native GetId
and confirmed close while app readiness stays false. After retaining evidence, explicit
assertions require zero StartServiceByName calls, zero activation-capable non-daemon
calls and zero fake provider calls. Header/category timestamps observe Chromium's
login-manager owner lookup before the TypeScript entry. Empty activation directories
and zero provider calls make this a bounded startup observation; neither activatable
providers nor successful portal/systemd methods or universal no-activation are proved.
The retained evidence hash is `1c0143693ccb77a3e0fe8798d540ff82f1f898910e6699272bddf46bbc8c4f73`.

Three pure strict-TypeScript modules parse trusted bounded argv, preserve all uint64
elapsed digits in the stable three-field JSON grammar, and route a single Dev control
transaction through a fixed-purpose injected port. Seventeen focused tests pass,
including two independent retirement cases. Watches precede owner lookup, UID and
generation are pinned, and every operation carries the shared deadline and
NO_AUTO_START policy. Accepted actions are never repeated or cancelled during cleanup.
The operation budget is five seconds followed by a separate two-second cleanup budget;
late cleanup remains owned, and failed retirement permanently closes the instance.
Fulfilled port close must certify all subscriptions, callbacks and pending resources;
an unsettled unsubscribe still blocks completion. These are injected tests, not native
bus evidence. Native loading/open cancellation, real Status snapshots, early bootstrap,
installed CLI and hardened packaging remain separately reviewed work. No recording
wiring or existing desktop issue closure follows from this slice.
