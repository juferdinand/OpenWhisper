# Isolated Electron development

The [migration plan](ELECTRON-MIGRATION.md) defines replacement and acceptance gates.
The first implementation slice starts **OpenWhisper Dev** with the existing settings UI,
a schema-validated sandboxed bridge and private settings/session directories. Recording,
global triggers, automatic paste, autostart and stable updates are unavailable in this slice.
It does not replace the released 0.2.5 application or establish desktop/speech parity.
The About view shows the Dev build's source commit and whether the checkout was modified;
the Models view exposes the selected private model directory.

## Build and run

Use Node.js 24–26 and npm. Install the locked shared UI dependencies, then the Electron
development dependencies and explicitly download the pinned Electron runtime:

```bash
cd shared/ui
npm ci
cd ../../electron
npm ci
npm run setup
npm run dev
```

The development launcher resolves the already installed pinned binary; launching does
not automatically download a missing runtime. `setup` uses the pinned package's official
download and checksum verification. Runtime/download override variables are removed.

The default Dev profile is `io.github.whisperfree.dev` beneath separate configuration,
data and cache bases. An explicit absolute private root can be selected:

```bash
npm run dev -- --dev-profile /absolute/private/path/openwhisper-dev
```

Existing Dev directories must be owned by the current user with mode `0700`; stored
preferences use `0600`. Stable storage, overlapping bases, symlink paths and unsafe
existing directories are refused. No stable preferences, models or recovery files are
imported automatically. Closing the last window quits this early preview so it stays
reachable without assuming a working tray host.

## Automated checks

```bash
cd electron
npm run typecheck
npm test
npm run build
cd ../shared/ui
npm run test:ui
```

The ordinary Electron tests do not launch a display or microphone. The explicit owned
UI launcher uses a separate container, UID 1000, private Xvfb and synthetic stable-data
sentinels. It exposes no host display, session bus, audio/input devices or stable profile;
Chromium sandboxing stays enabled. Its retained screenshots and runtime evidence cover
the Dev UI and bridge, not KDE/GNOME shortcuts, target-app paste or dictation.

After `npm run setup` and `npm run build`, run it on x86_64 Linux with Docker available:

```bash
cd electron
node --import tsx scripts/test-owned-ui.ts --output /absolute/path/new-evidence-directory
```

The evidence destination must not exist. The image recipe pins its base digest, core
runtime package versions and Node archive checksum; the launcher pins and retains the
upstream seccomp policy/license, selective namespace allowances and all tested input hashes.
It removes its test container after collecting evidence. Image provisioning runs as root
inside the container; the test application and display run as UID 1000 without capabilities.

The initial 2026-10-08 evidence includes 47 foundation unit tests, all 42 shared UI tests
for the existing macOS/Linux adapters, and a real Electron 44.7.0 Dev launch/restart in
the owned Debian 13 container. The runtime checks observed the renderer's Chromium
seccomp filter, nested PID namespace, zero effective capabilities and enabled sandbox;
validated the isolated preload, denied network/navigation/popups, preserved focused
fields and switch nodes, and checked EN/DE persistence, Dev build/profile identification
and unchanged synthetic stable settings/models/history/recovery/autostart files.
These checks cover P1. Native macOS permissions, Linux compositor adapters and complete
recording/recognition/package/update behavior remain unproven for Electron.

The native CPU probe is separate P2 work. It uses checksum-pinned whisper.cpp/Parakeet
source and Node-API headers, with a narrow compiled binding loaded only in a disposable
test process. GPU/native capture and packaged Electron worker parity remain separate gates.
Do not substitute this probe for a complete replacement or delete the existing hosts.
