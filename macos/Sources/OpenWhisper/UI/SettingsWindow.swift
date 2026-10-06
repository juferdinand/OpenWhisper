import AppKit
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case setup, general, models, snippets, history, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .setup: "Setup"
        case .general: "General"
        case .models: "Models"
        case .snippets: "Snippets"
        case .history: "History"
        case .about: "About"
        }
    }

    var symbol: String {
        switch self {
        case .setup: "checklist"
        case .general: "gearshape"
        case .models: "cpu"
        case .snippets: "text.badge.plus"
        case .history: "clock.arrow.circlepath"
        case .about: "info.circle"
        }
    }
}

/// Use a dedicated window because a menu bar-only app (LSUIElement) cannot reliably
/// bring a SwiftUI Settings scene to the front.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private var sharedView: SharedSettingsView?

    func show(tab: SettingsTab) {
        if window == nil {
            let view = SharedSettingsView(tab: tab)
            sharedView = view
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = "OpenWhisper"
            window.contentMinSize = NSSize(width: 800, height: 560)
            window.contentView = view.webView
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("WhisperFreeSettings")
            if !window.setFrameUsingName("WhisperFreeSettings") { window.center() }
            self.window = window
        }
        // Temporarily show a Dock icon so the settings window can receive focus.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        sharedView?.show(tab: tab)
    }

    func windowWillClose(_ notification: Notification) {
        AppDiagnostics.shared.record("ui.settings_closed")
        NSApp.setActivationPolicy(.accessory)
    }
}
