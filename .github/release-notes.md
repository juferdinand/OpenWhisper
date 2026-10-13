<!-- Prepared for the gated release workflow; repository status lives in README.md. -->

## What's new in OpenWhisper 0.5.2

- Speech recognition can use the Apple Silicon GPU (Metal) on macOS
- LM Studio shows when its server is stopped and can start it with one click
- Saving AI model settings is instant and no longer blocks the page

## Neu in OpenWhisper 0.5.2

- Die Spracherkennung kann auf macOS die Apple-Silicon-GPU (Metal) nutzen
- LM Studio zeigt an, wenn sein Server aus ist, und kann ihn mit einem Klick starten
- Das Speichern der KI-Modell-Einstellungen geht sofort und blockiert die Seite nicht mehr

Recognition runs locally. Exact package, desktop and test scope is recorded in
[Electron status](https://github.com/juferdinand/OpenWhisper/blob/main/docs/ELECTRON-STATUS.md) and
[Linux evidence](https://github.com/juferdinand/OpenWhisper/blob/main/docs/LINUX.md).

## Updating from 0.2.5

For the first transition from the native 0.2.5 application to Electron, install 0.4.1 manually
from the packages below. The original application's GUI updater has not been verified for this
host transition. The earlier 0.2.4-to-0.2.5 transition also required manual installation;
the 0.2.4 updater cannot apply 0.2.5. Older versions may need to be reopened from the application launcher
after an update. See the [immutable 0.2.5 release notes](https://github.com/juferdinand/OpenWhisper/blob/68294863af7fd101d7ce35d8eab0c28050e31dcf/.github/release-notes.md)
for the previous update guidance.

## macOS

Download **OpenWhisper-macOS.dmg**, drag **OpenWhisper.app** to **Applications**, eject the image,
and open the app from Applications. A ZIP is also available. Both packages include Apple Silicon
and Intel binaries and require **macOS 14 or later**. Download a model before dictation.

The app is signed with the project's persistent self-signed certificate and is **not notarized by
Apple**. If macOS blocks the first launch, review the app's origin and use **System Settings →
Privacy & Security → Open Anyway** if you choose to allow it.
See [release signing](https://github.com/juferdinand/OpenWhisper/blob/main/docs/SIGNING.md) and
[Apple's first-open instructions](https://support.apple.com/102445).

Verify the DMG with `SHA256SUMS` from the same folder:

```bash
grep '  OpenWhisper-macOS[.]dmg$' SHA256SUMS | shasum -a 256 -c -
```

## Linux x86_64

Download and run the AppImage:

```bash
chmod +x OpenWhisper-Linux-x86_64.AppImage
./OpenWhisper-Linux-x86_64.AppImage
```

If FUSE is unavailable, run it with `APPIMAGE_EXTRACT_AND_RUN=1`. On Debian or Ubuntu, install
the package with:

```bash
sudo apt install ./OpenWhisper-Linux-amd64.deb
```

Verify downloads against `SHA256SUMS`. See [Electron status](https://github.com/juferdinand/OpenWhisper/blob/main/docs/ELECTRON-STATUS.md)
for the tested package scope and remaining platform coverage.

The interface is available in English and German. Dictation supports multiple spoken languages.
