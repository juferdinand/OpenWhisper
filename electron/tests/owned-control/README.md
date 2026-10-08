# Owned Dev control acceptance

From `electron/`, after building the Dev app:

```sh
node --import tsx tests/owned-control/run.ts --output /absolute/new/evidence-directory
```

This opt-in launcher reuses the pinned Ubuntu 22.04 image/runtime recipe and
verified namespace policy. It copies frozen inputs into a disposable UID 1000
container, compiles the separate GDBus Node-API 8 addon and owned client, and
runs Electron 44.7 with the renderer sandbox enabled. No host mounts, devices,
network, session/display/audio/input/clipboard sockets or stable profile enter
the container. UID 1001 is a private fixture account. Tests skip without the
explicit owned launcher flag. The launcher confirms container removal.

The actual production platform transport opens no bus during readiness/status.
Only an explicit, validated initialization starts a private Dev control owner;
its capture capability remains unavailable. A separate utility fixture injects
a content-free fake capture port and exercises its acquisition/closure leases.
It does not open a microphone or prove desktop/audio parity.

Assertions cover unique Dev identity without production activation, foreign
UID refusal, no-reply Start refusal, caller loss and native expiry before
acceptance with late acquisition rollback, immediate CLI exit after receiving
an accepted reply, idempotent Start, concurrent action refusal, Stop after its
closure/sample fence, toggle/cancel and complete owner disposal. Pure tests also
delay the native acceptance Promise to prove that normal post-ack caller loss
does not undo a committed recording before NAPI completion reaches Node.

The native acceptance boundary is a method reply successfully queued while the
connection, observed unique caller and monotonic deadline remain current. It
does not claim the remote process received that reply. Invalidation/expiry and
send failure reject the Promise so the TS owner rolls back an uncommitted Start.
The timeout source is not the sole deadline check: native code rechecks the real
clock immediately before send. No transcript/audio or native payload is logged.

Separate owned no-display probes retain exact unmodified Electron binary/fuses,
entry-only, app-ready and ordinary Dev outcomes without RunAsNode overrides or
fuse changes. These are bootstrap feasibility evidence, not an implemented CLI.
The utility itself is not an OS sandbox; the container supplies outer isolation.
Actual distro portals/KDE/X11/wlroots, packages and bugs #21/#29/#30 remain separate.
