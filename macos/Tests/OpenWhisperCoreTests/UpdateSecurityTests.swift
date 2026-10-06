import Foundation
import Security
import Testing
@testable import OpenWhisperCore

struct UpdatePolicyTests {
    @Test func acceptsOnlyTheConfiguredReleaseAsset() throws {
        let version = try UpdatePolicy.validateRelease(repository: "owner/repo", tag: "v1.2.3",
            assetName: UpdatePolicy.assetName,
            assetURL: URL(string: "https://github.com/owner/repo/releases/download/v1.2.3/OpenWhisper-macOS.zip")!,
            pageURL: URL(string: "https://github.com/owner/repo/releases/tag/v1.2.3")!)
        #expect(version == "1.2.3")
    }

    @Test(arguments: [
        "http://github.com/owner/repo/releases/download/v1.2.3/OpenWhisper-macOS.zip",
        "https://github.com.attacker.test/owner/repo/releases/download/v1.2.3/OpenWhisper-macOS.zip",
        "https://github.com/other/repo/releases/download/v1.2.3/OpenWhisper-macOS.zip",
        "https://github.com/owner/repo/releases/download/v1.2.2/OpenWhisper-macOS.zip",
        "https://github.com/owner/repo/releases/download/v1.2.3/another.zip",
        "https://github.com/owner/repo/releases/download/v1.2.3/OpenWhisper-macOS.zip?redirect=elsewhere",
    ])
    func rejectsUnexpectedSource(_ source: String) {
        #expect(throws: (any Error).self) {
            try UpdatePolicy.validateRelease(repository: "owner/repo", tag: "v1.2.3",
                assetName: UpdatePolicy.assetName, assetURL: URL(string: source)!,
                pageURL: URL(string: "https://github.com/owner/repo/releases/tag/v1.2.3")!)
        }
    }

    @Test(arguments: ["", "1", "1.2", "1.2.3.4", "1.2.-3", "1.2.3-beta", "01.2.3", "1..3",
                      "1.2.3\n", "v1.2.3", "18446744073709551616.0.0"])
    func rejectsMalformedVersions(_ version: String) {
        #expect(UpdatePolicy.versionComponents(version) == nil)
        #expect(!UpdatePolicy.isNewer(version, than: "0.0.0"))
    }

    @Test func comparesVersionsNumericallyAndRejectsDowngrades() {
        #expect(UpdatePolicy.isNewer("1.2.10", than: "1.2.9"))
        #expect(!UpdatePolicy.isNewer("1.2.9", than: "1.2.10"))
        #expect(!UpdatePolicy.isNewer("1.2.10", than: "1.2.10"))
        #expect(!UpdatePolicy.isNewer("1.2.10", than: "broken"))
    }

    @Test func checksVersionInsideTheBundle() throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let app = try fixture.makeApp()
        try UpdatePolicy.validateBundle(at: app, expectedVersion: "1.2.3", currentVersion: "1.2.2",
                                        bundleIdentifier: "test.openwhisper.update")
        for (version, current, identifier) in [("1.2.4", "1.2.2", "test.openwhisper.update"),
                                             ("1.2.3", "1.2.3", "test.openwhisper.update"),
                                             ("1.2.3", "2.0.0", "test.openwhisper.update"),
                                             ("1.2.3", "1.2.2", "another.app")] {
            #expect(throws: (any Error).self) {
                try UpdatePolicy.validateBundle(at: app, expectedVersion: version, currentVersion: current,
                                                bundleIdentifier: identifier)
            }
        }
    }
}

struct UpdateSignatureTests {
    @Test func acceptsUntamperedBundleAndRejectsOtherIdentity() throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let app = try fixture.makeApp()
        try fixture.sign(app)
        let requirement = try fixture.requirement(app)
        try UpdateSignatureVerifier.verify(app, requirement: requirement)
        let other = try fixture.makeApp(name: "Other.app", identifier: "test.openwhisper.other")
        try fixture.sign(other)
        #expect(throws: (any Error).self) { try UpdateSignatureVerifier.verify(other, requirement: requirement) }
    }

    @Test(arguments: ["Contents/Resources/payload.txt", "Contents/MacOS/Test"])
    func rejectsTamperedSignedFiles(_ path: String) throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let app = try fixture.makeApp()
        try fixture.sign(app)
        let requirement = try fixture.requirement(app)
        let handle = try FileHandle(forWritingTo: app.appendingPathComponent(path))
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("tampered".utf8))
        try handle.close()
        #expect(throws: (any Error).self) { try UpdateSignatureVerifier.verify(app, requirement: requirement) }
    }

    @Test func rejectsUnsignedBundle() throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let app = try fixture.makeApp()
        try fixture.sign(app)
        let requirement = try fixture.requirement(app)
        try fixture.run("/usr/bin/codesign", ["--remove-signature", app.path])
        #expect(throws: (any Error).self) { try UpdateSignatureVerifier.verify(app, requirement: requirement) }
    }
}

