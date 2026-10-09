# Owned normal Linux Dev recording

For the fresh clean `340dee3fb60cbf5abf6819553d9b575848919305` AppImage candidate,
append `--appimage-admission` after `--stable-package --appimage-bundle /absolute/bundle`.
The ordinary older AppImage mode retains its original b892 package pins and unavailable
admission expectation. The new mode checks the fresh construction receipt against the
exact reference package and producer, then uses that captured image hash throughout.
It seeds the native legacy autostart entry and preserves its bytes/inode/request on
startup and focus. The ordinary UI disables then enables it into the exact permanent
launcher-plus-image target. That generated target restarts the app; another disable,
normal restart and re-enable verifies retained state. Existing recording, CLI, secondary
resource survival and all original cleanup checks remain. No actual login session,
host installation, update authority or signed public-release acceptance is claimed.

This maintainer fixture exercises the normal main/preload/shared UI and recording utility,
not a replacement recording entry. It uses private generated Pulse audio and public pinned
Tiny/JFK fixtures, real CPU recognition, private clipboard readback, recovery Retry/Discard
and graceful cleanup. It never mounts a host display, microphone, session bus or stable profile.

First build the recording-enabled application:

```bash
cd electron
npm run build -- --recording
node --import tsx tests/owned-dev-recording/run.ts \
  --output /absolute/path/new-evidence-directory \
  --artifacts-root /absolute/path/retained-electron-acceptance-artifacts \
  --fixtures /absolute/path/public-tiny-jfk-fixtures
```

