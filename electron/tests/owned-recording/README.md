# Owned Electron recording pipeline

This opt-in fixture runs the real coordinator, synthetic native ledger, private Linux WAV recovery, speech gate, adaptive processing, and recording-effects RPC in an Electron capture utility. Main brokers individual CPU inference windows to the existing packaged speech helper. All production imports resolve to the copied `dist/` modules; test authors write TypeScript and esbuild generates the fixture modules.

The test copies a fresh Dev distribution, a checksum-proven Ubuntu 22.04 CPU speech addon with its complete build manifest, the final synthetic capture addon, and public tiny/JFK fixtures into a private container. It never mounts a host directory, device, bus, audio server, or clipboard. Electron clipboard delivery uses only the fixture's private Xvfb display. Normal Dev UI recording remains disabled.

The first genuine adaptive window is intentionally passed as an offset view over a 16 MiB allocation. Worker RPC must normalize it to an exclusive zero-offset buffer before sending; main checks exact backing size for every received window. Direct malformed main-broker offset/overbacked frames must fail before creating a speech helper. The bounded copy preserves every sample hash.

Three helper epochs test failed delivery and preserved WAV, restored audio with capture creation prohibited, confirmed clipboard delivery with a deliberately dropped helper reply, and recovery-token receipt reuse in the same running main. Only the final confirmed retry removes the WAV. This does not claim exactly-once output across whole-app restarts. A fixture-only `[Music]` marker and canonical vocabulary/snippet prove cleaner → vocabulary → snippets processing and preserve literal multiline/Unicode expansion bytes. Only metadata and hashes enter evidence.

Run from `electron/` after a fresh reviewed `npm run build`:

```bash
node --import tsx tests/owned-recording/run.ts \
  --output /absolute/new/evidence-directory \
  --model /absolute/public/ggml-tiny.bin \
  --jfk /absolute/public/jfk.f32 \
  --baseline /absolute/p2-owned-speech/run-4 \
  --capture /absolute/native-capture \
  --speech-build /absolute/p6-proposal/gpu-build-1
```

The baseline contributes the previously reviewed sandbox policy; the new CPU build packet contributes the actual speech artifact and original graph. Current native implementation and source/header pins must match the build; build-tool refinements are recorded separately. Capture source must match its frozen manifest. The output records image/container constraints, source/artifact/distribution hashes, privacy boundaries, phase checkpoints, bounded command results, and confirmed container removal. Existing native capture packets remain unchanged.

Without `OPENWHISPER_OWNED_RECORDING_TEST=1`, the ordinary test suite skips this runtime test. The launcher sets that variable only inside its inspected owned container. Separate gates remain for physical/macOS capture, full desktop integration, signed packaging, and live recording UI wiring.
