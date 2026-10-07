## What's new in 0.2.5

- Add native keyboard setup and toggle/hold triggers for X11 desktops, with explicitly allowed session-only automatic paste. KDE keeps its own native adapter.
- Add `--control toggle`, `--control start` and `--control stop` for user-configured shortcuts on Sway, Hyprland and desktops without a usable shortcut portal.
- Make permission retry usable after denial, clean up failed portal sessions, and keep the main recording control available when a compositor has no floating-overlay protocol.
- Recover the settings window when the Linux tray host disappears. Closing without a tray host now quits cleanly, including during recording.
- Include the optional Wayland overlay runtime and its notices in the AppImage. Preserve nested notices during local installation.
- Acknowledge Stop before preparing captured audio for recognition. Recording still has no fixed time limit; the existing private recovery recordings, GPU/CPU retries and manual CPU choice remain available.
- Validate the shared English/German UI and Linux desktop flows in isolated graphical sessions across KDE, GNOME, Xfce, Cinnamon, MATE, Sway and Hyprland. The validation notes identify exact packages, virtual input/audio and remaining hardware coverage.

**Updating from Linux 0.2.1 or 0.2.2:** use **About → Check now**. The older updater may still
close after installing the update when launched by a systemd service. If that happens, open OpenWhisper
once from your application launcher; the new package is already installed. Original Linux 0.2.0
and source/CI builds need a manual installation of a signed release to obtain the updater.

## macOS download and installation

Download and open **OpenWhisper-macOS.dmg**, then drag **OpenWhisper.app** onto **Applications**.
Eject the OpenWhisper volume and launch the app from Applications. A ZIP is also available.
The app requires **macOS 14 or later** and includes both Apple Silicon and Intel binaries.
Download a speech model in the app before your first dictation; recognition then runs locally.

This release is signed with the project's self-signed certificate and is **not notarized by Apple**.
Initial open-source releases use self-signing to avoid the annual Apple Developer Program fee
while the project is being developed and tested. See the [signing decision](https://github.com/juferdinand/OpenWhisper/blob/main/docs/SIGNING.md).
If macOS blocks the first launch, review the app's origin and use **System Settings → Privacy & Security → Open Anyway**
if you choose to allow it. See [Apple's instructions](https://support.apple.com/102445).

`SHA256SUMS` contains the package checksums. To check the DMG, place the DMG and checksum file in the same folder and run:

```bash
grep '  OpenWhisper-macOS[.]dmg$' SHA256SUMS | shasum -a 256 -c -
```

The app interface supports English and German. Read the [README](https://github.com/juferdinand/OpenWhisper#readme)
for setup and permissions. Dictation still supports multiple languages.

## Linux download and installation

Linux packages are available for x86_64. Desktop integration depends on KDE native services,
the installed portal backend, X11, or explicit user-configured compositor bindings. Owned
graphical tests cover additional KDE distributions, GNOME 46/48/49, named X11 desktops,
Sway and Hyprland; these results do not establish every physical device or target application.

- **AppImage:** download `OpenWhisper-Linux-x86_64.AppImage`, make it executable, and run it. If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1 ./OpenWhisper-Linux-x86_64.AppImage`.
- **Debian/Ubuntu package:** download `OpenWhisper-Linux-amd64.deb` and install it with `sudo apt install ./OpenWhisper-Linux-amd64.deb`. Packages are built on Ubuntu 22.04; owned APT installation/removal tests preserve existing user data.
- Wayland clipboard output requires `wl-clipboard`; X11 requires `xclip`. KDE Plasma 6 supports native keyboard triggers; KDE Wayland mouse triggers also require `kreadconfig6`, `kwriteconfig6`, and the `buttonsrebind` plugin. Other Wayland desktops use an available GlobalShortcuts portal or explicit command bindings. Automatic Wayland paste requires a compatible RemoteDesktop portal; keyboard access is requested only when enabled.
- The AppImage includes `gtk-layer-shell` for floating controls on compatible Wayland compositors. Native builds use an optional system library. GNOME does not provide layer-shell; the main-window control remains available.
- Set the trigger and optional paste permission in General. KDE native and X11 keyboard triggers reconnect at startup; portal permissions remain session-scoped. Primary left/right clicks and scrolling are excluded. Fn, DPI/profile, and vendor buttons work only if the hardware exposes supported input events. Direct mouse capture outside KDE Wayland is not implemented.
- GNOME 48's tested shortcut backend returns a failed binding response; the main recording control and configured-command fallback remain available. The tested GNOME 49 backend passes shortcut activation and hold/release checks.
- Vulkan recognition requires a Vulkan loader and compatible graphics driver. Whisper Tiny and Parakeet v3 q4 were tested on an NVIDIA RTX 3060; AMD/Intel GPUs and other drivers still need hardware acceptance. CPU recognition remains available without a compatible GPU.
- Custom model import, clipboard restoration, editor output, and sounds are not yet available on Linux.

Linux updates use a separate persistent signing key and signed version. Verify the first download's origin and `SHA256SUMS`. The `.sig` files and `latest.json` are used by the updater.
AppImages must be in a writable permanent location; Debian updates request system administrator
authorization. A signed update into a real desktop login session remains separate from owned
installation tests.
Read the [Linux support and validation notes](https://github.com/juferdinand/OpenWhisper/blob/v0.2.5/docs/LINUX.md)
for dependencies, exact tested behavior, and coverage limits. Physical microphones, GPU drivers,
login sessions and application-specific paste behavior remain separately identified. Report
reproducible problems with the version, package, desktop and session type.

Known dependency risk: the Linux GTK 3 stack includes `glib 0.18.5`, affected by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The alert remains open;
see the [scope and source review](https://github.com/juferdinand/OpenWhisper/blob/v0.2.5/SECURITY.md#known-linux-dependency-advisory).