The output must not exist. This fixture reuses the checksum-verified Ubuntu 22.04 native
capture/CPU artifacts and build manifests from the retained source-enumeration/GPU build
packets, the retained pinned seccomp policy and the fixed owned image. It refuses changed
inputs; it does not provision or download them. The fixture directory contains `ggml-tiny.bin`
and `jfk.f32` from the existing public fixture fetcher. The artifact root follows the retained
packet layout recorded in `run.ts`; it is an explicit local input, never a user-specific path
embedded in source. General development needs none of these maintainer packets: use the
[normal Dev launcher](../../../docs/ELECTRON-DEVELOPMENT.md#linux-cpu-recording-dev-build).

Before execution, the fixture copies normal `dist`, substitutes only the accepted baseline
native bytes and compiles a typed captured descriptor. It freezes source/payload hashes and
checks the stopped-container roundtrip. Runtime never refreshes its expected native hashes.
The renderer stays sandboxed; the Node utilities are isolated by the private container.
The result and lifecycle receipts contain categorical metadata and hashes, not recorded text.
The runner also compiles a synthetic portal frontend using the existing pinned Ubuntu22
bus compiler image, before freezing the runtime payload. This fixture exercises actual
native D-Bus signatures, early replies, pending consent Cancel/retry, portal session/binding
loss, hold recording cleanup and portal Start/Stop through real recognition and delivery.
It sends synthetic portal signals; it does not press compositor keys or grant host access.
Original commands, processes and exact container cleanup are retained. Physical microphones,
stock KDE/GNOME dialogs and key delivery, automatic paste, hardware GPU, Mac recording and
release signing are separate gates.

Append `--native-x11` for actual X11 keys in the existing isolated Xvfb session.
This selection reuses the pinned Kubuntu image for its installed Xvfb, xdotool and
audio dependencies, but starts no KWin/KDE compositor or portal fixture. It copies
only the pinned Node runtime from the stopped compiler image; no synthetic portal
is compiled or signalled. The normal app explicitly selects `--ozone-platform=x11`
with no Wayland display. The normal UI starts native key capture, actual XTEST F8
press/release saves the legacy `x11_trigger` profile, and Escape preserves that
binding. Held/repeated F8 must own one capture; GUI Cancel followed by a later GUI
recording must survive the stale release. Later real F8 Start/Stop exercises the
public fixture, CPU recognition, clipboard/history and recovery removal. Remove
must release the grab so another real F8 does not start capture. The existing
Retry/Discard, sandbox, stable-sentinel and original process/container cleanup
checks remain. This is owned Xvfb evidence, not acceptance of a named X11 desktop,
physical keyboard, conflict handling across unrelated applications or packages.

For exact-directory package acceptance, append `--package-directory /absolute/path/OpenWhisper-Dev-Linux-x64`
after `--native-x11`. The runner copies that complete package intact and launches
its actual `openwhisper-dev --dev --dev-profile <private-profile>`, requiring
`app.getAppPath()` to equal the package's `resources/app`. Its captured descriptor,
production dependencies and native inputs are preserved; no fixture recapture or
native replacement occurs. Playwright remains outside the packaged app. Full
package hashes are checked before copying, in the stopped container and after
execution. The same native-X11 recording and cleanup checks apply. This proves
owned package execution, independently of host installation or signed releases.

For a stable-profile package use `--native-x11 --package-directory /absolute/path/OpenWhisper-Linux-x64 --stable-package`.
Append `--debian-package /absolute/path/matching-stable-package.deb` to select installation
inside the same disposable container at `/opt/openwhisper`. The archive's metadata,
control-only members, exact application bytes/modes, launcher, icon and license must match
the frozen package directory. Existing package/path conflicts refuse installation; missing
dependencies fail the normal unforced dpkg command. No apt or host installation is used. Only the
container's `dpkg --install` command runs as UID0, under the existing namespace restrictions.
The normal app, input/audio helpers and full recording/control case run as UID1000.

The installed variant seeds a private legacy autostart request of true with no existing
autostart entry. Ordinary startup and focus refresh must retain the stored request while
reporting actual disabled state without registration. The normal shared UI checkbox must
enable and disable the fixed private 0600 desktop entry beneath a 0700 directory. The existing
stable restart validates the generated single fixed Exec target independently, then executes
that exact installed target through the normal Playwright boundary with owned X11/CDP
instrumentation. This verifies the permanent executable and edited private profile, and
explicitly records `actualLoginSession: "NOT_TESTED"`; it does not exercise session-manager
login or desktop-launcher activation. The same full Retry/record/cancel/recognition/history/
discard/control assertions remain, with original legacy/model/Dev sentinels and archive,
source-directory and installed-tree checks. This mode is incompatible with `--install-package`.

Append `--install-package` as the final argument after that exact package path
to run the same recording case from a fresh installation inside the fixture's
private home. The source package's own executable runs its compiled
`dist/cli/install-dev.js` with `ELECTRON_RUN_AS_NODE=1`; installation does not
use system Node or launch another application. The installer receives a fresh
installation root, a fresh explicit profile and a fresh
`io.github.whisperfree.dev.desktop` under the owned data directory. The test
requires the profile to remain absent until normal profile preparation, then
checks that the relocated packaged app uses its installed executable and
`resources/app`. While that original app is idle, a second installation attempt
must refuse the existing destination without closing the app or changing its
executable, captured descriptor, launcher or stable sentinel. The normal X11,
recognition, clipboard, recovery and cleanup checks then run unchanged.
`result.json` labels this narrow installed-runtime evidence separately. Source,
copied, stopped-container and returned package hashes remain checked. This
owned fresh-copy case does not replace a host installation or prove downloads,
updates, data migration or release signatures.

Append `--stock-kde` to reuse `linux/scripts/run-owned-desktop.py` and the pinned
cached Kubuntu 24.04 portal image. This mode opens the normal app with native
Wayland and installed KDE portal services, never the synthetic frontend. It uses
no synthetic portal source or compiler execution. Only the verified Node runtime
is copied from a stopped image. The runner records each Docker command duration
and its total elapsed time in `launcher-result.json`.
QPainter and two Mesa rendering threads only for the nested desktop without GPU devices, and copies the same
verified Node runtime into the stopped payload. It starts the installed KGlobalAccel
daemon and selects the single nested-compositor surface from the private outer
display's actual window tree. After grabbing that owned virtual input, F8 setup
and dictation use outer-XTEST key edges through real KWin, never portal fixtures.
The current stock run also checks held F8, GUI Cancel, a later GUI recording and
safe stale release, followed by successful toggle dictation. It passes recognition,
clipboard/history, recovery, Remove and graceful Quit after removal. It records
cgroup counters and requires zero process-cap rejections while
keeping the 256-task limit. Before bounding rendering threads, the stock desktop
exhausted that cap and the speech helper died during startup. Those failures remain
retained. The portal still returns no assigned binding; KGlobalAccel supplies the
regular keyboard path. This is owned nested-compositor evidence, not physical
hardware coverage. Advanced triggers and automatic paste remain separate checks.

Use `--stock-kde-lifecycle` instead of `--stock-kde` for the narrowly selected
active-binding Quit and crash-recovery case. It opens the same normal application
three times with one private profile: Quit while F8 is bound, restart without
automatic binding, explicitly bind and SIGKILL only the original owned main,
then restart and explicitly recover a fresh working F8 binding. It reads actual
KGlobalAccel key availability and original D-Bus owner loss, observes all three
original main closes and finishes with Quit while the recovered binding is active.
This mode skips recognition/clipboard and labels its result accordingly. It
retains source/payload hashes, sandbox/resource and exact namespace cleanup checks.
See [the retained evidence](../../../docs/ELECTRON-DEV-EVIDENCE.md).

During platform development, run `npm run test:platform` for portal,
delivery receipt, preference and platform-channel regressions. Add the directly
affected test file to a focused invocation for changes outside that selection. Run one relevant
owned desktop mode after the focused checks pass. Reuse the built normal app and
verified native inputs while they remain unchanged. Build shared UI assets before
UI checks when their sources change. Run the full `npm test` once before handing
over a completed increment; repeat it only for relevant changes or new failures.
The focused command is development feedback, not full replacement acceptance.

Use `--stock-kde-paste` to select only native Wayland target delivery after F8
setup. The runner reuses the existing `test-owned-portals.py --typing-target`
helper verbatim and a compiled TypeScript KWin focus script. It exercises explicit
keyboard permission, actual F8 capture/CPU recognition and production Ctrl+V into
a separate GTK target. Require target == history == independent `wl-paste` bytes;
Electron's unfocused local cache is retained only as a diagnostic. The selected
case checks revoke, recovery removal, original Quit and resource/namespace cleanup.
It does not repeat Retry/Discard or prove dialogs or GNOME behavior.

Use `--stock-kde-xwayland-paste` for the same acceptance case with the separate
GTK editor on the private KWin-owned inner XWayland server. The normal app and
clipboard publisher stay on Wayland. Before starting the editor, the driver
checks the launcher-owned environment file, distinct inner display and socket,
actual Xwayland descendant of the private KWin bus owner, and authentication path.
This case proves the Wayland-to-XWayland delivery boundary on the pinned KDE
fixture; it does not establish standalone X11 desktop support.

Use `--stock-kde-overlay` to verify the normal app on the explicitly selected,
owned inner XWayland backend. The runner verifies the server before app launch;
outer XTEST still enters through the private KWin surface. The case checks sandboxed
overlay IPC, default/idle visibility, real F8 capture, one shared owner, actual pointer
Cancel, unchanged keyboard focus and original Quit. This does not select XWayland
globally. The failed native Wayland probe is retained: Electron's built-in inactive
show cannot preserve focus there, so that overlay path stays guarded pending the
separate native layer-shell requirement.

Use `--stock-kde-wayland-overlay` for the native Wayland surface case. This mode
passes the application's explicit `--experimental-wayland-overlay` switch.
Earlier runs failed the post-click Electron main-window focus check on the pinned
stock KWin desktop; Cancel itself and exact native pixel matching were verified,
while Stop/recognition was not reached. The revised case measures actual foreground
editor keyboard delivery, as described below. With KWin's dock role, case2 passes
all four markers, actual Cancel/Stop and recognition in 28.50 seconds. DockLayer
stacks below keep-above/fullscreen windows, which this case does not validate.
Normal Dev does not enable this prototype by default. This mode
does not enable inner XWayland or change the app's Wayland backend. The same
trusted, sandboxed overlay renderer stays offscreen; the owned GTK/layer-shell
utility paints its frames with keyboard mode NONE. The driver identifies that
original utility and its loaded libraries, reads the actual compositor output
bounds, and captures the verified outer KWin surface through Xlib using pinned
Koffi 3.3.2. These desktop PNGs include the native surface, rather than only the
offscreen renderer. Pointer coordinates combine the 360×64 bottom-centered
surface with the existing shared buttons' actual DOM bounds.

The case checks default-hidden and idle visibility, overlay preference refusal,
real F8/private capture and actual pointer Cancel. After configuring F8 and the
idle preference through the normal UI, it starts the same private native Wayland
GTK editor used by the paste case. The exact-caption KWin script focuses that
editor once. Fixed lowercase ASCII markers enter through the already grabbed
outer XTEST route before and after Cancel, and before and after Stop. No window
is refocused after either pointer action; the editor must receive the exact
cumulative bytes at its cursor. The main Electron window must be unfocused while
the editor is active, and the overlay must remain unfocused. A missing marker
fails this gate rather than substituting Electron's focus flag. The private text
file and bounded byte/hash receipts preserve the outcome without arbitrary text
in logs. The existing original-child ledger awaits editor cleanup.

A second public-fixture capture ends with actual native pointer Stop and CPU
recognition, independent Wayland clipboard/history readback and recovery removal.
The post-Stop marker follows the stopped capture fence and precedes waiting for
recognition. Only after all four keyboard gates may the case change the idle
preference through the main UI again.
Normal Quit must close the original app and leave the observed surface process
absent. Existing sandbox, private audio, task cap and exact namespace cleanup
guards remain unchanged. The runner copies the exact pinned Koffi package and
Linux native companion into the normal app before freezing the assembly.
