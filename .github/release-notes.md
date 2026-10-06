## What's new in 0.2.1

- In-app update controls for both macOS and Linux, with daily checks and explicit download/install.
- Signed, version-bound Linux AppImage and Debian updates, verified before installation. Linux 0.2.0 users need one manual upgrade to 0.2.1.
- A persistent English/German interface switch in the sidebar, shared by both apps and their recording controls and native menus. Dictation language is independent.
- First-run setup disappears after completion and stays hidden across restarts and updates. Existing installations migrate automatically; permissions and triggers remain in General.
- Update installation is blocked during dictation/model downloads, and recording cannot start during installation.
- One release workflow builds and verifies macOS and Linux together, including update signatures and the update feed.

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

## Linux preview

Linux is an **early preview**, not a promise of support for every distribution or desktop.
The primary tested environment is **CachyOS x86_64, KDE Plasma 6, Wayland, and PipeWire**.

- **AppImage:** download `WhisperFree-Linux-x86_64.AppImage`, make it executable, and run it. If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1 ./WhisperFree-Linux-x86_64.AppImage`.
- **Debian/Ubuntu package:** download `WhisperFree-Linux-amd64.deb` and install it with `sudo apt install ./WhisperFree-Linux-amd64.deb`. The package is built on Ubuntu 22.04; desktop acceptance on Debian/Ubuntu is still pending.
- Wayland clipboard output requires `wl-clipboard`. Global shortcuts and automatic pasting require compatible desktop portals; keyboard access is requested only when enabled.
- The floating indicator requires `gtk-layer-shell` and a compatible Wayland compositor. GNOME does not provide layer-shell; the main-window control remains available.
- Enable the trigger and optional keyboard permission in General after launching. Portal setup is session-scoped in this preview.
- Linux GPU acceleration, custom model import, clipboard restoration, editor output, sounds, and autostart are not included in this preview.

Linux updates use a separate persistent signing key and signed version. Verify the first download's origin and `SHA256SUMS`. The `.sig` files and `latest.json` are used by the updater.
AppImages must be in a writable permanent location; Debian updates request system administrator
authorization. Debian/Ubuntu update installation still needs desktop acceptance.
Read the [Linux support and validation notes](https://github.com/juferdinand/WhisperFree/blob/v0.2.1/docs/LINUX.md)
for dependencies, tested behavior, and remaining checks. Physical microphone quality, physical hold/toggle shortcut events,
XWayland insertion, and other distributions still need broader acceptance testing.

Known dependency risk: the Linux GTK 3 stack includes `glib 0.18.5`, affected by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The alert remains open;
see the [scope and source review](https://github.com/juferdinand/WhisperFree/blob/v0.2.1/SECURITY.md#known-linux-dependency-advisory).
