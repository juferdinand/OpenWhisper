import Foundation

public enum UpdateArchive {
    /// Use a fresh private directory and retain bsdtar's path traversal protections.
    public static func extract(_ zip: URL) throws -> URL {
        let manager = FileManager.default
        let folder = manager.temporaryDirectory.appendingPathComponent("WhisperFree-stage-\(UUID().uuidString)")
        try manager.createDirectory(at: folder, withIntermediateDirectories: false,
                                    attributes: [.posixPermissions: 0o700])
        do {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            // Do not use -P: it disables checks for .. and symlink traversal.
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
