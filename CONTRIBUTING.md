# Zu WhisperFree beitragen

Beiträge können Fehlerberichte, Dokumentation, Tests oder Code sein.
Issues und Pull Requests sind auf Deutsch und Englisch willkommen. Oberfläche, Kommentare und
Projektdokumentation sind aktuell überwiegend deutsch.

## Fehler melden und Ideen besprechen

Prüfe zuerst die [vorhandenen Issues](https://github.com/juferdinand/WhisperFree/issues).
Ein hilfreicher Fehlerbericht enthält:

- WhisperFree-Version oder Commit sowie macOS-Version und Mac-Chip.
- Modell, Sprache, Ausgabemodus und gegebenenfalls die betroffene Ziel-App.
- Schritte zum Nachstellen, erwartetes Verhalten und tatsächlich beobachtetes Verhalten.
- Passende Fehlermeldungen ohne private Diktate, Tokens oder andere vertrauliche Daten.

Bei größeren Funktionen lohnt sich zuerst ein Issue, um Ziel und Umfang abzustimmen.
Kleine Korrekturen kannst du direkt als Pull Request einreichen.

## Lokal arbeiten

Du brauchst macOS 14+ und eine aktuelle Swift-Toolchain aus Xcode oder den Command Line Tools.
Installation und erster Start stehen in der [README](README.md#installation).

1. Forke das Repository und klone deinen Fork.
2. Erstelle einen Branch für deine Änderung, etwa `git switch -c fix/clipboard`.
3. Halte die Änderung auf ein nachvollziehbares Problem begrenzt.
4. Prüfe relevante Änderungen mit den folgenden Befehlen:

```bash
make test
make mac
```

Für reine Dokumentationsänderungen reichen die Prüfung von Inhalt, Links und Formatierung.
Bei Änderungen an Aufnahme, Berechtigungen, Hotkeys oder Einfügen prüfe das Verhalten zusätzlich
manuell auf einem Mac; die Core-Tests decken diese Systemintegration nicht ab.

## Aufbau und Tests

- `macos/Sources/WhisperFreeCore/` enthält die eigenständig testbare Textverarbeitung und den Modellkatalog.
- `macos/Sources/WhisperFree/` enthält Oberfläche und macOS-Integration.
- `shared/models.json` ist die gemeinsame Quelle für Modelle und Empfehlungen.
- `shared/test-vectors.json` enthält Testfälle für Textbereinigung, Vokabular und Snippets. Ergänze bei behobenen Verarbeitungsfehlern einen passenden Fall.

Folge dem Stil der umgebenden Dateien. Ändere gemeinsame Datenformate bewusst, da sie auch
für die geplanten weiteren Plattformen vorgesehen sind.

## Pull Request einreichen

Beschreibe das Problem, die Änderung und wie du sie geprüft hast. Bei sichtbaren UI-Änderungen
hilft ein Screenshot; bei Fehlerbehebungen ein reproduzierbares Beispiel.
Verlinke ein zugehöriges Issue und nenne offen, welche Prüfungen du nicht durchführen konntest.

Bitte committe keine Modelle, Build-Ausgaben, Aufnahmen, persönlichen Konfigurationen oder
Signierschlüssel. Versionsänderungen und Releases erfolgen getrennt über den Release-Workflow.

Beiträge zu diesem Repository werden unter der bestehenden [MIT-Lizenz](LICENSE) veröffentlicht.
