# Frontend redesign plan

This is a proposed implementation plan, not a description of shipped functionality.
The owner supplied `Status page redesign.zip` on 2026-10-10. Use its
`OpenWhisper App v2.dc.html` as the visual reference; the older HTML is an alternative,
not a second interface to maintain. The archive and rendered previews remain local
reference material rather than application dependencies.

## Priority and scope

Deliver the new frontend for existing dictation features first, then reviewed AI text
processing ([#11](https://github.com/juferdinand/OpenWhisper/issues/11)), then Windows
([#35](https://github.com/juferdinand/OpenWhisper/issues/35)). Continue concrete reliability
fixes alongside these milestones. Within later integrations, model communication precedes
optional TTS, and structured Obsidian output follows those prerequisites.

The first milestone has one dictation workspace. Multiple dictation tabs/workspaces are
deferred at the owner's request and have no new feature ticket. Naming and logo work are
also deferred until the owner is ready to prepare a public introduction.

| Design element | First milestone |
| --- | --- |
| Dark purple surfaces, spacing, cards and visual hierarchy | Adapt to the shared renderer; retain bundled Inter and current app icon initially |
| Transcript-centered recording view | Use the existing final transcript and real recording state, elapsed time and audio level |
| Model drawer and CPU/GPU information | Use the authoritative catalog, actual download progress, selected preference, detected devices and fallback state |
| Collapsible history rail | Restyle the current bounded text list with full-text copy and clear controls |
| Setup and settings | Reorganize the existing controls; preserve all six setup steps and platform capability checks |
| Floating recording controls | Apply the same visual language while preserving host-specific availability and usable main-window fallback |
| Local model preview | Retain the existing optional Dev-only manual preview; do not advertise stable chat functionality |

The reference is an interactive simulation: recognition, downloads, hardware, history,
chat and processing changes use demo data. Screenshots establish its appearance only.
No mock result, progress stage, hardware name or destination claim may become production
state. A live recording waveform indicates input level, not live transcription.

## Implementation increments

1. **Foundation and recording view.** Introduce shared color/spacing tokens and the single
   transcript workspace. Preserve the current typed bridge and host state machine. Keep
   record, stop, cancel, retry and discard visible in the states where they are valid.
   Review screenshots at the actual 740 × 560 minimum window size and at larger sizes.
2. **Models, history and settings.** Reuse existing model operations and history actions;
   adapt setup, settings, snippets and About without removing current controls. A settings
   dialog/drawer must support keyboard navigation, Escape and focus restoration. Keep
   setup exclusive until completion, then remove it from normal navigation.
3. **Overlay and regression review.** Restyle floating controls separately from the main
   window, check both host layouts and capability fallbacks, and present one functional
   candidate for owner acceptance before merge.

Use strict TypeScript and the existing renderer. Do not import the prototype's dynamic
React/Babel runtime, remote fonts or demo scripts, relax the content security policy, or
switch frameworks solely for this appearance. Keep native window controls and titlebars;
the prototype's custom window buttons are placeholders.

Preserve these existing behaviors throughout:

- Microphone selection/refresh, permissions, speech language, model-family restrictions,
  CPU/GPU preference, actual device labels and model download cancellation.
- Keyboard/mouse setup, platform restrictions, hold/toggle behavior, shortcut conflicts,
  permission revocation, clipboard fallback and optional overlays.
- Vocabulary editing, full snippet management, login-item approval states, history controls,
  updates, signing status, version and license information.
- Unlimited recording duration, stopped-audio recovery, retry/discard and complete transcript
  copying even when an extremely long preview is omitted. Never truncate stored audio/text
  to fit the new layout or log sensitive content.
- English/German translations, patch-based preference updates and stable input focus while
  host state refreshes. Ordinary dictation remains independent of optional providers.

## Features outside the visual milestone

| Proposed behavior | Tracking |
| --- | --- |
| Raw/final text, processing changes and explicit correction/vocabulary feedback | [#46](https://github.com/juferdinand/OpenWhisper/issues/46) |
| Dated history, recording duration and time-based retention | [#47](https://github.com/juferdinand/OpenWhisper/issues/47) |
| Provider discovery, richer model selection, conversation or AI error review | Evaluate separately under [#11](https://github.com/juferdinand/OpenWhisper/issues/11); not existing stable capabilities |
| Coding-agent connections and actions | [#12](https://github.com/juferdinand/OpenWhisper/issues/12); no raw shell-template interpolation |
| Spoken replies and structured Obsidian output | [#13](https://github.com/juferdinand/OpenWhisper/issues/13), then [#10](https://github.com/juferdinand/OpenWhisper/issues/10) |

Hide unsupported controls instead of shipping simulated functionality. Do not show fabricated
change counts, historical dates/durations, or an editor name after insertion. Show delivery
success only after the host confirms it. A global offline badge must not imply that an
optional provider or external action processes everything locally.

## Acceptance

Adapt existing renderer tests rather than duplicating the suite. Cover recording/error/
recovery states, long-text copy, model selection/download cancellation, setup visibility,
settings patches/focus, history actions, keyboard/dialog behavior and both languages.
Check responsive main-window and floating-control geometry, readable contrast, visible
focus and reduced-motion behavior; unsupported desktop capabilities must retain a usable
main-window path.

Run the renderer build and UI suite for each complete UI increment, focused host tests if
contracts or composition change, and common preflight once before pushing the completed
increment. Use the documented owned package/runtime checks for platform acceptance. No
unattended real-microphone or physical-input tests, installed-app replacement, or new release
is part of this planning step. Independent review and owner acceptance precede functional merge.

## Later branding

Choose the final name before producing a replacement logo and before the public introduction.
A possible visual direction is a simple speech-to-text symbol that remains legible as a small
tray icon, with light/dark and monochrome variants. This is a concept, not an approved asset.
Preserve existing package/data identities and signing continuity when public branding changes.
