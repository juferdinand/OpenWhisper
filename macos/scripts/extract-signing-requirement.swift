import Foundation
import Security

// The codesign text display is not a reliable interchange format for implicit
// ad-hoc requirements. Apple's API returns their complete binary representation.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func check(_ status: OSStatus, _ operation: String) {
    guard status == errSecSuccess else {
        fail("\(operation) failed (OSStatus \(status))")
    }
}

guard CommandLine.arguments.count == 3 else {
    fail("Usage: extract-signing-requirement.swift <original.app> <requirement.bin>")
}
let app = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
var code: SecStaticCode?
check(SecStaticCodeCreateWithPath(app as CFURL, [], &code), "Open app")
guard let code else { fail("Signed code is missing") }
let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
check(SecStaticCodeCheckValidity(code, flags, nil), "Verify original signature")

var requirement: SecRequirement?
check(SecCodeCopyDesignatedRequirement(code, [], &requirement), "Read signing requirement")
guard let requirement else { fail("Signing requirement is missing") }
var data: CFData?
check(SecRequirementCopyData(requirement, [], &data), "Export signing requirement")
guard let data else { fail("Binary signing requirement is missing") }
do {
    try (data as Data).write(to: output, options: .atomic)
} catch {
    fail("Could not save signing requirement: \(error)")
}
