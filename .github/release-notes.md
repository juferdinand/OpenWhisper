## What's new in 0.2.4

- Fix Linux crashes when transcribing long Parakeet recordings. Recognition now uses bounded sections for both model families instead of building a GPU graph for the entire recording.
- Isolate Linux recognition in a separate process. Failed sections are retried with progressively smaller windows on GPU and CPU; a manual CPU choice is preserved. Already recognized sections are retained through automatic retries.
- Save a private local WAV before recognition. If recognition cannot finish or the app exits unexpectedly, **Retry transcription** and **Discard saved recording** remain available after restart. Temporary audio is deleted after successful clipboard delivery. Nothing is sent to a server.
- Keep the shared English/German interface, existing GPU/CPU selection, saved models and settings, and recording without a fixed time limit. macOS and Linux continue to share one release version.

**Updating from Linux 0.2.1 or 0.2.2:** use **About → Check now**. The older updater may still
close after installing 0.2.4 when launched by a systemd service. If that happens, open WhisperFree
once from your application launcher; the new package is already installed. Original Linux 0.2.0
and source/CI builds need a manual installation of a signed release to obtain the updater.

## macOS download and installation

Download and open **WhisperFree-macOS.dmg**, then drag **WhisperFree.app** onto **Applications**.
Eject the WhisperFree volume and launch the app from Applications. A ZIP is also available.
The app requires **macOS 14 or later** and includes both Apple Silicon and Intel binaries.
Download a speech model in the app before your first dictation; recognition then runs locally.

This release is signed with the project's self-signed certificate and is **not notarized by Apple**.
Initial open-source releases use self-signing to avoid the annual Apple Developer Program fee
while the project is being developed and tested. See the [signing decision](https://github.com/juferdinand/WhisperFree/blob/main/docs/SIGNING.md).
If macOS blocks the first launch, review the app's origin and use **System Settings → Privacy & Security → Open Anyway**
if you choose to allow it. See [Apple's instructions](https://support.apple.com/102445).

`SHA256SUMS` contains the package checksums. To check the DMG, place the DMG and checksum file in the same folder and run:

```bash
grep '  WhisperFree-macOS[.]dmg$' SHA256SUMS | shasum -a 256 -c -
```

The app interface supports English and German. Read the [README](https://github.com/juferdinand/WhisperFree#readme)
for setup and permissions. Dictation still supports multiple languages.

## Linux download and installation

Linux packages are available for x86_64. Desktop integration depends on KDE native services or the installed portal backend.
The primary tested environment is **CachyOS x86_64, KDE Plasma 6, Wayland, and PipeWire**.

- **AppImage:** download `WhisperFree-Linux-x86_64.AppImage`, make it executable, and run it. If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1 ./WhisperFree-Linux-x86_64.AppImage`.
- **Debian/Ubuntu package:** download `WhisperFree-Linux-amd64.deb` and install it with `sudo apt install ./WhisperFree-Linux-amd64.deb`. The package is built on Ubuntu 22.04; desktop acceptance on Debian/Ubuntu is still pending.
- Wayland clipboard output requires `wl-clipboard`. KDE Plasma 6 supports native keyboard triggers; KDE Wayland mouse triggers also require `kreadconfig6`, `kwriteconfig6`, and the `buttonsrebind` plugin. Other desktops use the GlobalShortcuts portal. Automatic pasting requires a compatible RemoteDesktop portal; keyboard access is requested only when enabled.
- The floating indicator requires `gtk-layer-shell` and a compatible Wayland compositor. GNOME does not provide layer-shell; the main-window control remains available.
- Set the trigger and optional paste permission in General. KDE native triggers reconnect at startup; portal setup remains session-scoped. Primary left/right clicks and scrolling are excluded. Fn, DPI/profile, and vendor buttons work only if the hardware exposes supported input events. Direct mouse capture on other desktops and X11 is not implemented.
- Vulkan recognition requires a Vulkan loader and compatible graphics driver. Whisper Tiny and Parakeet v3 q4 were tested on an NVIDIA RTX 3060; AMD/Intel GPUs and other drivers still need hardware acceptance. CPU recognition remains available without a compatible GPU.
- Custom model import, clipboard restoration, editor output, and sounds are not yet available on Linux.

Linux updates use a separate persistent signing key and signed version. Verify the first download's origin and `SHA256SUMS`. The `.sig` files and `latest.json` are used by the updater.
AppImages must be in a writable permanent location; Debian updates request system administrator
authorization. Debian/Ubuntu update installation still needs desktop acceptance.
Read the [Linux support and validation notes](https://github.com/juferdinand/WhisperFree/blob/v0.2.4/docs/LINUX.md)
for dependencies, tested behavior, and remaining checks. Physical microphone quality, physical hold/toggle shortcut events,
XWayland insertion, and other distributions still need broader acceptance testing.

Known dependency risk: the Linux GTK 3 stack includes `glib 0.18.5`, affected by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The alert remains open;
see the [scope and source review](https://github.com/juferdinand/WhisperFree/blob/v0.2.4/SECURITY.md#known-linux-dependency-advisory).
