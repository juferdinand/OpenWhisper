# Owned Linux bus transport probe

This opt-in fixture proves the internal GDBus Node-API 8 transport in an actual
Electron 44.7 utility process. It does not establish desktop, capture, hotkey,
clipboard, overlay, permission or package parity. The utility itself is not an
OS sandbox; the disposable container provides the outer isolation. The existing
Dev renderer retains Chromium sandbox, context isolation and disabled Node API.

From `app/`, after the Dev app has been built:

```sh
node --import tsx tests/owned-bus/run.ts --output /absolute/new/evidence-directory
```

Run the launcher as an ordinary x86_64 Linux user with Docker. It provisions the
pinned Ubuntu22 base and checksum-pinned Node24 runtime, copies inputs with
`docker cp`, then compiles the addon and fixture as UID1000 against verified
Node24.21 headers. There are no host mounts, devices, network, display, input,
audio or bus sockets in the running container. Chromium sandbox remains enabled;
the narrow namespace seccomp policy is reused from the P1 owned UI fixture.
UID1001 is a fixture account created only inside this disposable image.

The private daemon has no service activation directories or systemd activation.
Its owned socket permits the second fixture UID so the exported Dev Control1
service can prove actual credential rejection. Native calls are pinned to unique
owners (or the bus daemon) with NoAutoStart; the fixture service also checks the
received message flag. Imported modules do not open a bus by default.

The probe covers exact numeric widths, dictionaries/variants/tuples, Unicode
preservation, direct native invalid-surrogate rejection, real FD receive/reflect/
consume and unused/malformed/pipe/oversize cleanup, cancellation/deadline,
subscription removal, owner replacement, fixed export/refusal/expiry, actual
UID1001 rejection, signal backpressure/oversize disposal, a full pending queue
with an unconsumed FD, confirmed close/reopen, and main-window responsiveness.
Idle daemon loss also invalidates the owner without another method call; a new
private daemon establishes a different transport generation.
FDs remain local holders in the utility; no raw descriptor is sent to main.

Evidence contains exact source/compiled/runtime/image hashes, complete package
versions, compiler/CMake flags, passive ELF dependencies/versions, installed GIO
copyright, private bus configuration, foreign-UID result, screenshot, sandbox
state and confirmed container removal. Native requests/replies and real user
text are never logged. Failures remain retained under their own run directory.
The acceptance test skips unless explicitly launched by the owned harness.

Before a production control adapter can open capture, it must subscribe to
unique-caller loss/abort, authorize the real UID, check the monotonic invocation
deadline after every await and at state reservation, and reject expired/lost
callers before device acquisition. Start must roll back its acquired capture if
reply acceptance fails or the caller/epoch becomes invalid. This transport probe
does not wire an actual capture action or replace those coordinator fences.

The internal API is `open(address, lifecycleCallback?)`, `call`, `cancel`,
`subscribe`, `unsubscribe`, fixed `exportControl`, `reply`, categorical `reject`,
local `readFd`/`closeFd`, and confirmed `close`. The TS facade provides exact
owner/UID lookup, generation fencing, monotonic `controlCurrent` and
`authorizeControl`, abort propagation and fail-closed disposal. Main/preload
must never expose this generic transport to renderer commands.
