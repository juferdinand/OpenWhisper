# Release signing

OpenWhisper uses separate persistent signing identities for macOS and Linux. Public macOS
releases are self-signed; they are **not signed with an Apple Developer ID certificate and are
not notarized**. macOS may show a first-launch warning. Download only from the
[official Releases page](https://github.com/juferdinand/OpenWhisper/releases). If you choose to
allow the app, follow [Apple's instructions](https://support.apple.com/102445); do not disable
Gatekeeper globally.

The app's update checks preserve the existing identity and validate the expected source, version,
asset, package identity and signature before installation. A signature or checksum alone does not
show that software is free of vulnerabilities or that a distribution channel is uncompromised.

## Identity continuity

The Linux updater uses a persistent Minisign/Ed25519 key and version-bound signatures. The public
key and strict repository, asset, package identity, and version checks must remain stable. The
immutable [0.2.5 source](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the former Linux host configuration.

Release workflows use the existing identities, with no ad-hoc fallback for public packages.
Secrets are imported only into the signing job and removed during cleanup. Do not rotate release
identities or commit signing material; local backups belong under ignored `.local/`.

`app/scripts/create-dev-cert.sh` creates a local development certificate. It must never replace
the persistent public release certificate. Maintainers can upload one already-exported identity
with `app/scripts/export-dev-cert.sh owner/repo /path/to/identity.p12`; never export all keychain
identities.

Signing and package verification are concrete workflow controls, not an independent security
audit. See the [security policy](../SECURITY.md). Report security issues through the
[private advisory form](https://github.com/juferdinand/OpenWhisper/security/advisories/new).
