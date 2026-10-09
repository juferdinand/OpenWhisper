# Electron implementation status

Target version: **0.3.0**, replacing the existing Swift/Rust application hosts.
Implementation: [draft PR #34](https://github.com/juferdinand/OpenWhisper/pull/34),
tracked by [issue #33](https://github.com/juferdinand/OpenWhisper/issues/33).
The installed stable application is still 0.2.5.
Windows is separate follow-up work in [issue #35](https://github.com/juferdinand/OpenWhisper/issues/35).
Folder/documentation cleanup is tracked in [issue #36](https://github.com/juferdinand/OpenWhisper/issues/36).

Track completion by the functional milestones below. The full migration is still
incomplete; the table distinguishes runnable behavior from remaining replacement work.

| Area | Current result | Remaining work |
| --- | --- | --- |
| Plan and architecture | Reviewed plan, repository research answers and issue/PR review recorded | Keep decisions aligned with final implementation |
| Shared interface and services | Existing design, strict TS bridge, isolated Dev profile, settings, models/history and localized shared-owner tray actions; sandboxed recording overlay connected | Native tray presentation, assembled Mac overlay and remaining platform behaviors |
| Linux dictation | CPU recognition, clipboard/history, Retry/Discard and original cleanup pass in exact Dev/stable packages with private virtual audio. The installed stable package also passes migration, command control, autostart and permanent-target restart | Accelerated inference; an earlier final-Quit hang did not reproduce and remains unclassified |
| macOS dictation | Actual Intel/Apple Silicon Dev packages pass sandbox, signed utilities, CPU recognition of public audio, shortcut setup/removal and original Quit. Normal stable packages pass migration, edited-state restart and clean exits at b892d86 | Physical microphone/TCC, actual target insertion and device changes; Metal selection remains open |
| Linux desktop integration | Owned stock KDE 5.27 native Wayland F8, binding Quit/crash recovery and paste into separate Wayland/XWayland editors pass. Genuine X11 shortcuts and all five no-display CLI commands pass, including installed stable autostart enable/disable and generated-target restart | Expanded named-desktop, GNOME consent, wlroots, modifier/mouse, layout and overlay stacking coverage is deferred to follow-up tickets |
| Optional model communication | Isolated manual local-model preview port exists | Complete the remaining agreed provider/workflow scope separately; ordinary dictation remains independent |
| Packaging and updates | Fresh Ubuntu22 AppImage passes permanent-launch admission, autostart and the complete owned runtime. Debian metadata consumer passes in actual embedded Node; original-file downloads, signatures and Mac ZIP roundtrips pass. Universal Mac constructor is implemented | Actual universal construction/runtime, installation/restart/rollback, persistent publisher continuity, authenticated Dev replacement, DMG and release signing |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

## Current package checkpoint

Fresh clean `340dee3fb60cbf5abf6819553d9b575848919305` Ubuntu22 packages
retain their original source inventory. The 119,618,040-byte AppImage has
SHA-256 `40156f21310f03a06cd114217163586b2d355f3c209c86c0e1d94cd579341873`.
Its complete owned runtime passes eighteen checks in 74.44 seconds: actual
permanent-launch admission, read-only preservation of the legacy autostart
entry, explicit UI disable/enable, generated launcher/image restart, disabled
state across another restart, command control, native X11, CPU dictation,
clipboard/history, Retry/Discard and secondary resource survival. All three
original image/process chains exit normally and their private extraction trees
disappear. The first attempt failed a contradictory test seed; changing only
that seed produced this result with the same immutable package. Real login,
physical devices and update replacement remain separate.

Both original owned Mac jobs in
[CI 37873249720](https://github.com/juferdinand/OpenWhisper/actions/runs/37873249720)
pass Dev and stable ZIP/signature checks and normal original exits. API head is
`340dee3f`; the actual thin package producer is synthetic PR merge
`bcf527b8b1f51d5705a9b92b5cc664b2e77786b3`. The universal constructor now
uses exactly pinned official `@electron/universal` with common V2 metadata,
both locked Koffi variants and architecture-indexed original receipts. It
retains thin inputs, checks common bytes and both native slices, captures final
native hashes after signing and verifies the ZIP roundtrip. Portable fixture
tests and independent review are separate from the pending actual Darwin
construction and universal runtime.

The inactive Debian installer consumer authenticates the original private
download again, reads exact package/version/architecture through retained fd3,
and admits one fixed Polkit/dpkg transaction. Its eight checks pass in unchanged
Electron 44.7.0 / Node 24.21.0 with actual `dpkg-deb`; install effects remain
synthetic. No privileged install or restart took place. Application wiring,
post-native-cleanup restart and rollback remain open.

This combined source increment passes strict typing, the normal app/shared-UI
build and 1177 unit tests in 17.62 seconds, with zero failures and 34 explicit
native/opt-in skips. The separate eight-case embedded Debian check above has no
skips. Independent source reviews pass for both new consumers and the harness.

The next CI increment consumes both successful thin packages from the same run,
constructs one universal ZIP, then checks that identical ZIP on Intel and ARM.
It reuses the normal stable smoke for migration, settings, signatures, archives,
shortcuts, restart and original Quit, plus capture Configure/Close and CPU public
fixture inference without opening a microphone. This workflow and its explicit
V2/original-receipt admission are reviewed; actual universal results remain open.

Stable Debian packaging also retains `/usr/bin/openwhisper-desktop`, the restart
path captured by native 0.2.5. The fixed entry forwards to the permanent Electron
installation; Dev does not own it. Owned inert packaging checks pass, with the
actual native-to-Electron upgrade still outstanding.

The original Intel job in
[CI 37875160757](https://github.com/juferdinand/OpenWhisper/actions/runs/37875160757)
fails before packaging in an existing abort test's initial mock bind. Hosted
scheduling exceeds its unrelated 30-ms monotonic setup budget. That one logical
ordering test now uses the existing injected clock; fourteen focused cases pass.
Production deadlines and separate expiry tests are unchanged. The original ARM
job passes; the next original CI run must confirm the corrected Intel case.

Earlier package checkpoints follow with their original producers and scopes.

[CI37862779046](https://github.com/juferdinand/OpenWhisper/actions/runs/37862779046)
passes all six jobs at clean `b892d861921fd51c6a1de2e35c987a0bd620ac9b`, including
the complete owned Mac jobs on Intel and Apple Silicon. Each Mac job passes the
signed Dev capture-close check and normal stable first launch, read-only migration,
shortcut setup/removal, edited-state restart and original clean exits. The Mac
migration worker uses an empty OS preference domain and synthetic host facts; this
does not establish persistent-signature or nonempty 0.2.5 preference transitions.

Fresh Ubuntu22 stable build8 and Dev build9 retain that exact clean source. The
Dev package passes its full owned X11 runtime in 43.96 seconds. Installed stable
passes all eighteen checks in 58.92 seconds: ordinary Debian installation,
migration, CPU dictation, clipboard/history, recovery, all CLI commands, autostart
enable/disable, read-only refresh and restart through the fixed permanent target.
The final restarted original PID exits 0, all owned servers close normally and the
container is removed. The earlier attempt hung at final Quit; this did not
reproduce with the same immutable package and bounded close observations. No
production fix was made, and the original failure remains unclassified. These
unsigned packages establish automated container acceptance, not a release, real
login-session launch or physical-device coverage.

The fixed-key Linux signature helper verifies real cached 0.2.5 Debian/AppImage
bytes and streams with independent Rust-oracle agreement. Electron 44.7.0 /
embedded Node 24.21.0 lacks native BLAKE2b-512, so the helper uses exactly pinned
TypeScript `@noble/hashes` for that digest and retains Node Ed25519 verification.
All nine cases pass in that actual runtime in 20.25 seconds, including both real
packages and payload/key/comment/version/mode/stream negatives. This uses the
same immutable Dev9 executable and a separate compiled helper fixture; it does
not establish packaged updater wiring. Original MIT notices are included by both
packagers. Updates remain inactive pending installation acceptance and application
wiring. The separate Mac signature adapter obtains the current running
application's designated requirement and checks all architectures, nested code
and strict sealed resources through Apple's APIs. Nine focused ownership/failure
checks and independent reviews pass. Both original owned Mac jobs in
[CI37865793116](https://github.com/juferdinand/OpenWhisper/actions/runs/37865793116)
pass actual self, different-identity, unsigned and tampered-resource cases for
both Dev and stable, including normal restart/clean exits. The PR run identifies
head `9af2ed04`; its normal checkout/package producer is merge `ad3262de` into
`68294863`. These thin ad-hoc cases do not establish persistent release signing.

The complete signature increment passes strict typing, the ordinary application/
shared-UI build and 1110 unit tests with zero failures and 26 explicit native or
opt-in skips in 17.30 seconds. Focused real-artifact checks and actual Electron
execution are separate from those skipped default-suite cases.

The next reviewed increment shares private original-file staging and HTTPS
resource ownership between update consumers. Positioned writes preserve the
Mac inherited descriptor's initial offset; cancellation waits for actual reads,
writes and original connections to settle. Linux verifies both copied original
packages, and an inert HTTPS transfer of real cached Debian bytes authenticates
through the retained file. One actual public HTTPS transfer through the default
production factory also passes on Node26: exact 21,152,538-byte 0.2.5 Debian,
fixed signature/version/SHA, original descriptor closure and complete private
stage removal in 1.52 seconds. This uses synthetic current version 0.2.4 and
establishes download compatibility rather than an upgrade or Electron-embedded
network execution. The Mac consumer uses fixed system bsdtar/plutil,
internal framework links, exact metadata/version and the existing running-app
signature requirement. Both original Mac jobs in
[CI37868932078](https://github.com/juferdinand/OpenWhisper/actions/runs/37868932078)
fail in extraction cleanup; Stable smoke is skipped. The subsequent ARM job in
[CI37870309345](https://github.com/juferdinand/OpenWhisper/actions/runs/37870309345)
identifies `real-package:REMOVE_TREE:ENOTEMPTY`. An equivalent failure is
reproduced in the unchanged Dev9 Electron runtime: normal `fs` treats the
physical `default_app.asar` file as a virtual directory and leaves it behind.
The built-in `original-fs` removes the owned tree successfully. The reviewed
consumer now uses physical filesystem operations for bundle checks and removal,
with no global ASAR switch or retry. Both original owned Mac jobs in
[CI 37871798972](https://github.com/juferdinand/OpenWhisper/actions/runs/37871798972)
pass Dev and stable ZIP roundtrips, all seven malformed-archive fixtures,
same-version refusal and original clean exits. Its API head is `f28b2583`; the
actual checkout/package producer is synthetic merge `7e30a4f7`. These thin
ad-hoc packages establish archive acceptance, with persistent publisher and
universal installation acceptance still outstanding.

The committed cleanup/signing/harness increment `6994e42` passes strict typing,
ordinary build and 1153 tests with 28 explicit skips in 17.83 seconds. Its thin
Mac persistent-validation signing mode is independently reviewed; actual
certificate/universal release signing remains outstanding. AppImage startup and
secondary activation/resource survival pass with a short private temporary base.
The earlier 125-byte Chromium socket path and restrictive font-cache mode check
are retained as diagnosed harness failures. The corrected full owned runtime
passes all 15 checks in 64.39 seconds: all five CLI command kinds and absent-owner
refusal, native X11 controls, real CPU recognition/clipboard/history, Retry/
Discard, edited-state restart, secondary resource survival and normal cleanup.
Both launcher/runtime/main chains exit normally, all observed PIDs are absent
and the extraction base is empty; actual cache mode is safely 0600. That
increment passes strict typing and 1153 default-suite tests in 17.88 seconds
with 28 explicit skips. Matching Mac ZIP execution subsequently passes as above.

The next source increment admits an AppImage launch only through the exact
permanent image and launcher, matching extracted layout, same-user live process
ancestry and original file identities. Startup/status reads preserve existing
autostart entries; explicit enable can retarget a recognized entry to the two
escaped permanent arguments. Focused admission tests use real owned files and
a mocked kernel boundary; a fresh package runtime must verify the new wiring.
The separate Mac V2 descriptor validates both architecture branches before
selecting the current runtime's V1 services. Thin/Linux V1 remains unchanged;
this is preparation for a universal package rather than proof of one. The
combined source passes strict typing, ordinary build and 1167 tests in 17.99
seconds, zero failures and 28 explicit skips.

Unsigned AppImage construction reuses the exact clean `b892d861` stable package.
The 119,441,912-byte image has SHA-256
`5307c99c5d8f603fbf8ed937d8688dc24181509163cdfc365552dd9bd5eb5069`;
passive extraction matches the payload/native descriptors, modes and notices.
The installed-launcher design creates private temporary storage before each
extract-and-run invocation, avoiding the upstream shared-directory cleanup race.
Owned application/control/restart acceptance passes with that exact old producer;
new permanent-path admission/autostart runtime and update wiring remain open. Raw overlapping
extract-and-run launches are outside this protected path.
Static runtime component notices are included, with LGPL corresponding-source/
relink obligations retained as a public distribution gate. Construction is not
signed-update or release acceptance. [Evidence](ELECTRON-DEV-EVIDENCE.md) keeps
the original failures and successful scopes separate.

## Delivery order and execution limits

Owner scope adjustment, 2026-10-08: finish the current genuine-X11 increment,
then defer expanded Linux desktop/special-input matrices to existing bug reports.
Basic dictation, controls and installation must work on both macOS and Linux.
Known basic-function failures still need correction. Prioritize the remaining
Mac composition and usable packages/update transition; keep untested desktop
claims and follow-up issues explicit instead of blocking on exhaustive coverage.
The original migration plan remains the architecture record; deferred coverage
is not a completed acceptance gate.

The complete 0.3.0 migration remains the objective. Deliver one runnable behavior
at a time. Regular KDE keyboard control is now checked against the owned stock
desktop, including active-binding Quit/crash recovery and insertion into native
Wayland and inner XWayland editors, with a separate genuine-X11 basic dictation pass. Reuse the
current desktop harness; do not build another general evidence framework.

Keep implementation and diagnosis rounds to about 30 minutes before reporting a
verified result or a concrete unresolved condition. End unproductive experiments
and continue independent migration work. Do not estimate overall completion as a
percentage. Run focused checks during development and the required full checks
once per completed increment. Reuse successful checks until relevant changes or
new failures justify repeating them. Observe the existing CI run rather than
dispatching replacements. Do not restart broad agent reviews; delegate only a
bounded task with a specific deliverable when it materially shortens delivery.

The measured bottleneck is implementation and fixture diagnosis, not normal test
execution: the current full unit suite takes about 18 seconds. Use
`npm run test:platform` and directly affected test files during development, then
one matching owned desktop scenario. Stock KDE no longer builds an unused synthetic
C++ portal. Its runner records command and total durations; the selected lifecycle
case passes in 10.58 seconds including assembly and cleanup. These measurements
do not imply that broader desktop or migration acceptance is complete.

Keep the installed stable application and the running Dev build unchanged until
the user accepts a replacement. Present runnable increments for acceptance before
merging functional changes.
