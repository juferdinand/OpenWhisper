# Electron development evidence

This records the isolated implementation candidate on 2026-10-08, based on
`351041cece1f49bfc858ff1d8a9c2cbf4f2dfff2` with the following P2/P5 source changes.
These local checks preceded their commit; candidate CI is tracked in PR #34.
The base commit's CI does not cover these later changes.
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

This evidence does not close KDE/GNOME/X11/wlroots bugs, establish genuine Parakeet/GPU
inference, prove native capture/recovery storage, validate packages/updaters or establish
real model quality. Those remain explicit work in #33 and the linked issues. User acceptance
remains required before the functional migration is merged or the installed app is replaced.
