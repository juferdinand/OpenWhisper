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
| Linux dictation | Normal UI, CPU recognition, clipboard, Retry/Discard and graceful Quit pass on private Ubuntu22 and stock Kubuntu/KDE 5.27 native Wayland with virtual audio; background Wayland publication and actual GTK target insertion also pass. The normal stable package passes migration, saved-WAV Retry, X11 dictation and restart in an owned profile | Startup-failure cleanup under resource pressure; remaining desktop control, overlays and accelerated inference |
| macOS dictation | CPU recording, microphone permission, RAM Retry/Discard, shared tray/overlay and guarded Accessibility paste are connected. Actual Apple Silicon/Intel Dev apps pass startup, sandbox, signed production utilities, real CPU recognition of pinned public audio, keyboard setup/removal and original Quit in CI37842623817 | Physical microphone/TCC, actual target insertion and device changes; Metal selection remains open |
| Linux desktop integration | Stock KDE 5.27 native Wayland F8, cancellation, binding Quit/crash recovery and paste into Wayland/XWayland editors pass. The guarded native overlay passes pointer Cancel/Stop and foreground editor keyboard delivery. Genuine X11 native F8 capture, held/repeated keys, CPU dictation, clipboard/history and Retry/Discard pass in private Xvfb, including the stable package | Stable command control; expanded named-desktop, GNOME consent, wlroots, modifier/mouse, layout and overlay stacking coverage is deferred to follow-up tickets |
| Optional model communication | Isolated manual local-model preview port exists | Complete the remaining agreed provider/workflow scope separately; ordinary dictation remains independent |
| Packaging and updates | Ubuntu22-built Dev directory/.deb and a freshly compiled unsigned stable Linux package pass exact-package X11 dictation/recovery/cleanup. Stable profile migration, saved-WAV Retry and restart pass in 47.29s. Fresh local Dev installation through embedded Node passes Linux X11 and Mac package checks on both architectures. Mac stable selection, archival plist migration and read-only native admission are implemented | Actual Mac migration/runtime acceptance, archive download, existing-version replacement/upgrade, Electron AppImage/universal DMG+ZIP, autostart, release signing and old-client update checks |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

Stable data services now accept resolved stable profiles while retaining Dev
restrictions. Existing safe models remain at their original locations and modes;
new downloads remain private. Pure Linux/Mac converters preserve source settings,
history and unsupported trigger details. The compiled Linux startup worker passes
an owned filesystem fixture: complete initial migration, production preferences/
model reads, actual saved-WAV recovery, repeat after settings edits, Discard without
replay, original-data preservation and partial-state refusal. Publication cannot
replace existing data, and audio copying uses bounded memory without a recording
duration limit. The same fixture also passes through a fresh Dev package's own
embedded Node. P27 now verifies a fresh stable Linux package's normal main/shared
UI: migration precedes private path/service setup, the saved WAV is retried through
the UI, CPU dictation confirms clipboard/history, and restart retains edits and
Discard without replay. Legacy originals, in-place models and the separate Dev
sentinel remain unchanged; no Dev control owner appears. Actual X11 WM_CLASS
matches `io.github.whisperfree`. The owned case passes in 47.29s with original
application/server closes and container removal confirmed.
The exact stable package also passes the embedded Node startup fixture; a fresh
default Dev package from the same frozen source passes the X11 regression in 43.22s.

