import Foundation
import Testing

private let installerScript = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent("Resources/install-update.sh")

struct UpdateInstallerTests {
    @Test(arguments: [
        "WhisperFree with spaces.app",
        "WhisperFree$(touch injected).app",
        "WhisperFree`touch injected`.app",
        "WhisperFree\"; touch injected; #.app",
    ])
    func treatsFileNamesAsData(_ appName: String) throws {
        let fixture = try InstallerFixture(appName: appName)
        defer { fixture.cleanup() }

        let status = try fixture.install()

        #expect(status == 0)
        #expect(try String(contentsOf: fixture.current.appendingPathComponent("content.txt"), encoding: .utf8) == "new")
        #expect(try String(contentsOf: fixture.openLog, encoding: .utf8) == fixture.current.path)
        #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("injected").path))
        #expect(!FileManager.default.fileExists(atPath: fixture.staging.path))
    }

    @Test func restoresOriginalIfReplacementFails() throws {
        let fixture = try InstallerFixture(appName: "WhisperFree.app")
        defer { fixture.cleanup() }

        let status = try fixture.install(failReplacement: true)

        #expect(status != 0)
        #expect(try String(contentsOf: fixture.current.appendingPathComponent("content.txt"), encoding: .utf8) == "old")
        #expect(try String(contentsOf: fixture.openLog, encoding: .utf8) == fixture.current.path)
        #expect(FileManager.default.fileExists(atPath: fixture.updated.path))
    }
}

private struct InstallerFixture {
    let root: URL
    let current: URL
    let staging: URL
    let updated: URL
    let tools: URL
    let openLog: URL

    init(appName: String) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("WhisperFree-installer-test-\(UUID().uuidString)")
        current = root.appendingPathComponent("Applications").appendingPathComponent(appName)
        staging = root.appendingPathComponent("staging")
        updated = staging.appendingPathComponent(appName)
        tools = root.appendingPathComponent("tools")
        openLog = root.appendingPathComponent("opened.txt")
        for directory in [current, updated, tools] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try "old".write(to: current.appendingPathComponent("content.txt"), atomically: true, encoding: .utf8)
        try "new".write(to: updated.appendingPathComponent("content.txt"), atomically: true, encoding: .utf8)

        // Im Test werden nur Launch Services und xattr ersetzt; die Dateioperationen sind echt.
        try writeTool("open", body: "printf '%s' \"$1\" > \"$WF_TEST_OPEN_LOG\"")
        try writeTool("xattr", body: "exit 0")
        try writeTool("mv", body: """
        if [ "${WF_TEST_FAIL_SOURCE:-}" = "$1" ]; then exit 1; fi
        exec /bin/mv "$@"
        """)
    }

    private func writeTool(_ name: String, body: String) throws {
        let file = tools.appendingPathComponent(name)
        try ("#!/bin/sh\n" + body + "\n").write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
    }

    func install(failReplacement: Bool = false) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [installerScript.path, "99999999", current.path, updated.path, staging.path]
        process.currentDirectoryURL = root
        process.environment = [
            "PATH": tools.path + ":/usr/bin:/bin",
            "WF_TEST_OPEN_LOG": openLog.path,
            "WF_TEST_FAIL_SOURCE": failReplacement ? updated.path : "",
        ]
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: root)
    }
}
