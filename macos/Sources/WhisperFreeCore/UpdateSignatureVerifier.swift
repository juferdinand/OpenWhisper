#if os(macOS)
import Foundation
import Security

public enum UpdateSignatureVerifier {
    /// Validate all architectures, nested code, and sealed resources.
    public static func verify(_ app: URL, requirement: SecRequirement) throws {
        var code: SecStaticCode?
        let creationStatus = SecStaticCodeCreateWithPath(app as CFURL, [], &code)
        guard creationStatus == errSecSuccess, let code else {
            throw UpdateValidationError.invalidSignature(creationStatus)
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
        let status = SecStaticCodeCheckValidity(code, flags, requirement)
        guard status == errSecSuccess else { throw UpdateValidationError.invalidSignature(status) }
    }
}
#endif
