# Electron implementation status

Target version: **0.3.0**, replacing the existing Swift/Rust application hosts.
Implementation: [draft PR #34](https://github.com/juferdinand/OpenWhisper/pull/34),
tracked by [issue #33](https://github.com/juferdinand/OpenWhisper/issues/33).
The installed stable application is still 0.2.5.

Track completion by the functional milestones below. The full migration is still
incomplete; the table distinguishes runnable behavior from remaining replacement work.

| Area | Current result | Remaining work |
| --- | --- | --- |
| Plan and architecture | Reviewed plan, repository research answers and issue/PR review recorded | Keep decisions aligned with final implementation |
| Shared interface and services | Existing design, strict TS bridge, isolated Dev profile, settings, models/history and localized shared-owner tray actions; sandboxed recording overlay connected | Native tray presentation, assembled Mac overlay and remaining platform behaviors |
| Linux dictation | Normal UI, CPU recognition, clipboard, Retry/Discard and graceful Quit pass on private Ubuntu22 and stock Kubuntu/KDE 5.27 native Wayland with virtual audio; background Wayland publication and actual GTK target insertion also pass | Startup-failure cleanup under resource pressure; remaining desktop control, overlays and accelerated inference in normal Dev |
| macOS dictation | CPU recording, microphone permission, RAM Retry/Discard, shared tray/overlay and guarded Accessibility paste are connected. Actual Apple Silicon/Intel Dev apps pass startup, sandbox, signed production utilities, real CPU recognition of pinned public audio, keyboard setup/removal and original Quit in CI37842623817 | Physical microphone/TCC, actual target insertion and device changes; Metal selection remains open |
| Linux desktop integration | Stock KDE 5.27 native Wayland F8, cancellation, binding Quit/crash recovery and paste into Wayland/XWayland editors pass. The guarded native overlay passes pointer Cancel/Stop and foreground editor keyboard delivery. Genuine X11 native F8 capture, held/repeated keys, CPU dictation, clipboard/history and Retry/Discard pass in private Xvfb | Basic packaged controls remain required; expanded named-desktop, GNOME consent, wlroots, modifier/mouse, layout and overlay stacking coverage is deferred to follow-up tickets |
| Optional model communication | Isolated manual local-model preview port exists | Complete the remaining agreed provider/workflow scope separately; ordinary dictation remains independent |
| Packaging and updates | Ubuntu22-built Dev directory/.deb passes layout and exact-package X11 dictation/recovery/cleanup. Fresh local Dev installation through embedded Node passes the relocated Linux X11 dictation/recovery case in44.08s and actual signed Mac package/utility/shortcut checks on Apple Silicon and Intel in CI37840925558 | Archive download, existing-version replacement/upgrade, Electron AppImage/universal DMG+ZIP, release signing, stable data continuity and old-client update checks |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

Stable data groundwork now includes an independently reviewed fixed-identity
profile and pure Linux legacy converter. Existing model roots and permissions
are preserved; new Electron state uses private children. Conversion retains
settings, full source history and unsupported trigger profiles, and maps old
timestamped WAV names without losing UUID or chronological metadata. Eighteen
focused fixture tests and strict typing pass. Production store/bootstrap wiring,
filesystem migration and the Mac preference adapter remain required; ordinary
stable startup is not implemented by these helpers.

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
execution: the current full unit suite takes about 17 seconds. Use
`npm run test:platform` and directly affected test files during development, then
one matching owned desktop scenario. Stock KDE no longer builds an unused synthetic
C++ portal. Its runner records command and total durations; the selected lifecycle
case passes in 10.58 seconds including assembly and cleanup. These measurements
do not imply that broader desktop or migration acceptance is complete.

Keep the installed stable application and the running Dev build unchanged until
the user accepts a replacement. Present runnable increments for acceptance before
merging functional changes.
