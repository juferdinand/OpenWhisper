# Electron implementation status

Target version: **0.3.0**. [Draft PR #34](https://github.com/juferdinand/OpenWhisper/pull/34)
replaces the separate Swift/WebKit and Rust/Tauri hosts with the strict TypeScript app in
`app/`. [Issue #33](https://github.com/juferdinand/OpenWhisper/issues/33) retains the full
migration criteria. The latest public release and installed stable app remain **0.2.5**;
no candidate acceptance, merge, publication or live replacement is implied below.

## Functional milestones

| Area | Automated evidence | Remaining scope |
| --- | --- | --- |
| Application and interface | Typed IPC/preload, isolated Dev data, settings, models, history, vocabulary/snippets and current English/German UI; renderer 62/62 checks | Focused user acceptance of the assembled app |
| Linux dictation | Private virtual audio, CPU recognition, clipboard/history, Retry/Discard, control commands, installed autostart and permanent-target restart | Physical devices and accelerated inference are separate coverage |
| Linux desktops | Owned KDE 5.27 native Wayland keyboard binding, Quit/crash recovery and Wayland/XWayland editor insertion; genuine X11 keyboard/basic dictation | Expanded GNOME/wlroots, modifier/mouse, layout and overlay coverage stays in #21/#29/#30 |
| macOS dictation | Intel/Apple Silicon thin and Universal CPU/public-audio recognition, shortcut setup/removal, migrated edited-state restart and ordinary Quit | User microphone/TCC, target insertion, device changes and Metal selection |
| Linux updates | Genuine Electron 0.3.0 to private 0.3.1 Debian/AppImage GUI upgrades in offline owned containers; installation, fixed exec, preferences and normal cleanup | Production HTTPS/Polkit composition and final release artifacts |
| macOS updates | Persistent publisher continuity, running self/ZIP admission, actual same-identity install/relaunch, preserved preferences/migration files and normal successor Quit | Production HTTPS feed and final release artifacts |
| Legacy compatibility | Exact original 0.2.5 publisher/signature oracles; real Debian 0.2.5 to 0.3.0 installer component on one pinned baseline | This is not an original-app end-to-end GUI update or every-distro claim |
| Repository replacement | Feature folders, sole renderer/data tree, Electron CI/commands/version tooling; obsolete native hosts and Cargo manifests removed in this branch | Final revision checks, independent review and user acceptance before merge |
| Optional integrations | Isolated manual local-model preview and deterministic fixtures; ordinary dictation independent | Live LM Studio/Ollama/provider trials remain #11; Windows is #35 |

## Current package and update checkpoint

[Producer CI 37934542184](https://github.com/juferdinand/OpenWhisper/actions/runs/37934542184)
uses source `3f0734cb3105341a30c33120484a8de79183ae63`. Its common Mac/Ubuntu checks,
Intel/ARM native checks, Universal construction/runtime, signed Linux candidates and persistent
Mac publisher/self/ZIP admission pass. The publisher validates against the original 0.2.5
requirement and rejects a different publisher with the same bundle identity.

The original handoff installed and launched the correctly signed private successor, but its
inspector observation failed afterward. A bounded readiness correction selects the actual main
window, permits the known recording overlay, and preserves hard identity/state failures.
[Focused CI 37938340502](https://github.com/juferdinand/OpenWhisper/actions/runs/37938340502)
passes the full handoff with harness `a0e1affb9fe4abd4c62890a66ce35750a337511a` and the exact
retained packages from the producer above. Only preflight and handoff ran; every native/package
builder was skipped. Producer and harness commits are validated separately.

That passing test exercises the normal main update coordinator, native-owner retirement,
filesystem replacement and fixed-path relaunch of a persistent same-identity Universal 0.3.0
predecessor to a private **arm64 thin 0.3.1** successor on Apple Silicon. The original process
exits normally; recorded original PIDs disappear; the successor's source, version and state
match; preferences and migration files stay byte-identical. Normal successor Quit exits zero
and all recorded successor PIDs disappear. Feed/download are offline fixtures. This is not an
Intel successor, production HTTPS, original 0.2.5 app update, microphone or notarization test.

The Debian compatibility component installs the exact public signed 0.2.5 package, then the
source-bound 0.3.0 package with real `dpkg --install` in an owned, network-disabled Kubuntu 24
baseline. Both configured installations and `dpkg --audit` pass, without a dependency resolver
or forced dependencies. Package/desktop identity and the permanent compatibility launcher
match. A separate GUI diagnostic is inconclusive and supplies no GUI/state/Quit evidence;
the passing Electron GUI upgrade evidence above has a different, explicitly owned scope.

The Mac ZIP constructor now verifies extraction using the original updater's exact
`/usr/bin/tar -x -f ... -C ... --no-same-owner` invocation and fixed PATH, followed by the
existing strict signatures and full-tree comparison. Its focused checks pass; actual Darwin
execution of this final packaging change remains part of the final revision's CI.

## Checks and source organization

The final local retirement/quality increment passes **1,324 common tests** out of 1,372 total,
with zero failures and 48 explicit native/opt-in skips, in 20.84 seconds. Strict typing,
application/UI build and deterministic preflight pass. The focused packaging/source/publication
selection passes 32 checks with one Darwin-only skip, using unchanged public signed 0.2.5
Linux fixtures. Final-revision CI remains separate from these local checks.

`npm run preflight --prefix app` checks pinned actionlint/ShellCheck, strict TypeScript,
renderer formatting and whitespace. Use the PR base when checking a complete change:
`GITHUB_BASE_REF=main npm run preflight --prefix app`. Run focused tests while editing and one
complete common suite per finished increment. The release-staging correction additionally
rejects symlinked output parents before writing assets; its focused positive and refusal tests
pass with the existing signed fixture.

The app now groups core, contracts, services and ordinary tests by feature. Linux adapters
retain KDE/X11/shared ownership; `shared` means common Linux integration, not another UI.
Historical desktop/config fixtures are hash-pinned under `app/tests/fixtures/legacy-linux/`.
Original icons, multilingual vectors and required native/license inputs remain. Renovate keeps
npm, Actions and the pinned native-source manager; obsolete Cargo/GTK constraints are removed.

The requested bounded Luna quality audit found coherent feature/platform folders. Two useful
follow-ups in [#36](https://github.com/juferdinand/OpenWhisper/issues/36) are extracting cohesive
handlers from the large main startup function and extracting renderer tab views. These require
focused behavior-preserving increments; generic abstract-class hierarchies and arbitrary file
merges would add complexity. See [the cleanup plan](ELECTRON-MIGRATION.md#code-quality-and-final-repository-layout).

## Acceptance and publication

Complete the final revision's common/package checks and independent review, then provide the
user a concrete package and focused Mac capture/insertion checks. Preserve the running stable
app and protected Dev installation until explicit replacement approval. Linux acceptance uses
automated owned package/runtime checks and concrete bug reports; proactive physical-Linux
checks are waived.

Canonical Universal ZIP/DMG and Linux release/feed/checksum constructors exist. Actual final
release-mode construction, signing and artifact verification remain required before publication.
The existing identities and strict source/version/archive/signature rules must remain unchanged.
A source or oracle check does not establish an original-app download/install/relaunch. Production
feed reachability can be checked after publication without a circular prepublication requirement.

Expanded desktop/GPU coverage, Windows (#35), live providers (#11), TTS and structured Obsidian
are follow-up work. Model communication precedes TTS, which precedes structured Obsidian output.

## Historical evidence

The previous chronological migration diary is preserved at the immutable
[a0e1aff status snapshot](https://github.com/juferdinand/OpenWhisper/blob/a0e1affb9fe4abd4c62890a66ce35750a337511a/docs/ELECTRON-STATUS.md).
Detailed owned Dev evidence is preserved in the [immutable source snapshot](https://github.com/juferdinand/OpenWhisper/blob/122d68e4e029dbfebb8b9157ac53ab316687ebb8/docs/ELECTRON-DEV-EVIDENCE.md).
AppImage source/relink evidence includes an actual modified-libfuse runtime build and inert
image extraction/FUSE-free launch; that experiment did not build a production AppImage or
establish byte-identical/Alpine compatibility.

The published native hosts and their historical Linux record remain at the immutable
[0.2.5 source](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4).
Do not attribute old-host, synthetic, container or nested-desktop evidence to untested physical
hardware or other distributions.
