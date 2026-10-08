# Owned normal Linux Dev recording

This maintainer fixture exercises the normal main/preload/shared UI and recording utility,
not a replacement recording entry. It uses private generated Pulse audio and public pinned
Tiny/JFK fixtures, real CPU recognition, private clipboard readback, recovery Retry/Discard
and graceful cleanup. It never mounts a host display, microphone, session bus or stable profile.

First build the recording-enabled application:

```bash
cd electron
npm run build -- --recording
node --import tsx tests/owned-dev-recording/run.ts \
  --output /absolute/path/new-evidence-directory \
  --artifacts-root /absolute/path/retained-electron-acceptance-artifacts \
  --fixtures /absolute/path/public-tiny-jfk-fixtures
```

The output must not exist. This fixture reuses the checksum-verified Ubuntu 22.04 native
capture/CPU artifacts and build manifests from the retained source-enumeration/GPU build
packets, the retained pinned seccomp policy and the fixed owned image. It refuses changed
inputs; it does not provision or download them. The fixture directory contains `ggml-tiny.bin`
and `jfk.f32` from the existing public fixture fetcher. The artifact root follows the retained
packet layout recorded in `run.ts`; it is an explicit local input, never a user-specific path
embedded in source. General development needs none of these maintainer packets: use the
[normal Dev launcher](../../../docs/ELECTRON-DEVELOPMENT.md#linux-cpu-recording-dev-build).

Before execution, the fixture copies normal `dist`, substitutes only the accepted baseline
native bytes and compiles a typed captured descriptor. It freezes source/payload hashes and
checks the stopped-container roundtrip. Runtime never refreshes its expected native hashes.
The renderer stays sandboxed; the Node utilities are isolated by the private container.
The result and lifecycle receipts contain categorical metadata and hashes, not recorded text.
The runner also compiles a synthetic portal frontend using the existing pinned Ubuntu22
bus compiler image, before freezing the runtime payload. This fixture exercises actual
native D-Bus signatures, early replies, pending consent Cancel/retry, portal session/binding
loss, hold recording cleanup and portal Start/Stop through real recognition and delivery.
It sends synthetic portal signals; it does not press compositor keys or grant host access.
Original commands, processes and exact container cleanup are retained. Physical microphones,
stock KDE/GNOME dialogs and key delivery, automatic paste, hardware GPU, Mac recording and
release signing are separate gates.

Append `--stock-kde` to reuse `linux/scripts/run-owned-desktop.py` and the pinned
cached Kubuntu 24.04 portal image. This mode opens the normal app with native
Wayland and installed KDE portal services, never the synthetic frontend. It uses
QPainter and two Mesa rendering threads only for the nested desktop without GPU devices, and copies the same
verified Node runtime into the stopped payload. It starts the installed KGlobalAccel
daemon and selects the single nested-compositor surface from the private outer
display's actual window tree. After grabbing that owned virtual input, F8 setup
and dictation use outer-XTEST key edges through real KWin, never portal fixtures.
The current stock run also checks held F8, GUI Cancel, a later GUI recording and
safe stale release, followed by successful toggle dictation. It passes recognition,
clipboard/history, recovery, Remove and graceful Quit after removal. It records
cgroup counters and requires zero process-cap rejections while
keeping the 256-task limit. Before bounding rendering threads, the stock desktop
exhausted that cap and the speech helper died during startup. Those failures remain
retained. The portal still returns no assigned binding; KGlobalAccel supplies the
regular keyboard path. This is owned nested-compositor evidence, not physical
hardware coverage. Active-binding Quit, crash recovery, advanced triggers and
automatic paste remain separate checks. See [the retained evidence](../../../docs/ELECTRON-DEV-EVIDENCE.md).
