# Apple capture edge

This new development-only Node-API 8 addon places the AVAudioEngine/AVAudioConverter
framework calls in a dedicated utility. Recording policy, Stop acknowledgement,
delivery and recovery ownership remain in strict TypeScript. It contains no Swift
or Rust application host and is not wired to the development UI.

Each handle owns one fresh engine, notification observer, serial control queue,
callback acceptance gate and PCM ledger. Start checks existing microphone
authorization only; it never requests permission. Configuration interruptions and
native exceptions latch fixed failure categories. Stop removes the tap, attempts
engine Stop even after a removal exception, checks that the engine is no longer
running, and waits for all accepted callbacks before returning a fence. An
unconfirmed backend closure rejects while retaining that owner. Preparation then
converts the complete ordered ledger to bounded 16 kHz mono chunks, with explicit
end-of-stream drain at each input format transition and at the final tail.

Audio is held in utility RAM until explicit release. There is no recording cutoff,
WAV writer, audio path or Mac disk recovery. Converter/reference allocation errors
do not replace the previous complete ledger. Errors and diagnostics contain fixed
categories and counts, never audio, device names or native NSError descriptions.
The currently staged hardware tap accepts Float32 PCM at 8–192 kHz and 1–8
channels; unsupported formats fail explicitly. Device selection is the engine's
default input, not an explicit device lease. Same-format default-device changes,
the hardware executor/run-loop behavior, TCC/helper responsibility and public
signed-helper loading still require their own acceptance.

The separate synthetic mode creates only PCM buffers and converters. It does not
allocate AVAudioEngine, access its input node, query/request microphone permission
or enumerate devices. Fixed diagnostic counters are asserted by the owned native
fixture. Synthetic test hooks are rejected for a hardware handle. The independent
reference coalesces synthetic PCM and uses a separate full-stream Apple converter;
its bounded test-only coalescing is not a production recording limit.

Build on an Apple runner after the ordinary TypeScript distribution:

```bash
npm run build
node --import tsx scripts/build-macos-capture.ts
```

The build fixes architecture and macOS minimum version 14.0, verifies Mach-O
metadata, and retains compiler/SDK/source/artifact provenance. It uses the same
checksum-pinned Node headers as the other native addons, ARC, Foundation and
AVFoundation. The shared `../NODE-HEADERS-LICENSE` snapshot is preserved verbatim,
with its source and digest in `../node-header-license.json`; those are compile-time headers, not an embedded Node
runtime. Build success is separate from actual native load, converter tests,
macOS 14 runtime and physical permission/device acceptance.
