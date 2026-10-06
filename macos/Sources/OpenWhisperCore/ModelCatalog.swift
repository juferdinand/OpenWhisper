import Foundation

public enum ModelFamily: String, Codable, Sendable {
    /// OpenAI Whisper: ~99 languages, language selection, vocabulary prompt.
    case whisper
    /// NVIDIA Parakeet TDT v3: 25 European languages, automatic language detection, very fast.
    case parakeet

    public static func detect(fileName: String) -> ModelFamily {
        fileName.lowercased().contains("parakeet") ? .parakeet : .whisper
    }
}

public struct SpeechModel: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let family: ModelFamily
    public let file: String
    public let repository: String
    public let size: String
    public let note: String

    public init(id: String, title: String, family: ModelFamily, file: String, repository: String, size: String, note: String) {
        self.id = id
        self.title = title
        self.family = family
        self.file = file
        self.repository = repository
        self.size = size
        self.note = note
    }

    public var downloadURL: URL? {
        repository.isEmpty ? nil : URL(string: "https://huggingface.co/\(repository)/resolve/main/\(file)")
    }

    public var vendor: String {
        switch family {
        case .whisper: "OpenAI Whisper"
        case .parakeet: "NVIDIA Parakeet"
        }
    }
}

/// Shared catalog from shared/models.json; all platforms use the same file.
public struct ModelCatalog: Decodable, Sendable {
    public enum HardwareTier: String, Decodable, Sendable {
        case strong, weak, cpuOnly
    }

    public struct Pick: Decodable, Sendable {
        public let parakeet: String
        public let whisper: String
    }

    public let models: [SpeechModel]
    public let recommendations: [String: Pick]
    public let parakeetLanguages: [String]

    public static func load(from url: URL) throws -> ModelCatalog {
        try JSONDecoder().decode(ModelCatalog.self, from: Data(contentsOf: url))
    }

    public func model(id: String) -> SpeechModel? {
        models.first { $0.id == id }
    }

    /// Two hardware recommendations (Parakeet + Whisper), ordered by language suitability.
    public func recommendations(for tier: HardwareTier, language: String) -> [SpeechModel] {
        guard let pick = recommendations[tier.rawValue],
              let parakeet = model(id: pick.parakeet),
              let whisper = model(id: pick.whisper) else { return [] }
        return parakeetLanguages.contains(language) ? [parakeet, whisper] : [whisper, parakeet]
    }

    private enum CodingKeys: String, CodingKey {
        case models, recommendations, parakeetLanguages
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        models = try container.decode([SpeechModel].self, forKey: .models)
        parakeetLanguages = try container.decode([String].self, forKey: .parakeetLanguages)
        // Skip "$comment" entries.
        let raw = try container.decode([String: FailableDecodable<Pick>].self, forKey: .recommendations)
        recommendations = raw.compactMapValues(\.value)
    }
}

private struct FailableDecodable<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}
