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
| Shared interface and services | Existing design, strict TS bridge, isolated Dev profile, settings, models and history | Tray and complete platform behaviors |
| Linux dictation | Normal UI, CPU recognition, clipboard, Retry/Discard and graceful Quit pass on private Ubuntu22 and stock Kubuntu/KDE 5.27 native Wayland with virtual audio | Startup-failure cleanup under resource pressure; global desktop control, paste, overlays and accelerated inference in normal Dev |
| macOS dictation | Normal CPU Dev recording, explicit permission button and RAM Retry/Discard are now connected; focused synthetic tests pass | Validate the assembled Mac build and physical permission/device behavior; add Metal selection |
| Linux desktop integration | Dev commands, portal sessions and explicit KDE keyboard setup share recording ownership. Stock KDE 5.27 native Wayland F8 capture, actual key-driven dictation, held-key/GUI cancellation, Remove, Quit with an active binding and same-profile crash recovery pass; its unassigned portal is bypassed by the existing KGlobalAccel protocol | GNOME validation, modifier-only/mouse and KDE/X11 triggers, packaged CLI, paste/overlays and wlroots replacement behavior |
| Optional model communication | Isolated manual local-model preview port exists | Complete the remaining agreed provider/workflow scope separately; ordinary dictation remains independent |
| Packaging and updates | Architecture and compatibility requirements documented | Electron AppImage/.deb/universal DMG+ZIP, signing, stable data continuity and actual old-client update checks |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

The current checkpoint includes actual stock KDE keyboard dictation, recovery
after a held-key/GUI cancellation sequence and same-profile crash recovery.
Explicit setup releases a dead KDE action before window key capture; normal Quit
also releases an active binding. Native terminal failures retain their
original failure; only verified stale owners permit safe reference cleanup.
Prior startup/pressure failures remain retained. It does not change the installed application or publish
a release. [Dev instructions](ELECTRON-DEVELOPMENT.md) explain the currently runnable
build; [automated evidence](ELECTRON-DEV-EVIDENCE.md) records its exact tested scope.

## Delivery order and execution limits

The complete 0.3.0 migration remains the objective. Deliver one runnable behavior
at a time. Regular KDE keyboard control is now checked against the owned stock
desktop; next verify its active-binding lifecycle, then insertion and ordinary desktop controls. Reuse the
current desktop harness; do not build another general evidence framework.

Keep implementation and diagnosis rounds to about 30 minutes before reporting a
verified result or a concrete unresolved condition. End unproductive experiments
and continue independent migration work. Do not estimate overall completion as a
percentage. Run focused checks during development and the required full checks
once per completed increment. Reuse successful checks until relevant changes or
new failures justify repeating them. Observe the existing CI run rather than
dispatching replacements. Do not restart broad agent reviews; delegate only a
bounded task with a specific deliverable when it materially shortens delivery.

Keep the installed stable application and the running Dev build unchanged until
the user accepts a replacement. Present runnable increments for acceptance before
merging functional changes.
