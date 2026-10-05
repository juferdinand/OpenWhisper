import AppKit
import Combine
import SwiftUI

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

/// Handle clicks even when the panel is not the key window.
private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class OverlayController {
    private let panel: OverlayPanel
    private var cancellables = Set<AnyCancellable>()
    private let size = NSSize(width: 320, height: 72)

    init(state: AppState) {
        panel = OverlayPanel(size: size)
        let panel = panel
        let host = FirstMouseHostingView(rootView: OverlayView(window: { [weak panel] in panel }).environmentObject(state))
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

struct OverlayView: View {
    @EnvironmentObject private var state: AppState
    @State private var hovering = false
    @State private var drag: (mouse: NSPoint, origin: NSPoint)?

    let window: () -> NSWindow?

    var body: some View {
        HStack(spacing: 10) {
            leadingIcon
                .frame(width: 18, height: 18)
            content
            if state.phase == .recording && hovering {
                Button {
                    state.cancel()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.white.opacity(0.6))
                }
                .buttonStyle(.plain)
                .help("Discard recording")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
        .background(
            Capsule()
                .fill(Color.black.opacity(0.85))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.14)))
                .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        )
        .foregroundStyle(.white)
        .contentShape(Capsule())
        .gesture(dragOrTap)
        .onHover { hovering = $0 }
        .fixedSize()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.15), value: state.phase)
    }

    /// Dragging moves the panel; a short click starts or stops recording.
    private var dragOrTap: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .global)
            .onChanged { _ in
                guard let window = window() else { return }
                let mouse = NSEvent.mouseLocation
                if drag == nil { drag = (mouse, window.frame.origin) }
                guard let drag else { return }
                window.setFrameOrigin(NSPoint(x: drag.origin.x + mouse.x - drag.mouse.x,
                                              y: drag.origin.y + mouse.y - drag.mouse.y))
            }
            .onEnded { _ in
                defer { drag = nil }
                guard let drag else { return }
                let mouse = NSEvent.mouseLocation
                if hypot(mouse.x - drag.mouse.x, mouse.y - drag.mouse.y) < 4 {
                    window()?.setFrameOrigin(drag.origin)
                    state.toggle()
                }
            }
    }

    @ViewBuilder
    private var leadingIcon: some View {
        switch state.phase {
        case .idle:
            Image(systemName: "mic.fill")
        case .recording:
            PulsingDot()
        case .transcribing:
            ProgressView().controlSize(.small).tint(.white)
        case .done:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state.phase {
        case .idle:
            Text("Click or press your shortcut").font(.system(size: 12, weight: .medium)).opacity(0.75)
        case .recording:
            Waveform(levels: state.levels)
            if let start = state.recordingStartedAt {
                TimelineView(.periodic(from: start, by: 1)) { context in
                    Text(Self.format(context.date.timeIntervalSince(start)))
                        .font(.system(size: 12, weight: .medium).monospacedDigit())
                        .opacity(0.8)
                }
            }
        case .transcribing:
            Text("Transcribing …").font(.system(size: 12, weight: .medium))
        case .done(let message), .error(let message):
            Text(message).font(.system(size: 12, weight: .medium)).lineLimit(1)
        }
    }

    private static func format(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

private struct Waveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .fill(Color.white.opacity(0.9))
                    .frame(width: 2.5, height: 3 + CGFloat(levels[index]) * 19)
            }
        }
        .frame(height: 22)
        .animation(.linear(duration: 0.08), value: levels)
    }
}

private struct PulsingDot: View {
    @State private var pulse = false

    var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 10, height: 10)
            .scaleEffect(pulse ? 1.25 : 0.85)
            .opacity(pulse ? 1 : 0.7)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: pulse)
            .onAppear { pulse = true }
    }
}
