# Owned signed Debian GUI upgrade

This opt-in runner installs two genuinely versioned, existing-key-signed Stable
Debian packages in a disposable Ubuntu namespace. It drives the ordinary Update
controls, real packaged verification, real dpkg installation, installed audit,
native retirement and fixed-target exec. The successor must retain the original
supervisor PID/start time, report the newer version/source, preserve edited
preferences and quit with every observed app process absent.

Run from `app/`, as UID 1000 on Linux x64 with Docker and the pinned owned
runtime/Node images already available:

```bash
node --import tsx tests/owned-debian-upgrade/run.ts \
  --output /absolute/fresh-evidence-directory \
  --older /absolute/signed-older-candidate \
  --newer /absolute/signed-newer-candidate \
  --artifacts-root /absolute/owned-fixtures
```

Each candidate directory contains `OpenWhisper-Linux-x64/`, its canonical
`OpenWhisper-Linux-amd64.deb`, `.deb.sig` and `candidate-receipt.json` from the
existing candidate builder. Sources, versions, complete inventories and modes
must match their receipts. The newer source/version must differ. The fixture
root supplies the checksum-pinned `p2-owned-speech/run-4/electron-seccomp.json`.
The runner checks the image, Node and seccomp hashes before execution.

No host mounts, desktop/audio sockets, devices or external network are attached.
The app runs as UID 1000; only the owned namespace installer runs as root with
DAC_OVERRIDE to read the original private staged archive. No microphone opens.
Local feed/download fixtures intentionally exclude production HTTPS and Polkit.
This checks Electron-to-Electron Debian updates; it does not establish native
0.2.5, AppImage or macOS migration.

Private evidence records exact sources/payloads, original command closure,
installation, retirement, source closure, final exec guard, successor/UI results
and namespace cleanup. Both `result.json` and `launcher-result.json` must pass.
Failed attempts retain their evidence and cannot produce an acceptance result.
