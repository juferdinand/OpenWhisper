import Foundation
import Testing
@testable import OpenWhisperCore

struct LifecycleJournalTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test func detectsUncleanExitAndRecordsLastStage() throws {
        let folder = try directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let first = LifecycleJournal(directory: folder)
        first.begin(version: "test", system: "test", architecture: "test")
        first.record("speech.transcribing")
        let next = LifecycleJournal(directory: folder)
        next.begin(version: "test", system: "test", architecture: "test")
        let log = try String(contentsOf: folder.appendingPathComponent("lifecycle.log"))
        #expect(log.contains("session.previous_exit_unclean"))
        #expect(log.contains("\"last_event\":\"speech.transcribing\""))
        next.finish()
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("session.json").path))
    }

    @Test func cleanExitDoesNotReportACrashAndLateEventsAreIgnored() throws {
        let folder = try directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let journal = LifecycleJournal(directory: folder)
        journal.begin(version: "test", system: "test", architecture: "test")
        journal.finish()
        journal.record("late.callback")
        journal.begin(version: "test", system: "test", architecture: "test")
        let log = try String(contentsOf: folder.appendingPathComponent("lifecycle.log"))
        #expect(!log.contains("previous_exit_unclean"))
        #expect(!log.contains("late.callback"))
        journal.finish()
    }

    @Test func concurrentEventsStayValidAndLogsAreBounded() throws {
        let folder = try directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let journal = LifecycleJournal(directory: folder, maximumBytes: 1024)
        journal.begin(version: "test", system: "test", architecture: "test")
        DispatchQueue.concurrentPerform(iterations: 100) { _ in journal.record("audio.stopped") }
        journal.finish()
        let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        #expect(files.count == 2)
        for file in files {
            let data = try Data(contentsOf: file)
            #expect(data.count <= 1024)
            for line in data.split(separator: 0x0a) {
                #expect(try JSONSerialization.jsonObject(with: Data(line)) is [String: String])
            }
            let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
            #expect(mode == 0o600)
        }
    }
}
