import Foundation

/// A spoken phrase replaced with a longer text
/// (e.g. "my YouTube link" -> "https://youtube.com/@...").
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
    /// Replaces all enabled snippet triggers in the text.
    ///
    /// Matching ignores case and treats spaces and hyphens between words as interchangeable
    /// ("YouTube-Channel Link" == "youtube channel-link"), because Whisper can vary
    /// its spelling. If the entire dictation consists of the trigger, return only the
    /// expansion, without the period that Whisper often appends.
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
