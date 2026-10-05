import Foundation

public enum TranscriptCleaner {
    /// Marker, die Whisper für Nicht-Sprache ausgibt: [BLANK_AUDIO], [Musik], (Applaus), *lacht* …
    private static let nonSpeech = try! NSRegularExpression(
        pattern: "\\[[^\\]]*\\]|\\([^)]*(musik|music|applaus|applause|lacht|laughs|stille|silence|geräusch|noise)[^)]*\\)|\\*[^*]+\\*",
        options: [.caseInsensitive]
    )

    /// Bekannte Halluzinationen aus Untertitel-Trainingsdaten, die bei Stille auftauchen.
    private static let hallucinations = try! NSRegularExpression(
        pattern: "(Untertitel(ung)?[^.]*?(ZDF|Amara\\.org|funk)[^.]*\\.?)|(Subtitles by the Amara\\.org community\\.?)",
        options: [.caseInsensitive]
    )

    private static let whitespace = try! NSRegularExpression(pattern: "\\s+")

    public static func clean(_ raw: String) -> String {
        var text = raw
        for regex in [nonSpeech, hallucinations] {
            text = regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
        }
        text = whitespace.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " ")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Übrig gebliebene Satzzeichen ohne Inhalt (".", "…") verwerfen.
        if text.unicodeScalars.allSatisfy({ CharacterSet.punctuationCharacters.contains($0) || CharacterSet.whitespaces.contains($0) }) {
            return ""
        }
        return text
    }
}
