import AppKit
import Foundation
import OpenWhisperCore

/// Bundled-app ATS evidence using fresh synthetic fixture processes, never a user's model server.
@MainActor
enum LocalProcessingSmokeTest {
    static func run() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            fputs("Bundled local processing smoke test timed out.\n", stderr)
            exit(1)
        }
        Task {
            do {
                guard Bundle.main.bundleURL.pathExtension == "app",
                      let fixture = ProcessInfo.processInfo.environment["WF_LOCAL_PROCESSING_FIXTURE"],
                      FileManager.default.fileExists(atPath: fixture) else {
                    throw LocalProcessingError.message("A bundled app and owned synthetic fixture are required")
                }
                for host in ["127.0.0.1", "::1"] {
                    for provider in ["lm_studio", "ollama"] {
                        let server = try Server(fixture: fixture, host: host, provider: provider)
                        var profile = LocalProcessingProfile()
                        profile.enabled = true
                        profile.model = "owned-fixture"
                        profile.instruction = "Synthetic instruction"
                        profile.provider = provider
                        profile.endpoint = server.endpoint
                        profile.timeout_seconds = 3
                        let result = try await LocalProcessingService().preview(
                            requestID: UUID().uuidString, profile: profile, text: "Synthetic German: Wünsche.")
                        let request = try server.capturedRequest()
                        guard result == "A structured fixture plan.",
                              request["path"] as? String == (provider == "lm_studio" ? "/v1/chat/completions" : "/api/chat"),
                              request["authorization"] is NSNull,
                              let body = request["body"] as? [String: Any],
                              body["model"] as? String == "owned-fixture",
                              let messages = body["messages"] as? [[String: String]], messages.count == 2,
                              messages[0]["content"] == "Synthetic instruction",
                              messages[1]["content"] == "Synthetic German: Wünsche." else {
                            throw LocalProcessingError.message("The owned server contract did not match")
                        }
                    }
                }
                print("Bundled local processing smoke test passed: both providers over owned IPv4 and IPv6 loopback HTTP, with separate instructions and original synthetic text.")
                NSApplication.shared.terminate(nil)
            } catch {
                fputs("Bundled local processing smoke test failed: \(error.localizedDescription)\n", stderr)
                exit(1)
            }
        }
    }

    private final class Server {
        let process = Process()
        let output = Pipe()
        let endpoint: String

        init(fixture: String, host: String, provider: String) throws {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["python3", fixture, "--provider", provider, "--host", host]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            let port = try Self.readLine(output.fileHandleForReading)
            guard let number = Int(port), (1...65535).contains(number) else {
                throw LocalProcessingError.message("The owned server could not start")
            }
            endpoint = "http://\(host == "::1" ? "[::1]" : host):\(number)" + (provider == "lm_studio" ? "/v1" : "")
        }

        func capturedRequest() throws -> [String: Any] {
            let line = try Self.readLine(output.fileHandleForReading)
            guard let data = line.data(using: .utf8),
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw LocalProcessingError.message("The owned server did not capture the request")
            }
            return value
        }

        private static func readLine(_ handle: FileHandle) throws -> String {
            var line = Data()
            while let byte = try handle.read(upToCount: 1), !byte.isEmpty, byte[0] != 10 {
                guard line.count < 100000 else { throw LocalProcessingError.message("The owned fixture exceeded its limit") }
                line.append(byte)
            }
            return String(data: line, encoding: .utf8) ?? ""
        }

        deinit {
            if process.isRunning { process.terminate() }
            output.fileHandleForReading.closeFile()
        }
    }
}
