# Electron development evidence

## Fresh permanent AppImage runtime and reviewed universal/installer source

The exact clean `340dee3fb60cbf5abf6819553d9b575848919305` source produces a
119,618,040-byte AppImage with SHA-256
`40156f21310f03a06cd114217163586b2d355f3c209c86c0e1d94cd579341873`.
The Ubuntu22 construction checks retain all 696 tracked source inputs and verify
native ABI, package metadata, notices and extracted payloads. Cached dependency
selection and its initial refused mismatches are recorded separately; no older
package is relabeled as this producer.

The first matching runtime exits normally with a failed assertion in 10.63
seconds: actual effective autostart was true, but the test's own persisted legacy
seed was false. One reviewed seed correction retains the original failure and
the same immutable image. The corrected complete owned runtime passes all
eighteen checks in 74.44 seconds. Permanent AppImage admission is AVAILABLE;
ordinary startup/focus preserve the native legacy desktop bytes, inode and
timestamps. Explicit shared-UI disable/enable produces the exact permanent
launcher/image pair. That generated pair restarts edited state; another normal
restart preserves disabled state, and re-enable succeeds. CPU recognition,
clipboard/history, Retry/Discard, native X11, all five no-display commands and
secondary activation/resource survival pass in the same run.

All three original launcher/runtime/main chains exit 0 without a signal; PIDs
and extraction trees disappear. Original Docker commands close, private servers
close and the namespace is removed. Returned/source package, launcher and image
pins match. This is offline UID1000 Kubuntu24/Xvfb/private generated audio
evidence, without FUSE, host sockets/devices, physical microphone/GPU, real login
or update replacement claims.

