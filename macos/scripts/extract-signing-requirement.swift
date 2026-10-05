import Foundation
import Security

// Die Textausgabe von codesign ist kein verlässliches Austauschformat für implizite
// Ad-hoc-Anforderungen. Apples API liefert auch diese als vollständige Binärdaten.
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func check(_ status: OSStatus, _ operation: String) {
    guard status == errSecSuccess else {
        fail("\(operation) fehlgeschlagen (OSStatus \(status))")
    }
}

guard CommandLine.arguments.count == 3 else {
    fail("Aufruf: extract-signing-requirement.swift <original.app> <requirement.bin>")
}
let app = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
var code: SecStaticCode?
check(SecStaticCodeCreateWithPath(app as CFURL, [], &code), "App öffnen")
guard let code else { fail("Signierter Code fehlt") }
let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
check(SecStaticCodeCheckValidity(code, flags, nil), "Originalsignatur prüfen")

var requirement: SecRequirement?
check(SecCodeCopyDesignatedRequirement(code, [], &requirement), "Signaturanforderung lesen")
guard let requirement else { fail("Signaturanforderung fehlt") }
var data: CFData?
check(SecRequirementCopyData(requirement, [], &data), "Signaturanforderung exportieren")
guard let data else { fail("Binäre Signaturanforderung fehlt") }
do {
    try (data as Data).write(to: output, options: .atomic)
} catch {
    fail("Signaturanforderung konnte nicht gespeichert werden: \(error)")
}