The unsigned `.deb` remains `0.3.0~dev.58169b3a8cc1.modified`, preserving producer
58169b3a8cc167e7538f434e02f95fe437f46d68+modified. It opens the real stable profile;
the tested HOME/XDG roots were disposable. Current installations remain untouched.
The retained first attempt failed because saved-WAV recovery was invisible until
recording configuration; pre-UI worker configuration fixes that without opening a
capture stream. Autostart/updater, installation
transitions and release continuity remain open. P27 local source checks pass
1023 tests with 14 explicit skips and 62 shared UI tests; independent reviews pass.
Committed [CI37852647513](https://github.com/juferdinand/OpenWhisper/actions/runs/37852647513)
passes all six jobs for P27 at `40805be`.

The next Mac increment decodes binary/XML plist bytes with fixed CoreFoundation
APIs, preserves exact raw backups and unsupported native values, and publishes
private configuration exclusively. It checks that the old host is stopped and
that the preference-service snapshot agrees with the archival bytes. Completed
migration retains later edits without querying or replaying the old profile.
Stable bundle metadata/signature admission and factual login/hardware context are
connected before startup migration. Independent review passes; local typing,
build, compiled Linux regression and 1050 tests pass with 25 explicit skips.
Actual CF/AppKit/APFS behavior and the compiled Mac worker remain pending ARM/Intel
CI. The owned worker uses an empty OS preference domain and synthetic host facts;
it cannot establish a nonempty 0.2.5 cache or persistent-signature/login transition.
Ad-hoc thin stable packages are validation artifacts, not releases.

The current checkpoint includes actual stock KDE keyboard dictation, recovery
after a held-key/GUI cancellation sequence and same-profile crash recovery. Explicit
keyboard permission and F8 CPU dictation now insert into a separate owned native
Wayland or inner XWayland target with exact cross-client clipboard/history agreement. A TypeScript
adapter uses installed clipboard tools; no new C/C++ source is required.
Explicit setup releases a dead KDE action before window key capture; normal Quit
also releases an active binding. Native terminal failures retain their
original failure; only verified stale owners permit safe reference cleanup.
Prior startup/pressure failures remain retained. It does not change the installed application or publish
a release. [Dev instructions](ELECTRON-DEVELOPMENT.md) explain the currently runnable
build; [automated evidence](ELECTRON-DEV-EVIDENCE.md) records its exact tested scope.

The new native Wayland overlay probe failed focus retention, matching Electron's
documented inactive-show limitation. Its BrowserWindow path is guarded while
ordinary native Wayland dictation remains checked. The app is not globally forced
to XWayland. The full native layer-shell gate is still required; the explicit
XWayland overlay pass does not complete it.

A strict TypeScript GTK/layer-shell prototype now paints the same trusted Electron
overlay offscreen. A separate native GTK editor confirms that the previous normal
surface role really lost keyboard delivery after a click. Selecting KWin's dock
role fixes that case: all four keyboard markers before/after Cancel and Stop pass
without refocusing; actual native pixels, F8/private capture, CPU recognition,
independent clipboard/history and original cleanup pass in 28.50 seconds.
KWin stacks this role below active fullscreen and keep-above windows. That behavior
and other compositors remain unresolved, so the explicit
`--experimental-wayland-overlay` switch and main-control fallback remain.
The full L-OVERLAY gate stays open. CI at committed `de495e6` passes all six jobs;
that result does not validate subsequent uncommitted inputs or relabel older artifacts.

The genuine-X11 adapter uses the existing platform utility and strict TypeScript
Koffi calls, preserving the legacy keycode/keysym/modifiers/group profile separately
from KDE preferences. Native capture requires actual X11 focus ancestry. In private
Xvfb the server confirms the owned main window as its keyboard target while
Electron reports it unfocused. Initial keyboard mapping notices can now precede
the first captured candidate; later mapping changes still retire a captured or
active binding. The owned case passes real F8 setup, Escape preservation,
held/repeated keys, safe cancellation, CPU dictation, clipboard/history,
trigger removal, Retry/Discard and original cleanup in 40.99 seconds.
See the [exact evidence](ELECTRON-DEV-EVIDENCE.md). A separate private Ubuntu22
native build removes the first host preview's GLIBC2.43 dependency. Its actual
packaged executable passes the same X11 dictation/recovery checks in 41.78 seconds,
with its own resources/app, captured descriptor and native inputs unchanged.
Its frozen metadata remains de495e6+modified. This is owned package execution on
the pinned Kubuntu24.04 image; host installation, other distributions and signed
release acceptance remain separate.

## Delivery order and execution limits

The Mac regular-key adapter uses Electron globalShortcut and the same immutable
recording control leases. Explicit press/release setup, Escape/blur restoration,
conflicts, removal and shutdown have nine inert checks. The saved Mac accelerator
is host-owned and independent of Linux profiles; Dev startup does not bind it.
The shared UI explains toggle-only mode and disables hold selection.
Fn, modifier-only and mouse input are not implemented by this adapter. Strict
typing/build and 31 focused integration cases pass; the full unit suite has 929
passes and 14 explicit skips, and all 60 shared UI cases pass. Actual assembled
Mac shortcut/package execution now passes on [Apple Silicon](https://github.com/juferdinand/OpenWhisper/actions/runs/37830955196/job/113495848864)
and [Intel](https://github.com/juferdinand/OpenWhisper/actions/runs/37830955196/job/113495849495).
The owned VM input targets only the app's Chromium window; this does not establish
physical global-shortcut activation, microphone access, or insertion into another app.

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
