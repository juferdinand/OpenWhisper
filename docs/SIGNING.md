# Release signing

OpenWhisper has separate macOS and Linux signing identities. The current public version is 0.2.5;
Electron 0.3.0 release signing and update acceptance remain in progress. Consult
[current implementation status](ELECTRON-STATUS.md) for the exact evidence and open gates.

## macOS certificate

Public macOS releases use the persistent project self-signed certificate. They are **not signed
with an Apple Developer ID certificate and are not notarized**. macOS may show a first-launch
warning. Obtain the app from the official release page and follow
[Apple's instructions](https://support.apple.com/102445) only if you decide to allow it; do not
disable Gatekeeper globally.

The legacy updater checks the expected repository, version, asset name, bundle identity, and
signature continuity against the running app's designated requirement before replacement. The
Electron replacement preserves the existing identity and strict signature policy; its packaged
upgrade and native 0.2.5 transition still require completed acceptance. A signature or checksum
does not establish that software is free of vulnerabilities or that a distribution channel is
uncompromised.

On macOS, `app/scripts/create-dev-cert.sh` creates a local development certificate when the
expected certificate is absent. Keep the persistent release identity for signing continuity;
never replace or rotate it with the development certificate. Maintainers may upload one
already-exported identity with
`app/scripts/export-dev-cert.sh owner/repo /path/to/identity.p12`. Never export all keychain
identities.

## Linux update key

The public 0.2.5 Linux packages use a persistent Minisign/Ed25519 key. Their updater requires a
version-bound signature and checks the repository, asset, package identity, and version. The
immutable [0.2.5 source](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the original public-key configuration and updater. The Electron replacement retains
the existing Linux update key and validation policy; signed-package and transition acceptance
remain pending.

The encrypted Linux private key and password are configured only in the authorized release
workflow. Preserve the embedded public key and reject missing or mismatched signed versions.
Never print, commit, upload, or casually replace either signing identity. Losing or rotating a key
can break updater continuity and requires a reviewed transition or manual installation.

## Release workflow protections

- General test and build jobs use read-only repository permissions and receive no signing keys.
  Owner-only candidate jobs receive the existing signing keys only after source-bound admission,
  sign same-run artifacts for private CI audit, and do not publish releases.
- Release signing uses the existing identities, with no ad-hoc fallback for public packages.
- Secret material is imported only for the signing job and removed during cleanup. Local backup
  material belongs in the ignored `.local/` directory with restrictive permissions.
- Release publication follows source/version admission, package verification, and checksums.
  Manual release publication and any replacement of the installed application require their
  separate approval and acceptance gates.

These are concrete signing and workflow controls, not an independent security audit. See
[the security policy](../SECURITY.md) and the immutable [0.2.5 Linux signing source](https://github.com/juferdinand/OpenWhisper/blob/d69b43bf6e7017c61089e117e79af34f57f297c4/linux/src-tauri/tauri.conf.json).
