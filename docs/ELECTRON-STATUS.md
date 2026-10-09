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
| Packaging and updates | Ubuntu22 .deb construction/runtime and AppImage construction pass. Fresh Dev installation and normal Mac stable runtime pass. Fixed-key Linux verification includes real files and actual Electron execution; actual Mac signature checks pass on Intel/Apple Silicon. Reviewed original-file staging, bounded download and Mac ZIP consumer are implemented | Actual new Mac ZIP runtime, AppImage launch/admission/autostart, installation/restart/rollback, persistent publisher continuity, authenticated Dev replacement, universal DMG+ZIP and release signing |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

## Current package checkpoint

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
signature requirement. The original ARM job in
[CI37868932078](https://github.com/juferdinand/OpenWhisper/actions/runs/37868932078)
and Intel job fail while cleaning the extraction child after archive admission;
both Stable smoke steps are skipped. Their producer is synthetic merge `b561cfe5` of head `9ac9ae9` into
`68294863`. The original log does not distinguish stage/child identity failure
from recursive removal or expose an errno. ZIP acceptance remains outstanding.
The next focused change adds closed phase/errno diagnostics and closes the
original ZIP descriptor even if extraction cleanup refuses, without changing
permissions or adding retries. Complete typing, ordinary build and
1149 default-suite cases pass in 17.87 seconds, with zero failures and 28 explicit
native or opt-in skips for the preceding committed increment. The reviewed
follow-up adds the explicit thin Mac persistent-validation signing mode and an
owned AppImage runtime harness. Strict typing, ordinary build and 1153 tests pass
with 28 explicit skips in 17.83 seconds. Actual AppImage runtime and the next Mac
ZIP cleanup diagnostic remain separate acceptance work.

Unsigned AppImage construction reuses the exact clean `b892d861` stable package.
The 119,441,912-byte image has SHA-256
`5307c99c5d8f603fbf8ed937d8688dc24181509163cdfc365552dd9bd5eb5069`;
passive extraction matches the payload/native descriptors, modes and notices.
The installed-launcher design creates private temporary storage before each
extract-and-run invocation, avoiding the upstream shared-directory cleanup race.
Actual application/control/restart acceptance and permanent-path admission remain
open; raw overlapping extract-and-run launches are outside this protected path.
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
