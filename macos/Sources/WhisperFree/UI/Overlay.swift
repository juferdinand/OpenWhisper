import AppKit
import Combine
import WebKit

/// Floating panel that never takes focus; the cursor stays in the target app
/// so text can be inserted there.
final class OverlayPanel: NSPanel {
    init(size: NSSize) {
        super.init(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = true
        isMovableByWindowBackground = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class OverlayController {
    private let panel: OverlayPanel
    private var cancellables = Set<AnyCancellable>()
    private let size = NSSize(width: 340, height: 64)
    private let sharedView: SharedSettingsView

    init(state: AppState) {
        panel = OverlayPanel(size: size)
        sharedView = SharedSettingsView(tab: .general, overlay: true)
        let panel = panel
        let host = sharedView.webView
        host.frame = NSRect(origin: .zero, size: size)
        panel.contentView = host
        panel.setFrameOrigin(savedOrigin() ?? defaultOrigin())

        NotificationCenter.default.publisher(for: NSWindow.didMoveNotification, object: panel)
            .sink { [weak self] _ in self?.saveOrigin() }
            .store(in: &cancellables)

        state.$phase
            .combineLatest(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
                .map { _ in () }.prepend(()))
            .receive(on: RunLoop.main)
            .sink { [weak self] phase, _ in self?.update(for: phase) }
            .store(in: &cancellables)
    }

    private func update(for phase: Phase) {
        let showIdle = UserDefaults.standard.bool(forKey: Prefs.showIdleOverlay)
        if phase != .idle || showIdle {
            if !panel.isVisible { panel.orderFrontRegardless() }
        } else if panel.isVisible {
            panel.orderOut(nil)
        }
    }

    private func defaultOrigin() -> NSPoint {
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        return NSPoint(x: frame.midX - size.width / 2, y: frame.minY + 24)
    }

    private func savedOrigin() -> NSPoint? {
        guard let string = UserDefaults.standard.string(forKey: Prefs.overlayOrigin) else { return nil }
        let point = NSPointFromString(string)
        // Restore the position only if it is still on a connected display.
        let rect = NSRect(origin: point, size: size)
        return NSScreen.screens.contains { $0.frame.intersects(rect) } ? point : nil
    }

    private func saveOrigin() {
        UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: Prefs.overlayOrigin)
    }
}
