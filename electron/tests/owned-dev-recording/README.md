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
Original commands, processes and exact container cleanup are retained. Physical microphones,
hotkeys, automatic paste, hardware GPU, Mac recording and release signing are separate gates.
