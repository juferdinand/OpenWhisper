# Owned Electron CPU utility probe

This opt-in fixture runs the compiled application transport and speech client in
Electron 44.7.0. It does not start capture or use a host desktop, microphone,
clipboard, account, or language model service. The renderer keeps its Chromium
sandbox. Electron's Node utility process is not an OS sandbox; the whole test
runs as UID 1000 in a private container with no devices, mounts, network, or
desktop session sockets.

From `app/`, after installing the locked dependencies and building the
application and the initial native CPU addon:

```bash
OPENWHISPER_PUBLIC_SPEECH_FIXTURES=/absolute/path/to/app/.local/speech-fixtures \
  node --import tsx tests/owned-speech/run.ts --output /absolute/path/to/new-evidence
```

The fixture directory must contain the checksum-pinned `ggml-tiny.bin` and
`jfk.f32` created by `node --import tsx scripts/fetch-speech-fixtures.ts`. The
default is `app/.local/speech-fixtures`. The output directory must not already exist.
Docker access is required. Ordinary `npm test` skips this runtime test unless
the owned launcher explicitly enables it.

The launcher freezes and hashes the current `dist`, verifies the public fixture
and native source/header archive checksums, provisions the pinned Ubuntu 22.04
base and Node 24.21.0, and copies inputs with `docker cp`. It never bind-mounts
host directories. The seccomp policy is the same reviewed namespace-scoped
policy as the owned UI fixture. The container is removed even after failure.
Official Ubuntu package resolution remains time dependent; its exact package
versions and the resulting image ID are retained. This is a reproducible test
procedure, not a claim of bit-identical future distro package builds.

The current `abi` phase deliberately requires an incompatible host-built addon
and proves its load failure is contained. It then builds the same checksum-pinned
whisper.cpp/Node-API 8 source graph as UID 1000 inside Ubuntu 22.04 and tests the
baseline addon in the actual utility process. If the initial addon is already
compatible with Ubuntu 22.04, the negative phase must fail rather than report a
fabricated ABI failure. Use an explicitly retained incompatible candidate for
this two-phase regression; the negative phase is not a production requirement.

The CPU phase verifies two complete public-fixture inferences in one helper,
native module isolation from the application main, categorical native failure
and replacement, wrong-family cache refusal with an unchanged original-family
reload, an actual helper crash, a stopped-helper watchdog followed by
Electron's owned-process force-reap, early cancellation, malformed-frame
rejection, and normal shutdown. Only the fixture signals its own verified helper
PID; the production transport uses `UtilityProcess.kill()` and waits for its
exit event. It never signals a raw PID.

The test executes freshly compiled production transport/client files, not
bundled substitutes: the TypeScript fixture is compiled by esbuild with those
two imports externalized to the frozen owned `dist` paths. Generated `.mjs` is
kept in the ignored evidence directory; application and fixture sources remain
strict TypeScript.

Results contain checks, process identities, version information, hashes,
renderer sandbox state, and screenshots. No helper request/reply, vocabulary,
audio samples, or transcript text is logged. This proves the CPU utility
boundary only. GPU, Parakeet, capture, recovery storage, and physical desktop
acceptance have separate gates.
