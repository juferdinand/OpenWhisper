## Download and installation

Download **WhisperFree-macOS.zip**, extract it, and move **WhisperFree.app** to `/Applications`.
The app requires **macOS 14 or later** and includes both Apple Silicon and Intel binaries.
Download a speech model in the app before your first dictation; recognition then runs locally.

This release is signed with the project's self-signed certificate and is **not notarized by Apple**.
If macOS blocks the first launch, review the app's origin and use **System Settings → Privacy & Security → Open Anyway**
if you choose to allow it. See [Apple's instructions](https://support.apple.com/102445).

`SHA256SUMS` contains the package checksum. To check it, place both downloaded files in the same folder and run:

```bash
shasum -a 256 -c SHA256SUMS
```

The app interface is currently in German. Read the [English README](https://github.com/juferdinand/WhisperFree#readme)
or [deutsche README](https://github.com/juferdinand/WhisperFree/blob/main/README.de.md) for setup and permissions.

## Installation auf Deutsch

**WhisperFree-macOS.zip** herunterladen, entpacken und **WhisperFree.app** nach `/Applications` ziehen.
Benötigt macOS 14 oder neuer; Apple Silicon und Intel sind enthalten.
Die App ist selbstsigniert, aber nicht von Apple notarisiert. Falls macOS den ersten Start blockiert,
kannst du sie nach Prüfung der Herkunft unter **Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen** freigeben.
