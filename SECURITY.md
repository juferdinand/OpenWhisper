# Security policy

## Reporting a vulnerability

Please [report security vulnerabilities privately through GitHub](https://github.com/juferdinand/WhisperFree/security/advisories/new).
Include the affected version, reproduction steps, and the expected impact. Do not publish signing
keys, credentials, recordings, or exploit details in a public issue while a fix is being coordinated.

This is a volunteer project without a paid bug bounty or guaranteed response time. Security fixes
target the latest release; older versions do not receive a separate maintenance branch.

## Scope and current protections

- The updater checks the expected GitHub repository and asset, the signed app's identity and version,
  and signing continuity before replacement. Tests cover changed signed files, an unexpected code
  identity, unsigned apps, unsafe archives, shell metacharacters, and failed replacement rollback.
- Release signing is currently self-signed, without Apple notarization. Read
  [the signing decision and its limits](docs/SIGNING.md) before installing.
- GitHub secret scanning and push protection are enabled. Automated dependency changes
  require maintainer review.
- `renovate.json` configures weekly GitHub Actions updates, keeping full commit pins, and tracks
  whisper.cpp release versions in the download script. Auto-merge is disabled. The hosted
  [Renovate GitHub App](https://github.com/apps/renovate) must be granted access to this repository
  before it can run; committing configuration alone does not activate the service.
- `main` rejects force pushes and deletion, including for administrators. Normal pushes remain
  possible for the maintainer and release workflow. There is currently one repository administrator.
- Workflow tokens default to read-only and cannot approve pull requests. Publication needs the
  release job's explicit write permission. Untrusted pull requests never receive signing secrets.

Renovate requires dashboard approval before proposing a whisper.cpp update. Maintainers must
review the upstream release, verify the XCFramework checksum independently, and update its pinned
SHA-256 before merging. A version-only update deliberately fails checksum verification. Downloaded
model files are not tracked by this configuration. GitHub vulnerability alerts remain enabled
independently of the update bot. A checksum proves agreement with a file, not absence of vulnerabilities.

These are automated tests and maintainer checks, not an independent security audit. No paid audit
is planned at this stage. Manual tests for microphone access, Accessibility permissions, hotkeys,
dictation, and a complete GUI update on a physical Mac remain part of release verification.
