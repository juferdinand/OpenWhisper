# Release signing

## Current decision

As of 2026-10-05, WhisperFree uses a persistent, self-signed code-signing certificate for its
initial public releases. This keeps early open-source releases independent of a paid Apple
Developer Program membership while the project is being developed and tested.

Apple Developer ID signing and notarization remain a future option. This is a deliberate initial
distribution choice, not a claim that self-signing is equivalent to Apple's verification.

## What users can expect

- Releases are signed with the same project identity. The current in-app updater verifies a
  downloaded app against the running app's designated code-signing requirement.
- The certificate is not issued by Apple. The releases are not notarized by Apple, and macOS
  may block the first launch because it cannot verify the developer through Developer ID.
- Users can review the source and release origin and follow
  [Apple's instructions for opening an app](https://support.apple.com/102445) if they choose to allow it.
- A signature checks integrity and signing continuity; it does not establish that software is
  free of bugs or malicious behavior. The included `SHA256SUMS` also permits download integrity checks.
- CI development packages use ad-hoc signing and have no configured in-app updater.
  Public release packages use the persistent project certificate.

## Risks and limits

- **Initial trust:** a self-signed certificate does not give users an Apple-verified developer
  identity. Obtain the first app from the project's official release page and assess its origin.
- **No notarization scan:** these releases have not been submitted to Apple's notarization
  service for its checks for known malicious software. An exception for this app should not
  involve globally disabling Gatekeeper or other macOS protections.
- **Private-key compromise:** someone with the private key can sign altered applications with
  the project's identity. Signing continuity alone cannot detect misuse of that same key.
  Repository and workflow access also need to remain restricted to trusted maintainers.
- **Lost or replaced keys:** losing the signing identity can break the existing updater's trust
  continuity. Keep a protected backup and plan any identity change before publication.
- **Checksums are not an independent trust source:** an attacker who replaces both the ZIP and
  its checksum on a compromised distribution channel can make them agree. The checksum is useful
  for integrity checking, but does not substitute for verifying the release's origin.

Apple explains [Gatekeeper and notarization](https://support.apple.com/102445) and
[protecting signing identities](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html).

## Implemented protections

- Release URLs must match the configured GitHub repository, version tag, and exact macOS asset name.
  The signed bundle must have the expected app identifier and release version, newer than the installed version.
- Archives are extracted into fresh private directories using macOS bsdtar with its default path
  traversal protections. The expected app directory is required; symlinks leaving it are rejected.
  Invalid archives and rejected apps are removed. Tests exercise traversal and symlink attacks.
- The updater validates the downloaded app's code signature against the running app's designated
  requirement before starting replacement, including nested code and all architectures.
- The replacement script is part of the signed app bundle. Paths are passed as arguments, never
  interpolated into shell source, and production command lookup uses a fixed system `PATH`.
  Regression tests cover shell metacharacters in app names and restoration after a failed replacement.
- Release dependencies are downloaded fresh and checked against the pinned SHA-256 checksum.
- GitHub Actions are pinned to full commit IDs. Ordinary CI has read-only repository permissions
  and does not receive signing secrets. The release workflow is dispatched manually from `main`.
- Signing material is imported after the test step and removed from the temporary keychain when
  the release job ends. Release signing has no ad-hoc fallback.

These measures reduce specific risks; they are not a complete security audit or a guarantee against compromise.
See [SECURITY.md](../SECURITY.md) for automated checks, repository protections, reporting, and review limits.

## Maintaining the release identity

The release workflow imports the signing identity from the encrypted repository secrets
`SIGNING_CERT_P12` and `SIGNING_CERT_PASSWORD`. It must not silently fall back to ad-hoc signing.
The initial encrypted PKCS#12 backup and its password are stored locally under the ignored
`.local/release-signing/` directory with restricted permissions. Neither belongs in Git,
workflow logs, release assets, issues, or pull requests.

Keep the certificate and private key for subsequent releases. Do not replace the repository
secrets with a newly generated development certificate when setting up another Mac.
The local `create-dev-cert.sh` helper creates a separate development identity; matching the
certificate's display name does not make it the same signing identity.

## Moving to Apple Developer ID

When the project chooses to fund an Apple Developer Program membership:

1. Obtain a **Developer ID Application** certificate through the project's Apple developer account.
2. Add the signing and notarization steps required by Apple to the release pipeline and verify
   the resulting bundle on macOS before distribution.
3. Plan the updater transition. The current self-signed app's signature requirement will reject
   a binary signed with a different identity. Use a compatible migration release or document
   the need for a manual installation; do not just overwrite the signing secrets.
4. Update both READMEs, release notes, and this document to describe the new signing status.

Apple documents [membership fees](https://developer.apple.com/programs/enroll/) and
[Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/).
