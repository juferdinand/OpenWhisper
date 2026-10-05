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
- `main` rejects force pushes and deletion, including for administrators. Normal pushes remain
  possible for the maintainer and release workflow. There is currently one repository administrator.
- Workflow tokens default to read-only and cannot approve pull requests. Publication needs the
  release job's explicit write permission. Untrusted pull requests never receive signing secrets.

The manually downloaded whisper.cpp binary and model files need explicit tracking. Maintainers
must review their upstream releases and advisories before updating the pinned binary. CI verifies
that binary's SHA-256; this proves agreement with the pinned file, not absence of vulnerabilities.

These are automated tests and maintainer checks, not an independent security audit. No paid audit
is planned at this stage. Manual tests for microphone access, Accessibility permissions, hotkeys,
dictation, and a complete GUI update on a physical Mac remain part of release verification.

## Deutsch

Bitte melde Sicherheitslücken [vertraulich über GitHub](https://github.com/juferdinand/WhisperFree/security/advisories/new).
Nenne Version, Schritte zum Nachstellen und mögliche Auswirkungen. Veröffentliche keine Schlüssel,
Zugangsdaten, Aufnahmen oder Exploit-Details in einem öffentlichen Issue vor der koordinierten Behebung.
Sicherheitskorrekturen erfolgen für die neueste Version. Es gibt aktuell kein bezahltes Bug-Bounty-Programm,
keine garantierte Reaktionszeit und kein unabhängiges Sicherheitsaudit.
