## Download and installation

Download and open **WhisperFree-macOS.dmg**, then drag **WhisperFree.app** onto **Applications**.
Eject the WhisperFree volume and launch the app from Applications. A ZIP is also available.
The app requires **macOS 14 or later** and includes both Apple Silicon and Intel binaries.
Download a speech model in the app before your first dictation; recognition then runs locally.

This release is signed with the project's self-signed certificate and is **not notarized by Apple**.
Initial open-source releases use self-signing to avoid the annual Apple Developer Program fee
while the project is being developed and tested. See the [signing decision](https://github.com/juferdinand/WhisperFree/blob/main/docs/SIGNING.md).
If macOS blocks the first launch, review the app's origin and use **System Settings → Privacy & Security → Open Anyway**
if you choose to allow it. See [Apple's instructions](https://support.apple.com/102445).

`SHA256SUMS` contains both package checksums. To check the DMG, place the DMG and checksum file in the same folder and run:

```bash
grep '  WhisperFree-macOS[.]dmg$' SHA256SUMS | shasum -a 256 -c -
```

The app interface is currently in German. Read the [English README](https://github.com/juferdinand/WhisperFree#readme)
or [deutsche README](https://github.com/juferdinand/WhisperFree/blob/main/README.de.md) for setup and permissions.

## Installation auf Deutsch

**WhisperFree-macOS.dmg** herunterladen und öffnen. **WhisperFree.app** auf **Applications / Programme** ziehen,
das WhisperFree-Laufwerk auswerfen und die App aus Programme starten. Ein ZIP ist ebenfalls verfügbar.
Benötigt macOS 14 oder neuer; Apple Silicon und Intel sind enthalten.
Die App ist selbstsigniert, aber nicht von Apple notarisiert. Falls macOS den ersten Start blockiert,
kannst du sie nach Prüfung der Herkunft unter **Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen** freigeben.
Wir verwenden vorerst die selbstsignierte Variante, damit die ersten Open-Source-Releases ohne
die jährliche Apple-Developer-Mitgliedschaft auskommen. Eine spätere Apple-Signierung und Notarisierung bleiben möglich.
