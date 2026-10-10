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
deferred at the owner's request and have no new feature ticket. Final naming remains deferred
until the owner is ready to prepare a public introduction. The owner subsequently supplied
new SVG logo variants for the frontend.

Reproduce the reference's layout and interaction hierarchy, not just its purple palette:
a compact titlebar, a wide dictation canvas, a right-hand history rail, a right-edge model
drawer, and settings in a centered dialog with its own navigation. The timer and input level
sit above the large transcript; existing feature shortcuts and the centered round recording
control sit below it. Do not retain the previous permanent left navigation or promotional
dashboard cards in the dictation view. Keep the accepted seven-step setup flow.

| Design element | First milestone |
| --- | --- |
| Dark purple surfaces, spacing, cards and visual hierarchy | Adapt to the shared renderer with bundled Inter; use the supplied logo in the new setup view |
| Transcript-centered recording view | Use the existing final transcript and real recording state, elapsed time and audio level |
| Model drawer and CPU/GPU information | Use the authoritative catalog, actual download progress, selected preference, detected devices and fallback state |
| Collapsible history rail | Restyle the current bounded text list with full-text copy and clear controls |
| Setup and settings | Choose recognition hardware before the model, then preserve microphone, language, output, permission and shortcut controls and platform capability checks |
| Floating recording controls | Apply the same visual language while preserving host-specific availability and usable main-window fallback |
| Local model preview | Retain the existing optional Dev-only manual preview; do not advertise stable chat functionality |

The reference is an interactive simulation: recognition, downloads, hardware, history,
chat and processing changes use demo data. Screenshots establish its appearance only.
No mock result, progress stage, hardware name or destination claim may become production
state. A live recording waveform indicates input level, not live transcription.

## Implementation increments

1. **Setup first.** Start with the welcome/language screen, then present seven setup steps:
   recognition hardware, model, microphone, speech language, output, permissions and trigger.
   Show the detected CPU/GPU names and persist the selected recognition mode before showing
   its model recommendations. GPU selection requires a compatible detected device and a
   supported host backend; keep CPU available when that capability is absent.
   Preserve the real model, microphone, language, output,
   permission and shortcut controls, including optional fallback paths. Start a fresh,
   isolated Dev profile for owner review; no installation is needed.
   Require a fully installed, selected speech model before advancing from model selection
   or completing setup. Pending, cancelled and failed downloads do not satisfy this check;
   permission and shortcut fallbacks remain optional.
2. **Foundation and recording view.** Reproduce the reference's single transcript
   workspace, shown by default after setup. Place the existing settings, models, snippets,
   history and About views inside the settings dialog. Keep the
   renderer-only dictation view separate from host settings-navigation contracts.
   Show the actual selected model and recognition device, an elapsed timer and input level
   from host telemetry, and the latest final transcript. Do not imply live transcription;
   retain the previous result while recording or transcribing. Copy the complete result
   through the existing host command, including when the preview is omitted for size.
   Preserve the current typed bridge and host state machine. Keep record, stop,
   cancel, retry and discard visible in the states where they are valid. Review screenshots
   at the actual 740 × 560 minimum window size and at larger sizes.
3. **Models, history and settings.** Reuse existing model operations and history actions;
   open a right-edge model chooser drawer from Dictation with Whisper/Parakeet family
   selection, while retaining the full Models management view inside settings.
   Keep the native dialog stable through download progress, show command failures
   inside it, and support keyboard navigation, Escape and focus restoration.
   Add a collapsible history rail at the right edge of the workspace using the existing text list,
   complete-copy and clear commands, without inventing dates or durations. Keep the full
   History view available. Use a centered settings dialog with internal navigation and a
   scrollable content area; adapt snippets and About, including the supplied SVG branding,
   without removing current controls. Both dialogs must support keyboard navigation, Escape,
   focus restoration, and retained unsaved edits. Keep
   setup exclusive until completion, then remove it from normal navigation.
4. **Overlay and regression review.** Restyle floating controls separately from the main
   window, check both host layouts and capability fallbacks, and present one functional
   candidate for owner acceptance before merge.

Use strict TypeScript and the existing renderer. Do not import the prototype's dynamic
React/Babel runtime, remote fonts or demo scripts, relax the content security policy, or
switch frameworks solely for this appearance. Use the prototype's custom titlebar with
working minimize, maximize/restore and close buttons, as requested during owner review.
Keep dragging available and route these actions through the validated main-window bridge;
recording overlays must not gain access to main-window controls.

Group setup models into collapsible Whisper and Parakeet families. Show a starting
recommendation for each family using the catalog and detected hardware, while allowing
every supported model to be selected. These recommendations are heuristics, not device
benchmarks or compatibility limits. Preserve group expansion during download progress.
Show microphone display names while retaining their exact IDs for selection, and constrain
long labels so the minimum-size setup view does not scroll horizontally.

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

## Branding assets and later naming

The five supplied SVG variants are stored unchanged in `app/ui/public/branding/`: bordered
and borderless icons, a monochrome mark, and transparent marks for dark/light backgrounds.
The setup increment uses a prominent transparent mark and the prototype's lowercase
wordmark, also used in the main titlebar; existing views and packaged OS icons can adopt
the assets in subsequent reviewed increments. Do not maintain separate platform logo designs.
Revisit the final name and public presentation when the owner is ready to share the app.
Preserve existing package/data identities and signing continuity when public branding changes.
