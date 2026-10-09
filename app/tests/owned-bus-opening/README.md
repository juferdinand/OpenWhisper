# Owned opening and callback retirement fixture

This is test source prepared for review. It has not been built or executed against
the changed native addon. It is separate from the application entry, utility
factory, CLI and preload. Importing `scenarios.ts` performs no native loading or
bus/socket work. `entry.ts` requires an explicit owned test flag, UID1000 and an
Electron utility parent before loading one fixed copied native artifact.

After source review, the proposed launcher uses the existing pinned Ubuntu22
owned-bus image/recipe, Node24.21 checksum-pinned headers and Electron44.7. Run
without host mounts, host devices, host PID/network/session or privileges. Preserve
the Chromium sandbox for the ready parent and discard utility stdout/stderr.
Compile the new addon inside that image; a host binary is not equivalent evidence.

The launcher must provide an empty-activation private EXTERNAL bus at
`unix:path=/tmp/openwhisper-owned-bus`, set `UV_THREADPOOL_SIZE=1` before runtime
startup, and send exactly `{version:1,id:UUID,command:"run",address}`. The utility
owns a second private Unix socket which intentionally does not answer authentication.
No microphone, desktop service, input action, transcript or audio is involved.

The scenarios check invalid/expired opening, cancellation during authentication,
duplicate pending close, readiness before the close certificate, failed opening's
retained UUID, expiry while queued behind one finite cryptographic fixture,
lifecycle/signal/export-holder closure and no callback after replacement. The last
case checks the new optional facade path and the unchanged default path together.
Queue and callback behavior must be reported exactly as observed; native finalizer
ordering is also a source-review obligation, not a public diagnostic API.

A separate fresh utility receives `command:"cleanup"`. It writes only owned PID/UID
metadata, starts close with a pending registration, and disposes its environment
without another JS turn. The parent checks the prepared marker and absence of a
successful-ack marker **after independently confirming that owned process is
non-running**. Generic Electron `exit` alone is insufficient; zombie/non-running
observation is not a claim of full OS reaping. The active entry/worker source must
remain frozen while copying.

The future launcher must bound readiness/execution and disposal separately, retain
failure evidence, and keep ownership after ambiguous disposal. It must also rerun
the existing owned-bus transport fixture with the new addon/facade, including FD
cleanup, ordinary worker loading and UID1001 refusal. No old artifact packet tests
these new source bytes. No desktop issue, capture parity, package or release gate
is closed by this fixture.
