import AppKit
import os
import Security
import OpenWhisperCore

private let updateLog = Logger(subsystem: "io.github.whisperfree", category: "update")

/// Checks GitHub Releases for new versions and installs them on request.
///
/// Security: a downloaded update is installed only if its code signature satisfies the
/// running app's designated requirement, preserving the same signing certificate.
@MainActor
final class UpdateService: ObservableObject {
    static let shared = UpdateService()

    enum Status: Equatable {
        case idle
        case checking
        case upToDate
        case available(Release)
        case downloading(Double)
        case installing
        case failed(String)
    }

    struct Release: Equatable {
        let version: String
        let notes: String
        let assetURL: URL
        let pageURL: URL
    }

    @Published private(set) var status: Status = .idle
    @Published private(set) var lastCheck: Date?

    /// "owner/repo" from Info.plist (WFUpdateRepository). Empty disables updates.
    let repository: String? = {
        let value = Bundle.main.object(forInfoDictionaryKey: "WFUpdateRepository") as? String
        guard let value, UpdatePolicy.isValidRepository(value), !value.hasPrefix("OWNER") else { return nil }
        return value
    }()

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    var availableRelease: Release? {
        if case .available(let release) = status { return release }
        return nil
    }

    var isInstalling: Bool {
        switch status {
        case .downloading, .installing: true
        default: false
        }
    }

    private var timer: Timer?
    private var downloadObservation: NSKeyValueObservation?

