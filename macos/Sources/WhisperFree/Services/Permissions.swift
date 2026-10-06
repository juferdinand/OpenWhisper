import AppKit
import AVFoundation
import ApplicationServices
import ServiceManagement

enum Permissions {
    static var microphone: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    static func requestMicrophone() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    /// Accessibility access is used to simulate ⌘V for automatic text insertion.
    static var accessibilityGranted: Bool {
        AXIsProcessTrusted()
    }

    static func promptAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    static func openMicrophoneSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    static func openAccessibilitySettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    private static func open(_ string: String) {
        if let url = URL(string: string) { NSWorkspace.shared.open(url) }
    }
}

protocol LoginItemService {
    var status: SMAppService.Status { get }
    func register() throws
    func unregister() throws
}
extension SMAppService: LoginItemService {}

/// Registered-but-unapproved items must remain removable from the app.
final class LoginItemController {
    private let service: LoginItemService
    init(service: LoginItemService) { self.service = service }
    var isRequested: Bool { service.status == .enabled || service.status == .requiresApproval }
    var requiresApproval: Bool { service.status == .requiresApproval }
    func set(_ enabled: Bool) throws {
        guard enabled != isRequested else { return }
        if enabled { try service.register() }
        else { try service.unregister() }
    }
}

enum LaunchAtLogin {
    static let controller = LoginItemController(service: SMAppService.mainApp)
    static var isEnabled: Bool { controller.isRequested }
    static var requiresApproval: Bool { controller.requiresApproval }
    static func set(_ enabled: Bool) throws { try controller.set(enabled) }
    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
}
