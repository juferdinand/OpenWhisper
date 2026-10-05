import AppKit
import os
import Security

private let updateLog = Logger(subsystem: "io.github.whisperfree", category: "update")

/// Prüft GitHub Releases auf neue Versionen und installiert sie per Klick.
///
/// Sicherheit: Ein heruntergeladenes Update wird nur installiert, wenn seine Code-Signatur die
/// Designated Requirement der laufenden App erfüllt – also mit demselben Zertifikat signiert ist.
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

    /// "owner/repo" aus der Info.plist (WFUpdateRepository). Leer → Updates deaktiviert.
    let repository: String? = {
        let value = Bundle.main.object(forInfoDictionaryKey: "WFUpdateRepository") as? String
        guard let value, value.contains("/"), !value.hasPrefix("OWNER") else { return nil }
        return value
    }()

    var currentVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    var availableRelease: Release? {
        if case .available(let release) = status { return release }
        return nil
    }

    private var timer: Timer?
    private var downloadObservation: NSKeyValueObservation?

    func startAutomaticChecks() {
        guard repository != nil else { return }
        timer?.invalidate()
        // Einmal kurz nach dem Start, danach alle 24 Stunden.
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
            status = .failed("Kein Update-Repository konfiguriert")
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
                throw UpdateError.message("GitHub antwortete mit HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
            }
            let release = try JSONDecoder().decode(GitHubRelease.self, from: data)
            lastCheck = Date()
            let version = release.tagName.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))
            guard Self.isNewer(version, than: currentVersion) else {
                status = .upToDate
                return
            }
            // Ein Release enthält Artefakte für alle Plattformen – hier nur das macOS-Zip.
            let zips = release.assets.filter { $0.name.lowercased().hasSuffix(".zip") }
            guard let asset = zips.first(where: { $0.name.lowercased().contains("macos") }) ?? zips.first else {
                throw UpdateError.message("Release \(release.tagName) enthält keine .zip-Datei")
            }
            status = .available(Release(version: version, notes: release.body ?? "",
                                        assetURL: asset.browserDownloadURL, pageURL: release.htmlURL))
            updateLog.notice("Update verfügbar: \(version, privacy: .public)")
        } catch {
            status = .failed(error.localizedDescription)
            updateLog.error("Update-Prüfung fehlgeschlagen: \(error.localizedDescription, privacy: .public)")
        }
    }

    func install() {
        guard let release = availableRelease else { return }
        status = .downloading(0)
        let task = URLSession.shared.downloadTask(with: release.assetURL) { tempURL, response, error in
            // Datei muss noch im Callback verschoben werden.
            let result: Result<URL, Error>
            if let error {
                result = .failure(error)
            } else if let tempURL, (response as? HTTPURLResponse)?.statusCode == 200 {
                let kept = FileManager.default.temporaryDirectory.appendingPathComponent("WhisperFree-update-\(UUID().uuidString).zip")
                result = Result { try FileManager.default.moveItem(at: tempURL, to: kept); return kept }
            } else {
                result = .failure(UpdateError.message("Download fehlgeschlagen"))
            }
            DispatchQueue.main.async {
                UpdateService.shared.finishDownload(result)
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

    private func finishDownload(_ result: Result<URL, Error>) {
        downloadObservation = nil
        switch result {
        case .failure(let error):
            status = .failed(error.localizedDescription)
        case .success(let zip):
            status = .installing
            Task.detached {
                do {
                    let newApp = try Self.unpackAndVerify(zip)
                    await MainActor.run { UpdateService.shared.replaceAndRelaunch(with: newApp) }
                } catch {
                    await MainActor.run { UpdateService.shared.status = .failed(error.localizedDescription) }
                }
            }
        }
    }

    private nonisolated static func unpackAndVerify(_ zip: URL) throws -> URL {
        let folder = zip.deletingPathExtension()
        try? FileManager.default.removeItem(at: folder)
        try run("/usr/bin/ditto", ["-x", "-k", zip.path, folder.path])
        try? FileManager.default.removeItem(at: zip)

        guard let app = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            .first(where: { $0.pathExtension == "app" }) else {
            throw UpdateError.message("Keine App im Update gefunden")
        }
        try verifySignature(of: app)
        return app
    }

    /// Das Update muss dieselbe Designated Requirement erfüllen wie die laufende App.
    private nonisolated static func verifySignature(of app: URL) throws {
        var selfCode: SecCode?
        var requirement: SecRequirement?
        var staticSelf: SecStaticCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode,
              SecCodeCopyStaticCode(selfCode, [], &staticSelf) == errSecSuccess, let staticSelf,
              SecCodeCopyDesignatedRequirement(staticSelf, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateError.message("Eigene Signatur konnte nicht gelesen werden")
        }
        var newCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &newCode) == errSecSuccess, let newCode else {
            throw UpdateError.message("Update ist nicht signiert")
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
        let status = SecStaticCodeCheckValidity(newCode, flags, requirement)
        guard status == errSecSuccess else {
            throw UpdateError.message("Signatur des Updates passt nicht (\(status)) – Installation abgebrochen")
        }
    }

    /// Ein kleines Shell-Skript wartet, bis die App beendet ist, tauscht das Bundle aus und startet neu.
    private func replaceAndRelaunch(with newApp: URL) {
        let current = Bundle.main.bundleURL
        guard let script = Bundle.main.url(forResource: "install-update", withExtension: "sh") else {
            status = .failed("Update-Installer fehlt im App-Bundle")
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Dateinamen dürfen weder Command Substitution noch neue Shell-Befehle auslösen.
        process.arguments = [script.path, String(ProcessInfo.processInfo.processIdentifier),
                             current.path, newApp.path, newApp.deletingLastPathComponent().path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        do {
            try process.run()
            updateLog.notice("Update wird installiert, App startet neu")
            NSApp.terminate(nil)
        } catch {
            status = .failed("Installation fehlgeschlagen: \(error.localizedDescription)")
        }
    }

    private nonisolated static func run(_ tool: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw UpdateError.message("\(tool) fehlgeschlagen") }
    }

    /// Vergleicht "1.2.10" numerisch mit "1.2.9".
    nonisolated static func isNewer(_ candidate: String, than current: String) -> Bool {
        let a = candidate.split(separator: ".").map { Int($0) ?? 0 }
        let b = current.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
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
    }
}
