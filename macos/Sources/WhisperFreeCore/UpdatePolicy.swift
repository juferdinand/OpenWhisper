import Foundation

/// Strikte Grenzen für Metadaten aus der Release-API und dem heruntergeladenen Bundle.
public enum UpdatePolicy {
    public static let assetName = "WhisperFree-macOS.zip"

    public static func isValidRepository(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) == value.startIndex..<value.endIndex
            && ![".", ".."].contains(String(value.split(separator: "/").last ?? ""))
    }

    public static func versionComponents(_ value: String) -> [UInt64]? {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { return nil }
        var numbers: [UInt64] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy({ $0 >= "0" && $0 <= "9" }),
                  part.count == 1 || part.first != "0", let number = UInt64(part) else { return nil }
            numbers.append(number)
        }
        return numbers
    }

    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let a = versionComponents(candidate), let b = versionComponents(current) else { return false }
        return b.lexicographicallyPrecedes(a)
    }

    public static func validateRelease(repository: String, tag: String, assetName: String,
                                       assetURL: URL, pageURL: URL) throws -> String {
        guard isValidRepository(repository), tag.first == "v" else { throw UpdateValidationError.invalidRelease }
        let version = String(tag.dropFirst())
        guard versionComponents(version) != nil, assetName == Self.assetName,
              assetURL.absoluteString == "https://github.com/\(repository)/releases/download/\(tag)/\(Self.assetName)",
              pageURL.absoluteString == "https://github.com/\(repository)/releases/tag/\(tag)" else {
            throw UpdateValidationError.invalidRelease
        }
        return version
    }

    public static func validateBundle(at app: URL, expectedVersion: String,
                                      currentVersion: String, bundleIdentifier: String) throws {
        let plist = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        guard let info = try PropertyListSerialization.propertyList(from: plist, format: nil) as? [String: Any],
              info["CFBundleIdentifier"] as? String == bundleIdentifier,
              info["CFBundleShortVersionString"] as? String == expectedVersion,
              isNewer(expectedVersion, than: currentVersion) else {
            throw UpdateValidationError.invalidBundle
        }
    }
}

public enum UpdateValidationError: LocalizedError {
    case invalidRelease, invalidBundle, invalidArchive, invalidSignature(Int32)

    public var errorDescription: String? {
        switch self {
        case .invalidRelease: return "Ungültige Update-Quelle oder Release-Version"
        case .invalidBundle: return "App-Identität oder Version des Updates stimmt nicht überein"
        case .invalidArchive: return "Ungültiges oder unsicheres Update-Archiv"
        case .invalidSignature(let status): return "Signatur des Updates passt nicht (\(status)) – Installation abgebrochen"
        }
    }
}