Both original owned Mac jobs in
[CI 37873249720](https://github.com/juferdinand/OpenWhisper/actions/runs/37873249720)
pass Dev/stable ZIP and signature cases, edited-state restart and original
normal exits. API head is `340dee3f`; actual thin checkout/package producer is
`bcf527b8b1f51d5705a9b92b5cc664b2e77786b3`. No rerun or replacement build was
dispatched. These thin ad-hoc packages remain distinct from universal and
persistent publisher acceptance.

The independently reviewed universal constructor uses exactly pinned official
`@electron/universal` 3.0.6. Only fresh copies receive the common V2 descriptor,
locked Koffi union and architecture-indexed original receipts. The merger has
two literal native skip paths, no broad wildcard, forced replacement or ASAR
shim. Common resources, internal links, original snapshots and both Mach-O
slices are checked; native signing precedes final descriptor capture, nested/
outer signing and exact ZIP roundtrip. Nineteen focused constructor/preview
checks pass. This is portable inert-header/private-file evidence; actual Darwin
merging, universal execution and certificate continuity remain open.

The inactive Debian consumer verifies the original fixed-key/version signature
again, reads fixed metadata through retained fd3 and admits one Polkit-owned
transaction. Eight unchanged tests pass in actual Electron44.7.0/Node24.21.0
using real `dpkg-deb` and pinned public 0.2.5 bytes. Install outcomes use synthetic
effects; no `pkexec`, installation or restart occurs. The original test exits 0
in an 11.29-second complete lifecycle; package/fixture pins remain equal and
private stages disappear. The idle container's separate teardown exits137 after
the test closes normally. Application wiring, privileged installation,
post-native-cleanup restart and rollback are separate gates.

Combined source checks pass strict typing, normal app/shared-UI build and
1174 unit tests in 17.55 seconds, with 34 explicit native/opt-in skips and zero
failures. The skipped optional Debian asset cases are covered separately by the
eight-case actual embedded-Node run above. New source and harness each received
independent review.

## Historical Mac ZIP acceptance and installed-launch source increment

Both original owned Mac jobs in
[CI 37871798972](https://github.com/juferdinand/OpenWhisper/actions/runs/37871798972)
pass at API head `f28b2583`; both actual package producers are synthetic PR
merge `7e30a4f7fc9374c7795810e058d1e386b6c7121e`. Intel and Apple Silicon each
accept the real Dev and stable ZIP through retained original fd3, reject the
same version before extraction and reject wrong-version, corrupt, missing-app,
app-symlink, external-symlink, dotdot and symlink-write fixtures. Original files
remain unchanged, private stages disappear and no outside marker is created.
All original Dev/first-stable/restarted-stable exits are normal. Original logs
and terminal job receipts are retained; no rerun or artifact download is used.
Persistent release signing, universal packaging and installation remain separate.

The next AppImage source admits only the exact legacy permanent image and fixed
launcher, canonical extracted layout and a same-user live image ancestor proven
through bounded kernel process records and original executable inode. Status
is read-only. Explicit autostart enable can retarget a recognized native entry
to the permanent launcher/image after revalidation; extracted executables are
never published. The 23 focused checks pass with actual owned files and a mocked
kernel boundary. This does not replace the earlier immutable package runtime
or establish runtime acceptance of the new source.

The separate Mac V2 descriptor validates both original V1 branches before
selecting a matching runtime architecture; Linux/thin V1 semantics remain intact.
Five focused checks and independent descriptor/Main review pass. A universal
package has not yet been assembled. Combined strict typing, ordinary build and
1167 default-suite tests pass in 17.99 seconds, with 28 explicit skips and no
failures. Independent review of installed-launch admission, autostart, launcher,
packager and Main integration also passes; new package execution remains open.

## Physical Mac archive filesystem and targeted AppImage diagnosis

Original ARM job113626633516 in
[CI37870309345](https://github.com/juferdinand/OpenWhisper/actions/runs/37870309345)
identifies the positive ZIP fixture cleanup failure as
`real-package:CLEANUP_FAILED:REMOVE_TREE:ENOTEMPTY`. Its actual producer is PR
merge `697d7f98b656ac311429b59125aab9ced5a2b0d1`, distinct from API head6994e42.
The exact remaining Mac entry is not observed in that log.

One separate immutable Dev9 Electron44.7.0/Node24.21.0 embedded-Node probe
reproduces the filesystem mechanism: `original-fs` sees the 110862-byte0644
`default_app.asar` as a regular file; patched `fs` sees a virtual0755 directory
with eight members. One patched recursive removal fails with `ENOTEMPTY` and
the physical archive is the exact remaining entry. One built-in `original-fs`
removal succeeds; no global `process.noAsar` switch or retry is used. The probe
exits naturally0 in103.4ms with empty stderr, original PID absent, all1263 source/
copied/returned package files and fixture pins unchanged. Namespace cleanup is
separate: its sleeping container terminates137 after the probe closes normally,
then the container is removed. This embedded Linux result is not a Mac browser
acceptance claim. The reviewed consumer now uses the documented
[physical filesystem API](https://www.electronjs.org/docs/latest/tutorial/asar-archives#treating-an-asar-archive-as-a-normal-file)
for bundle inspection and cleanup; the subsequent actual Mac ZIP result is
recorded above.

The first owned AppImage case fails before readiness in7.96s total. Its targeted
startup-only diagnostic identifies a125-byte AF_UNIX SingletonSocket path below
the unnecessarily long owned TMPDIR; actual launcherPID51 exits127 and Electron
PID54 is reported in Chromium's fatal message. No model/capture action occurs.
The harness uses a fresh short0700 same-user canonical `/tmp/ow-ai-` base; the
image and launcher remain unchanged. Arbitrary long caller TMPDIR remains a
documented production limitation, without claiming a fix to the launcher.

The next full case records actual launcher/runtime/main identity, exact extracted
resources and successful secondary activation with primary-resource survival,
then fails the old font-cache assertion before dictation. Its exact mismatching
numeric mode was not retained. The reviewed harness accepts only safe0600/0644
regular owned cache files under the unchanged private-directory/name guards and
records bounded metadata before assertions; no contents are logged. This is
consistent with the launcher's restrictive umask, without assuming an unobserved
mode. All original failures and namespace/server closure receipts are retained.
Startup-only results have a separate schema and never claim dictation acceptance.

The corrected full AppImage runtime passes all15 checks in64.389 seconds against
the unchanged119441912-byte image and exact protected launcher. App producer
remains clean `b892d861`; the separate corrected harness is not relabeled as the
application source. All five actual no-display CLI command kinds and absent-owner
refusal pass, with strict replies and retired original processes. Native X11
setup/hold/cancel, real TinyCPU recognition, private clipboard/history, retained
WAV Retry/Discard and edited-state restart pass. Secondary activation and each
CLI invocation retire only their extraction while primary resources survive.
Original launcher/runtime/main chains51/53/54 and1826/1828/1829 close normally0
with no signal/forced termination; all observed descendants are absent and the
shared temp base is empty. Exact image/launcher/reference inputs remain equal,
private servers close and namespace removal passes. Nineteen bounded cache
receipts now observe0600 regular same-user files withnlink1; the previous failed
mode remains unknown. This is offline owned Xvfb/nativeX11/private Pulse evidence,
without FUSE/host devices/physical microphone/GPU/automatic paste/login claims.
AppImage admission/autostart/updater is unavailable in that immutable package. Its default
suite passes1153 tests in17.88 seconds, zero failures,28 explicit skips; strict
typing passes. Mac physical-FS source and every harness increment have separate
independent review; subsequent matching Mac ZIP execution is recorded above.

## Reviewed original-file staging, update download and Mac archive consumer

The shared stage borrows or retains the exclusively created original descriptor,
with exact private ownership/modes, literal asset names and before/after inode,
size and ancestry checks. Position-based writes/reads preserve the initial Mac
fd3 cursor. Consumers settle before original close and replacement-safe cleanup.
Linux file checks pass on both pinned original 0.2.5 Debian/AppImage copies with
independent Rust agreement. The separate bounded downloader revalidates source
policy before effects, shares the existing HTTPS lifecycle, admits only the
fixed GitHub/CDN hosts and measures actual bytes/EOF. Its cached Debian positive
uses inert HTTPS effects and real private files/signatures; it is not network
or installation evidence. Cancellation, partial writes, late closure, overflow
and changed-path cleanup cases pass. Incoming stream blocks are split into
64-KiB views while preserving exact bytes and existing model host policy.

One separate actual public HTTPS transfer passes with the production default
factory on Node26.10.0 in 1.522 seconds. It downloads exactly 21,152,538 bytes
from the admitted 0.2.5 Debian URL, verifies the original fixed publisher/global
signature and signed version, and matches SHA-256
`412d06d5475b430fd290c560ea9cd03818b6c471075f064833ebca021313b6cb`.
The original descriptor remains at offset zero until the explicit cursor check;
the process exits naturally, its PID is absent, the original descriptor closes
and the private stage/cache are empty. Cached feed/signature/package and all
111 compiled fixture/production/dependency inputs retain their pins. The prior
version is synthetic 0.2.4; this is neither an installation nor embedded
Electron network-execution claim. No redirected signed URLs or raw headers are
logged, and no retry, app launch or build is used.

The Mac ZIP consumer passes original fd3 to fixed bsdtar without `-P`, retains
internal framework links, refuses escaping/special files and requires exact
captured metadata/newer version and the running application's designated
requirement. Four local filesystem cases pass. The new ordinary Mac smoke adds
a real ditto ZIP plus version/corrupt/missing-app/traversal/symlink cases and
owned cleanup. Original ARM job113622220613 in
[CI37868932078](https://github.com/juferdinand/OpenWhisper/actions/runs/37868932078)
fails with `CLEANUP_FAILED` at extraction-child cleanup; Stable smoke is skipped.
Original Intel job113622220509 fails in the same Dev stage with `CLEANUP_FAILED`;
its Stable smoke is also skipped. Actual producer is PR merge
`b561cfe50230ed4560e02408e94cbb3806293ded`, not pure
API head `9ac9ae9`. Its original log does not expose the underlying phase/errno.
No actual ZIP or final-process-cleanup PASS is claimed. A focused follow-up
retains categorical phase/whitelisted-error diagnostics and preserves the first
cleanup error while still closing the original download descriptor. A real
private-file regression confirms that a refused extraction child remains intact,
the original descriptor closes and parent removal refuses the retained child.
No speculative permission change or retry is included. The prior version
is explicitly synthetic 0.0.0, and the fixture remains ad-hoc. No persistent
publisher transition, installation or updater UI is established.

The existing thin Mac packager now has an explicit persistent-validation mode:
stable identity, canonical version, clean captured commit and exact existing
certificate fingerprint are required before staging. Every existing signing
operation uses that admitted identity; signed native descriptors are recaptured
and original unsigned manifests remain intact. Fourteen focused tests and an
independent review pass. Default ad-hoc behavior is preserved. No actual
certificate signing, keychain access, universal build or release is performed;
captured clean metadata is not source-bit attestation or old-publisher acceptance.

The reviewed cleanup/signing/harness follow-up passes strict typing and the
ordinary application/shared-UI build. One complete default suite passes 1153
cases in 17.83 seconds, zero failures, 28 explicit native/opt-in skips. The final
smoke-only failure-label correction receives a fresh typecheck; it does not
change the default-suite production sources or tests. Actual Mac ZIP execution
and owned AppImage runtime are outstanding at this source checkpoint.

Independent source reviews pass. One completed increment passes strict typing,
ordinary app/shared-UI build and 1149 default-suite tests in 17.87 seconds,
zero failures, 28 explicitly skipped native/opt-in cases. Real cached positives
are separate focused checks; skips are not silently treated as acceptance.

## Unsigned AppImage construction from the existing exact Ubuntu22 package

Application producer remains clean `b892d861921fd51c6a1de2e35c987a0bd620ac9b`;
the wrapper construction does not relabel it as newer source. The image is
119,441,912 bytes, SHA-256
`5307c99c5d8f603fbf8ed937d8688dc24181509163cdfc365552dd9bd5eb5069`.
All 1340 original file/directory entries retain bytes/modes and captured native
descriptors. Pinned appimagetool/runtime execute only after digest/size checks.
Passive extraction matches the staged tree; the only permitted output link is
root `.DirIcon` to the exact captured app icon, recorded without traversal.
The runtime prefix changes only its documented reserved MD5 slot. Original
construction/extraction processes exit 0 and are absent afterward.

Attempt one failed without retained nested diagnostics and remains unclassified.
Attempt two retains the original unsupported-gzip failure; the pinned tool
provides zstd only. Attempt three succeeds using zstd and the observed root
icon link. No application/native rebuild or app execution occurred. Seven
original runtime/component notice texts and scoped provenance accompany the
payload; patched LGPL source/relink proof remains a public distribution gate.

Inert launcher checks establish separate temporary storage, literal argument
forwarding and normal cleanup. Real AppImage command control, PGID/lifetime,
autostart, restart, permanent-path admission and public signing are pending.
Neither construction nor the inert launcher establishes runtime/release support.

## Exact b892d86 installed Linux and Mac package checkpoint

Clean producer: `b892d861921fd51c6a1de2e35c987a0bd620ac9b`.
[CI37862779046](https://github.com/juferdinand/OpenWhisper/actions/runs/37862779046)
passes all six jobs. Both owned Mac jobs pass signed Dev capture-close and normal
stable first launch, read-only migration, shortcut setup/removal, edited-state
restart and original clean exits. The empty-domain worker uses synthetic host
facts; persistent 0.2.5 signature/login transitions are separate.

The Ubuntu22-built stable archive
`OpenWhisper-Linux-amd64_0.3.0~dev.b892d861921f.deb` retains Debian identity
`io-github-whisperfree`, 141,253,222 bytes, SHA-256
`5f178f0867481f7f060ddf8e3ce1e222a088ef6e3065e40b996eb78155f5d13c`.
Dev archive SHA-256 is
`7a5d5a1b08320838b9f9fddd14b3400057b5c84a5548f0e233c4aaed7ae5a7ab`.
The exact Dev package passes the owned X11 runtime in 43.96 seconds. The exact
installed stable package passes eighteen checks in 58.92 seconds: ordinary Debian
installation, migration, public-audio CPU recognition, clipboard/history,
Retry/Discard, native X11 shortcuts, all five CLI commands, absent-owner refusal,
autostart enable/disable, read-only refresh and permanent-target restart.

The latest restarted original app exits 0; its close event and PID absence are
observed, all owned servers close, and the private container is removed without
forced app termination. Package contents/modes, returned archive hash, legacy
originals, in-place models and the separate Dev sentinel remain unchanged. The
earlier attempt hung at final Quit. The same immutable package passes with bounded
close observations; no production fix was made and that failure is unclassified.

This is automated non-root container acceptance with private Xvfb, audio and buses.
It does not establish real login-session launch, physical microphone/GPU coverage,
automatic paste, signed public upgrade or universal release packaging. Installed
user applications remain unchanged. [Current status](ELECTRON-STATUS.md) lists
remaining replacement work; earlier receipts below retain their original scope.

## Fixed-key Linux signatures in the actual Electron runtime

The real cached 0.2.5 Debian/AppImage and their original signature/feed files are
checksum-pinned before and after use. Standalone Node checks agree with the
existing Rust verifier. Actual Electron 44.7.0 / embedded Node 24.21.0 first
refuses native BLAKE2b-512; that failed receipt remains retained. The narrow TS
helper replaces only this digest with pinned `@noble/hashes` 2.4.0, retaining the
publisher key, Node Ed25519, both signatures and exact signed-version rule.

The corrected separately compiled fixture passes all nine cases in 20.25 seconds
using the same immutable Dev9 executable, UID1000, no network, devices or host
desktop/audio sockets. Both real packages pass raw-byte and bounded-stream checks;
changed payload/key/comment/version/mode, malformed envelopes and stream errors
are refused. No private signing key, generated publisher, GUI, package rebuild
or installation is used. Package/assets remain independently pinned. Both package
fixtures preserve the actual dependency and MIT notice bytes. Supplied-byte
authentication does not establish filesystem ownership, download, installation
or release continuity; those adapters remain separate.

## Actual Mac update signature checks on both architectures

The strict TS adapter preserves the old Swift current-self/static-self/designated-
requirement chain and Security validation flags for all architectures, nested code
and strict sealed resources. Existing pinned Koffi calls Apple's APIs; no C/C++
source, replacement publisher input or installer is added. Nine focused inert
ownership/error checks pass and independent review accepts the source. The
existing owned Mac smoke tests the running package against itself, valid
different ad-hoc identity, unsigned code and a changed sealed resource. Both
original Intel/Apple Silicon jobs in
[CI37865793116](https://github.com/juferdinand/OpenWhisper/actions/runs/37865793116)
pass all four cases for Dev and stable, normal restart and original clean exits.
The run's associated head is `9af2ed04`; actual PR checkout/package producer is
merge `ad3262ded6b05b0f53ecb9f7b57687e7db4bddb3` into `68294863`.
Wrong-identity code is independently signature-valid before requirement refusal;
the three negatives report `INVALID_SIGNATURE`. Original logs are retained;
numeric OSStatus values are not printed or claimed. Thin ad-hoc fixtures cannot
establish universal or persistent 0.2.5 release-signature continuity.

## Mac archival migration and native empty-domain worker PASS

The reviewed source adds a bounded CoreFoundation XML/binary decoder, read-only
AppKit stopped-host and CFPreferences snapshot admission, and exclusive APFS
configuration publication. Exact plist/snippet backups and unsupported native
values remain private; source models and archives stay in place. The normal main
checks actual stable bundle metadata and signature before collecting login and
hardware facts. Dev packaging retains its separate identity.

Independent review found and corrected a publication-order bug: the final native
snapshot query must precede the final filesystem/source identity checks. A source
change during that query now refuses publication. Local strict typing, normal
build and the compiled Linux startup fixture pass. The full suite passes 1050
tests, skips 25 explicitly and fails zero in 18.25s. At source `f31bea4`,
[Apple Silicon](https://github.com/juferdinand/OpenWhisper/actions/runs/37855692180/job/113579185090)
and [Intel](https://github.com/juferdinand/OpenWhisper/actions/runs/37855692180/job/113579185034)
pass actual CF XML/binary parsing, APFS exclusive publication/source-change refusal
and compiled-worker admission. Each ordinary Mac suite passes 1032 tests with 43
explicit skips; owned native capture/retirement and the existing Dev package also
pass. Archival decoder/filesystem cases use owned fixtures and synthetic cache access;
the compiled worker uses read-only actual native admission on an empty hosted
runner preference domain, with synthetic host facts. Neither establishes nonempty
0.2.5 preference-cache, persistent-signature, login replacement or stable GUI
acceptance. Current installations are unchanged. The normal stable bundle/UI smoke
is the next bounded package check; it will not relabel Dev CPU evidence as stable.

## Ordinary stable Linux package startup PASS

P27 captures stable identity only in a fresh Linux x64 build. Its unsigned
`OpenWhisper-Linux-amd64_0.3.0~dev.58169b3a8cc1.modified.deb` retains producer
`58169b3a8cc167e7538f434e02f95fe437f46d68`, modified true. The actual `openwhisper`
executes its own `resources/app` and normal main/shared UI with unchanged captured
recording inputs. It opens `io.github.whisperfree` stable storage after the P26
migration worker completes, with private Electron userData/session paths and a
sandboxed renderer. Actual X11 WM_CLASS matches the stable desktop identity.

The existing owned Xvfb/private Pulse case `stable-package-2` passes in 47.288866512s.
It seeds legacy settings/history, pinned Tiny0644 and a valid saved JFK WAV. UI
Retry recognizes that recording without a capture stream; saved GPU opt-in stays
enabled while the actual helper uses CPU. Native F8 Start/Stop then confirms
virtual-source dictation, clipboard/history, hold/cancel safety and trigger removal.
The existing source-loss Retry/Discard checks also pass. Normal Quit/restart retains
edited settings/history and Discard without replay, with exact legacy originals,
in-place model identity/mode and a separate Dev sentinel unchanged. No Dev control
owner appears. Original app/server closes and namespace removal pass. Results are
retained under `.local/planning/electron-migration/p4-linux-dev-recording/stable-package-2/`.
The exact stable package also passes the existing compiled-startup fixture through
its embedded Node. A fresh default Dev package from the same frozen source passes
the existing native X11 recording/recovery regression in 43.21501415s, with original
app/server closes, no forced termination and namespace removal confirmed; its
receipts remain in `p4-linux-dev-recording/dev-package-p27/`.

The retained `stable-package-1` fails in 33.1s with cleanup confirmed: normal startup
and migration worked, but saved recovery remained invisible because configuration
was deferred until Start. Configuring the existing recording worker before UI load
restores saved-WAV Retry without resolving a source or opening a capture stream.
The corrected package was freshly built; the failed artifact remains unchanged.

Final local source checks pass 1023 tests with 14 explicit skips and zero failures
in 18.272s, strict typing and 62 shared UI tests in 6.2s. Independent reviews pass.
[Committed CI37848603092](https://github.com/juferdinand/OpenWhisper/actions/runs/37848603092)
passes all six P26 jobs; it does not cover the P27 source increment. This is
owned stable-package runtime evidence using disposable HOME/XDG roots and virtual
audio, with no physical microphone, host sockets/devices or installation changes.
Mac stable data, stable command control, autostart/updater, installation transitions
and signed release continuity remain open; no public release was produced.

## Stable data services and compiled Linux migration worker PASS

Stable profiles now work with the existing preference, model/download and complete
transcript stores. Dev startup/update restrictions remain. Safe legacy model files
stay in place with their original modes; new publications remain0600. The Mac
pure converter preserves source defaults, editable snippet drafts, full original
history and opaque native trigger/editor details with explicit review categories.
Mac plist decoding/filesystem transition remains separate.

The Linux worker stages a complete private config unit, backs up exact bounded
source JSON and streams timestamped WAV copies in64KiB blocks. It copies the
captured source size and rejects growth/early EOF; unchanged long recordings have
no duration cutoff. It preserves non-WAV leftovers and refuses unknown WAV names.
FD-relative no-replace publication, final source/parent checks, retained interrupted
stages and independent cleanup review pass. Both handles close even if destination
closure fails. Existing completed state retains later edits and discarded recordings.

The normal compiled startup worker and production consumers pass an owned Linux
filesystem fixture, including actual saved-WAV read, edits/repeat, Discard without
replay, exact original bytes, partial-state refusal and clean original worker exit.
The existing Ubuntu CI job runs this same check after its normal build. Independent
review passes for conversion, profile/storage, model consumers, preferences and
startup boundaries. The P26 service checkpoint passes1005 cases with14 explicit skips,
zero failures in17.57s; strict typing and the normal shared-UI/app build pass.
An actual fresh non-recording Dev directory also passes the same bundled fixture
through its own embedded Electron44.7.0/Node24.21.0 runtime in0.57s. The worker,
Koffi and production stores load from that package's own resources/app; packaged
dist, manifest and lock match the frozen inputs. Producer metadata remains
85db6e5+modified with a null recording descriptor; no old artifact is relabeled.
This fixture establishes owned filesystem/embedded-Node worker behavior. Ordinary
stable GUI/browser-host execution is covered by the later P27 receipt above.
Mac native data transition, autostart, signed updates and release continuity remain open.

## Packaged Mac CPU inference PASS on Apple Silicon and Intel

The existing signed-production-utility smoke now requires the existing pinned
Tiny/JFK fixture directory. The same verified CPU helper receives one normal
transcription request after its fresh identity challenges and capability check.
It checks model/audio byte sizes and hashes, copies176000 contiguous Float32
samples, verifies the public phrase, then shuts down and observes the original
exit. Results retain only recognition, hashes and sample count. Capture remains
at generation zero; no permission request, capture Start or microphone operation
occurs. Original signed expectations and main's native inventory checks remain.

Independent review passes after correcting the evidence wording to distinguish
public fixture inference from microphone capture. Strict typing,49 directly
affected protocol/bootstrap/Mac-host/entry-graph cases and serialized-callback
checks pass. The actual [Apple Silicon](https://github.com/juferdinand/OpenWhisper/actions/runs/37842623817/job/113535531317)
and [Intel](https://github.com/juferdinand/OpenWhisper/actions/runs/37842623817/job/113535532048)
package jobs pass the augmented smoke at branch input104c43d, PR merge tree
6df25da6e4e52f4ac65606cb9e97870e8cdf41e4. Their original actual-package smokes
finish at20:54:59UTC (arm64) and20:57:01UTC (x64). Real CPU recognition through
the signed packaged speech utility, original child exits and normal Quit all pass.
These are owned macOS15 thin ad-hoc Dev packages. Physical microphone/TCC,
device changes, target insertion, Metal and stable release signing remain separate.

## Fresh local Dev installation PASS on Linux, Apple Silicon and Intel

The pure Node TypeScript CLI installs a local standalone recording Dev directory
or matching `OpenWhisper Dev.app` into an exclusively reserved fresh root under
the user's home. It validates copied inventory/modes, locked dependencies,
architecture and captured recording inputs without executing package modules or
native addons. Linux exclusively creates an explicit Dev launcher; Mac uses
`ditto` and verifies the existing bundle signature. The profile remains absent.
Existing destinations and stable storage are refused. Rollback removes validated
known entries individually; unexpected files survive with incomplete cleanup reported.

Independent review found two defects, now corrected and covered: unexpected inner
files during rollback and `=` in Linux executable paths. Seven focused filesystem/
CLI tests pass. The full service suite passes 952 cases with 14 explicit skips,
zero failures in16.75s; final strict typing and the normal build pass. The losing
concurrent-installer assertion accepts either legitimate refusal point while
checking that the winner's launcher survives and no losing installation remains.

An actual embedded-Electron run exposed ASAR filesystem virtualization during
raw archive copying. The standalone CLI now sets `process.noAsar` only for its
operation and restores the previous state. This independently reviewed fix adds
no Electron/native imports or fuse/signature changes. Both original early failures
remain retained; they occur before app launch, profile/model creation or capture.

The fresh current-TS Linux package retains verified unchanged Ubuntu22-built
capture, CPU speech and D-Bus dependency bytes with their original producer manifest;
current worker entries and their expectations are captured at build time. No old
package is relabeled. The existing private Kubuntu/Xvfb runner now installs this
package through its embedded Node CLI, then runs the relocated ordinary executable
and its own `Resources/app`. `installed-x11-3` passes in44.08s: actual F8 setup,
Escape/held-key handling, CPU Tiny recognition, exact clipboard/history agreement,
source-loss Retry/Discard, original Quit, child closure and namespace removal.
Repeated installation is refused while the original installed app remains idle/alive;
source/returned package inventories, descriptor, launcher and owned stable sentinel
stay unchanged. No physical device or host installation is used.

The existing [Apple Silicon](https://github.com/juferdinand/OpenWhisper/actions/runs/37840925558/job/113529789851)
and [Intel](https://github.com/juferdinand/OpenWhisper/actions/runs/37840925558/job/113529789925)
package jobs pass the same fresh embedded-Node install before the relocated app's
normal sandbox, signed-utility and shortcut checks at branch input0cd12a1. Their
actual smokes finish at20:41:34UTC (arm64) and20:44:32UTC (x64). Both copied bundles
pass strict signature checks, the explicit profile starts nonexistent, and repeated
installation is refused while the original app remains alive/idle. The complete
original Quit/cleanup checks pass. CI37840925558 completes all six jobs successfully.
These are owned macOS15 thin ad-hoc Dev packages; the later receipt above establishes
packaged CPU transcription. Physical permissions/devices and release signing remain
separate. Archive download
authenticity, existing-version replacement,
stable migration, updates and release packaging remain separate work. See
[Dev installation commands](ELECTRON-DEVELOPMENT.md#install-a-separate-local-dev-copy).

## Signed Mac production-utility PASS on Apple Silicon and Intel

The existing actual-package smoke now also verifies and loads the unchanged
production capture and CPU speech entries in their original Electron utility
processes. Expectations come from the packaged signed build descriptor. Capture
configuration remains at generation zero without Start or session allocation;
speech discovery follows two fresh PID/epoch challenges and does not load a model.
Both original exits and failure cleanup are bounded and observed. The main
process must keep capture/speech addons out of its native inventory. This changes
only the existing TypeScript smoke, preserving package contents and signing policy.
Actual [Apple Silicon](https://github.com/juferdinand/OpenWhisper/actions/runs/37834933376/job/113509442466)
and [Intel](https://github.com/juferdinand/OpenWhisper/actions/runs/37834933376/job/113509442542)
package jobs pass in CI37834933376 at branch input b42caec, PR merge tree
5f6d3c7ca3d1c5f28440e4ca0817d6f95c2e29b4. Their original actual-package smokes
finish at19:53:02UTC (arm64) and19:57:58UTC (x64). The full startup/sandbox,
normal shortcut setup/removal and original clean Quit checks still pass. These
are thin ad-hoc Dev packages on owned macOS15 VMs; deployment floor14.0 remains
verified without claiming a macOS14 runtime. CI37834933376 has completed all six
jobs successfully, including legacy Linux.
Microphone/TCC, inference through these entries and target insertion remain separate.
Strict typing and 71 directly affected protocol/runtime/package cases pass. The
full unchanged service suite passes 945 cases with 14 explicit skips in 16.79s,
and the normal TypeScript/shared-UI build passes. A local inspector probe catches
the driver's unsupported dynamic imports before CI; package-module loading uses
the existing Node loader instead. The serialized callback has no external tsx
function-name helper.

## Actual Apple Silicon and Intel Mac Dev package PASS

[Run37830955196](https://github.com/juferdinand/OpenWhisper/actions/runs/37830955196)
passes both owned Mac jobs at branch input eebebef, PR merge tree
3149db6242bd8b3264cd02303152445d81498209. Each job builds, ad-hoc signs, verifies
and extracts its own architecture's Dev ZIP, then starts that exact executable
and Resources/app with a private profile. Dev identity, isPackaged, actual renderer
OS sandbox and normal main production retirement/native-descriptor initialization
pass. Owned-window Command+Shift+F8 setup saves the real profile and registers the
actual globalShortcut; Remove clears/unregisters it. Original normal Quit exits0
without a signal. Apple Silicon passes at19:21:21UTC, Intel at19:23:45UTC.

The same run passes the Mac CPU public-audio foundation check and both generated
PCM capture/retirement roles. These are macOS15 runtimes with a verified14.0
deployment floor. No microphone/Accessibility permission is requested and no
OS-global input is injected. Actual global-key firing, physical devices, TCC
attribution, target-field insertion, Metal,
universal release signing and stable update/data transition remain open. The
legacy Swift DMG/native UI also passes. Run37830955196 has now completed all six
jobs successfully, including legacy Linux. This receipt does not claim a completed
full migration. Signed utility loading was still pending at this checkpoint;
the later receipt above establishes that narrower additional runtime claim.

## Mac Dev package and Accessibility paste source

Per-architecture Dev packaging preserves the pinned Electron framework links,
locked dependencies, source metadata and native origin notices. It signs native
inputs before build-time descriptor finalization, then signs and verifies the
bundle and extracted ZIP. The existing Apple Silicon/Intel CI matrix launches the
actual package with a fresh private profile to check identity, sandboxed UI,
owned-window regular-key setup/removal and original clean Quit. The first run,
37827484622, fails before signing/UI launch on both architectures: the minimum-OS
parser mistakes linker versions for deployment floors. SHA-checked artifacts show
the native capture/retirement floor is 14.0 and locked Koffi is 11.0. The corrected
parser reads only deployment load-command fields and retains the 14.0 requirement;
strict typing and all six focused package cases pass. Actual packaged UI remains
pending. The separate legacy Swift DMG check also reports a corrupt image; its
cause is unresolved. Existing package artifacts are now retained after failure.

The next run, 37828376841, packages/signs/extracts the Apple Silicon Dev archive
and opens the real shared UI. Its smoke stops at package identity: the executable
is still named Electron, so Electron44's [actual IsPackaged implementation](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_app.cc#L865)
returns false. The staged executable and CFBundleExecutable now use OpenWhisper
Dev; no environment override replaces the assertion. Intel reaches runtime
signing but encounters unsigned nested Crashpad before the enclosing framework.
Runtime Mach-O inputs now sign inside out. Strict typing and seven focused package
cases pass; actual corrected package execution remains pending. The legacy Swift
DMG/native UI passes in this run without a DMG source change; the prior failure's
cause is not established.

Run 37829597870 passes Apple Silicon package identity, its actual renderer OS
sandbox and normal production retirement/native-descriptor initialization. Its
owned shortcut driver still leaves setup pending: it sends CDP keyDown, while
Electron's [main input handler](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_web_contents.cc#L1589)
accepts rawKeyDown/keyUp. The driver changes only that press-event type, retaining
the owned window, native keycode, matching release, normal setup, saved-profile/
globalShortcut assertions and clean Quit check. No application/native behavior
or OS-global input is introduced by this driver correction.

The strict TypeScript paste adapter lazily loads fixed Apple frameworks only after
permission and external-target admission. It refuses held modifiers, changed focus
and app-owned targets, posts one Command+V pair and releases native references.
Confirmed clipboard output remains the fallback. Native event posting does not
establish target-field readback. Nine inert adapter cases pass. The shared UI now
exposes native Accessibility setup without a Linux portal; unsupported clipboard
restoration is hidden through an optional capability preserving legacy Swift UI.

The completed increment passes strict typing/recording build and 942 unit cases
with 14 explicit skips (17.23s). After the small optional UI capability addition,
35 affected contract/shortcut/paste/package cases, strict typing and all 60 shared
UI cases pass after rebuilding the assets. Physical
microphones, TCC attribution, actual target insertion, Metal and stable release
signing/update continuity remain open.

## Basic Mac regular-key control source

The main-owned strict TypeScript adapter connects explicit regular-key toggle
setup to Electron globalShortcut and the existing immutable recording leases.
It registers only after explicit setup, commits on matching key release,
restores the previous binding on Escape/Cancel/blur, refuses conflicts and
removes only its own binding. Late callbacks and releases cannot retarget a new
recording. Shutdown waits for and cancels an original acquired Start lease.
Nine focused inert cases pass; main integration and host-only serialized Mac
preferences keep Linux profiles independent. A model download cannot disable
Stop for an already active dictation.

The shared UI states toggle-only behavior and disables hold selection for this
Dev adapter. Legacy native Mac controls remain compatible without that optional
capability flag. Fn/modifier-only/mouse/media/keypad input is unsupported. Strict
typing/build, 31 focused contract/preference/control cases, 929 full-suite passes
with 14 explicit skips (17.46s), and all 60 shared UI cases (9.4s) pass. The small
download-admission correction subsequently passes strict typing and 14 affected
adapter/control cases. These source/Linux-browser checks do not establish actual
Mac global-key dispatch, packaged loading, permission/device or target insertion.
The assembled Mac CI package check follows separately.

## Ubuntu22 native build and exact Dev package execution

The existing production recording builder rebuilds CPU speech, capture and D-Bus
in the pinned Ubuntu22 compiler image, offline and UID1000, using a fresh private
source copy. Source/UI/script inputs remain unchanged; only captured native/build
outputs change. All 13 shipped ELF files require at most GLIBC2.34/GLIBCXX3.4.29;
the Debian package declares libc6>=2.35. Metadata, extracted-tree equality,
launcher, existing icon and notices pass. The `.deb` SHA-256 is
`f728495c0796b0130ba5eb039c7384a571a9da8ba9927e7bb87bf6317838350a`.

**`packaged-x11-1` passes in 41.78 seconds.** The existing owned X11 runner copies
the complete directory intact and executes its actual `openwhisper-dev`, requiring
`app.isPackaged=true` and the package's own `resources/app`. Playwright stays
outside the app. No native input or captured descriptor is replaced or recaptured.
Original, copied, stopped-container, returned and final source package hashes agree.
Actual F8 setup, Escape restoration, hold/repeat/stale-release safety, Stop/Cancel,
CPU recognition, clipboard/history, trigger removal, source-loss Retry and Discard
pass. The renderer remains sandboxed; original Quit/private services and exact
namespace cleanup pass without forced termination. No host installation, physical
microphone, GPU or automatic target paste is used.

The runtime uses the pinned private Kubuntu24.04/Xvfb image. Ubuntu22 is the native
build baseline, not a newly claimed installed-desktop test. Frozen app metadata
remains de495e6+modified, without relabeling it as the subsequent source commit.
The first host-native preview and its GLIBC2.43 limitation remain historical
evidence below. Final strict typing/diff checks pass; application/UI/native-source
checks are reused because this step changes only the existing runner. Further
Linux matrices are deferred by the owner; Mac basics, installation/updates and
release acceptance remain open.

## Genuine X11 setup and Dev package preview checkpoint

**`native-x11-triggers-7` passes**, 40.99 seconds. The existing owned
recording runner uses the pinned private Kubuntu image with Xvfb, genuine X11
session variables and actual XTEST key edges; it starts no compositor or synthetic
portal. The X server confirms the original owned main XID as its keyboard target,
although Electron reports it unfocused. Actual F8 capture preserves the legacy
profile (keycode74, keysym65477, modifiers0, group0). Real Escape restores the
binding; held/repeated F8 opens one stream, and a stale release after GUI Cancel
cannot stop a later GUI recording. F8 Start/Stop, real CPU Tiny recognition, exact
clipboard/history agreement, recovery removal, trigger removal, source-loss
Retry without recapture and Discard pass. Original application/private-service
closure and exact namespace removal pass. No physical microphone, GPU or
automatic target paste is used or claimed.

The separate strict TypeScript adapter runs in the existing platform utility,
uses pinned Koffi and fixed X11/XKB libraries, and adds no authored C/C++ source or
helper supervisor. It preserves legacy keycode/keysym/modifiers/group preferences
separately from KDE profiles. Native focus ancestry gates its explicit grab;
press/release capture, repeat suppression, conflict rollback, lock variants and
layout invalidation have inert coverage. A map notice before the first candidate
allows capture against the current XKB map; a notice after a candidate or active
binding still invalidates it. Stale startup events are cleared before capture,
and pointer-only mapping notifications are ignored. Eight focused inert cases and
final strict TS/recording build pass. The final full suite has 920 passes,
14 explicit opt-in/tool skips and zero failures in 16.79 seconds; the shared UI
has 59 passes after its assets are rebuilt. The earlier 917-pass integration
receipt remains separate from these final source inputs.

Packets1–6 retain the original failures: initial state publication, Electron's
activation flag on bare Xvfb, then native setup invalidation. Packet6 remains FAIL
in 27.22 seconds with ENDED and no profile; its original cleanup passes.
[X server input-source switching](https://github.com/mirror/xserver/blob/master/xkb/xkbUtils.c)
can emit a new-keyboard notice before the first key. This was a source-supported
causal candidate rather than a measured event subtype. The minimal pre-candidate
handling passes the unchanged actual key scenario. Xlib's
[pending map refresh](https://github.com/mirror/libX11/blob/master/src/xkb/XKBBind.c)
keeps subsequent key translation current. Named desktops, startup/reconnect,
real layout/lock/conflict coverage and opted-in XTEST paste remain open; #29
is not closed by this basic dictation result.

The parallel Linux packaging script preserves an existing distribution,
package.json, lockfile, captured native descriptors and locked production
dependencies with their notices. An actual unsigned Dev `.deb` passes metadata,
extraction, staged-tree equality and desktop-file validation without installation
or app execution. Three focused tests pass in the existing offline private Debian
image; on the host the two non-archive checks pass and the archive check explicitly
skips because `dpkg-deb` is absent. The package uses the separate Dev identity and
`/opt/openwhisper-dev` destination.

The retained preview is
`OpenWhisper-Dev-Linux-amd64_0.3.0~dev.de495e626e28.modified.deb`, SHA-256
`4d532343be2f0b7f568ac5bf6dd02e8a139b9781e3999f79df0079936380d384`.
Its metadata remains `de495e6+modified`; it was frozen before the final X11 focus
and queue corrections. Its host-built speech addon requires GLIBC 2.43, truthfully
declared in Debian dependencies. Ubuntu 22.04 and Debian 13 cannot run that input.
This is archive/layout evidence, not portable or installed runtime, AppImage,
signatures, updates or release acceptance. Neither installation is replaced.

[CI37817460015](https://github.com/juferdinand/OpenWhisper/actions/runs/37817460015)
at committed `de495e6` passes all six jobs. That CI result is separate from these
later local inputs. The complete 0.3.0 migration and #21/#29/#30 remain open.
The owner's subsequent scope adjustment defers expanded Linux desktop matrices
to follow-up tickets; basic Mac/Linux dictation, controls and installation remain
required.

## Previous foreground editor checkpoint

**`stock-kde-wayland-editor-focus-2` passes in 28.50 seconds.** The preceding
case1 fails at the actual editor's post-Cancel keyboard marker in 15.93 seconds:
the editor retains only its initial 14 bytes, while both Electron focus flags
remain false. The revised gate uses the existing private native Wayland GTK
editor, focuses it once, and checks cumulative marker bytes before/after real
Cancel and Stop. It never restores focus after a pointer action.

The small KDE-specific change selects the layer-shell namespace `dock`.
[KWin's scope mapping](https://github.com/KDE/kwin/blob/v5.27.11/src/layershellv1window.cpp#L22)
and [Dock activation guard](https://github.com/KDE/kwin/blob/v5.27.11/src/activation.cpp#L383)
motivated that fix. On the pinned stock Plasma 5.27.12 runner all four markers
match exactly (14/27/39/50 cumulative bytes), with the main and overlay unfocused.
Actual desktop crops still match all 12,501 idle and 12,206 recording samples.
Real F8/private public-fixture capture, actual GTK Cancel/Stop, CPU recognition,
independent clipboard/history, recovery removal, graceful original Quit, surface
process absence and exact namespace removal pass. Peak 248/cap 256 has no task
rejection or OOM. Automatic target paste is separate evidence below.

Strict TS and recording build pass; the 19 directly affected overlay/surface tests
pass in 0.21 seconds. Unchanged full-suite/UI evidence below is reused. Frozen
artifact metadata is `da74568+modified`, not a later commit. The whole-image IPC
transfer now uses base64 instead of an array of millions of JSON numbers; actual
pixel checks are unchanged. Failed case1 and the earlier packets remain retained.

KWin gives this role DockLayer stacking, below keep-above and active fullscreen
windows. Those cases and other compositors remain open; the prototype retains
`--experimental-wayland-overlay` and ordinary Dev retains its main-control
fallback. This partial result does not close L-OVERLAY or #21/#29/#30.

## Previous native surface checkpoint

The native Wayland layer-shell prototype uses strict TypeScript and pinned
Koffi 3.3.2 against the existing GTK3 libraries; it adds no authored C/C++ or second
frontend. Its trusted sandboxed renderer stays unmapped. An empty initial paint
is ignored under a finite first-frame deadline; frame acknowledgements, PNG size,
input regions and the original utility shutdown remain bounded. Creation failures
destroy the unused renderer and leave main controls available.

**`stock-kde-wayland-overlay-4` remains FAIL.** Actual owned KWin screenshots match
all 12,501 sampled idle pixels and 12,206 recording pixels from the trusted renderer.
Mapping preserves main focus; real F8 opens one private audio stream, and an actual
GTK pointer Cancel returns the app to idle with no stream or recovery. The subsequent
main-window focus assertion fails. Attempt5 reproduces the same focus boundary
through a temporary shared-button activation experiment, so that alternative was
removed. Original graceful Quit, private service closure and exact namespace removal
pass in both failed packets. Their total runner durations are 47.10 and 46.33 seconds.
Pointer Stop/recognition is not reached and is not claimed as passing.

The final guarded build passes ordinary native Wayland dictation and insertion into
the owned inner XWayland editor in **`stock-kde-xwayland-paste-4`**, 24.91 seconds.
Clipboard/paste confirmation, recovery removal, permission revoke, original graceful
Quit and exact namespace cleanup pass. Strict TypeScript checking and recording build
pass; the final unit suite has **910 passes, 13 native opt-in skips and 0 failures**,
16.78 seconds. The unchanged shared UI retains its59-test receipt.

The earlier failed packets are retained separately: attempt1's screenshot hash
comparison could not establish actual native visibility; attempts2/3 identify an
empty 0×0 initial Electron paint. The corrected pixel gate and first-frame handling
establish real native presentation in attempts4/5. No failed packet is overwritten.
At that checkpoint the unresolved post-click focus boundary kept the prototype
behind the explicit switch. The later foreground-editor result above supersedes
that diagnosis only for the tested KDE role and ordinary-window case.

At committed `97e473f`, [CI37808051769](https://github.com/juferdinand/OpenWhisper/actions/runs/37808051769)
finishes with all six jobs passing. This does not certify the later local prototype
or establish that the earlier intermittent Mac process-binding failure is resolved.

The preceding tray/XWayland checkpoint remains as follows.

The normal Dev now connects a localized tray menu and the existing shared recording
overlay to the same authoritative recording handlers. In **`stock-kde-overlay-xwayland-2`**,
the app explicitly uses the verified private inner XWayland server. The sandboxed overlay
is hidden by default, follows the idle preference and mirrors real F8 capture. An actual
pointer click through the private outer KWin surface cancels its one audio stream without
moving keyboard focus. Overlay preference mutation is refused. Original Quit and exact
namespace cleanup pass; peak199/cap256, no rejection/OOM, **9.43 seconds**. Attempt1
separately covers renderer DOM Cancel (10.32 seconds); the final attempt proves pointer input.

The native Wayland attempt **`stock-kde-overlay-1` fails focus retention** when shown.
Electron documents inactive-show as unsupported there. The known unsafe BrowserWindow
path is guarded; no global XWayland switch or focus restoration masks the failure.
Native layer-shell presentation using shared renderer output remains required. Fresh
`stock-kde-xwayland-paste-3` still passes native Wayland app → XWayland editor dictation
and exact clipboard/history delivery in25.38 seconds, with peak218/cap256 and clean Quit.

Strict TS and recording build pass; **900 unit tests pass**, with13 native opt-in skips.
The15 new tests cover tray action routing/localization/availability and overlay policy.
The unchanged shared UI retains its59-test evidence. Real tray surface/menu interaction,
assembled Mac presentation and native Wayland floating controls remain open.

The normal native Wayland Dev app also pastes into an **owned inner XWayland GTK
editor** in `stock-kde-xwayland-paste-2`. The actual KWin-owned Xwayland server is
verified before target startup; only the editor changes display backend. Real F8
Start/Stop, private public-speech audio and CPU recognition produce 105 bytes that
match the editor, history and independent Wayland clipboard exactly while the app
remains unfocused. Permission revoke, empty recovery, graceful original Quit and
private-service/namespace cleanup pass. Peak214/cap256, no cap rejection or OOM;
the selected runner takes **24.52 seconds**. Attempt1 also passes at 23.99 seconds;
attempt2 covers the final nonempty launcher-file readiness check and its frozen
driver hash matches the committed source.

Strict TypeScript checking passes. This increment changes only the test harness
and documentation; unchanged application unit/UI/native inputs are reused from
the checks below, without an app rebuild. This is the pinned KDE Wayland-to-XWayland
boundary, not standalone X11 desktop acceptance or GNOME consent evidence.

Keyboard-only paste passes in **`stock-kde-paste-3`** on the pinned Kubuntu 24.04 /
Plasma 5.27.12 native Wayland runner with portal frontend 1.18.4 and KDE backend
5.27.11. The normal app explicitly grants a RemoteDesktop keyboard session through
shared UI, binds real F8, records only the private public-speech fixture and uses
CPU recognition. While the app remains unfocused, production Ctrl+V inserts into
a separate owned GTK TextView. Target, history and an independent `wl-paste` client
agree exactly (105 bytes). Recovery is empty, revocation is requested and normal
Quit closes the original app and clipboard helper. Original private services and
the exact namespace close without forced app termination. Peak218/cap256, zero
task rejections and no OOM; total runner duration is 23.78 seconds.

Attempts1/2 preserve the real failure: Electron's immediate self-read reported a
commit, but the target stayed empty and subsequent cross-client clipboard read
failed. The strict TypeScript Wayland adapter owns a foreground `wl-copy`, supplies
text through stdin, confirms external bytes before requesting paste and retains
true cleanup failures. The passing test still records Electron's unfocused cache
read as false; that cache is diagnostic, not authoritative clipboard evidence.
No native binding or new Python source was added. The existing owned GTK helper
is reused verbatim; its KWin focus script is compiled from strict TypeScript.

Permission tests cover early/foreign replies, pre-dispatch and pending cancellation,
denial/retry, session loss, key releases and fatal cleanup propagation to the original
utility supervisor. Clipboard tests cover exact multilingual text, held retirement,
failed cleanup, concurrent writes, missing tools and shutdown. Strict TS and recording
build pass; **885 unit tests** pass (13 native opt-in skips), with **59 shared UI tests**
passing at their unchanged UI source. A timing-sensitive Intel CI fixture now makes
its preparation deterministic and asserts entry into the intended blocked phase;
its product deadline and late-error containment remain unchanged.

This is owned stock KDE **legacy immediate grant**, not dialog Deny/Approve or
identity-associated consent evidence. GNOME combined
hold/paste, advanced triggers, overlays, normal Dev GPU, packages/signatures/updates
and full host replacement remain open. #21/#29/#30 are not closed by this result.
Stable0.2.5 and the running Dev build are unchanged.

Active-binding Quit and same-profile crash recovery pass in **`stock-kde-lifecycle-4`**
on the same pinned Kubuntu 24.04 / Plasma 5.27 native Wayland runner. With F8 still
bound, normal Quit closes the original app, empties its private journal and makes
the actual KGlobalAccel key available. Restart preserves the preference without
binding at startup. After SIGKILL of the original owned main, its original D-Bus
owner disappears but KDE still reserves F8. Explicit setup now recovers that dead
action **before window key capture**, then registers a fresh component/connection.
Actual F8 starts recording again; GUI Cancel closes its private virtual stream.
Normal Quit with the recovered binding releases the key and journal again.

All three original main processes close (Quit, deliberate crash, Quit), private
servers close and the exact namespace is removed. No forced cleanup is required
in the final pass. Peak182/cap256, zero task rejections and no OOM are recorded.
This dedicated lifecycle mode performs no recognition or target paste; the prior
keyboard dictation receipt below remains separately scoped. The normal app is
used without process interception or host input/microphone access.

Attempts1/2 reproduce the stale action consuming F8 before window capture, with
normal active-binding Quit already passing. Attempt3 separately retains the
previously observed initial-source enumeration failure and forced app cleanup,
without process-cap exhaustion. Its cause is still unproven; the final pass does
not close that startup gate. The fix adds only TypeScript recovery orchestration.
Strict TS, recording build and **861 unit tests** pass (13 native opt-in skips).
The shared UI source is unchanged from its 58-test passing receipt. At parent
`180d033`, all six CI jobs pass in
[CI37786332970](https://github.com/juferdinand/OpenWhisper/actions/runs/37786332970).
This new functional revision requires its own CI. No complete platform, package,
update, advanced-trigger or full-migration gate is inferred from this lifecycle pass.

The KDE keyboard path passes in **`stock-kde-keyboard-9`** on the pinned Kubuntu
24.04 / Plasma 5.27 native Wayland runner. The normal app captures F8 during explicit
setup, confirms the real KGlobalAccel assignment, and uses actual outer-XTEST
press/release events through the private nested compositor for CPU dictation.
No synthetic portal signals, process-start interception, or key-event observer is
used in this final run. The renderer remains sandboxed; audio is exclusively the
private public-speech fixture. Clipboard/history, GUI/command cancellation,
source-loss Retry/Discard, binding removal and graceful original Quit pass.
The journal is empty after Remove and F8 no longer starts capture. Original
commands and the exact namespace close without forced app termination; task peak
is 203 of 256, with zero cap rejections and no OOM.

The same run checks a held F8 acquisition, GUI Cancel, a later GUI recording and
the old key release. That release cannot stop the later recording; command Cancel
works and subsequent F8 toggle dictation remains usable. Earlier attempt 8 exposed
a worker-side rejected-promise cache after a guard-only stale Stop. The corrected
RPC carries `STALE_LEASE` only for a verified immutable owner change and permits
safe cleanup of that old reference. Invoked native terminal failures remain
retained and rejected. Regression tests cover both cases through the real main
lease / worker RPC chain.

Capture commits on release. Attempt 6 observed only key-down when main consumed
it early; keeping key-down in Chromium's path, suppressing UI defaults during
setup and consuming the release produces both edges in attempt 7. Attempt 9
repeats without that observer. Attempts 1/4 retain separate initial enumeration
and forced-cleanup failures without task exhaustion; their cause remains unproven.
The fixture records initial source count and may invoke the normal explicit
Refresh command. The passing final run finds its private source initially.

Strict TS, recording build, **858 passing unit tests** (13 native opt-in skips)
and **58 UI tests** pass. All six predecessor CI jobs at `5331be9` pass in
[CI37777115182](https://github.com/juferdinand/OpenWhisper/actions/runs/37777115182).
That functional push has its own CI. Crash-journal recovery/conflict refusal and
concurrent retirement have unit evidence; fresh runtime crash recovery and Quit
with an active binding are covered by the later lifecycle receipt above. No modifier-only/mouse, KDE X11,
GNOME, wlroots, automatic paste, overlay, GPU, Mac-device or release/update gate
is closed by this regular-key test. The full migration remains incomplete.

Earlier checkpoints follow with their original source and scope.

Stock Kubuntu dictation now passes in `ui-run-stock-kde-11`: the ordinary native
Wayland app performs real Tiny CPU recognition, exact clipboard/history delivery,
GUI/command cancellation, source-loss Retry/Discard and graceful original app close.
No startup interception or synthetic portal is used. The application source is
unchanged from `96790f2`; the correction is confined to the owned desktop fixture.

The retained stock failure was resource starvation in that fixture. Attempt 9
records `pids.max=256`, `pids.peak=256`, `pids.events: max 1`, no OOM event, and a
speech-child exit during startup. The same native module loads with the verified
Node runtime in the cached image. Limiting only the nested desktop's software
renderer with `LP_NUM_THREADS=2` keeps the same 256-task cap and actual inference
path. [Mesa documents this rendering-thread setting](https://docs.mesa3d.org/envvars.html#lp-num-threads).
Attempt 11 records a 215-task peak, zero cap rejections and no OOM. Its original
commands, application and exact container close without forced app termination.
The earlier pressure failures remain retained; robust application cleanup after
early worker death under pressure is still a separate lifecycle check.

The installed KDE 5.27 portal still returns no assigned shortcut. Stock key edges,
target-app paste, overlays, GPU, GNOME and release/data/update gates remain open.
All six CI jobs at application predecessor `96790f2` pass in
[CI37772826379](https://github.com/juferdinand/OpenWhisper/actions/runs/37772826379).
Strict TS, 843 unit tests and 57 UI tests remain valid for unchanged application/UI
source; fixture changes have their own strict check and fresh owned runtime.

Previous checkpoints follow for their retained scope and provenance.

The latest correction preserves confirmed shortcuts when a version-1 portal
cannot open configuration, retains release edges and binding changes during
reconfiguration, and keeps unassigned sessions visibly unassigned. The main
window also shows after its trusted document loads, so initial visibility does
not depend only on a first-frame event from a hidden Wayland surface.
Strict TypeScript, the recording build, **843 tests** (13 native opt-in skips),
and **57 shared UI tests** pass. The normal Ubuntu22 runtime also passes real CPU
recognition, clipboard/history, shortcut protocol, recovery and graceful Quit in
`ui-run-shortcuts-6`; its original commands and namespace close successfully,
including an observed original application close without forced termination.

The existing runner now offers `--stock-kde`, reusing the unchanged owned-desktop
launcher and a cached Kubuntu image. It runs the ordinary app on native Wayland
with a real portal frontend/backend, private audio and a test-only QPainter
compositor. Plasma 5.27.12, portal 1.18.4 and KDE backend 5.27.11 are recorded in
`ui-run-stock-kde-6`. Setup returns an available portal with no assigned shortcut;
the UI renders the desktop-settings fallback. GUI and command cancellation pass.
The earlier hidden-window frame timeout no longer prevents these UI operations.
This is partial stock evidence: recognition subsequently reports `SPEECH_FAILED`,
and cleanup reaches the owned launcher's 180-second deadline (exit 124). The
container and original launcher commands are closed, but graceful application
shutdown is unproven. Diagnostic follow-up `ui-run-stock-kde-7` preserves the
finite `SPEECH_FAILED` state and available private recovery before cleanup. It
fails immediately on terminal recognition errors instead of polling for success;
cleanup bounds the application wait and observes the original process close after
forced termination. The owned command fails in about 25 seconds, versus about
200 seconds in the previous attempt; this is one observed failure-path comparison,
not a general speed benchmark. The failure screenshot and receipts are retained. Do not
claim stock recognition, compositor key delivery or full KDE support from it.

All six jobs at shortcut predecessor `8f8b985` pass in
[CI37766878242](https://github.com/juferdinand/OpenWhisper/actions/runs/37766878242).
The corrections require their own push CI. Neither the installed stable app nor
the running Dev build was replaced.

Previous checkpoints follow for their retained scope and provenance.

The Linux shortcut increment adds explicit desktop setup, Cancel, confirmed binding
descriptions, toggle/hold recording and session cleanup to the normal Dev host.
Strict TypeScript and the recording-enabled build pass. **840 tests pass**, with
13 explicit native opt-in skips; **57 shared UI tests pass**. The existing held
download-close test now allows 200 ms for cleanup after its deliberate timeout,
avoiding an unrelated 20 ms private-file-sync race under concurrent test load.

The existing normal-UI/private-audio runner uses the existing pinned bus compiler
image to assemble a synthetic portal frontend before execution. Real D-Bus/native
transport carries early request responses, pending consent cancellation, retry,
binding loss and hold-recording cancellation. Portal Start/Stop performs actual CPU
Tiny recognition, confirmed clipboard/history delivery and recovery deletion;
the existing GUI/command Cancel and source-loss Retry/Discard cases remain included.
This is protocol/container evidence, not stock KDE/GNOME consent or OS key delivery.
Specialized KDE/X11 input, target-app paste, GPU and physical-device gates remain open.

Current local packet: `.local/planning/electron-migration/p4-linux-dev-recording/ui-run-shortcuts-4/`
(outside Git). The original commands and test namespace close successfully. An earlier
attempt, `ui-run-shortcuts-3`, hit its overall deadline while launching the normal app;
its commands and namespace were subsequently closed. No root cause or bootstrap fix
is claimed from the later successful run. Retain this startup gap for the lifecycle
replacement gate, rather than treating a rerun as a fix.

The Mac/control predecessor `5270796` passes all six jobs in
[CI37760091723](https://github.com/juferdinand/OpenWhisper/actions/runs/37760091723),
including normal Mac Dev assembly. New shortcut source requires its own push CI.

Previous checkpoints follow for their retained scope and provenance.

Current 0.3.0 development checkpoint: normal CPU recording is connected on Linux and
macOS. The Mac composition uses the production process-retirement boundary, an explicit
permission button and RAM-only Retry/Discard. Linux also connects authenticated Dev
command control to the same recording owner used by the window. Strict TypeScript and
827 ordinary tests pass (13 explicit native opt-in skips); the Linux recording build passes.
The shared renderer is unchanged from its previous 56 passing UI tests.

The existing owned Ubuntu 22.04 normal-UI launcher now also passes command Start → UI
Cancel, a later UI Start → command Cancel and command Start → command Cancel. Normal UI Start/Stop, real public Tiny CPU
recognition, exact private clipboard/history, source-loss Retry/Discard and graceful Quit
continue to pass. The exact test container and its original commands close successfully.
This is virtual-audio evidence, not physical microphone, global-trigger, target-app paste,
GPU or Mac end-to-end evidence. The Mac recording composition has focused synthetic/unit
coverage; the assembled Mac recording build is now an additional CI check.

Local runtime packet: `.local/planning/electron-migration/p4-linux-dev-recording/ui-run-platform-2/`
(kept outside Git). It reuses the existing pinned private container and cached baseline-native
artifacts, with fixed build descriptors assembled before execution. No new test framework
or host device access was added.

[CI37755500881](https://github.com/juferdinand/OpenWhisper/actions/runs/37755500881)
passes all six jobs at the previous pushed Linux-dictation checkpoint `426b85f`.
The current Mac/control increment requires its own push CI; that previous result does not
prove the new source.

[CI37743916089](https://github.com/juferdinand/OpenWhisper/actions/runs/37743916089)
passes all six jobs at `7b16af8`, including the distinct Mac production-role probe on both
architectures and the existing Linux/macOS packages. Each Apple production-role probe passes
five real process cases with original kernel retirement and read completion. These are
macOS 15 runner results with a macOS 14 deployment target; ordinary Mac recording, Metal,
macOS 14 runtime and signed-helper loading remain separate gates. Later source changes
require their own CI.

[CI37741940367](https://github.com/juferdinand/OpenWhisper/actions/runs/37741940367)
at `cccde7a` passed Ubuntu Electron checks and both existing packages. Its three
Mac Electron jobs failed during inert test preparation, before the native gates.
Source inspection identifies noncanonical temporary roots as the cause; the
failure logs do not retain their actual resolved paths.
The test-only correction resolves each newly created temporary root before use;
production guards are unchanged. The subsequent green CI above verifies the correction
and reaches both actual Mac production-role probes.

The first owned automatic loader-present fallback run reached three completed-job
checkpoints, then failed its final composition validation. The exact container was
removed, but the failed predicate and main birth were not retained before failure.
The failed run remains preserved. A later source-only fixture correction distinguishes
an incidental detached Electron exit listener from the authoritative original kernel
retirement/read barrier. Its owned loader-present run now passes three jobs across four
native owners: manual CPU, requested Vulkan with no GPU followed by CPU, then manual CPU.
All 1,857 artifact hashes and original command/namespace closure receipts were independently
verified. The separate loader-absent run also passes: actual Vulkan discovery returns
`START_FAILED`/unavailable, then full retirement/read completion precedes separate CPU
verification. Three public-input jobs and all 19 original commands pass; 1,857 retained
artifact hashes and 75 passive frozen source records were independently verified. Neither
profile establishes physical GPU execution or GPU support in the CPU-only normal Dev build.

The actual recording/pool fixture also passes three capture/recovery epochs with one
continuing supervisor and full original speech-process retirement. A deliberately failed
delivery retains the WAV; a later confirmed delivery with a lost reply is replayed from
the same-main receipt cache without copying twice. The private clipboard has one exact
commit; audio removal and model deletion follow their owned completion barriers.

The Linux asynchronous native bus candidate passes its opening, cleanup, async-call and
all 19 retained original tests, including genuine UID 1001 refusal. The final original-19
run takes 7.33 seconds and reuses the accepted native ELF; 165 artifact hashes were
independently verified. Its utility witness observes a same-birth zombie as non-running,
which is distinct from full reaping. Device enumeration separately passes without opening
any capture stream; generated-source capture then preserves 18,062 samples. Neither result
establishes physical-device, desktop shortcut, target-app paste or release-package parity.

The sections below retain historical evidence with their original source scope.

## Normal Linux recording UI checkpoint

Local packet `p4-linux-dev-recording/ui-run-4` uses the actual normal main, preload, shared
renderer and recording capture entry. Only its captured native artifacts/descriptor are
assembled for the existing Ubuntu 22.04 baseline before execution; runtime expectations
are not refreshed. The private container uses UID 1000, no network/host mounts/devices,
private Xvfb and a generated PipeWire-Pulse monitor source. Linux renderer kernel checks
verify sandboxing, no effective capabilities and no Node in the renderer main world.

| Actual path | Result |
| --- | --- |
| Startup and device enumeration | No capture stream is opened; the private Tiny inventory is selectable |
| Cancel | Original native stream closes without a recovery file |
| Start/Stop | Public JFK playback is captured; real Tiny CPU inference produces complete output |
| Delivery | Exact private clipboard readback and history confirm output before recovery WAV removal |
| Selected-source loss and Retry | Private WAV remains after loss; Retry recognizes and copies without reopening capture, then removes recovery |
| Discard | Actual shared control removes the retained WAV and returns to idle |
| Quit | Original main and private servers close; all 12 Docker commands close; exact container is removed and absent |

The main process loads neither native capture nor speech. Independent review rehashes
1,450 payload files and the same stopped-container roundtrip, and matches the 14 current
reviewed source hashes. Three earlier failed attempts remain retained: two pre-recording
fixture failures from a platform-inapplicable sandbox metric and one source-loss fixture
with a blind button click across the automatic Stop/Retry transition. The final
fixture follows actual button intent and kernel sandbox evidence without changing production.
No physical microphone, running installation, hotkey, target-app paste, GPU, macOS recording
or signed package is tested here. See the [owned UI procedure](../electron/tests/owned-dev-recording/README.md)
and [Dev commands](ELECTRON-DEVELOPMENT.md#linux-cpu-recording-dev-build).

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

### Trusted speech factory refusal

An independent pure reproduction found that a trusted pre-transfer TEARDOWN_FAILED
became START_FAILED and fulfilled the factory ownership promise. The corrected client
retains actual SpeechWorkerError integrity/teardown refusals as rejected ownership,
including a refusal arriving after cancellation. A subsequent request awaits that same
ownership and cannot allocate again. Arbitrary exception code fields stay generic.
All 12 combined client/factory lifecycle tests pass; the initial two failing regressions
are retained privately. This fence belongs to the continuing client instance. It does
not prove a process-wide allocation fence, native retirement or automatic fallback.

### Prepared owned Apple process probe

A standalone probe uses public libproc SDK records with zombie-inclusive queries,
current UID/direct-parent/birth checks, and a private NOTE_EXIT kqueue. The strict
TypeScript adapter requires matching A/watch/B observations, a fresh nonce on the
original owned UtilityProcess channel, and matching C before admission. Non-running
and fully reaped remain separate states. Native work, descriptor closure and the
asynchronous environment cleanup hook keep one owner through delayed operations;
a failed close remains failed on repeated calls.

Fourteen focused pure tests pass. The separately reviewed CI fixture now builds and
runs on the existing macOS 15 Apple Silicon and Intel jobs, after their capture gate.
It covers seven owned child cases plus target-free synthetic Worker cleanup, with
separate provenance artifacts. Private preparation precedes readiness; categorical
handlers and a watchdog precede asynchronous preparation. Native compilation and
execution of this new probe are pending at this source checkpoint. Deployment target
14 does not establish macOS 14 runtime acceptance. Production factory wiring, observer
placement, deterministic zombies/PID reuse, signed loading and uninterruptible kernel
shutdown remain open.


### Apple process probe CI correction

[CI 37722721367](https://github.com/juferdinand/OpenWhisper/actions/runs/37722721367)
completed with four successful jobs and two failed owned Apple jobs at `ee2cc05`.
Apple Silicon compiled the process addon and passed capture again. Its process
fixture completed clean exit, nonzero exit, owned UtilityProcess kill and delayed
SIGTERM phases before failing; it did not produce a complete acceptance result.
Intel failed a pure success-path test before the native build: its 30 ms synthetic
wall-clock budget expired during scheduling. No Intel native probe result follows.

The correction gives that inert success-path test a fixed clock while retaining
its separate actual-expiry tests. It also removes an unsupported assertion that a
child must still be alive after UtilityProcess.kill returns: the pinned Chromium
implementation may synchronously wait for the child. Fixed categorical checkpoint,
kill elapsed time and actual helper exit metadata replace that assumption. Native
observer source, ownership fences, runtime deadlines and cleanup guards are unchanged.
Both corrected architectures still require fresh CI evidence.

### Host speech resource catalog

A standalone strict TypeScript catalog validates fixed CPU/Vulkan/Metal destinations,
host architecture, Node-API 8, exact speech-source pins, byte count and SHA-256 before
any future native load. Verification checks genuine selected ancestry and a bounded
NOFOLLOW descriptor, including identity before/after streaming and actual descriptor
closure. A manual CPU selection visits only its CPU artifact.

Independent private filesystem regressions found that replacing a root directory,
or racing two preparations around that replacement, could escape an outstanding
close obligation. Persistent logical-path and physical-identity ownership now retain
that obligation across fresh handles and awaited metadata. Original six and four
independent tests pass 10/10; the retained failing reproductions precede their fixes.
Rejected or synchronous close stays terminal and is never retried or certified by a
new handle. No native loader, factory, worker, package or UI consumes this catalog yet.
This detects the tested mutations; it is not an immutable lease against later
same-UID modification, publisher authentication, or a process-wide allocation fence.


### Actual owned Linux process retirement

The standalone owned Node fixtures pass four lifecycle cases and one held-reader case
at their historical build-2 source. New Electron 44.7 fixtures pass the same four
lifecycle cases and a separate real held-procfs-descriptor case at build-7. Both run
as UID 1000 in isolated Ubuntu22 containers without network, mounts or host devices,
with the exact recorded runtime, approved seccomp policy and parent sandbox enabled.
Original returned child channels provide fresh nonce/birth confirmation before
admission and before an owned termination request. Direct-parent and current-UID
checks bind the actual kernel record. A runtime exit event alone cannot permit reuse.

Electron self-exit and self-abort directly sampled matching-birth Z states before
actual procfs absence. Other cases accurately report Z as not observed. Delayed
termination and held-reader ambiguity keep the allocation poisoned even after later
actual absence. The held reader uses a real procfs descriptor; its accepted queued
observation barrier stays pending until that exact descriptor closes. Independent
review verifies source/bundle/runtime/config hashes and complete owned container
cleanup. The local final packet hash is
`9db9ed375d3e849ee00e2770a7b3f342d68839f0609223189142df5f5ffadeb3`.

Current 44 focused inert tests pass, including the independent initially failing
reader-barrier regression. The fixture contract tests now run in the ordinary test
command. Actual invocation stays explicit: its fixed runtime payload and container
must be prepared and verified through `tests/owned-retirement/build-probe.ts` and
`run.ts`. These standalone tests do not connect the speech factory, native addon,
model leases or application lifecycle. Continuing main allocation ownership and
live automatic backend fallback still require their separate integration proofs.


### Prepared catalog model download

The host-only downloader accepts a catalog ID and optional cancellation. It streams
bounded data into genuine private Dev staging, validates HTTPS server-linked size/SHA,
then asks inventory to verify the copied stream before no-replace publication. Its
opaque publication receipt binds uncertainty/finalization to that exact operation.
Only fixed Hugging Face HTTPS authorities are permitted; credentials, proxies,
certificate overrides and redirects to other authorities are unavailable to callers.
Certificate verification is explicitly enabled on the private Agent and request.

Independent review reproduced three premature cleanup certificates: destroy intent
instead of actual socket close, and retried synchronous source/directory close refusal.
An additional output-part regression reproduced the same failure. The corrected
receipt owns its exact close Promise before invocation, retains rejection and never
obtains a replacement certificate. Socket completion requires its observed close
event. All 60 focused inventory/download/private-filesystem tests pass, including the
four initially failing regressions. Ordinary imports preserve their existing behavior.

This is source, injected event and actual private filesystem evidence. Real TLS,
public provider transfer, model compatibility/license acceptance and crash recovery
are separate gates before live UI wiring. Server integrity metadata is not a project
signature. The same-host reservation is not an interprocess lock. The reviewed source
manifest hash is `2dd3e886079348b6a1060ec48edbf3f90348110463737aac352f3b7740d92846`.

### Resource-directory ownership and Apple cleanup diagnostics

[CI 37725513947](https://github.com/juferdinand/OpenWhisper/actions/runs/37725513947)
completed with three successful jobs and three failures. Both existing host builds
and the macOS Electron foundation passed. The Ubuntu Electron job exposed an idle
physical-root identity conflict; both Apple process probes completed all seven
owned child phases before failing the separate synthetic Worker cleanup gate.
Their generated-PCM capture tests also passed. This is partial process evidence,
not complete Apple retirement acceptance.

The catalog now permits an unrelated idle inode to be reused while synchronously
reserving accepted work, including operations submitted through old handles. It
opens and stat-matches a genuine NOFOLLOW directory descriptor before the artifact,
and retains that directory until artifact closure and final consistency checks
finish. Failed file closure retains both descriptors; failed directory closure
retains its exact rejected Promise. All cleanup remains inside the pending fence.
Twenty-three focused tests pass, including ten new independent cases and a genuine
unlinked directory whose descriptor retains its original inode after file-close
refusal. Synthetic alias identities are distinguished from that filesystem test.
No birth-time heuristic, native load or application allocation is involved.

The Apple fixture now records bounded categorical Worker stages, validated native
counters and termination state. Its four original cleanup assertions, native
source, ownership guards and production deadlines are unchanged. Fresh CI is
required to identify the failed assertion before changing cleanup behavior.

The next CI exposed a fixture assumption before native execution: macOS reports
`nlink=2` for the still-open removed directory, where the owned Linux run reported
zero. The cross-platform test now requires actual pathname absence plus the live
descriptor's original dev/inode and a different replacement identity. It does not
infer pathname removal from a platform-specific link count. Catalog source and
Apple native assertions remain unchanged; the earlier Linux observation is retained
at its exact historical test source.

### Continuing speech allocation and measured Apple cleanup order

A host-only supervisor now privately owns one allocation for the lifetime of the
main module. Its 47 inert tests cover captured model leases, manual CPU without GPU
probing, fixed Vulkan selection, eligible pre-inference fallback, two original-channel
nonces around matching OS birth, and complete retirement/read closure before reuse.
Integrity or uncertain cleanup remains terminal across jobs; deadlines retain original
late operations. An admitted hung helper can be terminated through its original handle
after a fresh matching kernel observation without requiring responsive helper JavaScript.
An unadmitted helper still requires fresh channel confirmation. These are policy tests;
the existing speech entry/factory remains ineligible and is not wired to this supervisor.

At `ad87bd1`, both owned Apple jobs again completed their seven child phases but
failed the separate synthetic Worker assertion: environment cleanup and disposal each
increased once, while the addon-hook suppression counter did not increase. Pinned
Node24.21 source drains pending native work before the cleanup-hook queue. New native
counters measure completion before versus after that addon hook, without inferring a
unique shutdown cause from a Node-API exception status. The certificate requires one
completion, one measured path, one cleanup/disposal and zero outstanding reservation.
A continuous bounded Worker observer refuses malformed, duplicate or late frames and
unexpected exit before requested termination. Nineteen focused inert checks pass; fresh
native compile/runtime evidence on both Mac architectures is still required. Neither
the old failure nor this source correction establishes complete Apple retirement,
actual kernel cancellation, production Metal selection or signed helper loading.

The `4cb0bae` CI passed the complete owned Apple Silicon gate. Intel stopped before
native execution because two inert supervisor success cases exceeded their short
40/80 ms fixture budgets under scheduling load. A downloader whole-deadline test
also incorrectly assumed HEAD must start before expiry. Test-only success budgets
now allow scheduling; explicit expiry/late-settlement cases retain their short
budgets. The whole-download test allows zero or one early HEAD and proves the request
count cannot increase after expiry/gate release. Production deadlines and failure
categories are unchanged. Fresh Intel native evidence remains required.

### Bootstrap controls before native speech loading

The helper now accepts exactly the fixed absolute binding and a main-created UUID
epoch. It sends bootstrap availability without loading native code and answers a
closed, finite challenge protocol with its own PID. Two distinct valid challenges
are required before ordinary discovery or transcription; shutdown before loading
also stays entirely in the bootstrap. Native loading has one lazy attempt, with
separate closed start versus native-operation failure categories. Twenty bootstrap
tests, ten fixture-channel tests and the expanded client tests pass; together with
the unchanged protocol checks, the focused set has 44 passing inert tests. Four
fixture builders generate six modules without executing them.

These controls are a child-side prerequisite, not OS admission. The continuing
main supervisor must still bracket the original channel with genuine process
identity checks. Historical owned fixtures use a separately labeled two-challenge
helper with generic-exit cleanup; it is ineligible for production retirement.
The old production factory remains unchanged and its old arguments fail closed
against this entry. Main transport/identity integration and actual execution at
these new hashes remain separate steps before ordinary app wiring.

The complete Apple Silicon retirement artifact from
[CI 37729612021](https://github.com/juferdinand/OpenWhisper/actions/runs/37729612021)
was independently checked against `4cb0bae`: all seven owned child cases reached
full reap and disposal, and the synthetic Worker completed exactly once during
Node's work drain before the addon cleanup hook. All recorded source and native
binary hashes match. This is actual arm64 evidence on a macOS 15 CI runner using
the 15.5 SDK; the SDK version is not the runtime OS version. It does not
establish Intel execution, macOS 14 runtime, production Metal admission, kernel
cancellation or signed package loading. Zombie visibility was not observed.

At `2f0099f`, [CI 37731217799](https://github.com/juferdinand/OpenWhisper/actions/runs/37731217799)
passes the same complete owned retirement gate on both Apple Silicon and Intel.
The independently checked artifacts match all fourteen project source hashes
and four pinned header hashes per architecture. Seven actual child cases fully
reap and dispose; the target-free synthetic Worker again completes exactly once
during the work drain, followed by one cleanup/disposal and zero reservation.
The runtime is Electron 44.7 with Node 24.21. Tested binding hashes agree with
their build manifests and the independently reread native binaries; their Mach-O
architectures also match. This establishes neither production factory, Metal,
device/TCC nor signing acceptance.

All six jobs in that exact `2f0099f` run now pass, including the existing Linux
package and CPU fallback checks. This is a completed checkpoint; later source
changes require their own checks.

### Owned HTTPS transport and retained cleanup

The private loopback TLS gate now passes all thirteen cases with the reviewed
Node 24.21 runtime and immutable unprivileged network-none container. It publishes
and reads back exactly 1,000,017 synthetic bytes with matching SHA-256 and a counted
17-byte tail. Certificate/hostname refusal, incomplete response parsing, a distinct
local error after apparent EOF, two cancellation phases and three deadlines pass.
All acquired original requests, responses and sockets observe actual close events;
owned servers close with no remaining connections. Three additional cases hold
close notifications over already closed connections: retained cleanup refuses,
a second owner remains BUSY without another request, and the same owner finalizes
after notification release. These cases do not hold physical connections open.

The first actual run remains a failure after its successful partial download.
An independently reproduced test defect expected an empty cache even though Dev
preparation creates control/locks/session. The corrected fixture requires those
exact private empty directories and rejects staging, symlinks, permission/owner
changes or missing entries. Seventeen focused inert/private-filesystem checks
pass and are registered in ordinary CI; the actual TLS runner is separately
opted in. Closed stage checkpoints retain no response content or private keys.
The successful runtime input is
`2a2a43a4d5247d61b984ace9ba6c7a4642b189da35f5a3bb5d6e3bc7a7d47545`;
all 128 declared inputs and copied runtime artifacts were independently checked.
Exact container removal/absence and original CLI closure are confirmed.

This is actual local TLS with synthetic model publication. Public provider/catalog
behavior, model authenticity, native compatibility, crash recovery, interprocess
locking and live UI download wiring remain separate work. No production CA or
destination override was introduced.

### Fixed Linux speech host and original transport

The new main-only Linux edge captures opaque native and entry catalogs, verifies
them before the original fork, and uses the strict bootstrap controls with the
genuine procfs retirement wrapper. The resolved witness and original binding
transaction remain owned even when conversion refuses. Fifty-six focused inert
checks pass. Source-only compilation records 265 fixed graph entries and 101
actual resolution inputs, including the speech contracts and application/Zod
package metadata. No generated helper was executed during those checks.

Caller cancellation retains accepted private controls and the original spawn.
Malformed frames never signal a child implicitly. Explicit supervisor-authorized
termination invokes the original handle once and waits its independent bounded
acknowledgment even after channel failure; the first refusal remains terminal.
This does not establish successful recovery from corrupt admitted channels.
Generic exit and termination acknowledgment still cannot release the continuing
allocation; full kernel retirement and accepted read closure remain required.

The reviewed source manifest is
`43a1121b6c7f653355550bf6e5bf5119f9d6a28cf23f080197b375dbc456883d`.
The subsequent owned manual-CPU composition now passes as recorded below.
Ordinary recording/UI wiring and automatic application fallback remain separate
gates.

### Retained Linux bus opening and environment cleanup

The separately reviewed `beginOpen` edge keeps one monotonic deadline and retains
its opaque native owner through cancellation, readiness and actual callback/read
disposal. Existing default opening remains compatible. Six actual private-bus
opening cases now pass with the exact retained addon, including original daemon
birth admission before scenarios and original exit/close before final absence.
The separate environment-disposal case also passes: its pending certificate
marker exists, no successful acknowledgment follows, and the original utility
becomes absent before completion. This is observed ordering/non-running evidence,
not a universal cleanup-hook or full-reap guarantee.

The remaining transport fixture stops with a categorical `TIMEOUT` before its
complete nineteen-case result or foreign-UID stage. A separately reviewed finite
diagnostic with both binaries reused completes the first eight original checks,
then records `CONTROL_STATUS` entered and `TIMEOUT`. Its 83-transition ledger
preserves that operation through completed final bus/child cleanup. The aggregate
execution lasts about3.41s against a45s watchdog; the original method has a3s
native bound. This supports method expiry, without proving the underlying cause
or an exact per-call duration. The original failed run remains immutable; source
causal analysis precedes any semantic fix or further runtime retry.
The utility's separately observed same-birth zombie is non-running, not reaped.
The actual fixed test-service compile and its Ubuntu 22 ABI metadata pass; native
code was reused unchanged. Original receipts and exact container removal/absence
were independently checked. These results do not establish live desktop,
capture, installed CLI or production adapter acceptance.

### Separate production Mac retirement source

The excluded-by-default production target now shares the public-SDK native
lifecycle with the historical probe, but omits every probe/synthetic/barrier
export. A main-only ABI capture and challenge-free retirement boundary retain
original launch facts, accepted queries and the same cleanup operation. Thirty
new inert cases and the fourteen unchanged probe tests pass against the complete
committed base. The continuing supervisor remains responsible for its two
original-channel challenges and model/allocation release. This source slice
has not compiled the production target or connected a verified main loader.
Actual native compilation, both Mac architectures, supervisor composition,
signed loading and minimum macOS14 runtime remain separate gates.

### Ordinary CI ownership fixture correction

CI37733983352 failed before native tests in three Intel inert cases and one
Linux filesystem case. The Intel fixture used 5–100ms budgets for setup and
success, allowing scheduler latency to expire before the intended boundary.
Setup/success now allow 3000ms. Explicit expiry tests still consume one real
monotonic deadline, hold the actual inert boundary beyond it, require refusal
and prevent a second cleanup budget. Production deadlines are unchanged.

The Linux close-refusal fixture physically closed its synthetic handles and
removed its directory while the process-wide failed owner remained pinned.
A recycled inode could then alias that failed owner in the next independent
case. Both refused fixture directories now remain allocated until this test
file completes, when private cleanup removes them. The production registry,
failed-owner retention and fresh-handle refusal remain unchanged. All51 focused
inert checks pass; exact failed CI logs remain retained before the correction.

The eleven finite legacy diagnostic/service-reuse contract cases are also
registered in ordinary CI. They preserve the exact original nineteen assertions
and compile receipts and provide a closed active-operation/completed-prefix
ledger. The separate actual legacy-only runner reuses both previously verified
binaries; importing these inert tests starts no bus, process, container or build.

### Actual continuing Linux manual-CPU composition

One reviewed actual invocation now composes the normal continuing supervisor,
canonical Linux host, original transport/bootstrap and genuine procfs retirement
boundary with private model inventory and the retained native CPU addon. Two
consecutive jobs recognize the exact pinned public Tiny/JFK fixture. Both return
the same 107-byte output hash; transcript text is absent from the evidence.
Each helper completes two distinct original-channel challenges and matching
UID/direct-parent/birth admission before inference. After each job, kernel
retirement, final reaped observation, accepted read closure and final reaped
state precede release of the actual model lease. The first exact job.close
promise releases its lease before the second job starts. Generic exit remains
a separate observation. Manual CPU performs no GPU verification or discovery.

The immutable Ubuntu22 container runs UID1000, network none, private PID/IPC
and Xvfb, zero host mounts/devices, dropped capabilities, no-new-privileges and
the reviewed seccomp policy. Raw Electron44.7.0 runtime bytes are checked with
original-fs. No native compilation or download occurs. The original browser
PID/birth is absent after its CLI closes, and the exact container is removed
and absent. All17 original commands close successfully. Independent review
checks all1844 retained artifacts, all92 current/frozen source/provenance files
and all872 payload records against the original build and stopped-container
round trip. The result SHA is
`8e10daf3ce1167c65b60bd85a52dd9b6a62bcf393d4d5460d2608899c89eed11`;
the actual manifest SHA is
`7f5e89d3827a5865f81fe516a112b701604c4dcd24eb6118a32856ef6d62f894`.

This establishes owned Linux manual-CPU inventory/supervisor/inference/process
composition on these public inputs. Automatic GPU selection/fallback, capture,
clipboard delivery, actual desktops, macOS and signed package parity remain
unestablished by this run. The ten closed runner/receipt/private-file contract
cases are registered in ordinary CI; importing them starts no container,
native addon, inference, audio or application.

### Recording broker and private model-lease composition source

The asynchronous main recording broker now accepts a host-owned speech factory
that captures one selected model ID/GPU choice and acquires the real private
inventory lease. It delegates bounded inference windows to a job of the existing
continuing supervisor. Every window must match the leased path/family and cannot
promote a manual CPU selection; a GPU-permitted selection may retry on CPU.
The gate is shared by the exact continuing supervisor across new factories,
selections and recording-helper epochs. Another inventory binding refuses.
Accepted acquisition, original job close and lease release stay owned; the exact
original job.close promise is passed to lease.release. Held release blocks new
work, and failed cleanup remains terminal even after the job itself has closed.

Cancel during opening waits for the accepted original transaction and retires
a late returned client without sending inference. Opening teardown failure is
fatal to broker reuse and shutdown. Native/model integrity and invalid authority
remain nonretryable ownership failures through the worker/adaptive boundary.
The historical synchronous speech seam remains only for existing inert fixtures.
Thirteen added broker/private-inventory lifecycle cases pass, including deletion
refusal while leased and original close-promise identity. The complete isolated
source overlay passes strict checking,689 ordinary tests,10 opt-in skips and
the source/UI build; independent source review passes. These are policy and
private-filesystem results. Actual recording through this new factory, utility
controls, microphone/permission enumeration, clipboard/history, model actions,
shutdown and development UI wiring remain subsequent composition gates.

### Explicit Mac production-role build and owned fixture

The shared TypeScript builder preserves the historical probe target and default
paths. A separate explicit entry builds only `openwhisper_macos_retirement`, with
its own build directory, binary and notices. It checks exact source/header hashes,
Node-API8, production-only compile definitions and minimum macOS14 Mach-O metadata.
The historical probe is retained and its result is not a production-role result.

The opt-in production fixture captures native/source/distribution/runtime input
hashes before launch. It tests the real production ABI and fixed exports, actual
browser/main/UID guards, target-free Worker and ordinary pinned Node refusal, then
five original utility-child identity/retirement cases. Two fresh original-channel
nonces surround admission; full native retirement and read closure precede reuse.
The fixture has no renderer, audio, permission, Metal or production-factory work.
Original CLI/Node/Worker errors poison acceptance without replacing their actual
close/exit obligations. Deadline/escalation remains until original close; stdout
overflow and late monotonic acceptance cannot become success after exit0.

Independent review checks the exact eleven source files, unchanged native and
historical fixtures, inert lifetime regressions and source-only generated bundles.
Strict checking, the full suite (710 passing tests) and build pass; eleven runtime tests
are explicitly skipped unless their fixture is enabled. The existing Intel and
Apple Silicon CI jobs now build and execute this distinct role after their original
capture/probe gates, using Node24.21.0 and separate always-retained artifacts.
Actual new native/runtime evidence is pending that CI. This source does not wire
ordinary Mac supervisor/Metal or establish signing, minimum-OS runtime, microphone,
TCC, device or desktop parity.
