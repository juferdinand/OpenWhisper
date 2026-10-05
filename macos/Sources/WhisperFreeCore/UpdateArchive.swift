import Foundation

public enum UpdateArchive {
    /// Neues privates Verzeichnis; bsdtar behält seine Schutzprüfungen gegen Pfadausbrüche.
    public static func extract(_ zip: URL) throws -> URL {
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent("WhisperFree-stage-\(UUID().uuidString)")
        try manager.createDirectory(at: folder, withIntermediateDirectories: false,
                                    attributes: [.posixPermissions: 0o700])
        do {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            // Kein -P: Das würde die Prüfungen für .. und Symlink-Traversierung deaktivieren.
            process.arguments = ["-x", "-f", zip.path, "-C", folder.path, "--no-same-owner"]
            process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw UpdateValidationError.invalidArchive }
            let app = folder.appendingPathComponent("WhisperFree.app")
            let attributes = try manager.attributesOfItem(atPath: app.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw UpdateValidationError.invalidArchive
            }
            let root = app.resolvingSymlinksInPath().path + "/"
            var enumerationFailed = false
            guard let entries = manager.enumerator(at: app, includingPropertiesForKeys: [.isSymbolicLinkKey],
                                                   errorHandler: { _, _ in enumerationFailed = true; return false }) else {
                throw UpdateValidationError.invalidArchive
            }
            for case let entry as URL in entries {
                if try entry.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink == true {
                    guard entry.resolvingSymlinksInPath().path.hasPrefix(root) else {
                        throw UpdateValidationError.invalidArchive
                    }
                }
            }
            guard !enumerationFailed else { throw UpdateValidationError.invalidArchive }
            return app
        } catch {
            try? manager.removeItem(at: folder)
            throw error
        }
    }
}
