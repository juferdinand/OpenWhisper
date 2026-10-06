import Foundation
import Testing
@testable import OpenWhisperCore

@Suite("Bundled UI access")
struct LocalUIAccessTests {
    let root = URL(fileURLWithPath: "/Applications/OpenWhisper.app/Contents/Resources/WebUI", isDirectory: true)

    @Test func onlyBundledFilesCanUseTheBridge() {
        #expect(LocalUIAccess.allows(root.appendingPathComponent("index.html"), root: root))
        #expect(LocalUIAccess.allows(root.appendingPathComponent("assets/main.js"), root: root))
        #expect(!LocalUIAccess.allows(URL(string: "https://example.com/index.html"), root: root))
        #expect(!LocalUIAccess.allows(URL(string: "file://remote.example.com/Applications/OpenWhisper.app/Contents/Resources/WebUI/index.html"), root: root))
        #expect(!LocalUIAccess.allows(root.appendingPathComponent("../private.html"), root: root))
        #expect(!LocalUIAccess.allows(URL(fileURLWithPath: root.path + "-other/index.html"), root: root))
        #expect(!LocalUIAccess.allows(nil, root: root))
    }
}
