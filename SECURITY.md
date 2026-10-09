# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/juferdinand/OpenWhisper/security/advisories/new).
Include the affected version, reproduction steps, and expected impact. Do not publish signing keys,
credentials, recordings, or exploit details while a fix is being coordinated. This volunteer
project has no paid bug bounty or guaranteed response time; security fixes target the latest
release.

## Current scope

The public release is 0.2.5 and contains the legacy native macOS/Linux hosts. The Electron 0.3.0
replacement is under acceptance. Its strict TypeScript contracts, sandboxed renderer, update
validators, package checks, and test evidence are described in
[Electron status](docs/ELECTRON-STATUS.md). Candidate tests are not a complete security audit and
do not establish physical-device, permission-dialog, or every-desktop coverage.

macOS releases use a persistent self-signed certificate and are not notarized by Apple. Linux
release updates use a persistent version-bound signing key. Preserve both identities and their
validation rules; see [release signing](docs/SIGNING.md). Obtain public downloads from the
[official Releases page](https://github.com/juferdinand/OpenWhisper/releases) and verify the
published checksums. A signature verifies integrity and continuity relative to its key, not the
absence of vulnerabilities or compromise of the distribution account.

GitHub Actions use pinned action revisions and read-only token permissions by default. Only
authorized release jobs receive signing secrets. Secret scanning and push protection are enabled;
dependency changes require maintainer review. Renovate's configuration keeps auto-merge disabled.
The hosted Renovate app must be granted repository access before it can run.

These controls and automated tests are limited evidence. No independent paid security audit has
been completed. Keep recordings, transcripts, vocabulary, clipboard content, and device names
out of logs and issue attachments. Unattended tests must use owned fixtures and must not access a
real microphone or the user's desktop/input devices.

## Known legacy Linux dependency advisory

The retained 0.2.5 Linux host locks `glib 0.18.5` through Tauri 2 / GTK 3. It is affected by
[RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g](https://rustsec.org/advisories/RUSTSEC-2024-0429.html):
`VariantStrIter` has undefined behavior and can dereference a null pointer in optimized builds.
The upstream fix is in `glib >=0.20`, outside GTK 3's dependency range; see the
[upstream Tauri issue](https://github.com/tauri-apps/tauri/issues/12048).

A source search found no calls to the affected API in OpenWhisper or its resolved dependencies
outside glib's own implementation, documentation, and tests. That is limited evidence, not proof
of unreachability. The GitHub alert remains open and must not be dismissed as harmless. The
Electron host has a separate dependency graph, but the legacy release remains available until
replacement and retirement gates complete. The immutable
[0.2.5 source snapshot](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4)
preserves the affected dependency lock.

See [Linux package and acceptance status](docs/LINUX.md) for the separation between published
0.2.5 evidence and the Electron candidate.
