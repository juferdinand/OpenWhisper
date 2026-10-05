import Foundation

/// Ein gesprochenes Stichwort, das durch einen längeren Text ersetzt wird
/// (z. B. "mein YouTube Link" -> "https://youtube.com/@...").
public struct Snippet: Codable, Identifiable, Hashable, Sendable {
    public var id: UUID
    public var trigger: String
    public var expansion: String
    public var enabled: Bool

    public init(id: UUID = UUID(), trigger: String, expansion: String, enabled: Bool = true) {
        self.id = id
        self.trigger = trigger
        self.expansion = expansion
        self.enabled = enabled
    }
}

public enum SnippetExpander {
    /// Ersetzt alle aktiven Snippet-Trigger im Text.
    ///
    /// Groß-/Kleinschreibung ist egal, Leerzeichen und Bindestriche zwischen den Wörtern sind
    /// austauschbar ("YouTube-Kanal Link" == "youtube kanal-link"), weil Whisper das je nach
    /// Laune unterschiedlich schreibt. Besteht das ganze Diktat nur aus dem Trigger, wird
    /// ausschließlich die Expansion zurückgegeben (ohne den Punkt, den Whisper gern anhängt).
    public static func apply(_ text: String, snippets: [Snippet]) -> String {
        let active = snippets.filter { $0.enabled && !$0.trigger.trimmingCharacters(in: .whitespaces).isEmpty }
        guard !active.isEmpty else { return text }

        let bare = text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters))
        for snippet in active {
            if let regex = regex(for: snippet.trigger, anchored: true),
               regex.firstMatch(in: bare, range: NSRange(bare.startIndex..., in: bare)) != nil {
                return snippet.expansion
            }
        }

        var result = text
        for snippet in active {
            guard let regex = regex(for: snippet.trigger, anchored: false) else { continue }
            let template = NSRegularExpression.escapedTemplate(for: snippet.expansion)
            result = regex.stringByReplacingMatches(
                in: result,
                range: NSRange(result.startIndex..., in: result),
                withTemplate: template
            )
        }
        return result
    }

    static func regex(for trigger: String, anchored: Bool) -> NSRegularExpression? {
        let words = trigger
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" })
            .map { NSRegularExpression.escapedPattern(for: String($0)) }
        guard !words.isEmpty else { return nil }
        let body = words.joined(separator: "[\\s\\-]+")
        let pattern = anchored
            ? "^\(body)$"
            : "(?<![\\p{L}\\p{N}])\(body)(?![\\p{L}\\p{N}])"
        return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }
}
