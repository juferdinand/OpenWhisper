import AppKit
import Foundation
import WhisperFreeCore

/// Chip und Arbeitsspeicher – für die Modell-Empfehlung.
struct MacHardware {
    let chip: String
    let memoryGB: Int
    let isAppleSilicon: Bool

    static let current: MacHardware = {
        var size = 0
        sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
        var buffer = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("machdep.cpu.brand_string", &buffer, &size, nil, 0)
        let chip = String(cString: buffer)
        #if arch(arm64)
        let appleSilicon = true
        #else
        let appleSilicon = false
        #endif
        return MacHardware(
            chip: chip.isEmpty ? (appleSilicon ? "Apple Silicon" : "Intel") : chip,
            memoryGB: Int((Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824).rounded()),
            isAppleSilicon: appleSilicon
        )
    }()

    var summary: String { "\(chip) · \(memoryGB) GB" }
}

/// Verwaltet die lokal gespeicherten Modelle. Der einzige Netzwerkzugriff dafür ist der
/// einmalige, explizit vom Nutzer gestartete Download von Hugging Face.
@MainActor
final class ModelManager: ObservableObject {
    /// Gemeinsamer Katalog aus shared/models.json (wird von build-app.sh ins Bundle kopiert).
    static let catalogData: ModelCatalog? = {
        guard let url = Bundle.main.url(forResource: "models", withExtension: "json") else { return nil }
        return try? ModelCatalog.load(from: url)
    }()

    static var catalog: [SpeechModel] { catalogData?.models ?? [] }

    struct Recommendation {
        let model: SpeechModel
        let reason: String
    }

    /// Zwei Vorschläge passend zu Hardware und Systemsprache; der erste ist der Standard.
    static var recommendations: [Recommendation] {
        guard let catalogData else { return [] }
        let hw = MacHardware.current
        let tier: ModelCatalog.HardwareTier = !hw.isAppleSilicon ? .cpuOnly : (hw.memoryGB >= 8 ? .strong : .weak)
        let language = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
        return catalogData.recommendations(for: tier, language: language).map { model in
            Recommendation(model: model, reason: model.family == .parakeet
                ? "Beste Wahl für Deutsch & europäische Sprachen"
                : "Alle ~99 Sprachen + Vokabular-Prompt")
        }
    }

    static var recommendedID: String { recommendations.first?.model.id ?? "large-v3-turbo-q5_0" }

    @Published private(set) var installed: Set<String> = []
    @Published private(set) var progress: [String: Double] = [:]
    @Published var lastError: String?
    @Published var selectedID: String {
        didSet { UserDefaults.standard.set(selectedID, forKey: Prefs.selectedModel) }
    }

    private var tasks: [String: URLSessionDownloadTask] = [:]
    private var observations: [String: NSKeyValueObservation] = [:]

    let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("WhisperFree/Models", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    init() {
        selectedID = UserDefaults.standard.string(forKey: Prefs.selectedModel) ?? Self.recommendedID
        refresh()
    }

    /// Alle Modelle im Ordner – auch selbst importierte, die nicht im Katalog stehen.
    var allModels: [SpeechModel] {
        Self.catalog + importedModels
    }

    var importedModels: [SpeechModel] {
        installed
            .filter { id in !Self.catalog.contains { $0.id == id } }
            .sorted()
            .map { SpeechModel(id: $0, title: $0, family: ModelFamily.detect(fileName: $0), file: "\($0).bin",
                               repository: "", size: "", note: "Importiert") }
    }

    var selectedModel: SpeechModel? {
        allModels.first { $0.id == selectedID }
    }

    var selectedModelPath: String? {
        guard installed.contains(selectedID) else { return nil }
        return url(forID: selectedID).path
    }

    var hasAnyModel: Bool { !installed.isEmpty }

    func url(forID id: String) -> URL {
        let file = Self.catalog.first { $0.id == id }?.file ?? "\(id).bin"
        return directory.appendingPathComponent(file)
    }

    func refresh() {
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        installed = Set(files.filter { $0.hasSuffix(".bin") }.map { file in
            Self.catalog.first { $0.file == file }?.id ?? String(file.dropLast(4))
        })
        // Falls das gewählte Modell fehlt, auf ein vorhandenes ausweichen.
        if !installed.contains(selectedID), let fallback = allModels.first(where: { installed.contains($0.id) }) {
            selectedID = fallback.id
        }
    }

    func isDownloading(_ model: SpeechModel) -> Bool { tasks[model.id] != nil }

    func download(_ model: SpeechModel) {
        guard tasks[model.id] == nil, let downloadURL = model.downloadURL else { return }
        lastError = nil
        let destination = url(forID: model.id)
        let task = URLSession.shared.downloadTask(with: downloadURL) { [weak self] tempURL, response, error in
            // Die temporäre Datei muss noch in diesem Callback verschoben werden.
            var failure: String?
            if let error {
                if (error as? URLError)?.code != .cancelled { failure = error.localizedDescription }
            } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                failure = "Server antwortete mit HTTP \(http.statusCode)"
            } else if let tempURL {
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: tempURL, to: destination)
                } catch {
                    failure = error.localizedDescription
                }
            }
            DispatchQueue.main.async {
                self?.finishDownload(model, error: failure)
            }
        }
        observations[model.id] = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            let value = progress.fractionCompleted
            DispatchQueue.main.async { self?.progress[model.id] = value }
        }
        tasks[model.id] = task
        progress[model.id] = 0
        task.resume()
    }

    func cancelDownload(_ model: SpeechModel) {
        tasks[model.id]?.cancel()
    }

    func delete(_ model: SpeechModel) {
        try? FileManager.default.removeItem(at: url(forID: model.id))
        refresh()
    }

    func importModel() {
        let panel = NSOpenPanel()
        panel.title = "ggml-Whisper-Modell auswählen"
        panel.allowedContentTypes = [.data]
        panel.allowsMultipleSelection = false
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let source = panel.url else { return }
        let name = source.deletingPathExtension().lastPathComponent
        let destination = directory.appendingPathComponent("\(name).bin")
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.copyItem(at: source, to: destination)
            refresh()
            selectedID = Self.catalog.first { $0.file == destination.lastPathComponent }?.id ?? name
        } catch {
            lastError = error.localizedDescription
        }
    }

    func revealInFinder() {
        NSWorkspace.shared.activateFileViewerSelecting([directory])
    }

    private func finishDownload(_ model: SpeechModel, error: String?) {
        tasks[model.id] = nil
        observations[model.id] = nil
        progress[model.id] = nil
        if let error {
            lastError = "Download von \(model.title) fehlgeschlagen: \(error)"
        }
        refresh()
        if error == nil, installed.contains(model.id), !installed.contains(selectedID) || installed.count == 1 {
            selectedID = model.id
        }
    }
}
