# Owned signed AppImage upgrade

This opt-in Linux x64 check starts the existing-key-signed 0.3.0 AppImage fixture,
uses the ordinary Update controls to install the signed 0.3.1 AppImage, observes the
real AppImage update transaction and fixed-launcher handoff, then quits the successor.
The older image has a private fixture-only `AppRun` that starts the same packaged ELF
with a test-owned host entry to provide an offline feed and download. The 0.3.1 image
keeps the factory production `AppRun`. This is an owned AppImage updater composition,
not a canonical 0.2.5 migration or public release acceptance.

Both payloads must be privately constructed from the exact versioned P29 Stable trees,
signed with the unchanged existing key, and accompanied by `signed-receipt.json`.
Candidate directories contain `OpenWhisper-Linux-x86_64.AppImage`, its `.sig`, and the
receipt. The runner checks each signature and version with the existing verifier before
copying the pair into an owned namespace.

Run from `electron/` as UID 1000 on Linux x64 after the pinned runtime and Node images,
Docker, seccomp profile, and existing signed image inputs are available:

```bash
node --import tsx tests/owned-appimage-upgrade/run.ts \
  --output /absolute/fresh/private-evidence-directory \
  --older /absolute/private-signed-images/0.3.0 \
  --newer /absolute/private-signed-images/0.3.1 \
  --verifier /home/juferdinand/Schreibtisch/WhisperFree/linux/target/debug/examples/verify-update
```

Pass the already-built native verifier; the runner does not rebuild Linux artifacts.

The container has no network, host mounts, desktop/audio sockets, input devices, GPU,
FUSE device, or real microphone. Its X11, session bus, and audio services are private.
No root installer is used. The test verifies old GUI/native-owner retirement, actual
source closure before exec, stable supervisor PID/start time, the 0.3.1 app and source
identity, saved preferences, normal quit, and namespace cleanup.
Pre-exec evidence records the closed source descriptor, absent staging directory, and old GUI/native PID absence at the exec boundary. A capped private log retains the owned predecessor's stdout and stderr for failure diagnosis.
