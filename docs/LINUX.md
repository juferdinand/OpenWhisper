# Linux implementation and support

The Linux app in `linux/` is available as source and public AppImage / `.deb` releases.
CI also provides development packages.
A working build does not by itself establish support for
global shortcuts, text insertion, microphone devices, or every desktop environment.

## First target

The first acceptance target is **CachyOS x86_64 with KDE Plasma 6 on Wayland and PipeWire**.
The development machine has a Ryzen 5 5600X, 64 GB of RAM, and an NVIDIA RTX 3060.
On 2026-10-05, host inspection confirmed KDE Plasma 6.7.5, PipeWire 1.6.9, and version 2
of both the GlobalShortcuts and RemoteDesktop portals. The native settings window launched
on this machine, and Whisper Tiny / Parakeet v3 q4 each transcribed the pinned upstream JFK
fixture twice with one loaded context. On 2026-10-06, the full native capture pipeline was also exercised
with a private virtual microphone, including a 126-second recording, cancellation, silence, and clipboard output.
This avoids recording the real microphone during automated checks.
The settings and floating recording control use the same custom UI, settings navigation, bundled font, and original icon
as macOS. Tauri hosts these assets on Linux; WKWebView hosts them on macOS.

## Compatibility targets

| Distribution family | Desktop/session | Target | Current evidence |
|---|---|---|---|
| CachyOS | KDE Plasma 6 / Wayland | Primary acceptance system | Native UI, virtual-microphone capture beyond two minutes, floating stop/cancel, both CPU engines, clipboard, and AppImage launch verified |
| Arch Linux and derivatives | KDE Plasma 6 / Wayland | Same integration path | Stock Arch nested KWin: exact CI AppImage capture/recovery/install and native trigger leases pass; patched native real keyboard portal and Wayland/XWayland paste pass |
| Ubuntu 24.04 and Debian 13 | GNOME / Wayland | Portal integration, clipboard and configured-command fallback | Exact combined CI AppImage passes keyboard permission, native Wayland/inner-XWayland insertion, custom command shortcuts, local installation and reactivation on GNOME 46/48. GNOME 48 shortcut backend has a separately documented upstream response failure |
| Fedora KDE 43 | KDE Plasma 6 / Wayland | Native keys, portals, clipboard fallback | Owned stock KWin capture/recovery/install pass. Native keys pass; untouched stock keymap rejects mouse leases safely. Patched native real keyboard portal and Wayland/XWayland paste pass |
| Kubuntu / Ubuntu 24.04 LTS | KDE Plasma 5.27 / Wayland | Portal or Record-button fallback | Exact CI AppImage owned capture/recovery/install pass with stock Plasma 5.27 and private WirePlumber 0.4 policy. Unsupported native Plasma 6 trigger helpers reject before leasing; physical acceptance remains open |
| openSUSE Tumbleweed | KDE Plasma 6 / Wayland | Same integration path | Stock nested KWin: exact CI AppImage capture/recovery/install and native trigger leases pass; patched native real keyboard portal and Wayland/XWayland paste pass |
| Fedora 43 GNOME | GNOME / Wayland | Portals and main recording control | Exact combined CI AppImage passes actual shortcut Activate/Deactivate and hold edges, keyboard Cancel/retry/Share/Revoke, native Wayland/inner-XWayland insertion, local installation and reactivation on GNOME 49 |
| Debian 13 named desktops | Xfce, Cinnamon, MATE and KDE / X11 | Native keyboard triggers and explicit session paste; KDE adapter preferred | Actual owned named-desktop setup, toggle/hold, focused paste, conflicts, release/cleanup, persistence and capture pass on native source; physical and login-manager checks remain open |
| Arch compositor environments | Sway / Hyprland / Wayland | Explicit user-configured command bindings and clipboard | Sway 1.12 headless and Hyprland 0.56.2 owned QEMU guest command/capture/recognition/clipboard checks pass on native source; physical and exact package acceptance remain separate |
| Other architectures | ARM64 / 32-bit | Outside the initial release scope | No Linux packages yet |

