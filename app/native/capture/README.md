# Capture edge (staged Linux PulseAudio slice)

This Node-API8 addon has one private context/device/sample ledger per recording. It is loaded only
by the capture utility, independently of the disposable speech utility. The initial build enables
PulseAudio exclusively. CoreAudio, ALSA, hardware capture and Dev recording UI remain separate gates.

`scripts/build-capture.ts` checks the exact source archive/header/license pins before compilation,
uses the existing pinned Node headers, and copies the addon and complete notices into `dist/native`.
The library does not autospawn a server or fall back to a default device. Start needs a selected
Pulse source and explicit local Unix server. No initialization/enumeration happens on allocation.

The utility-local TypeScript wrapper exposes `NativeCaptureSession`:

- `start()` opens only the frozen selection; failed startup rolls back native device/context.
- `closeAndFence()` asynchronously stops/uninitializes backend activity before sealing the ledger.
  Stop-time backend errors and cached stream/context/source state are checked before intentional
  disconnect. It returns closure/fence/error metadata before duration-dependent conversion. Samples stay owned.
- `prepare()` asynchronously averages all input channels, validates finite samples, and converts
  the complete ledger to floor-rounded 16kHz mono with a fresh filtered miniaudio converter.
  Converter latency is removed and the last partial input is flushed. It can be retried from raw RAM.
- `readPreparedChunk()` moves one bounded chunk into utility-local JS RAM (at most 16,384 samples).
  It uses a Node-owned ArrayBuffer compatible with Electron's memory cage. It never sends audio to main.
- `release()` explicitly destroys retained raw/prepared data after confirmed delivery or discard.
  A prepared JavaScript chunk remains valid independently of native session teardown.

Samples are never overwritten and there is no fixed capture duration cutoff. Memory grows with
duration; allocation failure is categorical and retains already accepted chunks. Callback code
cannot call Node, perform file I/O, infer, or stop the backend. Per-session async operations reject
overlap; callbacks and notifications keep their exact native owner alive through backend teardown.
Synthetic `feed`/`feedHole`/`injectError` operate only on explicitly synthetic sessions and never open devices.
The explicit Pulse source enables upstream `PA_STREAM_DONT_MOVE`. Every accepted callback verifies
the selected source identity; terminal stream notifications, rerouting and read/drop errors mark
failure and block later fragments. A positive-length NULL Pulse fragment is a server-defined hole;
its exact duration is retained as bounded zero PCM, including partial tails. The exact upstream
header remains unmodified. A small read guard in the same pinned miniaudio translation unit reports
errors that upstream otherwise drops. Metadata carries fixed categorical failure kinds without
backend messages, source names or user content. Callback registration occurs before starting the
plain Pulse main loop used by this exact miniaudio revision; it is not a threaded-mainloop object.

Application Start/Stop/Cancel policy stays in the approved TypeScript coordinator. The capture
adapter serializes startup rollback and validates opaque handle identity/generation/attempt.
Start/close/release deadlines report failure while retaining the unresolved native owner. Cancellation
latches an atomic native startup abort; cleanup retries wait for the same pending operation.
Prepared chunks and recovery remain inside the capture utility; public control schemas are metadata
only. The main renderer remains unable to acquire an audio handle or submit samples through IPC.

Run pure checks with `npm run typecheck` and `npm test`. To include actual native synthetic conversion:

```bash
OPENWHISPER_CAPTURE_SYNTHETIC_ADDON=/absolute/path/openwhisper_capture.node npm exec tsx -- --test tests/capture.test.ts
```

`tests/owned-capture/run.ts /absolute/ignored/evidence/path` builds an isolated Ubuntu 22.04 runtime,
checks no mounts/devices/network, uses UID 1000 and a private bus/PipeWire/Pulse server, disables
hardware monitors and refuses unexpected sources before capture. It captures generated tones and
the checksum-pinned public JFK fixture for over 300 seconds, then verifies Stop fencing, complete
duration/tail conversion, source removal, partial retention and source recreation. It also attempts
a move to another owned virtual source and checks daemon-loss retention. The fixture never opens
the real microphone or inherits the user's desktop bus/socket. Container scope does not
establish macOS, ALSA, physical hardware, permissions, signing, packaging or release acceptance.

Linux private stopped WAV/RF64 ownership belongs to the separate TypeScript recovery service.
The addon writes no recordings/logs to disk. Mac recovery remains RAM-only when implemented.
An unconfirmed or hung native close must not be presented as successful; the capture process owns
the sole raw recording and must not be killed as an inference-timeout shortcut.
