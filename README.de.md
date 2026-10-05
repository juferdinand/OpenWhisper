# WhisperFree

[English](README.md) | **Deutsch**

**Drücken. Sprechen. Weiterschreiben. Lokales Diktieren für macOS.**

[![CI](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml/badge.svg)](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black.svg)](#voraussetzungen)

WhisperFree ist eine native Menüleisten-App, die Sprache lokal auf deinem Mac in Text umwandelt.
Drücke <kbd>⌥</kbd> + <kbd>Space</kbd>, sprich und drücke das Kürzel erneut:
Der Text wird in das aktive Textfeld eingefügt. Kein Konto, kein API-Schlüssel, kein Abo.

> **Sprache der App:** Die Oberfläche ist derzeit auf Deutsch. Diese README ist auf Deutsch und Englisch verfügbar.

[Installation](#installation) · [Funktionen](#funktionen) · [Datenschutz](#datenschutz) ·
[Mitmachen](#mitmachen) · [Probleme melden](https://github.com/juferdinand/WhisperFree/issues)

## Projektstatus

WhisperFree ist in früher Entwicklung. Lade die fertige macOS-App unter
[GitHub Releases](https://github.com/juferdinand/WhisperFree/releases/latest) herunter oder baue sie aus dem Quellcode.

| Plattform | Stand |
| --- | --- |
| macOS 14+ | Native Swift-App; Universal-Paket für Apple Silicon und Intel |
| Linux und Windows | Geplant, noch nicht implementiert — siehe [Plattformplan](docs/PLATFORMS.md) |

## Funktionen

- **Systemweites Diktieren:** Text im aktiven Textfeld einfügen, in die Zwischenablage kopieren oder in einem Texteditor öffnen.
- **Dein Auslöser:** Frei belegbare Tastenkombinationen, einzelne Modifier-Tasten, Fn oder zusätzliche Maustasten. Umschalten oder gedrückt halten (Push-to-Talk).
- **Lokale Spracherkennung:** OpenAI Whisper und NVIDIA Parakeet über [whisper.cpp](https://github.com/ggml-org/whisper.cpp), mit Metal-Unterstützung auf Apple Silicon.
- **Modellverwaltung:** Modelle herunterladen, wechseln, löschen oder kompatible eigene ggml-Dateien importieren. Die App schlägt Modelle passend zu Hardware und Systemsprache vor.
- **Vokabular und Snippets:** Eigene Begriffe korrigieren lassen und gesprochene Kürzel durch hinterlegte Texte ersetzen, etwa „mein Link“ durch eine URL.
- **Schwebendes Overlay:** Aufnahmepegel, Timer und Verarbeitungsstatus; verschiebbar und ohne den Fokus vom Textfeld zu nehmen.
- **Alltagseinstellungen:** Start beim Anmelden, optionale Hinweistöne, Wiederherstellung der Zwischenablage und abschaltbarer lokaler Textverlauf.

## Voraussetzungen

- Ein Mac mit **macOS 14 oder neuer**.
- Ein Mikrofon und genügend Speicherplatz für das gewählte Sprachmodell; die Downloadgröße wird in der App angezeigt.
- Für den Build: aktuelle **Xcode Command Line Tools** oder Xcode mit Swift-Toolchain.
- Internet zum Download der App und eines Sprachmodells beziehungsweise der Abhängigkeiten für einen Quellcode-Build. Nach der Einrichtung funktioniert das Diktieren offline.

## Installation

### App herunterladen

1. Lade [**WhisperFree-macOS.zip**](https://github.com/juferdinand/WhisperFree/releases/latest/download/WhisperFree-macOS.zip) herunter.
2. Entpacke das ZIP und ziehe **WhisperFree.app** nach `/Applications`.
3. Öffne die App und folge den Schritten unter [Erstes Diktat](#erstes-diktat).

Releases verwenden ein dauerhaftes, selbstsigniertes Zertifikat und sind **nicht von Apple notarisiert**.
So kommen die ersten Open-Source-Releases vorerst ohne die jährliche Gebühr des Apple Developer Program aus.
Developer-ID-Signierung und Notarisierung bleiben eine spätere Option; siehe die [Entscheidung zur Signierung](docs/SIGNING.md) (Englisch).
Falls macOS den ersten Start blockiert, prüfe die Herkunft der App. Wenn du sie freigeben möchtest,
verwende **Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen**.
Siehe [Apples Anleitung](https://support.apple.com/de-de/102445).

Jedes Release enthält `SHA256SUMS`. Lege diese Datei neben das ZIP und prüfe den Download mit:

```bash
shasum -a 256 -c SHA256SUMS
```

### Aus dem Quellcode

Installiere bei Bedarf zuerst die Command Line Tools:

```bash
xcode-select --install
```

Klone das Repository und baue die App:

```bash
git clone https://github.com/juferdinand/WhisperFree.git
cd WhisperFree
make mac
open macos/build/WhisperFree.app
```

Der Build lädt das festgelegte whisper.cpp-XCFramework automatisch herunter und prüft dessen
SHA-256-Prüfsumme. Du kannst die fertige `WhisperFree.app` anschließend nach `/Applications` ziehen.

Alternativ baut `make mac-install` die App, ersetzt eine vorhandene Installation in `/Applications`
und startet sie.

## Erstes Diktat

1. Öffne WhisperFree. Die Einrichtung erreichst du auch über das Menüleisten-Symbol.
2. Lade ein Modell in **Einstellungen → Modelle** und wähle es aus.
3. Erlaube den **Mikrofonzugriff**.
4. Erlaube **Bedienungshilfen**, wenn Text automatisch eingefügt werden soll. Für manuelles Einfügen wähle **Nur in die Zwischenablage kopieren**.
5. Setze den Cursor in ein Textfeld. Drücke <kbd>⌥</kbd> + <kbd>Space</kbd>, sprich und drücke das Kürzel erneut.

Die Transkription beginnt nach dem Stoppen der Aufnahme. Auslöser, Aufnahmemodus, Sprache und
Ausgabe lassen sich in den Einstellungen ändern. Ohne Bedienungshilfen stehen für den globalen
Auslöser gewöhnliche Tastenkombinationen zur Verfügung; einzelne Modifier- und Maustasten benötigen die Berechtigung.

## Modelle und Sprachen

| Modellfamilie | Auswahl in WhisperFree | Sprachverhalten |
| --- | --- | --- |
| OpenAI Whisper | Tiny, Base, Small, Medium, Large v3 Turbo; auch komprimiertes Turbo-Modell | Manuelle Sprachwahl oder automatische Erkennung; Vokabular zusätzlich als Erkennungshinweis |
| NVIDIA Parakeet TDT v3 | Volle Präzision sowie q8- und q4-Varianten | Automatische Spracherkennung; die manuelle Sprachwahl wird nicht angewendet |

Die anschließende Vokabular-Korrektur und Snippets funktionieren mit beiden Modellfamilien.
Verfügbare Dateien, Downloadgrößen und die Sprachliste für Parakeet stehen im
[Modellkatalog](shared/models.json). Erkennungsgeschwindigkeit und Qualität hängen unter anderem
von Modell, Hardware, Sprache und Aufnahme ab.

## Datenschutz

Die Spracherkennung läuft im App-Prozess auf deinem Mac. WhisperFree lädt keine Audioaufnahmen
oder Transkripte zur Erkennung hoch und enthält keine Telemetrie-Anbindung.

| Daten oder Verbindung | Verhalten |
| --- | --- |
| Audio | Die App verarbeitet Samples im Arbeitsspeicher und schreibt keine Audiodateien. |
| Modelle | Download auf Anforderung von Hugging Face, einschließlich dessen Download-Infrastruktur; Ablage unter `~/Library/Application Support/WhisperFree/Models`. |
| Einstellungen und Verlauf | Lokale User Defaults. Der Verlauf speichert standardmäßig die letzten 20 Textdiktate; unter **Verlauf** abschaltbar und löschbar. |
| Snippets | Lokal unter `~/Library/Application Support/WhisperFree/snippets.json`. |
| Ausgabe im Texteditor | Schreibt Textdateien nach `~/Library/Application Support/WhisperFree/Diktate`; diese bleiben unabhängig vom Verlauf bestehen. |
| Updates | Nur bei konfiguriertem Update-Repository: abschaltbare automatische Prüfung über die GitHub-API, Download eines Updates nach Klick. |

Ausgegebener Text gelangt in die Zwischenablage und gegebenenfalls in die von dir gewählte App.
Deren Speicherung und Synchronisierung richtet sich nach deinen dortigen Einstellungen.

## Hilfe bei Problemen

| Problem | Was du prüfen kannst |
| --- | --- |
| Kein Text wird eingefügt | Bedienungshilfen für WhisperFree erlauben und ein aktives Textfeld wählen. Alternativ den Zwischenablage-Modus verwenden und selbst mit `⌘V` einfügen. |
| „Kein Mikrofonzugriff“ oder „Nichts gehört“ | Mikrofonberechtigung, das Standard-Eingabegerät und den Eingangspegel in macOS prüfen. |
| Das Kürzel reagiert nicht | Ein anderes Kürzel wählen und auf Konflikte mit System- oder App-Kürzeln prüfen. Für Fn, einzelne Modifier und Maustasten Bedienungshilfen erlauben. |
| Kurze Sätze werden in der falschen Sprache erkannt | Bei Whisper die Sprache ausdrücklich einstellen. Parakeet verwendet immer automatische Erkennung. |
| Nach einem lokalen Rebuild fehlen Berechtigungen | Eine wechselnde Ad-hoc-Signatur kann erneute Freigaben erfordern; ein dauerhaftes lokales Entwicklungszertifikat hilft. Siehe [Entwicklung](#entwicklung). |
| „Updates sind in diesem Build nicht konfiguriert“ | Das ist bei normalen Quellcode-Builds vorgesehen. Aktualisiere den Quellcode und baue die App erneut. |

Noch offen? [Erstelle ein Issue](https://github.com/juferdinand/WhisperFree/issues/new) mit macOS-Version,
Mac-Chip, WhisperFree-Version, verwendetem Modell und Schritten zum Nachstellen.
Bitte entferne persönliche Diktate und andere vertrauliche Angaben aus angehängten Logs.

## Grenzen und Ausblick

Die aktuelle App transkribiert nach der Aufnahme; eine laufende Textvorschau ist noch nicht implementiert.
Ebenso gibt es derzeit keine Linux- oder Windows-App, Cloud-Synchronisierung oder LLM-Nachbearbeitung.
Automatisches Einfügen verwendet die Zwischenablage und einen simulierten Tastendruck; das Verhalten
kann je nach Ziel-App variieren.

Nächste Schritte sind die weitere Erprobung der macOS-App sowie Apple-Developer-ID-Signierung und Notarisierung.
Ideen und geplante Plattformen stehen in [SPEC.md](SPEC.md) und [docs/PLATFORMS.md](docs/PLATFORMS.md).
Das sind Planungen, keine zugesagten Veröffentlichungstermine.

## Entwicklung

```bash
make test                      # Tests für Textverarbeitung und Modellkatalog
make mac                       # Lokales App-Bundle bauen
make -C macos app UNIVERSAL=1   # Universal-Bundle für Apple Silicon und Intel
```

Die [CI](https://github.com/juferdinand/WhisperFree/actions/workflows/ci.yml) führt Tests aus,
baut ein Universal-ZIP und hält es 14 Tage als herunterladbares Actions-Artefakt vor.
Diese Entwicklungs-Builds sind ad-hoc-signiert und aktivieren den In-App-Updater nicht.
Für die normale Installation verwende die signierten Pakete unter [Releases](https://github.com/juferdinand/WhisperFree/releases/latest).
Die Tests verwenden gemeinsame Fälle aus
[`shared/test-vectors.json`](shared/test-vectors.json).

Für eine gleichbleibende lokale Signatur kannst du auf deinem Mac einmal
`macos/scripts/create-dev-cert.sh` ausführen. Der Build verwendet das Zertifikat **WhisperFree Dev**,
wenn es im Schlüsselbund vorhanden ist.

```text
macos/
  Sources/WhisperFree/       App, Aufnahme, Hotkeys, Ausgabe und Oberfläche
  Sources/WhisperFreeCore/   Textbereinigung, Vokabular, Snippets und Modellkatalog
  Tests/                    Tests mit Swift Testing
  scripts/                  Build, Abhängigkeiten und Signierung
shared/                     Gemeinsamer Modellkatalog und Testfälle
docs/                       Plattformplanung
.github/workflows/          CI und manueller Release-Workflow
VERSION                     Projektversion
```

<details>
<summary>Releases für Maintainer</summary>

Der [Release-Workflow](.github/workflows/release.yml) benötigt eine dauerhafte Signieridentität
in den Repository-Secrets `SIGNING_CERT_P12` und `SIGNING_CERT_PASSWORD`.
Um eine vorhandene Identität hochzuladen, exportiere in der macOS-Schlüsselbundverwaltung nur
diese Identität samt privatem Schlüssel als verschlüsselte `.p12`-Datei. Starte danach
`macos/scripts/export-dev-cert.sh juferdinand/WhisperFree /pfad/zur/identitaet.p12`.
Das Skript fragt das Passwort ab und lädt ausschließlich die ausgewählte Datei hoch.
Die öffentliche Release-Identität ist bereits eingerichtet. Behalte sie für weitere Releases bei;
ein neu erzeugtes lokales Zertifikat würde die Signaturkompatibilität für Updates aufheben.

Anschließend wird der Workflow unter **Actions → Release → Run workflow** mit einer neuen
Version im Format `X.Y.Z` gestartet. Er setzt `VERSION`, erzeugt Commit und Tag, baut das
Universal-Bundle und veröffentlicht das ZIP mit `SHA256SUMS`. Das Paket wird zusätzlich als Actions-Artefakt gespeichert.
Dabei wird das Update-Repository im Bundle hinterlegt.
Der Updater prüft heruntergeladene Apps gegen die Signaturanforderung der laufenden App;
die Signieridentität muss deshalb über Releases hinweg erhalten bleiben.

</details>

## Mitmachen

Fehlerberichte, Verbesserungen an der Dokumentation und Pull Requests sind willkommen — auf Deutsch
oder Englisch. Eine Anleitung für Beiträge findest du in [CONTRIBUTING.md](CONTRIBUTING.md).
Besonders hilfreich sind reproduzierbare Berichte zu verschiedenen Macs, Ziel-Apps und Sprachen.
Nutze für Sicherheitslücken die [vertrauliche Sicherheitsmeldung](SECURITY.md) statt öffentlicher Issues.

## Lizenz und Danksagung

WhisperFree steht unter der [MIT-Lizenz](LICENSE).
Die Spracherkennung baut auf [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
[OpenAI Whisper](https://github.com/openai/whisper) und
[NVIDIA Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) auf.
Für Bibliotheken und heruntergeladene Modelle gelten zusätzlich deren jeweilige Lizenzbedingungen.
