# Owned Apple PCM acceptance

This fixture runs only with `OPENWHISPER_OWNED_MAC_CAPTURE_TEST=1` on an ordinary
user's GitHub-hosted Apple VM. It launches a private Electron main fixture and a
real utility process, loads the actual generated native addon only in that
utility, and selects synthetic PCM for every session. It creates no renderer,
AVAudioEngine, input node, permission request or device inventory. Its private
user/session/cache directories are disposable; captured audio remains in RAM.

After `npm run build` and `scripts/build-macos-capture.ts`:

```bash
OPENWHISPER_OWNED_MAC_CAPTURE_TEST=1 \
OPENWHISPER_MAC_CAPTURE_EVIDENCE="$PWD/.local/macos-capture-evidence" \
  node --import tsx --test tests/owned-macos-capture.test.ts
```

Nine cases check identity-rate exact bytes and a 17-frame final tail; stereo,
planar/interleaved and rate transitions; 14,640,017 input frames representing
305 seconds plus a tail; an accepted callback held across Stop; 50 cancellation
and generation races; queue allocation rollback/retry and copy allocation failure
with a retained prefix; interruption;
Start rollback; and Objective-C exception-raising stand-ins. Preparation is
compared sample-for-sample against a separate coalesced Apple full-stream
converter. A 0.000002 absolute numerical tolerance permits converter output-block
differences, not omitted samples. This is generated-duration evidence, not 305
seconds of wall-clock microphone recording.

The utility returns only schemas containing fixed names, counts, hashes and
categories. Native/JavaScript diagnostic reports, PCM and native exception text
are never retained. Main uses the in-memory Node loaded-object inventory and
keeps only the addon-present boolean, with environment/network report sections
disabled. Parent and helper waits are finite; the helper's generic exit event is
observed and owned process-group kill/disposal is attempted on timeout/exit
cleanup. Evidence records `helperExitObserved: true` and
`actualOSRetirementVerified: false`; this does not prove OS retirement or a
universal production backend-owner retirement guarantee.

The fixture explicitly permits unsigned libraries through Electron's Plugin
helper for its locally compiled development addon. It does not change production
helper signing, entitlements or `allowLoadingUnsignedLibraries` policy. Public
signed-helper load/TCC responsibility and real permission/device behavior remain
separate gates. An evidence destination must be an owned private directory under
this checkout's `electron/.local/`; only metadata, source/native provenance and
categorical failure artifacts are copied there.
