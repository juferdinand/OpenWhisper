import Foundation
import Testing
@testable import WhisperFreeCore

/// Die Testfälle liegen plattformübergreifend in shared/ – jede Implementierung muss sie bestehen.
private let sharedDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // WhisperFreeCoreTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // macos
    .deletingLastPathComponent()  // Repo-Wurzel
    .appendingPathComponent("shared")

private struct Vectors: Decodable {
    struct Case: Decodable, CustomTestStringConvertible {
        let name: String
        let input: String
        let expected: String
        var testDescription: String { name }
    }

    struct Vocabulary: Decodable {
        let terms: String
        let cases: [Case]
    }

    struct Snippets: Decodable {
        let snippets: [SnippetData]
        let cases: [Case]
    }

    struct SnippetData: Decodable {
        let trigger: String
        let expansion: String
        let enabled: Bool
    }

    let cleaner: [Case]
    let vocabulary: Vocabulary
    let snippets: Snippets

    static let shared: Vectors = {
        let data = try! Data(contentsOf: sharedDirectory.appendingPathComponent("test-vectors.json"))
        return try! JSONDecoder().decode(Vectors.self, from: data)
    }()
}

struct SharedVectorTests {
    @Test(arguments: Vectors.shared.cleaner)
    fileprivate func cleaner(_ testCase: Vectors.Case) {
        #expect(TranscriptCleaner.clean(testCase.input) == testCase.expected)
    }

    @Test(arguments: Vectors.shared.vocabulary.cases)
    fileprivate func vocabulary(_ testCase: Vectors.Case) {
        let terms = VocabularyCorrector.parse(Vectors.shared.vocabulary.terms)
        #expect(VocabularyCorrector.apply(testCase.input, terms: terms) == testCase.expected)
    }

    @Test(arguments: Vectors.shared.snippets.cases)
    fileprivate func snippets(_ testCase: Vectors.Case) {
        let snippets = Vectors.shared.snippets.snippets.map {
            Snippet(trigger: $0.trigger, expansion: $0.expansion, enabled: $0.enabled)
        }
        #expect(SnippetExpander.apply(testCase.input, snippets: snippets) == testCase.expected)
    }
}

struct ModelCatalogTests {
    let catalog = try! ModelCatalog.load(from: sharedDirectory.appendingPathComponent("models.json"))

    @Test func idsAreUnique() {
        #expect(Set(catalog.models.map(\.id)).count == catalog.models.count)
    }

    @Test func recommendationsReferenceExistingModels() {
        for tier in [ModelCatalog.HardwareTier.strong, .weak, .cpuOnly] {
            let picks = catalog.recommendations(for: tier, language: "de")
            #expect(picks.count == 2, "Tier \(tier.rawValue)")
        }
    }

    @Test func germanPrefersParakeetJapanesePrefersWhisper() {
        #expect(catalog.recommendations(for: .strong, language: "de").first?.family == .parakeet)
        #expect(catalog.recommendations(for: .strong, language: "ja").first?.family == .whisper)
    }

    @Test func familyMatchesFileName() {
        for model in catalog.models {
            #expect(ModelFamily.detect(fileName: model.file) == model.family, "\(model.id)")
        }
    }
}
