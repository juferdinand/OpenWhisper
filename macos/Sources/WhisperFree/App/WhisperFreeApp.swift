import AppKit
import SwiftUI

@main
struct WhisperFreeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @ObservedObject private var state = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent(openSettings: { appDelegate.showSettings(.general) })
                .environmentObject(state)
        } label: {
            Image(systemName: menuBarSymbol)
        }
    }

    private var menuBarSymbol: String {
        switch state.phase {
        case .recording: "record.circle.fill"
        case .transcribing: "ellipsis.circle"
        default: "waveform"
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var overlay: OverlayController?
    private let settings = SettingsWindowController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let state = AppState.shared
        state.openSettings = { [weak self] tab in self?.showSettings(tab) }

        overlay = OverlayController(state: state)
        registerHotkey(state)
        state.preloadModel()
        UpdateService.shared.startAutomaticChecks()

        // Beim ersten Start (oder solange etwas fehlt) die Einrichtung zeigen.
        let defaults = UserDefaults.standard
        if !defaults.bool(forKey: Prefs.setupShown) || !state.models.hasAnyModel {
            defaults.set(true, forKey: Prefs.setupShown)
            showSettings(.setup)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppState.shared.shutdown()
    }

    func showSettings(_ tab: SettingsTab) {
        settings.show(tab: tab)
    }

    private func registerHotkey(_ state: AppState) {
        let hotkeys = HotkeyService.shared
        hotkeys.onPress = {
            if Self.mode == .hold { state.start() } else { state.toggle() }
        }
        hotkeys.onRelease = {
            if Self.mode == .hold { state.stop() }
        }
        hotkeys.onInterrupt = {
            // Modifier wurde für eine normale Tastenkombination benutzt (z. B. ⌥E) – kein Diktat.
            state.cancel()
        }
        hotkeys.start()
    }

    private static var mode: RecordingMode {
        RecordingMode(rawValue: UserDefaults.standard.string(forKey: Prefs.recordingMode) ?? "") ?? .toggle
    }
}
