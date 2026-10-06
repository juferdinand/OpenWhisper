import AppKit
import Foundation
import Darwin
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
                        let server = try await Server(fixture: fixture, host: host, provider: provider)
                        var profile = LocalProcessingProfile()
                        profile.enabled = true
                        profile.model = "owned-fixture"
                        profile.instruction = "Synthetic instruction"
                        profile.provider = provider
                        profile.endpoint = server.endpoint
                        profile.timeout_seconds = 3
                        let result = try await LocalProcessingService().preview(
                            requestID: UUID().uuidString, profile: profile, text: "Synthetic German: Wünsche.")
                        let request = try await server.capturedRequest()
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
        let errorOutput = Pipe()
        private let fixture: String
        private(set) var endpoint = ""

        init(fixture: String, host: String, provider: String) async throws {
            self.fixture = fixture
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["python3", fixture, "--provider", provider, "--host", host]
            process.standardOutput = output
            process.standardError = errorOutput
            process.standardInput = FileHandle.nullDevice
            var started = false
            do {
                guard FileManager.default.fileExists(atPath: fixture) else {
                    throw LocalProcessingError.message("The owned fixture script is missing")
                }
                try process.run()
                started = true
                // Process owns closing parent writers when its standard streams are Pipe objects.
                let port = try await Self.readLine(output.fileHandleForReading)
                guard let number = Int(port), (1...65535).contains(number) else {
                    throw LocalProcessingError.message("The owned server could not start")
                }
                endpoint = "http://\(host == "::1" ? "[::1]" : host):\(number)" + (provider == "lm_studio" ? "/v1" : "")
            } catch {
                let failure = diagnostic(error, phase: "startup", started: started)
                if process.isRunning { process.terminate() }
                try? output.fileHandleForReading.close()
                try? errorOutput.fileHandleForReading.close()
                throw failure
            }
        }

        func capturedRequest() async throws -> [String: Any] {
            do {
                let line = try await Self.readLine(output.fileHandleForReading)
                guard let data = line.data(using: .utf8),
                      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw LocalProcessingError.message("The owned server did not capture the request")
                }
                return value
            } catch {
                throw diagnostic(error, phase: "request capture", started: true)
            }
        }

        /// Bounded synthetic stderr only; captured requests and response bodies stay out of diagnostics.
        private func diagnostic(_ error: any Error, phase: String, started: Bool) -> LocalProcessingError {
            var bytes = [UInt8](repeating: 0, count: 4096)
            var descriptor = pollfd(fd: errorOutput.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
            let count = Darwin.poll(&descriptor, 1, 0) > 0
                ? Darwin.read(descriptor.fd, &bytes, bytes.count) : 0
            let detail = count > 0 ? String(reflecting: String(decoding: bytes.prefix(count), as: UTF8.self)) : "<empty>"
            let status = !started ? "not launched" : (process.isRunning ? "running" : "exited \(process.terminationStatus)")
            return .message("Owned fixture \(phase) failed: \(error.localizedDescription); process=\(status); fixture=\(fixture); stderr=\(detail)")
        }

        private static func readLine(_ handle: FileHandle) async throws -> String {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    do {
                        let descriptorNumber = handle.fileDescriptor
                        guard descriptorNumber >= 0, Darwin.fcntl(descriptorNumber, F_GETFD) >= 0 else {
                            throw LocalProcessingError.message("The owned fixture pipe descriptor is invalid (fd=\(descriptorNumber), errno=\(errno))")
                        }
                        let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
                        var line = Data()
                        while line.count < 100000 {
                            let now = DispatchTime.now().uptimeNanoseconds
                            guard now < deadline else { throw LocalProcessingError.message("The owned fixture pipe read timed out") }
                            var descriptor = pollfd(fd: descriptorNumber, events: Int16(POLLIN), revents: 0)
                            let ready = Darwin.poll(&descriptor, 1, Int32((deadline - now + 999999) / 1000000))
                            if ready < 0 && errno == EINTR { continue }
                            guard ready >= 0 else { throw LocalProcessingError.message("The owned fixture pipe poll failed (fd=\(descriptorNumber), errno=\(errno))") }
                            guard ready > 0 else { throw LocalProcessingError.message("The owned fixture pipe read timed out (fd=\(descriptorNumber), bytes=\(line.count))") }
                            var byte: UInt8 = 0
                            let count = Darwin.read(descriptorNumber, &byte, 1)
                            if count < 0 && errno == EINTR { continue }
                            guard count == 1 else {
                                throw LocalProcessingError.message("The owned fixture exited before completing its response")
                            }
                            if byte == 10 {
                                continuation.resume(returning: String(data: line, encoding: .utf8) ?? "")
                                return
                            }
                            line.append(byte)
                        }
                        throw LocalProcessingError.message("The owned fixture exceeded its limit")
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }

        deinit {
            if process.isRunning { process.terminate() }
            try? output.fileHandleForReading.close()
            try? errorOutput.fileHandleForReading.close()
        }
    }
}
