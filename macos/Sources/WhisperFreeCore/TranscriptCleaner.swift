import Foundation

public enum TranscriptCleaner {
    /// Non-speech markers emitted by Whisper: [BLANK_AUDIO], [Music], (Applause), *laughs*, etc.
    private static let nonSpeech = try! NSRegularExpression(
        pattern: "\\[[^\\]]*\\]|\\([^)]*(musik|music|applaus|applause|lacht|laughs|stille|silence|geräusch|noise)[^)]*\\)|\\*[^*]+\\*",
        options: [.caseInsensitive]
    )

    /// Known subtitle-training hallucinations that can appear during silence.
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
        // Discard remaining punctuation without content (".", "…").
        if text.unicodeScalars.allSatisfy({ CharacterSet.punctuationCharacters.contains($0) || CharacterSet.whitespaces.contains($0) }) {
            return ""
        }
        return text
    }
}
