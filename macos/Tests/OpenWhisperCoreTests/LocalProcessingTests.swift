import Foundation
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

private final class OwnedProcessingServer {
    let process = Process()
    let output = Pipe()
    let endpoint: String
    init(provider: String = "lm_studio", status: Int = 200, delay: Double = 0, bodyDelay: Double = 0, response: String = "valid") throws {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", processingSharedDirectory.appendingPathComponent("tests/local-processing-server.py").path,
                             "--provider", provider, "--status", String(status), "--delay", String(delay), "--body-delay", String(bodyDelay), "--response", response]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte[0] != 10 { line.append(byte) }
        guard let port = String(data: line, encoding: .utf8), Int(port) != nil else { throw LocalProcessingError.message("Owned fixture could not start") }
        endpoint = "http://127.0.0.1:\(port)" + (provider == "lm_studio" ? "/v1" : "")
    }
    func capturedRequest() throws -> [String: Any] {
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte[0] != 10 { line.append(byte) }
        return try #require(JSONSerialization.jsonObject(with: line) as? [String: Any])
    }
    deinit {
        if process.isRunning { process.terminate() }
        output.fileHandleForReading.closeFile()
    }
}

struct LocalProcessingTests {
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
            let server = try OwnedProcessingServer(provider: provider)
            var profile = enabledProfile(); profile.provider = provider; profile.endpoint = server.endpoint; profile.instruction = "Synthetic instruction"
            #expect(try await LocalProcessingService().preview(requestID: UUID().uuidString, profile: profile, text: "Synthetic German: Wünsche.") == "A structured fixture plan.")
            let capture = try server.capturedRequest(), body = try #require(capture["body"] as? [String: Any])
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
            let server = try OwnedProcessingServer(status: status, response: response)
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
        let timedServer = try OwnedProcessingServer(delay: 2)
        var timed = enabledProfile(); timed.endpoint = timedServer.endpoint; timed.timeout_seconds = 1
        do {
            _ = try await LocalProcessingService().preview(requestID: "timeout", profile: timed, text: "Original")
            Issue.record("Expected a timeout")
        } catch { #expect(error.localizedDescription.contains("timed out")) }
        let server = try OwnedProcessingServer(delay: 3)
        var profile = enabledProfile(); profile.endpoint = server.endpoint
        let service = LocalProcessingService()
        let running = Task { try await service.preview(requestID: "owned-request", profile: profile, text: "Original") }
        _ = try server.capturedRequest()
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
            let server = try OwnedProcessingServer(bodyDelay: delay, response: response)
            var profile = enabledProfile(); profile.endpoint = server.endpoint; profile.timeout_seconds = 1
            do {
                _ = try await LocalProcessingService().preview(requestID: UUID().uuidString, profile: profile, text: "Synthetic original")
                Issue.record("Expected a bounded streaming fixture failure")
            } catch { #expect(error.localizedDescription.contains(expected)) }
        }
    }
}
