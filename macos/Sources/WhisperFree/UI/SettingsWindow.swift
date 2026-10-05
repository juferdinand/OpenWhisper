import AppKit
import SwiftUI

enum SettingsTab: String, CaseIterable, Identifiable {
    case setup, general, models, snippets, history, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .setup: "Einrichtung"
        case .general: "Allgemein"
        case .models: "Modelle"
        case .snippets: "Snippets"
        case .history: "Verlauf"
        case .about: "Über"
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

@MainActor
final class SettingsRouter: ObservableObject {
    @Published var tab: SettingsTab = .general
}

/// Eigenes Fenster statt SwiftUI-`Settings`-Scene, weil eine reine Menüleisten-App
/// (LSUIElement) die Settings-Scene nicht zuverlässig nach vorne holt.
@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let router = SettingsRouter()

    func show(tab: SettingsTab) {
        router.tab = tab
        if window == nil {
            let view = SettingsView()
                .environmentObject(AppState.shared)
                .environmentObject(AppState.shared.models)
                .environmentObject(AppState.shared.snippets)
                .environmentObject(router)
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 720, height: 520),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.title = "WhisperFree"
            window.contentView = NSHostingView(rootView: view)
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.setFrameAutosaveName("WhisperFreeSettings")
            if !window.setFrameUsingName("WhisperFreeSettings") { window.center() }
            self.window = window
        }
        // Für die Dauer des Fensters als normale App mit Dock-Icon auftreten, damit es Fokus bekommt.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }
}

struct SettingsView: View {
    @EnvironmentObject private var router: SettingsRouter

    var body: some View {
        NavigationSplitView {
            List(SettingsTab.allCases, selection: Binding(get: { router.tab }, set: { if let t = $0 { router.tab = t } })) { tab in
                Label(tab.title, systemImage: tab.symbol).tag(tab)
            }
            .navigationSplitViewColumnWidth(170)
        } detail: {
            Group {
                switch router.tab {
                case .setup: SetupPane()
                case .general: GeneralPane()
                case .models: ModelsPane()
                case .snippets: SnippetsPane()
                case .history: HistoryPane()
                case .about: AboutPane()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: 680, minHeight: 460)
    }
}
