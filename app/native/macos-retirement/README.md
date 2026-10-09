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
Environment teardown can drain completion before this addon's cleanup hook;
the probe distinguishes that order from hook-flag suppression and checks that no
late JavaScript frame is delivered. An ambiguous descriptor close keeps the native
reservation and cleanup hook; the probe does not promise bounded shutdown for an
uninterruptible kernel call.

The separately labelled `createSynthetic()` hook is available only in this opt-in
probe artifact and on a non-main thread. It accepts no PID, UID or parent. Its held
operation runs no libproc query or kqueue allocation. The Node Worker fixture measures
the same ownership/cleanup machinery using this target-free barrier, not actual
kernel-query cancellation. Kernel operations require an Electron browser process
and `pthread_main_np()`; the TS resource loader additionally requires `isMainThread`.

The standalone probe passed seven cases and its continuous Worker cleanup checks
on both macOS15 architectures in run37731217799 at source2f0099f6, with deployment
metadata14.0. No natural zombie was observed in those cases. That exact retained
source/binary evidence is separate from the new production role below. A
deterministic zombie driver, real PID reuse, macOS 14 runtime, signed package loading
and production architecture/admission are separate gates. No existing factory or
workflow is modified by this source slice.

`NODE-HEADERS-LICENSE` is the complete upstream Node 24.21.0 notice snapshot, retained
verbatim with its hash in `node-header-license.json`. The build manifest records
before/after input hashes, SDK/compiler, Mach-O architecture/minOS and addon hash.

## Separate production source role

The default CMake build still selects only `openwhisper_macos_retirement_probe`.
The explicit `openwhisper_macos_retirement` target is excluded from that default
build and has its own `openwhisper_macos_retirement.node` basename. Both targets
compile the same asynchronous query/close/cleanup lifecycle. Exactly one of
`OPENWHISPER_RETIREMENT_PROBE` and `OPENWHISPER_RETIREMENT_PRODUCTION` is required.
The production role omits all synthetic/barrier/counter exports and exposes only
`create`, `bindCandidate`, `observe`, `close` and closed `abi` metadata. Module
initialization and kernel creation require an ordinary Electron browser/main
thread. The probe retains its GitHub/test guards and target-free Worker hook.

`services/macos-retirement-boundary.ts` adds challenge-free internal mechanics
for the continuing supervisor's two-challenge admission. It captures one opaque
native owner before asynchronous binding, retains valid non-running birth
identities, distinguishes watch-registration races from live unregistered
records, and waits accepted query work plus the same close promise. A disposal
receipt never proves the helper reaped; only zombie-inclusive absence or a
changed original birth does. Deadline/abort/close failures remain sticky.

This source role is not wired to a main factory or loader. ABI validation is not
artifact authentication. A future reviewed main initializer must capture actual
original-UtilityProcess launch facts and verify the fixed artifact/entry graph;
no renderer supplies this boundary. No production native build, actual Mac
supervisor composition, signed loading, macOS14 runtime, Metal or capture gate
has passed merely because this source exists. Historical probe evidence remains
separately scoped to its exact source and binary hashes.
