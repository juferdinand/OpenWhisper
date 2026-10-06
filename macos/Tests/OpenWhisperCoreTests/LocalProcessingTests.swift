import Foundation
import Darwin
import Testing
@testable import OpenWhisperCore

private let processingSharedDirectory = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("shared")

private func enabledProfile() -> LocalProcessingProfile {
    var profile = LocalProcessingProfile()
    profile.enabled = true; profile.model = "owned-fixture"
    return profile
}

/// Poll on a utility queue so fixture pipes never block Swift's cooperative executor.
private func readOwnedProcessingLine(_ handle: FileHandle, timeoutNanoseconds: UInt64 = 5_000_000_000) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
            do {
                let descriptorNumber = handle.fileDescriptor
                guard descriptorNumber >= 0, Darwin.fcntl(descriptorNumber, F_GETFD) >= 0 else {
                    throw LocalProcessingError.message("Owned fixture pipe descriptor is invalid (fd=\(descriptorNumber), errno=\(errno))")
                }
                let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
                var line = Data()
                while line.count < 100000 {
                    let now = DispatchTime.now().uptimeNanoseconds
                    guard now < deadline else { throw LocalProcessingError.message("Owned fixture pipe read timed out") }
                    var descriptor = pollfd(fd: descriptorNumber, events: Int16(POLLIN), revents: 0)
                    let ready = Darwin.poll(&descriptor, 1, Int32((deadline - now + 999999) / 1000000))
                    if ready < 0 && errno == EINTR { continue }
                    guard ready >= 0 else { throw LocalProcessingError.message("Owned fixture pipe poll failed (fd=\(descriptorNumber), errno=\(errno))") }
                    guard ready > 0 else { throw LocalProcessingError.message("Owned fixture pipe read timed out (fd=\(descriptorNumber), bytes=\(line.count))") }
                    var byte: UInt8 = 0
                    let count = Darwin.read(descriptorNumber, &byte, 1)
                    if count < 0 && errno == EINTR { continue }
                    guard count == 1 else {
                        throw LocalProcessingError.message("Owned fixture exited before completing its response")
                    }
                    if byte == 10 { continuation.resume(returning: line); return }
                    line.append(byte)
                }
                throw LocalProcessingError.message("Owned fixture response exceeded its limit")
            } catch { continuation.resume(throwing: error) }
        }
    }
}

/// Only synthetic fixture stderr is collected, and never its captured request or response body.
private func ownedProcessingFailure(_ error: any Error, phase: String, fixture: URL,
                                    process: Process, started: Bool, errorOutput: Pipe) -> LocalProcessingError {
    var bytes = [UInt8](repeating: 0, count: 4096)
    var descriptor = pollfd(fd: errorOutput.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
    let count = Darwin.poll(&descriptor, 1, 0) > 0
        ? Darwin.read(descriptor.fd, &bytes, bytes.count) : 0
    let detail = count > 0 ? String(reflecting: String(decoding: bytes.prefix(count), as: UTF8.self)) : "<empty>"
    let status = !started ? "not launched" : (process.isRunning ? "running" : "exited \(process.terminationStatus)")
    return .message("Owned fixture \(phase) failed: \(error.localizedDescription); process=\(status); fixture=\(fixture.path); stderr=\(detail)")
}

private final class OwnedProcessingServer {
    let process = Process()
    let output = Pipe()
    let errorOutput = Pipe()
    private let fixture = processingSharedDirectory.appendingPathComponent("tests/local-processing-server.py")
    private(set) var endpoint = ""
    init(provider: String = "lm_studio", status: Int = 200, delay: Double = 0, bodyDelay: Double = 0, response: String = "valid") async throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", fixture.path,
                             "--provider", provider, "--status", String(status), "--delay", String(delay), "--body-delay", String(bodyDelay), "--response", response]
        process.standardOutput = output
        process.standardError = errorOutput
        process.standardInput = FileHandle.nullDevice
        var started = false
        do {
            guard FileManager.default.fileExists(atPath: fixture.path) else {
                throw LocalProcessingError.message("Owned fixture script is missing")
            }
            try process.run()
            started = true
            // Process owns closing parent writers when standardOutput/standardError are Pipe objects.
            let line = try await readOwnedProcessingLine(output.fileHandleForReading)
            guard let port = String(data: line, encoding: .utf8), Int(port) != nil else { throw LocalProcessingError.message("Owned fixture could not start") }
            endpoint = "http://127.0.0.1:\(port)" + (provider == "lm_studio" ? "/v1" : "")
        } catch {
            let failure = ownedProcessingFailure(error, phase: "startup", fixture: fixture, process: process,
                                                 started: started, errorOutput: errorOutput)
            if process.isRunning { process.terminate() }
            try? output.fileHandleForReading.close()
            try? errorOutput.fileHandleForReading.close()
            throw failure
        }
    }
    func capturedRequest() async throws -> [String: Any] {
        do {
            let line = try await readOwnedProcessingLine(output.fileHandleForReading)
            return try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
        } catch {
            throw ownedProcessingFailure(error, phase: "request capture", fixture: fixture, process: process,
                                         started: true, errorOutput: errorOutput)
        }
    }
    deinit {
        if process.isRunning { process.terminate() }
        try? output.fileHandleForReading.close()
        try? errorOutput.fileHandleForReading.close()
    }
}

