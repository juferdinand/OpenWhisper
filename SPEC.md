# WhisperFree – Spezifikation

## Ziel

Eine schlanke macOS-Menüleisten-App für systemweites Diktieren. Nutzer drücken ein globales Kürzel,
sprechen und erhalten den erkannten Text an der Cursor-Position der gerade aktiven App.

Leitprinzipien:

1. **Lokal** – Inferenz auf dem Gerät, keine Server, keine Telemetrie.
2. **Kostenlos & offen** – MIT-Lizenz, kein Konto, kein Lizenzschlüssel.
3. **Klein** – nur die Funktionen, die man täglich braucht: Kürzel, Snippets, mehrere Sprachen.

## Funktionen

| Bereich | Verhalten |
|---|---|
| Auslöser | Systemweiter `CGEvent`-Tap (Bedienungshilfen): Tastenkombination, einzelne Modifier-Taste (Fn, rechte ⌥ …, seitengenau) oder Maustaste ab Nr. 3. Aufnehmen des Auslösers ebenfalls über den Tap, also fokusunabhängig. Auslösende Events werden geschluckt. Ohne Berechtigung: Carbon-`RegisterEventHotKey` als Fallback für Kombinationen. Modi: *Umschalten* oder *Halten* (Push-to-Talk). Wird während eines gehaltenen Modifiers eine andere Taste gedrückt (z. B. ⌥E), wird die Aufnahme verworfen. |
| Overlay | Nicht aktivierendes, randloses `NSPanel` (`.statusBar`-Level, alle Spaces, über Vollbild-Apps). Zeigt Mikrofon / pulsierenden Punkt + Waveform + Timer / Spinner / Erfolg / Fehler. Klick = Start/Stopp, Ziehen = Verschieben (Position wird gespeichert), ✕ verwirft eine Aufnahme. |
| Aufnahme | `AVAudioEngine` Input-Tap, `AVAudioConverter` → 16 kHz mono Float32 im RAM. Aufnahmen < 0,3 s werden ignoriert, Aufnahmen ohne nennenswerten Pegel als „nichts gehört“ gemeldet (verhindert Whisper-Halluzinationen bei Stille). |
| Transkription | whisper.cpp als XCFramework, in-process. Kontext bleibt geladen; Laden startet bereits beim Aufnahmebeginn. Greedy-Decoding, keine Timestamps, optionaler `initial_prompt` aus dem Vokabular-Feld. Sprache fest oder `auto`. |
| Nachbearbeitung | Entfernt Nicht-Sprache-Marker (`[BLANK_AUDIO]`, `(Musik)` …) und bekannte Untertitel-Halluzinationen, normalisiert Leerraum, wendet Snippets an. |
| Snippets | Trigger → Expansion. Case-insensitive, Leerzeichen/Bindestriche austauschbar, nur ganze Wörter. Besteht das Diktat nur aus dem Trigger, wird ausschließlich die Expansion ausgegeben. |
| Ausgabe | Text in die Zwischenablage, dann ⌘V per `CGEvent` (benötigt Bedienungshilfen). Vorherige Zwischenablage wird nach 0,5 s wiederhergestellt, sofern sich zwischenzeitlich nichts geändert hat. Ohne Berechtigung: nur Zwischenablage + Hinweis. |
| Modelle | Katalog (tiny, base, small, medium, large-v3-turbo, large-v3-turbo-q5_0) mit Download von Hugging Face, Fortschritt, Abbrechen, Löschen; Import eigener ggml-Dateien. Ablage: `~/Library/Application Support/WhisperFree/Models`. |
| Einstellungen | Einrichtung (Checkliste), Allgemein, Modelle, Snippets, Verlauf, Über. |

## Zustandsmaschine

```
idle ──start──► recording ──stop──► transcribing ──ok──► done(msg) ──1,2 s──► idle
  ▲                 │                     └──fehler──► error(msg) ──2,5 s──► idle
  └────cancel───────┘
```

## Nicht-Ziele (vorerst)

Live-Streaming-Transkription, Cloud-Sync, KI-Umformulierung, Befehlsmodus, Sandbox/App Store.

## Ideen für später

- Streaming-Vorschau während der Aufnahme
- Automatische Groß-/Kleinschreibung und Satzzeichen-Kommandos („neue Zeile“, „Punkt“)
- Einfügen direkt über AX-Selection-Ranges statt ⌘V
- Optionale lokale LLM-Nachbearbeitung (z. B. über Ollama)
- Universal Binary + notarisiertes Release über GitHub Actions
