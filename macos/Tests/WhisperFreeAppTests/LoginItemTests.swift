import ServiceManagement
import Testing
@testable import WhisperFree

private final class FakeLoginItem: LoginItemService {
    var status: SMAppService.Status = .notRegistered
    var registrations = 0
    var removals = 0
    func register() throws { registrations += 1; status = .requiresApproval }
    func unregister() throws { removals += 1; status = .notRegistered }
}
struct LoginItemTests {
    @Test func pendingApprovalCanBeTurnedOffWithoutASecondRegistration() throws {
        let service = FakeLoginItem()
        let controller = LoginItemController(service: service)
        try controller.set(true)
        #expect(controller.isRequested)
        #expect(controller.requiresApproval)
        try controller.set(true)
        #expect(service.registrations == 1)
        try controller.set(false)
        #expect(!controller.isRequested)
        #expect(!controller.requiresApproval)
        #expect(service.removals == 1)
        service.status = .enabled
        try controller.set(false)
        #expect(service.removals == 2)
    }
}
