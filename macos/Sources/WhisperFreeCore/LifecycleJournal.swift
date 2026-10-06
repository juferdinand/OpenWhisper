import Foundation

/// Bounded, local lifecycle breadcrumbs. Callers pass event identifiers, never user content.
public final class LifecycleJournal: @unchecked Sendable {
    private let lock = NSLock()
    private let directory: URL
    private let maximumBytes: UInt64
    private var active = false
    private var log: URL { directory.appendingPathComponent("lifecycle.log") }
    private var previousLog: URL { directory.appendingPathComponent("lifecycle.previous.log") }
    private var marker: URL { directory.appendingPathComponent("session.json") }

    public init(directory: URL, maximumBytes: UInt64 = 256 * 1024) {
        self.directory = directory
        self.maximumBytes = maximumBytes
    }

    public func begin(version: String, system: String, architecture: String) {
        lock.withLock {
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                        attributes: [.posixPermissions: 0o700])
                active = true
                if let data = try? Data(contentsOf: marker),
                   let previous = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                    try write("session.previous_exit_unclean", metadata: ["last_event": previous["event"] ?? "unknown"])
                }
                try write("session.started", metadata: ["version": version, "system": system, "architecture": architecture])
            } catch { /* Diagnostics must never prevent the app from running. */ }
        }
    }

    public func record(_ event: String) {
        lock.withLock {
            guard active else { return }
            try? write(event)
        }
    }

    public func finish() {
        lock.withLock {
            guard active else { return }
            do {
                try write("session.ended_cleanly")
                try FileManager.default.removeItem(at: marker)
            } catch { /* Leave the last known state available for troubleshooting. */ }
            active = false
        }
    }

    private func write(_ event: String, metadata: [String: String] = [:]) throws {
        let manager = FileManager.default
        var entry = metadata
        entry["event"] = event
        entry["time"] = ISO8601DateFormatter().string(from: Date())
        var data = try JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys])
        data.append(0x0a)
        let size = (try? manager.attributesOfItem(atPath: log.path)[.size] as? UInt64) ?? 0
        if size + UInt64(data.count) > maximumBytes {
            if manager.fileExists(atPath: previousLog.path) { try manager.removeItem(at: previousLog) }
            if manager.fileExists(atPath: log.path) { try manager.moveItem(at: log, to: previousLog) }
        }
        if !manager.fileExists(atPath: log.path) {
            guard manager.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
        }
        let handle = try FileHandle(forWritingTo: log)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try data.write(to: marker, options: [.atomic])
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
    }
}