Actual features depend on the desktop and its portal backend, not just the distribution name.
The app must report detected capabilities and any fallback it uses.
Portal detection reads each interface's actual `version` property; automatic paste also
requires the RemoteDesktop `AvailableDeviceTypes` keyboard bit. Session-bus connection
has a one-second deadline, followed by independent two-second interface deadlines.
Missing, invalid, or non-answering interfaces leave their permission actions unavailable.
These probes do not request a shortcut binding or keyboard permission.
Native KDE integration checks KWin, KGlobalAccel, Plasma version, the button-rebinding plugin,
and available utilities. It is not restricted to CachyOS. Other KDE distributions with those
capabilities use the same adapter. The owned matrix below records demonstrated behavior on
other KDE distributions; supervised physical acceptance remains separate. The [roadmap](ROADMAP.md#linux-desktop-acceptance) tracks KDE, GNOME, X11, and
other Wayland sessions independently.

## Wider KDE owned matrix, 2026-10-07

Fedora KDE 43, Arch, openSUSE Tumbleweed and Ubuntu 24.04's stock KDE packages were
provisioned in separate disposable x86_64 containers. KWin ran on a private Xvfb display;
apps and trigger helpers ran as an ordinary user. Each session had private HOME/XDG
paths, D-Bus, accessibility, PipeWire and virtual audio. Runtime containers had no network,
physical audio/graphics/input devices or host desktop sockets. Recognition used the pinned
public JFK fixture and Whisper Tiny on CPU. This is container and nested-compositor evidence.
It does not establish microphone, GPU, login-manager, physical shortcut or full-distro support.

The baseline is the unchanged Ubuntu 22.04 development AppImage from
[CI run 37651712074](https://github.com/juferdinand/OpenWhisper/actions/runs/37651712074),
artifact `11498575477`, test merge `0fc2093a39a3600d8fa20a50f8101a38136329f5`
(tree `b4fd84a5905a839fe6b5f4db71da45ec9356282d`). The AppImage SHA-256 is
`2f60cdec9034979546042bc005d9d4b6971598b062254d53c5b15738f7e41a7c`;
its native payload is `84786e3c4cca3f253d8ecccc55ea8b8e9ff1de9d2975ae7d1364cbe24da7216f`.
The corresponding `.deb` SHA-256 is
`e6c4430ac69d04bdbf0c128c147f7b46eda39a4652cb196cdeae9ac3fc1c976f`.
These unsigned CI artifacts are distinct from a signed public release.

| Owned stock environment | Baseline AppImage | Stock native triggers | Patched native portals / paste |
|---|---|---|---|
| Fedora KDE 43, KWin 6.7.5 | PASS | Keyboard and modifier-only toggle PASS; mouse helper rejects unsupported stock spare-key mapping before Ready or a lease | Actual Deny/retry/Approve/Revoke and insertion into focused GTK Wayland and inner XWayland targets PASS |
| Arch, KWin 6.7.5 | PASS | Nine regression groups PASS on the untouched stock keymap, including five mouse buttons | Actual Deny/retry/Approve/Revoke and Wayland/XWayland insertion PASS |
| openSUSE Tumbleweed, KWin 6.7.5 | PASS | Nine regression groups PASS on the untouched stock keymap, including five mouse buttons | Actual Deny/retry/Approve/Revoke and Wayland/XWayland insertion PASS |
| Ubuntu 24.04 / Kubuntu package set, KWin 5.27.11 | PASS | Plasma 6 native keyboard/modifier/mouse helpers reject before Ready or a lease; Record-button and clipboard fallback PASS | Actual legacy keyboard grant/revoke and Wayland/XWayland insertion PASS; unidentified owned host received no dialog, so identity-associated Deny remains open |

For each baseline AppImage, PASS includes native onboarding/English/German persistence,
GTK reactivation, a 126-second recording stopped or cancelled explicitly, floating controls,
CPAL capture, recognition, exact history/Wayland clipboard delivery, silence and failed-inference
WAV retention across restart followed by successful retry. The unchanged local installer also
passes actual GIO desktop launch/reactivation, enabling autostart to the permanent AppImage,
launching that generated entry, disabling it with `Hidden=true`, and retaining private history/models.
Launching an autostart entry is separate from testing a real login or logout.
The exact CI `.deb` also installs and removes successfully on Ubuntu 24.04. Its
native UI, short capture, recovery, German persistence and packaged identity pass;
removal preserves the private settings/history/model fixture. This Debian run used
a one-second duration check; Ubuntu's separate AppImage run establishes the 126-second case.
Container package management runs as container root; every app/helper runs as an ordinary user.

The Arch/openSUSE trigger groups cover keys, modifier release, mouse leases, existing conflicts,
later edits, EOF/SIGTERM cleanup, SIGKILL journal recovery, saved reconnection and changed layouts.
Held tests check modifier cleanup and reconnection; they do not prove that every compositor
clears a held synthetic surrogate key after helper death. That separate gap remains open.
Fedora's unsupported mouse result is kept separate from any modified synthetic keymap.

The real permission tests reproduce a baseline UI bug: after Deny, Allow stayed disabled
until navigation. Shared UI commit `0d723bb` corrects that busy-state rendering. The
independent patched native candidate SHA-256 is
`8a6bf09ddcb5c34c836927276224f050ccb1f0d5e6a9d772d4e08c4d3ce9148a`.
It passes actual KDE dialogs without persistent restoration, keyboard-session revocation,
and automatic Ctrl+V into separately owned Wayland/XWayland GTK text fields. Each insertion
must equal both saved history and the private clipboard; successful delivery removes its WAV.
These native source checks do not substitute for re-testing the eventual combined CI package.

Ubuntu 24.04 additionally passes actual keyboard-session grant/revoke and focused Wayland
and inner-XWayland insertion using native source `ad8cd4a`, binary SHA-256
`84fdbc4df046057e52f55967087108cc72b8f6691675acb82ee55dc615d2c914`
(maximum required GLIBC 2.39). The private-bus host receives an immediate grant without a
consent dialog. This is explicitly selected with `--permission-profile legacy-automatic`;
it does not establish Deny or a normal login-session application identity. The
[upstream Plasma 5.27 backend](https://raw.githubusercontent.com/KDE/xdg-desktop-portal-kde/Plasma/5.27/src/remotedesktop.cpp)
skips its dialog for an empty application ID; that is a source-based explanation of the
observed behavior, rather than proof of the identity assigned by this isolated frontend.
The harness supports KDE 5's actual script object and window APIs without changing the app.

Fedora and Arch's actual PlasmaShell and KDED StatusNotifierWatcher additionally render the native
candidate's tray icon. An owned compositor Close hides the settings window while the app
stays alive; actual rendered context-menu actions reopen the same window and Quit cleanly.
Virtual pointer events target that owned panel only. This checks real tray widgets and
protocols rather than substituting a test watcher. Minimal openSUSE container panel rendering
remains unresolved; physical tray/login acceptance remains open on every distribution.

A separate actual Fedora host-loss test exposed a no-tray Close defect in native source
`ad8cd4a`: after KDED and PlasmaShell stopped, the main window reopened, but closing it left
the process alive without an accessible window. Source `816a6d0` explicitly exits through
the normal Quit path when no tray host can reopen the app. Its retained CPU native binary,
SHA-256 `2c37ec272f9ccf9d46c567b17ffebe02cd6589dbfa811f9ce5bcc8fd8835bca9`,
passes the same real host-loss regression on Fedora, including Close while the recording
overlay and one private virtual capture stream are active: exit status 0, no app frames,
and no remaining capture streams. The same binary preserves actual rendered tray Show/Quit
on Arch. These native source checks remain separate from the combined package checks below.
Run `test-owned-kde-tray.py --host-loss` in the owned harness; adding
`--recording-model /path/to/ggml-tiny.bin` exercises the private recording variant.

The unchanged public 0.2.4 signed AppImage fixture also passes signature-verified installation
and removal on all four containers, preserving private data sentinels. That passive package
check does not execute or relabel the old public binary, exercise its updater, or establish
that the new development candidate has public release signatures.

The combined Ubuntu 22.04 development package from
[CI run 37678314536](https://github.com/juferdinand/OpenWhisper/actions/runs/37678314536),
artifact `11508384203`, source `816a6d0`, test merge
`e73b72fdf70abd4ed855c95d731e5c5e29e93740`, also passes bounded owned checks on all four
environments above. The exact AppImage SHA-256 is
`6afe2fbe3aa06a58baac24d263082f1657635ddca2884da8128a2559c72df284`;
its extracted native payload is
`7483aeeb21cb1688dbd082a77fac97def83f050ad6dfeae0f89a01275ef08e7f`.
Direct AppImage execution passes native UI, short virtual capture/Cancel/Stop, fixture
recognition/clipboard, persisted settings, failed-inference recovery, actual local
installation/GIO reactivation/autostart entry, and real Wayland plus inner-XWayland paste.
Fedora/Arch/openSUSE pass actual permission Deny/retry/Approve/Revoke; Ubuntu retains the
explicit legacy grant/revoke profile and its identity/denial limitation. The verified native
payload separately passes Fedora's actual tray-host loss and recording Close cleanup, and
Arch's rendered tray Show/Quit. Using the native payload for those PID-owned tray checks
is explicitly recorded; it is not a direct AppImage tray result. Final harness source is
`b3235f7`. The unchanged-duration 126-second evidence remains the earlier baseline result;
this final package run uses a one-second cancellation check and the full public speech fixture.
The corresponding `.deb`, SHA-256
`f5f1c82ecf6e677a045b7b1789eb0af53d67e0081b6e7905b07474e461cfc505`, also passes actual
offline APT installation, installed desktop-entry GIO reactivation/original icon, native UI,
short capture/recovery and removal retaining private settings/history/models on Ubuntu 24.04.
Its installed native SHA-256 is
`39226b31ed81c53189c0275d679529d0c8cf9f139d3e61fd37e23e630d2e34f2`.
All four KDE images provide system gtk-layer-shell. This AppImage does not contain that optional
library, so its positive overlay checks do not establish self-contained overlay portability;
explicit inclusion and fresh package acceptance remain required.

Private evidence, exact image IDs, package versions, input hashes and earlier failed fixture
attempts remain in `.local/planning/kde-distro-matrix/`. The reusable scripts are
`linux/scripts/test-owned-install.py`, `test-owned-kde-paste.py` and `test-owned-kde-tray.py`;
the latter two use the sibling real-portal ownership helpers. `run-owned-desktop.py --kde-xwayland` records KWin's owned inner display separately from the outer Xvfb display.
Paste tests verify that server's UID and compositor ancestry before selecting it.
WirePlumber 0.4 uses private no-device policy overrides; no hardware monitor is enabled.
Older AT-SPI's `push button` role is accepted without changing the session guards.

## Additional owned desktop source evidence, 2026-10-07

The following results use separately hashed development binaries, not the published 0.2.4
release. [PR #28](https://github.com/juferdinand/OpenWhisper/pull/28) combines the source changes;
its eventual CI packages require their own checks. All audio is the public upstream JFK
fixture played into a private virtual source, with Whisper Tiny and manual CPU selection.
Containers use ordinary app users, private configuration/session buses and software graphics,
without host display/audio/input sockets or physical devices. The Hyprland VM uses QEMU's
virtual keyboard and graphics devices, with no host device passthrough. Nothing here replaces
the running user installation or establishes physical microphone, GPU, login or signed-update
acceptance. Earlier failed runs remain separate from later passing corrections.

### GNOME

| Owned environment | Keyboard permission / paste | Shortcut path |
|---|---|---|
| Ubuntu 24.04, GNOME Shell 46.0 / Mutter 46.2 | Actual Cancel/retry/Approve/Revoke; focused native Wayland and inner-XWayland GTK insertion equal clipboard/history | GlobalShortcuts is unavailable; Record and explicit custom-command fallback remain usable |
| Debian 13, GNOME Shell/Mutter 48.7, portal backend 48.0 | Actual Cancel/retry/Approve/Revoke; focused native Wayland and inner-XWayland GTK insertion equal clipboard/history | Actual `gsd-media-keys` custom shortcuts invoking `--control toggle/start/stop` pass; portal binding response fails in this backend |
| Fedora 43, GNOME Shell 49.10 / Mutter 49.8, portal backend 49.0 | Actual Cancel/retry/Share/Revoke; focused native Wayland and inner-XWayland GTK insertion equal clipboard/history | Actual shortcut dialog Cancel/Add, Activate/Deactivate and hold press/release pass |

The earlier corrected portal/paste source is `ad8cd4a`; its native binary SHA-256 is
`84fdbc4df046057e52f55967087108cc72b8f6691675acb82ee55dc615d2c914`.
The final Fedora, Debian and Ubuntu portal/paste and custom-command checks use native binary SHA-256
`7778dda99bbe1c5a8045f4e19998dac62947624ea6b1a96e4ac6373649581c06`.
Permission cancellation no longer leaves Allow disabled. Failed shortcut and keyboard-session
setup explicitly closes the rejected portal session. Host registration uses the same cached
portal connection and stable application identity where the Registry interface exists;
older backends remain supported without pretending that registration grants permission.

The exact combined AppImage from [CI run 37678314536](https://github.com/juferdinand/OpenWhisper/actions/runs/37678314536),
artifact `11508384203`, source `816a6d0`, has SHA-256
`6afe2fbe3aa06a58baac24d263082f1657635ddca2884da8128a2559c72df284`;
its actual native process has SHA-256
`7483aeeb21cb1688dbd082a77fac97def83f050ad6dfeae0f89a01275ef08e7f`.
Direct AppImage execution passes 11 portal/shortcut/paste gates on GNOME 49 and nine
portal/fallback/paste gates each on GNOME 48 and 46. All three final portal runs use the
same test-only correction `3aa9554`, which waits for the actual Overview-hidden property
and verifies field activation through owned typing rather than cached accessibility focus.
Actual packaged custom `--control toggle/start/stop` bindings separately pass on both
GNOME 48 and 46. Local AppImage installation, original identity/icon, GIO reactivation of
that same native process, generated permanent-path autostart enable/launch/disable, and
retention of private data pass on all three. These checks launch the generated autostart
entry; they do not establish login-manager startup. GNOME's missing layer-shell protocol
keeps the main recording fallback usable regardless of the optional library's presence.
The packaging correction for that library requires fresh affected fallback checks.

GNOME 48's tested backend returns a failed binding response even when its Shell binding
exists. In the upstream `shell_grab_accelerators_done` success path, `response` is uninitialized;
[version 49 initializes it to zero](https://github.com/GNOME/xdg-desktop-portal-gnome/blob/0a3499e0e04f4f9b657bf404f9266dd23d03d2ae/src/globalshortcuts.c#L490).
This is consistent with the observed version-specific failure; OpenWhisper continues treating failed
responses as failures and closes the session. It does not bypass permission responses.
GNOME's missing layer-shell protocol keeps the main-window recording controls usable.
No-watcher Close/restart passes; host-loss recovery with a replacement test watcher is
recorded as synthetic tray evidence, separate from KDE's actual panel widgets.

`test-owned-portals.py` checks real dialog widgets, owned virtual input and exact target-field
delivery. Its environment guards remain mandatory. Raw local reports are under
`.local/planning/gnome-comprehensive/`; fixture focus failures and the GNOME 48 backend failure
are retained separately from passing runs. Normal login identity, real hardware and other
application paste bindings still require supervised checks.

### Named X11 desktops

The native fallback source is `086f419e4e640e7cab93c5f37bb392def2d5282a`, tested with CPU binary
SHA-256 `a616f2389ad04b32a68cad633353378fe58fa5d7a8be74300f5c06b926f895a8`
in Debian 13 image `sha256:352a1233bdca10f1644feee2589a8765d9f8f8009a85e2053ca458dbc7f49ce2`.
Genuine Xfce session 4.20.2 / Xfwm4 4.20.0, Cinnamon 6.4.10, MATE session 1.26.1 /
Marco 1.26.2 and KDE Plasma/KWin 6.3.6 run inside private Xvfb displays. Each passes actual
native keyboard capture, Escape/focus cancellation, toggle and physical-key release for hold,
public-fixture capture/recognition, focused GTK paste equal clipboard/history, explicit paste
revocation, saved trigger restart/removal, and shared onboarding/German/manual-CPU persistence.
KDE retains and prefers its own adapter. These are owned virtual key events, not physical keys.

The general X11 adapter uses conflict-preserving passive grabs and a disposable helper. It
rejects nonlocal displays, stops on keymap changes, preserves existing grabs and releases its
grabs on EOF/SIGTERM/SIGKILL. Held autorepeat, lock variants, AltGr, sticky/latched modifiers
and bounded startup are exercised. Native paste requires explicit session-only opt-in and
refuses unsafe modifier/focus combinations; portal and native paste permissions are exclusive.
An XWayland display inside Wayland does not enable this X11 adapter. Mouse capture is absent.

MATE's first generic UI smoke failed on a one-pixel integer layout metric despite no visible
overflow. The corrected smoke source `8aa721a` requires every visible child to remain inside
the content viewport and accepts only the precisely reproduced fractional-scale integer
rounding case. Seven browser checks still reject real overflow and disconnected navigation.
Actual MATE native smoke passes on corrected binary SHA-256
`c3155bfa1ca0009f696bdb2d1cd61eec4f064ddec192b91640e2064b71ab80e4`.
No application CSS or layout tolerance was changed. `test-x11-triggers.py` and
`test-x11-session.py` are reusable guarded harnesses; exact reports are under
`.local/planning/x11-desktop-acceptance/`. Login-manager sessions, physical tray/keyboards,
hardware audio/GPU and application-specific paste shortcuts remain open.

### Sway and Hyprland

The integrated native binary `7778dda9…` passes all eleven command-control checks in owned
Arch Sway 1.12 / wlroots 0.20: no-service/no-activation, content-free status, missing-model
rejection, idempotent and concurrent commands, immediate Stop acknowledgement, real F8 toggle
and F9 press/release, busy refusal while an owned helper is deliberately stalled, public-fixture
recognition and clipboard delivery, and preservation of the completed result.

Hyprland 0.56.2 / Aquamarine 0.15.1 runs in a disposable Arch QEMU guest with software Mesa
and a virtual GPU. All eleven control checks pass on corrected source `816a6d0`, native binary
SHA-256 `2c37ec272f9ccf9d46c567b17ffebe02cd6589dbfa811f9ce5bcc8fd8835bca9`.
Actual guest F8/F9 compositor bindings, capture, Stop acknowledgement, all four capture controls'
bounded busy responses, public-fixture recognition and clipboard delivery pass. The replay
took six minutes overall under CPU emulation with a 480-second recognition test deadline.
The original debug recognition run did not finish within its 90-second deadline; that failure
remains recorded separately. Exposing layer-shell or
virtual-keyboard protocols alone does not establish overlay focus or physical support.
The guest has no physical devices, and post-provisioning network access is disabled.

A separate owned Sway focus check uses the verified CI native payload
`7483aeeb21cb1688dbd082a77fac97def83f050ad6dfeae0f89a01275ef08e7f` as a detached ELF
with an explicitly installed system gtk-layer-shell 0.10.1. It passes an actual visible
floating Cancel after 126 seconds without changing the focused target; floating Stop
recognizes the public fixture, and history, private clipboard and actual manual Ctrl+V
in that target match exactly. Actual compositor Close exits cleanly when no tray host
can reopen the app, while the separate target remains alive. This is native runtime
and system-library evidence, not AppRun or self-contained AppImage evidence. The initial
library-free image could use main recording controls but had no visible overlay; the
combined CI AppImage's missing optional library is separately undergoing packaging correction.

The same focus/Stop/manual-paste/Close gates also pass in the owned Hyprland guest using
source `816a6d0` / CPU debug native `2c37ec27…` with system gtk-layer-shell 0.10.1. Its
cancellation interval is one second; the complete run takes about six minutes under CPU
emulation. This does not establish a 126-second Hyprland recording or combined-package
portability. The original five-second startup IPC timeout is retained separately; the
corrected fixture has bounded 20-second VM IPC calls and a bounded target-map wait.

`test-wlroots-focus.py` requires the private runner and validates its Wayland endpoint before
app/input actions. Its fixed-key `owned-wayland-keyboard.py` uses a standard virtual-keyboard
keymap for actual GTK clear/paste shortcuts, never physical input devices. Test focus and
Close are scoped to owned process/window identities. Earlier target-map, keyboard-map,
and bounded VM startup failures remain separate from later passing fixtures.

`test-compositor-control.py` keeps finite test deadlines, an explicit owned-session guard and
private virtual audio. Its optional recognition deadline accommodates CPU-emulated test VMs;
it does not change product inference limits or introduce a recording cutoff. See the
[command-binding examples](#compositor-command-bindings) and
[acceptance issue #7](https://github.com/juferdinand/OpenWhisper/issues/7).

## Implemented features

- Tauri 2 with the shared English custom interface and a Rust backend. macOS renders the same
  UI assets with a native Swift bridge while preserving its existing services.
- Text cleanup, vocabulary correction, and snippets pass the existing shared test vectors.
- Uses the shared model catalog and the same pinned whisper.cpp source for Whisper and Parakeet.
  Model contexts stay loaded and inference is serialized. Version 0.2.2 includes Vulkan GPU acceleration
  with a portable CPU fallback. Hardware coverage is listed below; 0.2.1 packages remain CPU-only.
- Captures the selected microphone locally and converts audio to 16 kHz mono. Keeps recordings in
  memory. Includes error handling, a silence threshold and cancellation before transcription, with
  no fixed recording duration limit. Stop or cancel explicitly when finished. Audio is held in RAM, so longer recordings use more memory. Microphone acceptance testing is still required.
- Version 0.2.4 isolates recognition in a speech helper process. Both model families use windows
  of at most 30 seconds, preferably split at pauses. Failed windows are retried at progressively
  smaller sizes down to one second, then on CPU if GPU was selected. Successful windows are not
  repeated during automatic retries. This bounds inference memory without limiting capture duration.
  Stopped recordings are atomically saved as private WAV files under `$XDG_CONFIG_HOME/whisperfree/recovery/`
  (normally `~/.config/whisperfree/recovery/`) before native inference. RF64 supports large backups.
  Successful clipboard delivery removes audio and the temporary transcript; failed recordings remain
  available through **Retry transcription** / **Discard saved recording**, including after restart.
  Capture still uses RAM; this does not protect audio before Stop, or promise success when neither
  backend has enough memory to load the model. Disk-write failures retain the stopped samples in RAM
  for retry while the app remains open.
- Wayland clipboard attempts use a three-second input/readiness deadline. A running
  `wl-copy` waiting for focus is reported as a failure, with the stopped WAV and transcript
  retained for retry or explicit discard. Copy actions run off the native UI thread. The
  helper's successful command completion is not proof against cancellation or another
  client replacing the selection; no previous clipboard is read or rolled back. Explicit
  Quit/update exit stops the owned clipboard helper, preserving the existing exit policy.
- KDE Plasma 6 supports direct keyboard capture, including single keys without Ctrl. On KDE
  Wayland, extra mouse buttons are supported; the middle button requires Plasma 6.3+. Saved
  bindings reconnect at startup. Other desktops use the GlobalShortcuts portal. Toggle and
  push-to-talk are supported; modifier-only KDE triggers use toggle mode. These direct bindings
  are available from 0.2.3; older packages keep the portal-only implementation.
- For automatic pasting on Wayland, request keyboard control through the RemoteDesktop portal.
  Request keyboard access only; do not request screen capture. Clipboard output remains available
  if permission is denied or the backend is unsupported. Do not require root or input-group access.
- When an actual tray host is registered, closing settings keeps tray controls available.
  Without a tray host, Close uses the explicit Quit path so a hidden recording window cannot
  strand the process. Losing a tray host reopens hidden settings. The Linux app uses an
  in-window recording control and the same floating recording UI as macOS. KDE and other
  layer-shell Wayland compositors use `gtk-layer-shell` with keyboard focus disabled; X11 uses
  a non-focusable floating window. Unsupported compositors keep the in-window control.
- Store configuration and models in the user's XDG directories. Do not migrate or delete existing
  files without a documented migration. Avoid logging dictated text or private audio.
- Public Linux packages remain a manual action after desktop acceptance,
  with package checksums and accurate support notes. Release builds use a separate persistent Linux
  signing key, verified with the embedded public key and signed package version before installation.

## Validation status

The update restart correction was checked on 2026-10-06 in isolated X11 sessions on CachyOS.
An unmodified public 0.2.1 AppImage installed the public 0.2.2 package but failed to relaunch under
a transient systemd user service with the default `ExitType=main` / `KillMode=control-group`.
An isolated build of the corrected source, carrying test version 0.2.1, then installed that same
signed public 0.2.2 package and relaunched successfully, both directly and under that service.
The installed file matched the public package byte for byte; German UI, completed setup, model
storage, snippets, and history fixtures survived. No real microphone or user data was used.
Unit tests also check that process replacement preserves the PID and literal arguments. The
native WebKitGTK smoke test passes with the event loop returning before process replacement.
These checks do not replace Debian installation acceptance or a physical Wayland shortcut test.

The 0.2.4 long-recording correction was checked on 2026-10-06 on the primary host.
Seven minutes of the public JFK fixture completed with Whisper Tiny and Parakeet v3 q4 on
both CPU and NVIDIA RTX 3060 Vulkan, including text from the end of the recording. Killing an
owned speech helper with SIGKILL during inference left the parent alive and automatic retry
completed the full recording. Native WebKitGTK checks in a private X11 session also verified
that an inference failure preserves a WAV and that restart/retry recovers it, saves history,
and removes the temporary audio after clipboard delivery. Rust tests cover shrinking windows,
CPU choice, exact sample coverage, process death/watchdogs, backup permissions, and RF64 headers.

Verified on the primary host:

- Shared multilingual processing vectors and 44.1 / 48 / 96 kHz resampling tests.
- TypeScript production build, Rust build, and Clippy without warnings.
- Native settings window on KDE Wayland with the NVIDIA compatibility workaround below.
- Floating recording indicator over other windows, including its stop and cancel controls.
- A 126-second uninterrupted CPAL recording through a private PipeWire/PulseAudio monitor source,
  explicitly cancelled after passing the old two-minute cutoff.
- Public speech fixture through native recording controls, CPAL, Whisper Tiny / Parakeet v3 q4,
  history, and the Wayland clipboard. Silent input does not add a history entry.
- Keyboard-only RemoteDesktop permission, GlobalShortcuts binding, and automatic insertion of
  the recognized public fixture into an owned native GTK Wayland text field.
- Real ALSA/PipeWire device enumeration and both version-2 portal interfaces.
- Whisper Tiny and Parakeet v3 q4 recognize the known JFK fixture twice per loaded context.
- The Linux PNG icon exactly matches the 256px image embedded in the macOS ICNS.
- Local installer, GTK application identity, and KDE taskbar desktop-file association.
- Ubuntu 22.04 CI `.deb` / AppImage builds, package checksums and launcher metadata; the downloaded
  AppImage also passes the native WebKitGTK UI smoke test and virtual-source recording,
  floating controls, Whisper recognition, silence, and clipboard checks on CachyOS.
- Shared UI tests cover both native adapters, every section in light/dark themes, minimum window
  size, original icon, bundled font, recording controls, and identical shared navigation rendering.
- macOS CI builds the universal app and verifies both settings and the non-activating recording
  panel in real WKWebView. This does not replace microphone/permission testing on a physical Mac.

Release 0.2.1 additionally passed its native UI/onboarding/language checks and virtual-source
recognition, floating controls, silence, and clipboard tests in an isolated X11 session on CachyOS.
The regular KDE desktop was locked during final verification, so this does not replace a fresh
KDE/Wayland permission check or physical microphone testing. The same source passed a 126-second
recording in that isolated session.

An updater-enabled test build carrying version 0.2.0 fetched the **public 0.2.1** release, verified it,
replaced its AppImage with the exact published SHA-256, and restarted successfully. German interface
language, dictation language, completed setup, snippets, history, and model storage survived; a second
check correctly reported the current version. This test build contained the new updater code: the
original public Linux 0.2.0 release still requires a manual first upgrade to 0.2.1.

Still required before calling a distribution fully supported:

- Actual microphone speech and device disconnect checks (virtual-source cancellation and silence pass).
- Permission denial, physical toggle / hold shortcut events, and session restart.
- Automatic insertion into XWayland apps and applications with nonstandard paste bindings.
- Installer, relaunch, tray behavior, and uninstall on each target distribution.
- AMD/Intel GPU validation and non-CachyOS desktop combinations.

### Owned acceptance evidence, 2026-10-07

These checks use private HOME/XDG directories, session and accessibility D-Bus buses, Xvfb,
and a PipeWire server running WirePlumber's policy-only profile. The harness refuses unexpected
audio sources before creating its virtual sink. Nested KWin uses the owned Xvfb display.
No host desktop sockets, physical microphone, live portal permission dialogs, user clipboard,
or user configuration are used. Container execution has networking disabled and no host devices
or desktop sockets mounted. This is synthetic, nested-compositor, and container evidence;
acceptance checks 3–7 and the broad desktop issues remain open for supervised physical testing.

The source baseline is `de9dbe962115aa41ac426a26ff70d94bc5e2dce7`, version **0.2.4**.
The Ubuntu 22.04 packages came from the successful
[CI run 37537458103](https://github.com/juferdinand/OpenWhisper/actions/runs/37537458103),
Linux job `112521985732`, artifact `11447809811`. CI checked out merge commit
`622582f8a4806e23eb3fd864c3e705099072e19f`; its tree and the baseline's tree are both
`7150a9bbff7358f559922116003613d568365631`. These are unsigned development artifacts,
not public release-signature acceptance. The archive digest reported by GitHub is
`sha256:1e207d27427e36bd8492d79f35787e8a0ea03ae776a3c64cd2aca21cdd196108`.

Recorded file SHA-256 values:

```text
4cb4c361c52f848cebfd3cfe3a65343f785b3a431f14a8fe8b163d1ac66d35bd  OpenWhisper_0.2.4_amd64.deb
79601d73326e8363d351a6c772a5b516b048f0705f64b606abc9014fe161247b  OpenWhisper_0.2.4_amd64.AppImage
d0c940a28e2166c99252b054794a56cc60259f2bd17cac31b29219a8a9e84a41  Debian-installed /usr/bin/openwhisper-desktop
ec1ff66435001e1b32f20f41df6c65232f057795a0d56caf871f4a01c7a20820  Local baseline openwhisper-desktop
be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21  Whisper Tiny model
aa7fe2f5fb47d863ca23e8b1d490632d63a2599f515268b6d6bd656158dad45e  Parakeet v3 q4 model
59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e  Pinned upstream samples/jfk.wav
```

The host versions were CachyOS x86_64, KWin / plasma-workspace `6.7.5-1.1`, PipeWire /
pipewire-pulse `1:1.6.9-1`, WirePlumber `0.5.18-1.1`, GTK `1:3.24.52-1.1`,
WebKitGTK `2.52.6-1`, AT-SPI `2.60.7-1.1`, PyGObject `3.56.3-1`, and D-Bus `1.16.2-1.1`.
The privately extracted Xvfb was `xorg-server-xvfb 21.1.24-1.1`, x86_64_v3;
its executable SHA-256 was `7d16a6e019ae16428663835b14e4e6a53c73eec605178129f0b0da62d41974cc`.
No system package installation was needed for that display server.

The Debian container base is pinned in `linux/tests/debian-package/Dockerfile` to
`debian:13-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f`.
The tested runtime had Debian 13, GTK `3.24.49-3`, WebKitGTK `2.54.0-1~deb13u2`,
PipeWire `1.4.2-1`, WirePlumber `0.5.8-2`, PyGObject `3.50.0-4+b1`,
D-Bus `1.16.2-2`, and Xvfb `2:21.1.16-1.3+deb13u4`.
The built acceptance image ID was
`sha256:471ebea3fd4d99aeb83547c18a8e148a5cf16bd91a951493ceaef30b75e6ab44`.

| Check | Status | Exact scope / local evidence directory |
|---|---|---|
| KDE keys, modifier release, mouse-button leases, conflicts, EOF/SIGTERM/SIGKILL cleanup | PASS | Owned nested KWin; `kde-triggers.log` |
| Local native WebKitGTK UI and GTK reactivation | PASS | Owned X11 and nested KWin; `x11-smoke-3`, `wayland-smoke` |
| 126-second capture, floating Cancel/Stop, fixture recognition, silence, history and clipboard | PASS | Local CPU Whisper Tiny; `x11-capture`, `wayland-capture` |
| Failed inference retains mode-0600 WAV unchanged across restart; retry delivers and removes it | PASS | Local CPU Whisper Tiny; `x11-recovery-2`, `wayland-recovery` |
| Parakeet capture, recognition, silence, clipboard and saved CPU preferences | PASS | Local CPU Parakeet v3 q4; `wayland-parakeet`; its duration check was one second |
| CI AppImage native WebKitGTK UI | PASS | Owned nested KWin; `appimage-wayland-smoke` |
| CI AppImage 126-second capture and inference-failure recovery | PASS | Owned nested KWin, CPU Whisper Tiny; `appimage-wayland-complete` |
| CI AppImage Parakeet capture/recovery and native onboarding/German persistence | PASS | Owned nested KWin, CPU Parakeet v3 q4; `appimage-parakeet-accepted`; its duration check was one second |
| Debian 13 APT installation, library resolution, packaged resources/identity and native WebKitGTK UI | PASS | Actual CI `.deb` in disposable container; `debian13-accepted` |
| Debian 13 126-second capture/recovery, native onboarding/German/CPU persistence and clipboard | PASS | Owned X11 in container, CPU Whisper Tiny; `debian13-accepted/capture` |
| Debian 13 package removal preserves private settings/history/model storage | PASS | Settings/history SHA-256 and model-link checks after APT removal; `debian13-accepted.log` |
| Live-session guards | PASS | Three unsafe combinations reject before desktop/audio tools; `isolation-guards.log` |
| Harness timeout cleanup | PASS | Expected exit 124; owned application groups disappeared and runtime was removed; `timeout-cleanup-check.log` |
| Harness interruption cleanup | PASS | SIGTERM/SIGINT during owned capture preserve exit 143/130; app/service groups and private runtime disappear; `harness-interruption-final.log` |
| Earlier harness attempts | FAIL, superseded | Stale AT-SPI objects after restart, shallow container script path, missing `at-spi2-core` / `libglib2.0-bin`, language switch's toggle-button role; corrected harnesses were rerun |
| GNOME, wlroots, target-distribution Wayland portals, signed update/restart and physical devices | SKIP | Not exercised by these owned checks |
| Full session login/autostart, tray acceptance, real shortcut/hold edges, portal denial, XWayland paste and target-field focus | MANUAL REQUIRED | Run the supervised checklist below; no desktop-support claim follows from the owned overlay's unfocused accessibility button |

Logs and host test data remain local under `.local/planning/overnight-linux-acceptance/`
and the printed `/tmp/openwhisper-desktop-test-*` paths; they are not committed.
Container logs and checksums are retained there, while its disposable `/tmp` data disappears
when the container exits. New harness runs also
write `run.json` with the command, UTC timestamps, session type and exit status.
The native app sources are unchanged by these acceptance harness changes. The baseline has
green Linux backend/Clippy/shared-UI CI evidence; the new guard test and Python/Bash syntax
checks exercise the changed scripts.

## Acceptance checks

1. Pass the shared multilingual text-processing cases and Linux backend tests.
2. Build on the primary host and a conservative Linux CI baseline using locked dependencies.
3. Launch the native app on KDE Wayland, enumerate the real microphone, and check permission flows.
4. Transcribe known audio with Whisper and Parakeet; then test an actual microphone recording.
5. Exercise start, stop, cancel, silence, and repeated dictations without reloading the model.
6. Check shortcuts, release events, clipboard output, and insertion into both a native Wayland app
   and an XWayland app. Explicitly test permission denial and unavailable portals.
7. Verify that recording and the overlay do not steal focus from the target text field.
8. Test installation, relaunch, persistence, and uninstall behavior before claiming distro support.

## Build from source

For packaged installation from a terminal, see
[README terminal installation](../README.md#install-from-the-linux-terminal). A source build is
not required to install a release `.deb` or AppImage.

Initial scope: x86_64 Linux with GTK 3, WebKitGTK 4.1, an ALSA-compatible microphone service,
and a graphical desktop session. PipeWire through its ALSA compatibility layer is the primary
path. The source build was checked with Rust 1.99.0 and Node 26; CI uses Rust 1.99.0 and Node 24.
Install Rust/Cargo, Node.js/npm, Python 3, a C++ compiler, CMake, pkg-config, and curl first.

CachyOS / Arch build and runtime dependencies:

```bash
sudo pacman -S --needed rust nodejs npm base-devel cmake python curl webkit2gtk-4.1 gtk3 libappindicator-gtk3 alsa-lib pipewire-alsa libxkbcommon gtk-layer-shell wayland-protocols binutils squashfs-tools wl-clipboard xclip vulkan-icd-loader shaderc
```

Ubuntu 22.04+ / Debian build dependencies (desktop validation is still pending):

```bash
sudo apt install build-essential cmake ninja-build pkg-config python3 curl libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libasound2-dev librsvg2-dev libssl-dev libxkbcommon-dev libgtk-layer-shell0 libvulkan-dev patchelf binutils squashfs-tools wl-clipboard xclip
python3 linux/scripts/build-glslc.py
export PATH="$PWD/linux/vendor/shaderc/bin:$PATH"
```

Install a current Rust toolchain and Node.js separately if the distribution packages are too old.
For Wayland shortcuts and automatic pasting, install `xdg-desktop-portal` and the backend for
your actual desktop, such as `xdg-desktop-portal-kde`. Merely installing a backend does not
establish that all its portal interfaces work in your session.

From the repository root:

```bash
make linux-test
make linux
make linux-install
```

The local installer needs no root access. It places the executable and licenses under
`~/.local/lib/whisperfree`, and an application launcher and the original Mac icon under
`$XDG_DATA_HOME` (default `~/.local/share`). Open OpenWhisper from your application launcher.

AppImage packaging explicitly stages `libgtk-layer-shell.so.0`: the overlay loads it at runtime,
so automatic ELF dependency discovery cannot include it. Both npm bundle commands run
`scripts/prepare-appimage.py` before Tauri. Staging checks the native architecture, library
version and installed Debian/Arch package ownership before retaining the matching copyright
and full license texts. Arch additionally needs `wayland-protocols` for its protocol notices;
an unrecognized library version requires updating the upstream notice snapshot first.
The library remains optional for native builds, and compositors without layer-shell keep the
main recording control.

Verify the finished image, including its actual ELF exports/build ID and notice bytes, with:

```bash
cd linux
python3 scripts/verify-appimage.py target/release/bundle/appimage/*.AppImage
```

This uses `readelf` and `unsquashfs` without launching the AppImage. CI performs the same check
before release signing; it requires `binutils` and `squashfs-tools`.

`make linux-run` runs the build directly. Builds made on a rolling distribution are not portable
binaries for older distributions; the CI package baseline is Ubuntu 22.04.

For development: run `bash linux/scripts/fetch-native.sh`, then `npm ci` and `npm run tauri dev` inside `linux/`. The host builds the shared UI from
`shared/ui/`; UI-only development and tests run in that shared directory. For the known-audio smoke test, install `ffmpeg` and run
`bash linux/scripts/test-recognition.sh`; this downloads the checksum-pinned Whisper Tiny model.
New packages and `make linux` include Vulkan. Install a Vulkan loader and a graphics driver with
Vulkan support (NVIDIA's driver, or the appropriate Mesa driver for AMD/Intel). Build dependencies
also include `glslc` and the Vulkan loader development library. Ubuntu 22.04 does not package
`glslc`; the commands above build it locally from checksum-pinned Shaderc sources and dependencies,
without changing the runtime distribution baseline. A recent distribution-provided `glslc` can
also be used. The build script downloads
checksum-pinned Khronos headers into `linux/vendor/vulkan`; it does not install system packages.
Use `make linux LINUX_FEATURES=custom-protocol` for a CPU-only development build.

In **General → Appearance & system**, **Use GPU acceleration when available** is on by default.
The detected GPU is shown there. Existing CPU-only installations migrate to automatic GPU use;
a deliberate CPU choice in the new version is preserved. No detected GPU uses the CPU, and
recoverable GPU loading/inference errors retry the same captured audio on the CPU. A defective
driver that terminates the process cannot be recovered in-process.

On 2026-10-06, Whisper Tiny and Parakeet v3 q4 both recognized the public JFK fixture twice using
the **Vulkan0 backend on an NVIDIA RTX 3060 (12 GB, driver 615.71.09)**. The same Vulkan-enabled
build also passed repeated Whisper recognition with Vulkan disabled. AMD and Intel GPUs and
other drivers still need hardware acceptance. The first GPU inference can take longer while
shaders compile; CPU work for audio conversion and other orchestration is still expected.

**Launch at login** is available on both platforms from 0.2.2. On Linux it manages
only this user's XDG autostart file. AppImages use their persistent installed path, not a temporary
extraction path. Moving an AppImage requires turning this setting off and on at its new location.
No administrator access is needed. Automatic launch after a full desktop logout/login still needs
manual acceptance; creation, disabling, path escaping, and native IPC are covered by tests.
The installed AppImage also passed enabling/disabling through the native settings UI and launching
its generated desktop entry in an isolated X11 session on CachyOS.

### Native desktop acceptance test

After building, quit the running app and run this inside the graphical KDE Wayland session:

```bash
bash linux/scripts/test-recognition.sh
python3 linux/scripts/test-session.py
```

The session test needs Python PyGObject/AT-SPI, `pactl`, `paplay`, `gdbus`, and `wl-paste`.
It checks launcher reactivation, then uses isolated temporary settings/model paths and a private virtual audio monitor, never
the physical microphone. The default 126-second capture checks the former two-minute cutoff;
it also checks floating stop/cancel, silence, fixture transcription, and clipboard output.
It replaces the clipboard with the public upstream speech fixture. Temporary logs remain at the
printed path; the test app and virtual audio sink are stopped when the test exits.

Use `--model /path/to/model.bin --model-id parakeet-v3-q4` to check Parakeet. Add `--portals`
to request keyboard permission, bind the shortcut, and check insertion into a private GTK test
field. This optional check requires `qdbus6`, KDE, and approval of any desktop permission dialogs;
its shortcut binding can persist in KDE's settings. Launch it with the correct app identity:

```bash
systemd-run --user --wait --pipe --collect --unit=app-io.github.whisperfree \
  python3 "$PWD/linux/scripts/test-session.py" --portals
```

Do not start a second instance while the test owns OpenWhisper's application ID. A recording
test with a virtual source proves the capture/inference/output path, not physical microphone quality.

### Owned unattended checks

`run-owned-desktop.py` needs Xvfb, D-Bus, PipeWire / pipewire-pulse, WirePlumber 0.5+,
`pactl`, PyGObject, and AT-SPI. `test-session.py` additionally needs `paplay`, `gdbus`,
and `xclip` for X11 or `wl-paste` for Wayland. Wayland modes need `kwin_wayland`,
`sway`, or `gnome-shell`/Mutter respectively.
Use a new output directory for each run:

```bash
python3 linux/tests/test-owned-session-guards.py
python3 linux/tests/test-owned-session-interruption.py
python3 linux/scripts/run-owned-desktop.py --session x11 \
  --output .local/acceptance-review-x11 -- \
  python3 linux/scripts/test-session.py --owned --recovery
python3 linux/scripts/run-owned-desktop.py --session kde-wayland \
  --output .local/acceptance-review-kwin -- \
  python3 linux/scripts/test-session.py --owned --recovery
python3 linux/scripts/run-owned-desktop.py --session sway \
  --output .local/acceptance-review-sway -- \
  python3 linux/scripts/test-session.py --owned --expect-no-portals
python3 linux/scripts/run-owned-desktop.py --session gnome-wayland \
  --output .local/acceptance-review-gnome -- \
  python3 linux/scripts/test-session.py --owned --expect-no-portals --expect-no-overlay \
    --expect-clipboard-unavailable
```

Sway uses its headless backend and pixman renderer without DRM or input devices.
GNOME runs nested inside the private Xvfb, with an additional empty private system bus.
Neither mode enables portal activation or reaches the user's desktop services.
The optional fallback assertions require `--owned`: they check unavailable portal notices
and disabled permission buttons, or the unsupported-overlay notice and main-window Stop/Cancel.
Normal output checks require exact clipboard equality, with a ten-second read deadline.
`--expect-clipboard-unavailable` is a separate negative fixture restricted to owned Wayland
sessions. It requires a clipboard timeout without a delivery claim, private WAV/text retention,
fully German errors, responsive History/Transcript Copy while the helper is pending, restart
recovery and explicit discard. It does not read the clipboard or exercise pasting, and cannot
be combined with `--recovery` or `--portals`.

The default duration remains 126 seconds. The session script handles SIGTERM so a harness
timeout still stops its separate application process group and unloads its virtual sink.
The harness handles SIGTERM/SIGINT within its cleanup scope, including during service startup,
and preserves exit 143/130 while stopping its owned services and removing the private runtime.
`--recovery` replaces only the test's private model
link with an invalid disposable model, verifies its retained WAV after restart, restores the
link and retries. Owned runs also complete onboarding through **Finish setup**, assert the
saved completion and manual CPU choice, select **Deutsch** through the native UI, and verify
German after restart. `--owned --portals` is rejected: permission acceptance requires supervision.
For a downloaded AppImage, prefix the harness command with `APPIMAGE_EXTRACT_AND_RUN=1` and
pass `--binary /path/to/OpenWhisper_0.2.4_amd64.AppImage` to `test-session.py`.
Add `--model /path/to/parakeet.bin --model-id parakeet-v3-q4` for the second model family.

On 2026-10-07, disposable Debian 13 checks used Sway `1.10.1-2`, wlroots
`0.18.2-3`, GNOME Shell `48.7-0+deb13u2`, Mutter `48.7-0+deb13u1`, PipeWire
`1.4.2-1`, and WirePlumber `0.5.8-2`. The PR #20 CI package from source
`03e69f5e6e64edd3b247a61e67ebd6b88721fd7f` passed native UI smoke checks in
both compositors and the Sway capture/clipboard path. Its `.deb` SHA-256 was
`71c73ce752deb1b3101c92b4379c09da4542b9dc204f5a8a2c49451369626df5`.
That unchanged package failed the GNOME absent-portal assertion: proxy construction
had incorrectly reported an unavailable shortcut service as available.

A local CPU/custom-protocol development build of the correction on main baseline
`46a6b82530bbd7927964332131319070674fe684` had executable SHA-256
`ea8ead599f89d07f24e9fa121feeff0d50296c28882d2a919fae980e3007a46c`.
Its owned Sway run passed explicit missing-portal notices, disabled permission actions,
private CPAL capture, floating Cancel/Stop, Whisper Tiny fixture recognition, silence,
history, Wayland clipboard equality, and German/CPU/onboarding persistence after restart.
Both Sway duration checks in this additional evidence used one second; they do not add
new long-recording or GPU evidence.

The corrected GNOME run passed the unavailable-overlay/portal notices, disabled actions,
main-window capture and cancellation, and fixture recognition/history. Clipboard output
did not complete, so the full pipeline and later persistence checks did not pass.
The owned Mutter registry advertised `wl_data_device_manager` without data-control;
`wl-paste`'s transparent-window fallback received no keyboard focus in the retained trace. Upstream
[documents this possible hang](https://github.com/bugaevc/wl-clipboard/blob/v2.2.1/data/wl-clipboard.1#L165-L171).
This no-input nested result does not establish clipboard behavior in a physical GNOME
session. [GNOME acceptance #5](https://github.com/juferdinand/OpenWhisper/issues/5)
and [Sway/Hyprland acceptance #7](https://github.com/juferdinand/OpenWhisper/issues/7)
remain open for their supervised checks. No portal permissions, physical microphone,
target-field paste, login/autostart, tray, signed-update, or Hyprland acceptance follows
from these owned results.

A separate clipboard-readiness correction based on main
`e0e27fa82938f359f6658b703bb1aca0b96a7f92` passed 57 Rust tests, Clippy,
frontend/assets checks and 30 shared UI tests. Ten private fake-helper tests cover
bounded writes/readiness, nonzero exits, redacted errors, large multibyte input,
unreaped-parent ownership, failed/successful replacement, descendant cleanup,
ordinary Drop versus explicit Quit cleanup, lost ownership and queued copies during shutdown.
Its disposable Debian 13 CPU development executable had SHA-256
`41d9b54e548ede25a24f6103b286f6091a699e28cfae2d30e53b287653644d86`.
Headless Sway still passed exact recognized-text/clipboard equality. The nested GNOME
no-focus negative fixture passed bounded failure without a delivery claim, complete German
errors, responsive native History and Transcript Copy during pending helper waits, private
WAV/text persistence across restart and explicit discard. The fixture deliberately disables
its private history to expose Transcript Copy. These are owned synthetic checks, not an
Ubuntu CI package or physical-desktop acceptance. [Clipboard issue #25](https://github.com/juferdinand/OpenWhisper/issues/25)
tracked this focused correction, merged in [PR #26](https://github.com/juferdinand/OpenWhisper/pull/26);
broad GNOME and Sway/Hyprland acceptance stays open.

The exact packages from [CI run 37651712074](https://github.com/juferdinand/OpenWhisper/actions/runs/37651712074),
source `c1d7e4612d5cda25bf66a99b74ab47fac0c035b9`, subsequently passed separate owned
Debian 13 runtime profiles on 2026-10-07. The Debian package SHA-256 is
`e6c4430ac69d04bdbf0c128c147f7b46eda39a4652cb196cdeae9ac3fc1c976f`;
its installed executable SHA-256 is
`f73bd3005fc5fe0a33d93a63b18b9c7234aaa568875bbc840d96b1fe30315806`.
Nested GNOME passed the complete no-focus negative flow above. The AppImage SHA-256 is
`2f60cdec9034979546042bc005d9d4b6971598b062254d53c5b15738f7e41a7c`;
it passed native UI and the unchanged strict Sway capture, cancellation, recognition,
clipboard equality, silence and setup/language/manual-CPU persistence checks.
The AppImage was launched with `APPIMAGE_EXTRACT_AND_RUN=1`, default runtime cleanup
and no host devices or desktop services. These checks do not establish every extracted
resource's lifetime or automatic removal of all extraction scratch. No physical desktop,
portal consent/pasting, actual model server or public signed update was exercised.

To reproduce Debian package acceptance without installing anything on the host, provide the
Ubuntu-built `.deb` with its verified checksum and the public fixture/model paths:

```bash
ow_package_test="$(mktemp -d /tmp/openwhisper-package-test-XXXXXX)"
mkdir "$ow_package_test/context" "$ow_package_test/evidence"
cp /path/to/OpenWhisper_0.2.4_amd64.deb "$ow_package_test/context/package.deb"
docker build -f linux/tests/debian-package/Dockerfile \
  -t openwhisper-debian13-acceptance "$ow_package_test/context"
docker run --rm --network none \
  --mount "type=bind,src=$PWD/linux/scripts,dst=/scripts,readonly" \
  --mount "type=bind,src=$PWD/linux/tests/debian-package/test.sh,dst=/test.sh,readonly" \
  --mount "type=bind,src=$PWD/linux/target/speech-smoke/ggml-tiny.bin,dst=/fixtures/ggml-tiny.bin,readonly" \
  --mount "type=bind,src=$PWD/linux/vendor/whisper.cpp/samples/jfk.wav,dst=/fixtures/jfk.wav,readonly" \
  --mount "type=bind,src=$ow_package_test/evidence,dst=/evidence" \
  openwhisper-debian13-acceptance bash /test.sh
```

The container installs the actual package through APT, runs native X11 UI/capture/recovery as
an unprivileged test user, removes the package, and verifies that private settings, history,
model storage and a sentinel survive. A container has no ordinary GNOME/KDE desktop session;
this cannot establish Debian desktop, portal, tray or physical-device support.

For morning acceptance, first review the retained logs and the branch diff. Then, on the actual
target desktop, perform checks 3–8 above with a supervised tester: physical speech and device
disconnect, toggle/hold and release, permission denial, native Wayland and XWayland targets,
focus preservation, tray close/reopen, and a full logout/login. Review German and completed
setup after relaunch. Keep the running installation until those functional changes are accepted.

### Long-recording and process-failure regression

After a Vulkan-enabled build, run the explicit file-based regression with downloaded models:

```bash
python3 linux/scripts/test-long-recognition.py \
  --tiny /path/to/ggml-tiny.bin \
  --parakeet /path/to/ggml-parakeet-tdt-0.6b-v3-q4_0.bin --gpu
```

This creates seven minutes of the public upstream speech fixture, transcribes it with both
families on CPU and GPU, checks the complete repeated text, and kills an owned speech helper
with SIGKILL to verify automatic recovery. Omit `--gpu` on CPU-only hosts. It uses private
temporary files and never opens the microphone, desktop, clipboard, or application data.

## First use

1. In **Models**, download a model and select **Use**.
2. In **General**, select the system default microphone and your usual language.
3. Click the recording control, speak, and click again. Inspect the result in **History**.
4. In **General**, click **Set trigger …**, then press and release a key or supported mouse button
   on KDE Plasma 6. X11 offers native keyboard capture; other desktops open their shortcut
   portal dialog when available.
5. For automatic insertion, choose **Allow** keyboard access and **Paste at the cursor**.
   This requests keyboard control only. No screen capture is requested.
6. Focus a text field in another app and try the shortcut. With clipboard output, paste manually.

On KDE Plasma 6, direct keyboard triggers do not require Ctrl or another modifier. A function
key such as F8 avoids reserving a letter used in normal typing. A single modifier (Ctrl, Alt,
Shift, or Super) activates on release and uses toggle mode; left/right variants are not
independently assignable. Reserved desktop shortcuts are rejected. Fn, DPI/profile buttons,
and vendor-specific mouse buttons work only if the hardware exposes them as supported input
events. Primary left/right clicks and scrolling are intentionally excluded.

On KDE Wayland, direct mouse capture supports Back, Forward, and other extra buttons;
Middle requires Plasma 6.3+. `kreadconfig6`, `kwriteconfig6`, and KWin's `buttonsrebind` plugin
must be available. The selected button is reserved for dictation while the app runs. Existing
KDE remappings are rejected rather than overwritten. OpenWhisper registers a free internal
function key (F19 or F24) and temporarily maps the chosen mouse button to it using KDE's configuration API.
Before registering a new mouse shortcut or changing its mapping, a separate, surface-free Wayland
connection checks the compositor's keyboard-map metadata. A candidate must emit its single symbol
without modifier or layout-changing actions, on the same first keycode in every layout, and be
available on every advertised keyboard seat. Missing, unsafe, or unverifiable metadata leaves
keyboard triggers and the Record button available. No input events are recorded and no user keymap
is changed. A subsequent keymap or keyboard-seat change stops the mouse helper and restores its lease.
A helper restores the mapping on normal exit or when the app crashes. Later user edits are
preserved. If the helper itself is forcibly killed (SIGKILL, including an entire process group),
its recovery file restores the mapping on the next app start; until then, remove that button's
mapping in KDE System Settings if necessary. **Remove trigger** also restores the normal binding.
No root, input-device access, or additional permission prompt is required for these KDE bindings.
KWin 6.3.6 does not emit a synthetic key release when its rebinding device is removed. Restoration
therefore does not prove that a surrogate held during teardown has cleared from compositor key/repeat
state. The app ends its hold-to-talk state when the helper fails, but this wider compositor limitation
remains open in [issue #21](https://github.com/juferdinand/OpenWhisper/issues/21). Release the mouse
button before changing its trigger or keyboard layout.

On X11, native keyboard setup supports toggle and hold/release; paste additionally requires
explicit session-only keyboard permission. Existing desktop shortcuts are preserved. The
native X11 adapter never runs merely because a Wayland session exposes XWayland.

**Desktop shortcut dialog** selects the portal alternative on KDE. Other Wayland desktops use it
when available; their recorder determines the accepted keys. Portal setup remains session-scoped and
must be enabled again after restart. OpenWhisper suggests Ctrl+Alt+Space but does not require
Ctrl. Direct mouse capture on GNOME, Sway, Hyprland, and X11 is not implemented.

If your desktop has neither native shortcut support nor a shortcut portal, use the Record
button or configure the compositor command bindings below. Clipboard output remains available. No root,
`input` group membership, `evdev`, or `uinput` access is required. The app never disables Wayland
security controls. Linux custom model import, clipboard restoration, text
editor output and start/stop sounds are not implemented yet. The floating indicator
requires `gtk-layer-shell` on a Wayland compositor supporting layer-shell; GNOME does not
provide that protocol. Its availability is shown in General.

## Compositor command bindings

When a Wayland compositor has no GlobalShortcuts portal, configure a binding to the
running app with `openwhisper-desktop --control toggle`. AppImage users should replace
`openwhisper-desktop` with the absolute path of their installed AppImage. Open the app
normally first; command control never activates it or opens audio if it is not running.
It uses the current user's session bus and does not change compositor configuration.

The allowed commands are `start`, `stop`, `toggle`, `cancel`, and `status`. Start, stop,
and cancel are idempotent. Stop ends capture and acknowledges the `transcribing` state;
recognition and clipboard delivery continue locally. Status returns only `status`,
`elapsed`, and `recovery_available`, with no transcript, audio, history, or preferences.
Requests fail while transcribing, installing an update, or assigning a trigger. Missing
models and pending recovery recordings still prevent a new recording. Cancel discards
only the current recording; it does not discard a saved recovery recording or a completed
transcript. No recording duration limit is introduced.

For Sway, use non-repeating bindings. The two alternatives below use different keys;
choose a free key or chord and preserve your existing desktop bindings:

```sway
# Toggle recording with F8.
bindsym --no-repeat F8 exec openwhisper-desktop --control toggle
# Hold F9 to record; releasing F9 stops capture.
bindsym --no-repeat F9 exec openwhisper-desktop --control start
bindsym --release F9 exec openwhisper-desktop --control stop
```

For Hyprland, ordinary `bind` does not request key repeat; `bindr` runs on release:

```ini
bind = , F8, exec, openwhisper-desktop --control toggle
bind = , F9, exec, openwhisper-desktop --control start
bindr = , F9, exec, openwhisper-desktop --control stop
```

Sway bindings were exercised in an owned headless Arch session using real compositor
key dispatch, a private virtual keyboard, virtual CPAL capture, the public JFK audio
fixture, and clipboard delivery. This is isolated compositor evidence, not physical
keyboard, GPU, signed-update, or login acceptance. Hyprland acceptance is tracked
separately in [issue #7](https://github.com/juferdinand/OpenWhisper/issues/7).

The reproducible command check requires an owned session:

```bash
python3 linux/scripts/run-owned-desktop.py --session sway --output /tmp/ow-sway-control -- \
  python3 linux/scripts/test-compositor-control.py \
  --binary /absolute/path/openwhisper-desktop \
  --model /absolute/path/ggml-tiny.bin --fixture /absolute/path/jfk.wav \
  --output /tmp/ow-sway-control-flow --sway-bindings
```

## Updates and first-run setup

From 0.2.1, release AppImages and Debian packages offer **About → Check now** and optional daily
checks. Installation is explicit. The updater requires an exact repository/tag/asset URL, a newer
X.Y.Z version, the embedded public key, and a matching cryptographically signed package version.
Tampered packages, foreign signatures, and replaying an old package as a newer version are rejected.

AppImages update in place and must be writable by the current user. Debian updates request system
authorization through `pkexec /usr/bin/dpkg --install`; a cancelled prompt is not retried using another
authentication mechanism. The Debian package name, version, and architecture are checked first.
The Debian authorization/install path still requires desktop acceptance on a Debian/Ubuntu machine.
Source/CI builds disable installation. Linux 0.2.0 users must install 0.2.1 manually once.
See [release signing](SIGNING.md#linux-update-signatures) for key continuity.

Use the sidebar to choose English or German independently of dictation language. Setup stays hidden
once completed and existing settings migrate as completed. Permissions and triggers are in General.
Updating the app preserves settings, models, snippets, and history; it does not rerun onboarding.
The Linux restart replaces the current process after native event-loop cleanup, keeping its PID
and any supervising AppImage parent alive. Spawning a child and exiting instead can cause a
systemd desktop service to stop the new process along with the old one.

## Data storage

- Models: `$XDG_DATA_HOME/whisperfree/models` (default `~/.local/share/whisperfree/models`).
- Preferences and snippets: `$XDG_CONFIG_HOME/whisperfree/settings.json`.
- Optional last 20 transcripts: `$XDG_CONFIG_HOME/whisperfree/history.json`.
  History is enabled by default, as on macOS. Turning it off clears saved history.
- Configuration defaults to `~/.config/whisperfree`. App-created directories use mode 0700;
  settings, history, and model downloads use mode 0600. Active capture remains in memory;
  stopped audio is privately saved under the configuration directory's `recovery/` folder.
  Unfinished recordings survive restart until successful clipboard delivery or explicit discard.
- Model downloads use HTTPS, validate the server’s SHA-256 and file size, and rename completed
  files atomically. The hash verifies transfer integrity; it does not independently authenticate
  the model publisher. Interrupted downloads do not replace an installed model.

Uninstall the local build by removing the app’s executable directory, desktop entry, and icon
listed above. Settings and models remain until you deliberately delete their separate directories.
If launch at login was enabled, also remove `~/.config/autostart/io.github.whisperfree.desktop`
(or the corresponding file below `$XDG_CONFIG_HOME`). Disabling it writes a `Hidden=true` override.

## Troubleshooting

Run `~/.local/lib/whisperfree/openwhisper-desktop --diagnose` to report the session, input devices,
portal versions, clipboard helper, and whether Vulkan was compiled in. It does not record audio
or print your settings, transcripts, or model contents. Device names can still be identifying;
review them before posting diagnostics publicly.

- **NVIDIA + Wayland startup failure:** WebKitGTK can fail with `Error 71 (Protocol error)`.
  On hosts with the NVIDIA kernel driver and a Wayland session, OpenWhisper sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` before GTK starts unless the user already set it.
  This changes UI rendering, not speech inference. It fixed startup on the primary host.
  See the [upstream WebKit report](https://bugs.webkit.org/show_bug.cgi?id=324551).
- **No microphone signal:** choose **System default**, then select the intended input in your
  desktop’s audio settings. On PipeWire systems, check that ALSA compatibility is installed.
  ALSA’s device list can include compatibility endpoints that are not physical microphones.
- **No global shortcut:** on KDE Plasma 6, set the trigger in **General**. Other desktops require
  the GlobalShortcuts portal; its initial suggestion is Ctrl+Alt+Space. Check for desktop conflicts.
- **Mouse button unavailable:** direct capture requires KDE Wayland and its configuration utilities.
  Buttons already remapped in KDE are rejected; hardware-only DPI/profile switches may not emit
  usable input events. Some distribution keymaps, including stock Debian 13's xkb-data 2.42,
  lack both safe internal symbols; use a keyboard trigger or the Record button. After forcibly killing both app and helper, start OpenWhisper again to
  recover its temporary mouse mapping.
- **No pasted text:** enable keyboard access in **General**, select paste output, and focus a text
  field. Targets with a different paste binding (including many terminals) may require manual paste.
- **Clipboard unavailable:** install `wl-clipboard` on Wayland or `xclip` on X11. You can also
  select text directly in **History**. Clipboard contents may be saved by your desktop’s clipboard manager.
- **No tray icon on GNOME:** support depends on the desktop's AppIndicator integration.
  Settings and its recording controls remain usable. Close quits when no tray host is registered;
  losing a registered host reopens hidden settings. Creating an AppIndicator alone does not prove
  the desktop displays it.

## Known dependency risk

The GTK 3 dependency chain includes an open `glib` advisory. See the
[security policy](../SECURITY.md#known-linux-dependency-advisory) for the affected code, review scope,
and upstream constraint. Release publication does not mean the dependency graph is free of advisories.

## Packaging and release policy

CI on `main` builds development `.deb` and AppImage packages and retains artifacts for 14 days.
A main push does not change the version, create a tag, or publish a GitHub Release.
The manual Release workflow applies the requested version to both platform builds and runs them
in parallel. CI and Release call the same reusable Linux build workflow. After both platforms pass,
a publication job creates the version commit/tag, verifies both artifact checksum files, and uploads
all packages with combined checksums. There is no separate CI dispatch or manual Linux attachment.
The complete release is a draft by default so its AppImage can receive desktop acceptance before
publication. Public downloads use the stable asset names
`OpenWhisper-Linux-x86_64.AppImage` and `OpenWhisper-Linux-amd64.deb`; their internal version still
matches the tag. `SHA256SUMS` covers both Linux packages, signatures, update feed, and the macOS DMG/ZIP.
Publishing Linux packages does not establish support for untested distributions.

Both platforms currently share a version and public release. A platform-only fix can ship in the
next joint patch release; the other platform still receives the same version and shared UI.
Linux-only releases are technically possible, but require platform-aware update discovery first:
the macOS updater currently expects its ZIP in GitHub's latest release. Publishing a Linux-only
latest release would make that check fail. Keep both platform assets until the feeds are separated.

## References

- [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- [GlobalShortcuts portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [KDE shortcut dialog](https://github.com/KDE/xdg-desktop-portal-kde/blob/master/src/GlobalShortcutsDialog.qml) and [key recorder patterns](https://api.kde.org/qml-org-kde-kquickcontrols-keysequenceitem.html)
- [RemoteDesktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)
- [Pinned whisper.cpp source](https://github.com/ggml-org/whisper.cpp/tree/927cfce34f31707e17f2bff35c349632fb9e2c3a)

## Native KDE trigger regression test

After building with `make linux`, run:

```bash
python3 linux/scripts/test-kde-triggers.py --binary linux/target/release/openwhisper-desktop
```

This optional desktop test requires Plasma 6.3+, Xvfb, libei, Python PyGObject, and the KDE
configuration utilities. It creates a private D-Bus session, nested KWin, and disposable XDG
settings. Synthetic events are sent only to that owned compositor. It checks single keys,
modifier release behavior, middle/extra mouse buttons, conflicting shortcuts, EOF/SIGTERM cleanup,
SIGKILL recovery, and preservation of existing or later user mappings. It never opens a microphone.
It also replaces only the owned compositor's map with a two-layout fixture while no button is held,
checks that metadata invalidation restores the lease, and validates a fresh mouse helper afterward.
For an owned map known to lack both safe candidates, run the same command with
`--expect-mouse-unsupported`: it verifies five mouse-button requests fail before Ready without a new
lease or mapping change, then confirms keyboard triggering still works. That mode deliberately skips
the working-mouse cases.
The test passed with Plasma 6.7.5 on the primary host; it does not establish physical-device or
other-desktop coverage. The native GTK capture path was also exercised in an isolated Wayland session: key/mouse capture,
Escape cancellation, virtual-source toggle/push-to-talk recording, app-crash cleanup, saved binding restoration,
and trigger removal. Physical-device checks remain outstanding.

### Mouse-keymap readiness guard, 2026-10-07

The guard was checked on an isolated branch based on `46a6b82530bbd7927964332131319070674fe684`.
`make linux-test` passed (5 core, 38 desktop, and 2 speech tests; Clippy with warnings denied;
shared assets and synchronized English/German messages). Fourteen desktop tests use complete synthetic
XKB maps or private file/socket fixtures: absent/present symbols, earlier shifted duplicates,
multi-symbol levels, differing first keycodes across layouts, modifier/group actions, maximum-keycode
exclusion, incompatible seats, safe-to-safe map replacement, malformed/bounded file descriptors,
and an unresponsive private socket deadline. None contacts the user's display.

The owned nested-KWin suite passed all nine groups on CachyOS with KWin `6.7.5-1.1`,
KGlobalAccel `6.30.0-1.1`, Qt `6.11.2-3.1`, xkeyboard-config `2.48-1`, and libxkbcommon
`1.13.2-1.1`. The shared UI suite passed all 29 tests using system Chromium; the bundled headless
shell exited with SIGSEGV before loading a page, retained separately as an environment failure.
Local commands, exact binary checksum, and logs are under `.local/planning/kde-keymap-module-check/`.
This proves the readiness guard and owned cleanup assertions; it does not prove physical input,
absence of a held compositor surrogate, or distribution-wide support. The exact Ubuntu-built Debian package from [CI run 37647268687](https://github.com/juferdinand/OpenWhisper/actions/runs/37647268687)
subsequently passed both the stock Debian 13 refusal profile and all nine trigger groups with
separately augmented private F19/F24 maps. The package SHA-256 is
`b93511a73a671463613ec5c7273e18ea21912ae3d24dd9461d2723f398e0ddb2`;
the installed executable SHA-256 is
`4b800c63b315f306d018d984bd63826a3eb855d0daaf657338a1a342a0aa7001`.
These owned tests used KWin 6.3.6, Qt 6.8.2 and xkb-data 2.42; no stock keymap was
changed. Missing safe mouse symbols still mean keyboard/Record fallback, rather than
completed mouse support. Held compositor-surrogate state and physical checks remain
in [issue #21](https://github.com/juferdinand/OpenWhisper/issues/21).

## Acceptance evidence

Use one report per distribution, desktop/session, and package combination. Record the release
tag/commit and package SHA-256, OS release, desktop/compositor and version, Wayland/X11,
portal/backend versions, audio service, GPU/driver, and AppImage or Debian installation method.
Do not infer a passing result from a missing feature, a package build, or another distribution.

| Check | Result | Evidence and limits |
| --- | --- | --- |
| Install, launch from desktop entry, reactivation | PASS / FAIL / SKIP / MANUAL REQUIRED | Commands, exact package, isolated or physical session |
| Native UI, English/German, saved setup and settings | PASS / FAIL / SKIP / MANUAL REQUIRED | State survives restart/upgrade |
| Fixture recognition, CPU, optional GPU | PASS / FAIL / SKIP / MANUAL REQUIRED | Model/checksum, device/driver, full recognized fixture |
| Virtual-source long capture, stop/cancel, silence | PASS / FAIL / SKIP / MANUAL REQUIRED | Private test source; never an unattended real microphone |
| Physical microphone and device disconnect | PASS / FAIL / SKIP / MANUAL REQUIRED | Supervised tester and device type; no private audio attached |
| Toggle/hold keys, permitted mouse triggers, conflicts | PASS / FAIL / SKIP / MANUAL REQUIRED | Physical events or owned nested compositor clearly identified |
| Permission allow/deny, clipboard, native/XWayland insertion | PASS / FAIL / SKIP / MANUAL REQUIRED | Owned target fields and observed fallback |
| Overlay focus, tray or main-window fallback | PASS / FAIL / SKIP / MANUAL REQUIRED | Desktop behavior; protocol availability alone is insufficient |
| Login, signed update/restart, uninstall | PASS / FAIL / SKIP / MANUAL REQUIRED | Supervised session; settings/models preserved |

Agents may execute existing fixture, private virtual-source, and owned nested-compositor
tests. Physical input and permission/login flows need an explicitly supervised tester.
Use a disposable account/session or VM for installation and desktop changes. Attach only
sanitized evidence; never attach private dictations, recordings, keys, or clipboard content.
An unsupported feature can pass its fallback check while its full-feature check remains skipped.
Only promote the support matrix for the features and environments actually demonstrated.