struct LocalProcessingTests {
    @Test func ownedFixtureProcessPipeYieldsACompleteLine() async throws {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/printf")
        process.arguments = ["owned-pipe-probe\\n"]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        defer {
            if process.isRunning { process.terminate() }
            try? output.fileHandleForReading.close()
        }
        try process.run()
        #expect(try await readOwnedProcessingLine(output.fileHandleForReading) == Data("owned-pipe-probe".utf8))
    }

    @Test func ownedFixturePipeEOFAndDeadlineFailExplicitly() async throws {
        let ended = Pipe()
        try ended.fileHandleForWriting.close()
        defer { try? ended.fileHandleForReading.close() }
        do {
            _ = try await readOwnedProcessingLine(ended.fileHandleForReading)
            Issue.record("Expected explicit fixture EOF")
        } catch { #expect(error.localizedDescription.contains("exited")) }
        let silent = Pipe()
        defer {
            try? silent.fileHandleForWriting.close()
            try? silent.fileHandleForReading.close()
        }
        do {
            _ = try await readOwnedProcessingLine(silent.fileHandleForReading, timeoutNanoseconds: 100_000_000)
            Issue.record("Expected explicit fixture deadline")
        } catch { #expect(error.localizedDescription.contains("timed out")) }
    }

    @Test func sharedEndpointAndOutputContractsMatch() throws {
        let schema = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: processingSharedDirectory.appendingPathComponent("local-processing.schema.json"))) as? [String: Any])
        let properties = try #require(schema["properties"] as? [String: [String: Any]])
        let required = try #require(schema["required"] as? [String])
        let defaults = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(LocalProcessingProfile())) as? [String: Any])
        for (key, value) in defaults {
            #expect(NSDictionary(dictionary: ["value": value]).isEqual(to: ["value": properties[key]!["default"]!]))
            #expect(required.contains(key))
        }
        let data = try Data(contentsOf: processingSharedDirectory.appendingPathComponent("local-processing-vectors.json"))
        let vectors = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for value in try #require(vectors["valid_endpoints"] as? [[String: String]]) {
            var profile = enabledProfile(); profile.provider = value["provider"]!; profile.endpoint = value["endpoint"]!
            #expect(try profile.requestURL().absoluteString == value["request_url"])
        }
        for endpoint in try #require(vectors["invalid_endpoints"] as? [String]) {
            var profile = enabledProfile(); profile.endpoint = endpoint
            #expect(throws: LocalProcessingError.self) { try profile.validate() }
        }
        for value in try #require(vectors["responses"] as? [[String: Any]]) {
            var profile = enabledProfile(); profile.provider = value["provider"] as! String
            let response = try JSONSerialization.data(withJSONObject: value["value"]!)
            if let expected = value["expected"] as? String { #expect(try profile.output(from: response) == expected) }
            else { #expect(throws: LocalProcessingError.self) { try profile.output(from: response) } }
        }
        for value in try #require(vectors["invalid_profiles"] as? [[String: Any]]) {
            let data = try JSONSerialization.data(withJSONObject: value)
            #expect(throws: (any Error).self) {
                let profile = try JSONDecoder().decode(LocalProcessingProfile.self, from: data)
                try profile.validate()
            }
        }
        for value in try #require(vectors["valid_profile_patches"] as? [[String: Any]]) {
            let data = try JSONSerialization.data(withJSONObject: value)
            try JSONDecoder().decode(LocalProcessingProfile.self, from: data).validate()
        }
        #expect(throws: LocalProcessingError.self) { try LocalProcessingProfile().requestBody(text: "Original") }
        #expect(throws: LocalProcessingError.self) { try enabledProfile().requestBody(text: String(repeating: "x", count: 65537)) }
    }

    @Test func bothAdaptersUseOwnedHTTPServersAndPreserveOriginalInput() async throws {
        for provider in ["lm_studio", "ollama"] {
            let server = try await OwnedProcessingServer(provider: provider)
            var profile = enabledProfile(); profile.provider = provider; profile.endpoint = server.endpoint; profile.instruction = "Synthetic instruction"
            #expect(try await LocalProcessingService().preview(requestID: UUID().uuidString, profile: profile, text: "Synthetic German: Wünsche.") == "A structured fixture plan.")
            let capture = try await server.capturedRequest(), body = try #require(capture["body"] as? [String: Any])
            #expect(capture["path"] as? String == (provider == "lm_studio" ? "/v1/chat/completions" : "/api/chat"))
            #expect(capture["authorization"] is NSNull)
            #expect(body["model"] as? String == "owned-fixture")
            #expect(body["stream"] as? Bool == false)
            let messages = try #require(body["messages"] as? [[String: String]])
            #expect(messages[0]["content"] == "Synthetic instruction")
            #expect(messages[1]["content"] == "Synthetic German: Wünsche.")
        }
    }

    @Test func failuresRejectRedirectsAndBoundRepliesWithoutExposingServerDetails() async throws {
        for (status, response) in [(302, "valid"), (401, "valid"), (500, "valid"), (200, "invalid"), (200, "oversized")] {
            let server = try await OwnedProcessingServer(status: status, response: response)
            var profile = enabledProfile(); profile.endpoint = server.endpoint
            do {
                _ = try await LocalProcessingService().preview(requestID: UUID().uuidString, profile: profile, text: "Original")
                Issue.record("Expected a bounded fixture failure")
            } catch {
                #expect(!error.localizedDescription.contains("private"))
                if status != 200 { #expect(error.localizedDescription.contains("server rejected")) }
            }
        }
    }

    @Test func timeoutAndCancellationKeepOriginalInputAndAllowAnotherPreview() async throws {
        let timedServer = try await OwnedProcessingServer(delay: 2)
        var timed = enabledProfile(); timed.endpoint = timedServer.endpoint; timed.timeout_seconds = 1
        do {
            _ = try await LocalProcessingService().preview(requestID: "timeout", profile: timed, text: "Original")
            Issue.record("Expected a timeout")
        } catch { #expect(error.localizedDescription.contains("timed out")) }
        let server = try await OwnedProcessingServer(delay: 3)
        var profile = enabledProfile(); profile.endpoint = server.endpoint
        let service = LocalProcessingService()
        let running = Task { try await service.preview(requestID: "owned-request", profile: profile, text: "Original") }
        _ = try await server.capturedRequest()
        await service.cancel(requestID: "different-request")
        do {
            _ = try await service.preview(requestID: "another", profile: profile, text: "Original")
            Issue.record("Expected one active preview")
        } catch { #expect(error.localizedDescription.contains("already running")) }
        await service.cancel(requestID: "owned-request")
        do { _ = try await running.value; Issue.record("Expected cancellation") }
        catch { #expect(error.localizedDescription.contains("cancelled")) }
        do { _ = try await service.preview(requestID: "next", profile: LocalProcessingProfile(), text: "Original"); Issue.record("Expected disabled preview") }
        catch { #expect(error.localizedDescription.contains("disabled")) }
    }

    @Test func responseBoundsAndTimeoutApplyWhileReadingTheBody() async throws {
        for (response, delay, expected) in [("chunked-oversized", 0.0, "exceeded"), ("valid", 2.0, "timed out")] {
            let server = try await OwnedProcessingServer(bodyDelay: delay, response: response)
            var profile = enabledProfile(); profile.endpoint = server.endpoint; profile.timeout_seconds = 1
            do {
                _ = try await LocalProcessingService().preview(requestID: UUID().uuidString, profile: profile, text: "Synthetic original")
                Issue.record("Expected a bounded streaming fixture failure")
            } catch { #expect(error.localizedDescription.contains(expected)) }
        }
    }
}
