import Foundation

/// Corrects spelling after recognition using a list of names and technical terms.
///
/// Works with any model, including Parakeet, which does not accept a text prompt.
/// Compares normalized windows of 1–3 words (lowercase, without whitespace, punctuation,
/// or accents). Long terms allow small differences; short terms require exact matches
/// to avoid accidentally replacing ordinary words.
public enum VocabularyCorrector {
    public static func parse(_ vocabulary: String) -> [String] {
        vocabulary
            .split(whereSeparator: { $0 == "," || $0 == ";" || $0.isNewline })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { normalize($0).count >= 3 }
    }

    public static func apply(_ text: String, terms: [String]) -> String {
        guard !terms.isEmpty else { return text }
        let words = wordRanges(in: text)
        guard !words.isEmpty else { return text }

        struct Match { let first: Int; let last: Int; let term: String; let score: Double }
        var matches: [Match] = []

        for term in terms {
            let key = normalize(term)
            let termWordCount = max(1, term.split(whereSeparator: { $0.isWhitespace || $0 == "-" }).count)
            let maxWindow = min(3, termWordCount + 1)
            for start in words.indices {
                for length in 1...maxWindow where start + length <= words.count {
                    let candidate = words[start..<(start + length)].map { String(text[$0]) }.joined()
                    let score = similarity(normalize(candidate), key)
                    if score >= threshold(for: key.count) {
                        matches.append(Match(first: start, last: start + length - 1, term: term, score: score))
                    }
                }
            }
        }

        // Prefer the best match, then the longer one; discard overlapping matches.
        matches.sort { ($0.score, $0.last - $0.first) > ($1.score, $1.last - $1.first) }
        var used = IndexSet()
        var chosen: [Match] = []
        for match in matches where !used.contains(integersIn: match.first...match.last) {
            chosen.append(match)
            used.insert(integersIn: match.first...match.last)
        }

        var result = text
        for match in chosen.sorted(by: { $0.first > $1.first }) {
            let range = words[match.first].lowerBound..<words[match.last].upperBound
            // Map the range to the original: result has only changed after `range` so far.
            result.replaceSubrange(range, with: match.term)
        }
        return result
    }

    static func threshold(for length: Int) -> Double {
        switch length {
        case ..<5: 1.0     // "Jira" ≠ "Jura"
        case ..<8: 0.84    // 1 error
        default: 0.8       // ~2 errors in 10 characters
        }
    }

    static func normalize(_ string: String) -> String {
        string
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
            .unicodeScalars
            .filter { CharacterSet.alphanumerics.contains($0) }
            .map(String.init)
            .joined()
    }

    static func similarity(_ a: String, _ b: String) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        if a == b { return 1 }
        let x = Array(a), y = Array(b)
        var previous = Array(0...y.count)
        for i in 1...x.count {
            var current = [i] + Array(repeating: 0, count: y.count)
            for j in 1...y.count {
                current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] == y[j - 1] ? 0 : 1))
            }
            previous = current
        }
        return 1 - Double(previous[y.count]) / Double(max(x.count, y.count))
    }

    private static let wordPattern = try! NSRegularExpression(pattern: "[\\p{L}\\p{N}][\\p{L}\\p{N}'’\\-]*")

    private static func wordRanges(in text: String) -> [Range<String.Index>] {
        wordPattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
            .compactMap { Range($0.range, in: text) }
    }
}
