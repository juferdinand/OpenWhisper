# OpenWhisper — Agent Instructions

OpenWhisper is a free, local dictation application. Speech recognition runs on the user's computer;
the app requires no account or subscription.

## Documentation and language

- Keep `AGENTS.md` and `CLAUDE.md` synchronized and in English.
- Write source comments, scripts, logs and documentation in English.
- Keep the renderer's English and German translations in `app/ui/locales/` synchronized,
  including keys and placeholders. Never translate user text.
- Keep `README.md` as the documentation entry point; link to focused reference documents.

## Delivery and acceptance

- The current release is Electron 0.3.0 for macOS and Linux. Consult [release status](docs/ELECTRON-STATUS.md)
  for tested scope and limitations; do not claim untested desktop, device, or distribution coverage.
- Work in an isolated branch/worktree, keep changes reviewable, and run focused checks while
  editing. Run the required common checks once for a complete increment. Prepare functional
  changes with automated evidence and independent review; merge through the normal PR workflow
  after user acceptance.
- Linux desktop acceptance uses the documented automated package/runtime checks. The user waived
  proactive manual desktop checks in favor of bug reports. Close automated-scope issues when their
  checks pass; track concrete remaining defects without requiring proactive physical-device or
  login-session checks.
- Do not replace the user's installed app, publish a release, or alter signing identities without
  explicit authorization. Preserve any existing installation during tests.
- Never use a real microphone or unattended physical input in tests. Identify synthetic, container,
  nested-desktop, and physical-device evidence separately.
- Keep ordinary dictation independent of optional integrations. Deliver integrations in order:
  model communication first, optional text-to-speech next, then structured Obsidian output.

## Project layout

- `app/` is the strict TypeScript Electron application, native speech boundary, platform services,
  build scripts, and tests.
- `app/src/main/` owns application lifecycle and composition; `preload/` exposes a narrow typed
  bridge; `src/contracts/` validates IPC at runtime; `src/services/` owns platform integrations.
- Group feature logic under `app/src/core/` and `app/src/services/`, including recording, speech,
  models, text, settings/history, and update features. Keep platform-specific host code under its
  platform area.
- `app/src/platforms/linux/{kde,x11,shared}/` owns Linux desktop adapters. Here `shared` means
  common Linux integration code, not the renderer or shared UI. GNOME and wlroots use capability-
  driven shared fallbacks.
- `app/ui/` is the Electron-only renderer. Preserve its layout, icons, Inter font, English/German
  switch, and stable interactive controls.
- `app/data/` contains the production model catalog. Test-only local-processing and multilingual
  vectors belong under `app/tests/fixtures/`; runtime contracts live in `app/src/contracts/`.
- Group worker implementation modules under `app/src/workers/{recording,speech,migration,platform}/`.
  Keep the six top-level worker entries and their emitted paths stable; update integrity graphs
  and every package consumer together when a supporting module moves.
- `app/native/` contains checksum-pinned native speech and focused platform bindings. Prefer the
  existing Electron/Node APIs or typed adapters before adding native code.
- The obsolete `macos/` and `linux/` hosts are removed from this replacement branch. Their
  historical source and evidence remain at [the immutable 0.2.5 commit](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4).
  Exact updater and desktop reference inputs used by current tests live in
  `app/tests/fixtures/legacy-linux/`, with their hashes and provenance.
- `VERSION` is the project version. Keep it, Electron and UI manifests, and lockfiles aligned.

## Code quality

- Group modules by cohesive behavior and keep platform dependencies out of the core. Prefer small
  interfaces at real process/platform boundaries; retain schema-derived types and discriminated unions.
- Share demonstrated common behavior through composition. Avoid static utility classes, speculative
  base classes, empty adapters and files that merely forward calls without defining a boundary.
- Keep one authoritative runtime schema. Test fixtures describe independent expected behavior;
  do not maintain another handwritten schema just to compare it with the first.
- Prefer existing APIs and maintained libraries when they satisfy the required capabilities. Verify
  the pinned version, types, ownership and failure behavior before replacing a tested adapter.
- Tests should cover user behavior, failures and trust boundaries. File count and LOC are review
  signals, not deletion targets; preserve meaningful regressions and exact historical fixtures.
- Keep durable instructions in the README-linked guides. Link chronological evidence to immutable
  history instead of extending active documentation with another execution diary.

## Development commands

Use Node.js 24–26 and npm.

```bash
npm ci --prefix app/ui
npm ci --prefix app
npm run setup --prefix app
npm run dev --prefix app
npm run preflight --prefix app
npm run typecheck --prefix app
npm run lint --prefix app
npm run check:unused --prefix app
npm test --prefix app
npm run build --prefix app
npm run build --prefix app/ui && npm run test:ui --prefix app/ui
make linux                         # Build candidate only; does not install
make mac                           # Build candidate only; does not install
```

For a renderer change, run `npm run build && npm run test:ui` in `app/ui/`. For an application
change, run the focused tests, `npm run typecheck`, and the appropriate build. `npm run preflight`
checks workflow syntax and shell, both TypeScript projects, typed Oxlint rules, unused code and
dependencies with Knip, formatting, and whitespace before a push. Keep worker entries explicit
and document individual runtime/system-tool exceptions in `app/knip.jsonc`.

## Behavior and safety constraints

- Do not impose a recording-duration limit or truncate audio. Record until explicit stop or cancel;
  audio stays in memory and long recordings consume more RAM.
- Keep Dev data and identity separate from stable data. Reject symlinked or unsafe profile paths;
  never import preferences, models, or recovery files automatically.
- Keep audio, transcripts, vocabulary, clipboard contents, and device names out of logs and test
  receipts. Expose only bounded, non-sensitive status through control interfaces.
- Retain strict update-source, version, archive, signature, and installed-tree checks. Preserve the
  macOS signing identity, Linux update key, package identity `io.github.whisperfree`, and existing
  data locations. Never relabel an old binary or silently fall back to ad-hoc release signing.
- Use private, owned fixtures for recording, replacement, and desktop tests. Never inherit the
  user's display, audio service, sockets, or input devices in unattended checks.
- Preserve model and language fixtures, vocabulary and snippet behavior, and English test names.

## Releases and security

The 0.3.0 Electron app uses persistent macOS and Linux signing identities. The original 0.2.5
app's GUI updater has not been demonstrated to update to Electron; document manual installation
when describing that transition. Do not claim data migration without evidence for that exact path.

macOS releases are self-signed and not Apple-notarized. Linux update signatures are version-bound.
See [release signing](docs/SIGNING.md) and [security policy](SECURITY.md). Keep signing material
out of Git, logs, artifacts, issues, and pull requests. Never rotate a release identity casually.

Current Linux package and test scope are recorded in [Linux status](docs/LINUX.md). The immutable
0.2.5 source snapshot is historical evidence for the former native host; keep it separate from
Electron results. See [platform architecture](docs/PLATFORMS.md).