struct UpdateArchiveTests {
    @Test func extractsDittoPackageAndPreservesItsSignature() throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let app = try fixture.makeApp()
        // Frameworks contain relative links like these; they must be preserved.
        try FileManager.default.createSymbolicLink(atPath: app.appendingPathComponent("Contents/Resources/link").path,
                                                  withDestinationPath: "payload.txt")
        try fixture.sign(app)
        let requirement = try fixture.requirement(app)
        let zip = fixture.root.appendingPathComponent("update.zip")
        try fixture.run("/usr/bin/ditto", ["-c", "-k", "--keepParent", app.path, zip.path])
        let extracted = try UpdateArchive.extract(zip)
        defer { try? FileManager.default.removeItem(at: extracted.deletingLastPathComponent()) }
        try UpdateSignatureVerifier.verify(extracted, requirement: requirement)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath:
            extracted.appendingPathComponent("Contents/Resources/link").path) == "payload.txt")
    }

    @Test(arguments: ["dotdot", "symlink-write", "external-symlink", "app-symlink", "missing-app", "corrupt"])
    func rejectsUnsafePackages(_ mode: String) throws {
        let fixture = try SecurityFixture()
        defer { fixture.cleanup() }
        let zip = fixture.root.appendingPathComponent("malicious.zip")
        let outside = fixture.root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try fixture.run("/usr/bin/python3", ["-c", """
        import os, stat, sys, zipfile
        archive, mode, outside = sys.argv[1:]
        if mode == 'corrupt':
            open(archive, 'wb').write(b'not a zip')
            sys.exit(0)
        with zipfile.ZipFile(archive, 'w') as z:
            def link(name, target):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                z.writestr(info, target)
            if mode == 'dotdot':
                z.writestr('../' + os.path.basename(os.path.dirname(outside)) + '/outside/marker', 'bad')
            elif mode == 'symlink-write':
                link('escape', outside)
                z.writestr('escape/marker', 'bad')
            elif mode == 'external-symlink':
                link('OpenWhisper.app/Contents/Resources/escape', outside)
            elif mode == 'app-symlink':
                link('OpenWhisper.app', outside)
            else:
                z.writestr('Other.app/Contents/Info.plist', 'bad')
        """, zip.path, mode, outside.path])
        #expect(throws: (any Error).self) { try UpdateArchive.extract(zip) }
        #expect(!FileManager.default.fileExists(atPath: outside.appendingPathComponent("marker").path))
    }
}

private struct SecurityFixture {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("OpenWhisper-security-\(UUID().uuidString)")

    init() throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    }

    func makeApp(name: String = "OpenWhisper.app", identifier: String = "test.openwhisper.update") throws -> URL {
        let app = root.appendingPathComponent(name)
        for path in ["Contents/MacOS", "Contents/Resources"] {
            try FileManager.default.createDirectory(at: app.appendingPathComponent(path), withIntermediateDirectories: true)
        }
        try FileManager.default.copyItem(at: URL(fileURLWithPath: "/usr/bin/true"),
                                         to: app.appendingPathComponent("Contents/MacOS/Test"))
        let plist = try PropertyListSerialization.data(fromPropertyList: [
            "CFBundleIdentifier": identifier, "CFBundleExecutable": "Test",
            "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "1.2.3",
        ], format: .xml, options: 0)
        try plist.write(to: app.appendingPathComponent("Contents/Info.plist"))
        try Data("original".utf8).write(to: app.appendingPathComponent("Contents/Resources/payload.txt"))
        return app
    }

    func sign(_ app: URL) throws {
        try run("/usr/bin/codesign", ["--force", "--sign", "-", app.path])
    }

    func requirement(_ app: URL) throws -> SecRequirement {
        var code: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code,
              SecCodeCopyDesignatedRequirement(code, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateValidationError.invalidBundle
        }
        return requirement
    }

    func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdateValidationError.invalidBundle }
    }

    func cleanup() { try? FileManager.default.removeItem(at: root) }
}
