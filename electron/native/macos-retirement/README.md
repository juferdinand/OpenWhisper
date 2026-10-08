# Owned macOS retirement probe

This standalone probe is not loaded by production factories. Its build and runtime
require separate review. It uses public SDK `proc_bsdinfo`/`kevent` declarations,
Node-API 8, and the existing checksum-pinned Node headers. No private process-ID ABI,
signals, reaper, process launcher, audio framework, microphone, TCC or user data API
is exposed by the native edge.

The browser main thread creates an opaque owner before asynchronously binding its
trusted utility PID. Native acquisition records zombie-inclusive BSD snapshots
(`PROC_PIDTBSDINFO`, arg `1`), validates a NOTE_EXIT watch receipt and observed
close-on-exec, then records a second snapshot. TypeScript checks UID/direct parent,
birth, the fresh original-channel nonce/epoch and a final same-birth observation.
NOTE_EXIT and zombie mean non-running; neither opens the full-reap gate. Refusal,
short records, unknown errors and timeouts remain ambiguous. An absent/replaced
original identity is distinct from proof that all OS resources everywhere are freed.

Each owner permits one pending query. A deadline rejects promptly while the same
query and allocation remain owned. Close is idempotent and waits for that query;
the descriptor is never closed underneath it. The native asynchronous cleanup hook
keeps its shared owner alive through query completion and preallocated close work.
During environment teardown completion does not settle a JavaScript promise. An
ambiguous descriptor close keeps the native reservation and cleanup hook; the probe
does not promise bounded shutdown for an uninterruptible kernel call.

The separately labelled `createSynthetic()` hook is available only in this opt-in
probe artifact and on a non-main thread. It accepts no PID, UID or parent. Its held
operation runs no libproc query or kqueue allocation. The Node Worker fixture measures
the same ownership/cleanup machinery using this target-free barrier, not actual
kernel-query cancellation. Kernel operations require an Electron browser process
and `pthread_main_np()`; the TS resource loader additionally requires `isMainThread`.

The CI proposal covers macOS 15 arm64 and Intel with deployment metadata 14.0.
SDK availability, direct-child topology, natural zombie observations, async Worker
cleanup and native resource disposal remain unexecuted until those jobs run. A
deterministic zombie driver, real PID reuse, macOS 14 runtime, signed package loading
and production architecture/admission are separate gates. No existing factory or
workflow is modified by this source slice.

`NODE-HEADERS-LICENSE` is the complete upstream Node 24.21.0 notice snapshot, retained
verbatim with its hash in `node-header-license.json`. The build manifest records
before/after input hashes, SDK/compiler, Mach-O architecture/minOS and addon hash.
