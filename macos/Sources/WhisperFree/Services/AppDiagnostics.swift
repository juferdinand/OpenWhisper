import Foundation
import WhisperFreeCore

/// No audio, transcripts, vocabulary, clipboard contents, or device names are recorded.
/// macOS crash reports remain the source of exception types and native stack traces.
enum AppDiagnostics {
    static let shared = LifecycleJournal(directory: FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/WhisperFree", isDirectory: true))

    static func start() {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        shared.begin(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development",
                     system: ProcessInfo.processInfo.operatingSystemVersionString, architecture: architecture)
    }
}
