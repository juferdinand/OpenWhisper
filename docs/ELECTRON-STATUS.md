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
| Linux dictation | Normal Dev UI Start/Stop/Cancel, real CPU recognition, clipboard, Retry/Discard passed in an owned virtual-audio container | Global desktop control, paste, overlays and accelerated inference in normal Dev |
| macOS dictation | Normal CPU Dev recording, explicit permission button and RAM Retry/Discard are now connected; focused synthetic tests pass | Validate the assembled Mac build and physical permission/device behavior; add Metal selection |
| Linux desktop integration | Same-user Dev command control and GlobalShortcuts portal sessions share the actual recording owner; grant/cancel/revoke, toggle and hold edges have automated evidence | Stock KDE/GNOME portal validation, specialized KDE/X11 triggers, packaged CLI, paste/overlays and wlroots replacement behavior |
| Optional model communication | Isolated manual local-model preview port exists | Complete the remaining agreed provider/workflow scope separately; ordinary dictation remains independent |
| Packaging and updates | Architecture and compatibility requirements documented | Electron AppImage/.deb/universal DMG+ZIP, signing, stable data continuity and actual old-client update checks |
| Final replacement | Isolated branch and draft PR preserve the installed application | User acceptance, merge, remove obsolete Swift/Rust hosts/builds, release 0.3.0 |

The current increment connects Linux desktop shortcut setup to the ordinary Dev
host using the existing transport and runtime fixture. It does not change the installed application or publish
a release. [Dev instructions](ELECTRON-DEVELOPMENT.md) explain the currently runnable
build; [automated evidence](ELECTRON-DEV-EVIDENCE.md) records its exact tested scope.
