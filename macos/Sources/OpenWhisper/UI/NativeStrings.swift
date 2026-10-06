import Foundation

/// Native menus share the same translations as the bundled settings UI.
enum NativeStrings {
    private static let german: [String: String] = {
        guard let root = Bundle.main.resourceURL,
              let data = try? Data(contentsOf: root.appendingPathComponent("WebUI/locales/de.json")),
              let messages = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return messages
    }()

    static func text(_ source: String, _ values: [String: String] = [:]) -> String {
        var message = UserDefaults.standard.string(forKey: Prefs.uiLanguage) == "de" ? german[source] ?? source : source
        for (key, value) in values { message = message.replacingOccurrences(of: "{\(key)}", with: value) }
        return message
    }
}