    func startAutomaticChecks() {
        guard repository != nil else { return }
        timer?.invalidate()
        // Once shortly after launch, then every 24 hours.
        timer = Timer.scheduledTimer(withTimeInterval: 24 * 60 * 60, repeats: true) { _ in
            Task { @MainActor in UpdateService.shared.checkIfEnabled() }
        }
        Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            checkIfEnabled()
        }
    }

    private func checkIfEnabled() {
        guard UserDefaults.standard.bool(forKey: Prefs.autoCheckUpdates) else { return }
        Task { await check() }
    }

    func check() async {
        guard let repository else {
            status = .failed("No update repository configured")
            return
        }
        switch status {
        case .checking, .downloading, .installing: return
        default: break
        }
        status = .checking
        do {
            var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw UpdateError.message("GitHub returned HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            lastCheck = Date()
            guard !release.draft, !release.prerelease,
                  let asset = release.assets.first(where: { $0.name == UpdatePolicy.assetName }) else {
                throw UpdateError.message("Release does not contain a supported macOS package")
            }
            let version = try UpdatePolicy.validateRelease(repository: repository, tag: release.tagName,
                assetName: asset.name, assetURL: asset.browserDownloadURL, pageURL: release.htmlURL)
            guard UpdatePolicy.isNewer(version, than: currentVersion) else {
                status = .upToDate
                return
            }
            status = .available(Release(version: version, notes: release.body ?? "",
                                        assetURL: asset.browserDownloadURL, pageURL: release.htmlURL))
            updateLog.notice("Update available: \(version, privacy: .public)")
        } catch {
            status = .failed(error.localizedDescription)
            updateLog.error("Update check failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func install() {
        guard let release = availableRelease else { return }
        guard !AppState.shared.phase.isBusy, AppState.shared.models.progress.isEmpty else {
            status = .failed("Finish dictation and model downloads before installing an update")
            return
        }
        status = .downloading(0)
        let task = URLSession.shared.downloadTask(with: release.assetURL) { tempURL, response, error in
            // Move the file before returning from this callback.
            let result: Result<URL, Error>
            if let error {
                result = .failure(error)
            } else if let tempURL, (response as? HTTPURLResponse)?.statusCode == 200 {
                let kept = FileManager.default.temporaryDirectory.appendingPathComponent("OpenWhisper-update-\(UUID().uuidString).zip")
                result = Result { try FileManager.default.moveItem(at: tempURL, to: kept); return kept }
            } else {
                result = .failure(UpdateError.message("Download failed"))
            }
            DispatchQueue.main.async {
                UpdateService.shared.finishDownload(result, expectedVersion: release.version)
            }
        }
        downloadObservation = task.progress.observe(\.fractionCompleted) { progress, _ in
            let value = progress.fractionCompleted
            DispatchQueue.main.async {
                if case .downloading = UpdateService.shared.status { UpdateService.shared.status = .downloading(value) }
            }
        }
        task.resume()
    }

    private func finishDownload(_ result: Result<URL, Error>, expectedVersion: String) {
        downloadObservation = nil
        switch result {
        case .failure(let error):
            status = .failed(error.localizedDescription)
        case .success(let zip):
            status = .installing
            let installedVersion = currentVersion
            let identifier = Bundle.main.bundleIdentifier ?? ""
            Task.detached {
                do {
                    let newApp = try Self.unpackAndVerify(zip, expectedVersion: expectedVersion,
                                                        currentVersion: installedVersion, identifier: identifier)
                    await MainActor.run { UpdateService.shared.replaceAndRelaunch(with: newApp) }
                } catch {
                    await MainActor.run { UpdateService.shared.status = .failed(error.localizedDescription) }
                }
            }
        }
    }

    private nonisolated static func unpackAndVerify(_ zip: URL, expectedVersion: String,
                                                   currentVersion: String, identifier: String) throws -> URL {
        defer { try? FileManager.default.removeItem(at: zip) }
        let app = try UpdateArchive.extract(zip)
        do {
            try verifySignature(of: app)
            try UpdatePolicy.validateBundle(at: app, expectedVersion: expectedVersion,
                                            currentVersion: currentVersion, bundleIdentifier: identifier)
            return app
        } catch {
            try? FileManager.default.removeItem(at: app.deletingLastPathComponent())
            throw error
        }
    }

    /// The update must satisfy the running app's designated requirement.
    private nonisolated static func verifySignature(of app: URL) throws {
        var selfCode: SecCode?
        var requirement: SecRequirement?
        var staticSelf: SecStaticCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
              SecCodeCopyStaticCode(selfCode, [], &staticSelf) == errSecSuccess, let staticSelf,
              SecCodeCopyDesignatedRequirement(staticSelf, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateError.message("Could not read the current app’s signature")
        }
        try UpdateSignatureVerifier.verify(app, requirement: requirement)
    }

    /// A small shell script waits for the app to exit, replaces the bundle, and relaunches it.
    private func replaceAndRelaunch(with newApp: URL) {
        let current = Bundle.main.bundleURL
        guard let script = Bundle.main.url(forResource: "install-update", withExtension: "sh") else {
            try? FileManager.default.removeItem(at: newApp.deletingLastPathComponent())
            status = .failed("Update installer is missing from the app bundle")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Filenames must not trigger command substitution or inject shell commands.
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier),
                             current.path, newApp.path, newApp.deletingLastPathComponent().path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        do {
            try process.run()
            updateLog.notice("Installing update; the app will restart")
            NSApp.terminate(nil)
        } catch {
            try? FileManager.default.removeItem(at: newApp.deletingLastPathComponent())
            status = .failed("Installation failed: \(error.localizedDescription)")
        }
    }
}

private enum UpdateError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let text) = self { return text }
        return nil
    }
}

private struct GitHubRelease: Decodable {
    let tagName: String
    let body: String?
    let htmlURL: URL
    let assets: [Asset]
    let draft: Bool
    let prerelease: Bool

    struct Asset: Decodable {
        let name: String
        let browserDownloadURL: URL

        enum CodingKeys: String, CodingKey {
            case name
            case browserDownloadURL = "browser_download_url"
        }
    }

    enum CodingKeys: String, CodingKey {
        case tagName = "tag_name"
        case body
        case htmlURL = "html_url"
        case assets
        case draft, prerelease
    }
}
