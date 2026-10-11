# Frontend redesign plan

This is a proposed implementation plan, not a description of shipped functionality.
The owner supplied `Status page redesign.zip` on 2026-10-10 and refreshed it on
2026-10-11 with update controls and a release-notes dialog. Use its
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
| Dark purple surfaces, spacing, cards and visual hierarchy | Match the reference with locally bundled Instrument Sans and Newsreader; retain Inter in the accepted setup and use the supplied logo |
| Transcript-centered recording view | Use the existing final transcript and real recording state, elapsed time and audio level |
| Model drawer and CPU/GPU information | Use the authoritative catalog, actual download progress, selected preference, detected devices and fallback state |
| Collapsible history rail | Restyle the current bounded text list with full-text copy and clear controls |
| Setup and settings | Choose recognition hardware before the model, then preserve microphone, language, output, permission and shortcut controls and platform capability checks |
| Floating recording controls | Apply the same visual language while preserving host-specific availability and usable main-window fallback |
| Text processing | Group existing vocabulary and snippet editing together; hide the former model-server preview until Connections is implemented |

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
   permission and shortcut fallbacks remain optional. Use the reference's large centered
   shortcut keycap and compact output selector in the final trigger step without reducing
   the accepted hardware/model flow to the prototype's four simulated steps.
2. **Foundation and recording view.** Reproduce the reference's single transcript
   workspace, shown by default after setup. Group General, Recording & shortcuts, Text processing,
   History and About inside the settings dialog. Keep the
   renderer-only dictation view separate from host settings-navigation contracts.
   Show the actual selected model and recognition device, an elapsed timer and input level
   from host telemetry, and the latest final transcript. Do not imply live transcription;
   retain the previous result while recording or transcribing. Copy the complete result
   through the existing host command, including when the preview is omitted for size.
   Preserve the current typed bridge and host state machine. Keep record, stop,
   cancel, retry and discard visible in the states where they are valid. Review screenshots
   at the actual 740 × 560 minimum window size and at larger sizes.
3. **Models, history and settings.** Reuse existing model operations and history actions;
   open the right-edge model chooser drawer from Recording and General with Whisper/Parakeet
   family selection. Do not duplicate it as a primary settings tab.
   Keep the native dialog stable through download progress, show command failures
   inside it, and support keyboard navigation, Escape and focus restoration.
   Add a collapsible history rail with selectable, two-line entries and complete-copy/clear
   commands, without inventing dates or durations. Keep history preferences, the actual folder
   action and clear controls in History settings. Use a centered dialog with internal navigation and a
   scrollable content area; adapt snippets and About, including the supplied SVG branding,
   without removing current controls. Both dialogs must support keyboard navigation, Escape,
   focus restoration, and retained unsaved edits. Keep
   setup exclusive until completion, then remove it from normal navigation. Put the shortcut,
   segmented output choice and floating indicator first in Recording & shortcuts; retain useful
   push-to-talk mode beside the trigger, with microphone/language and output permissions in
   separate groups. Shortcut capture and permission to insert text are separate capabilities.
   Do not expose a second trigger-options group. Group vocabulary
   and snippet editors in Text processing, without adding simulated cleanup or correction counts.
4. **Overlay and regression review.** Restyle floating controls separately from the main
   window, check both host layouts and capability fallbacks, and present one functional
   candidate for owner acceptance before merge. Display input levels as a rolling history:
   actual new telemetry enters on the right and moves left; do not animate invented samples.

Use Recording/Aufnahme throughout visible navigation and actions, and Vocabulary/Vokabular
for target terms. Keep technical command identifiers and existing data locations stable.
The left Discard action clears the current workspace preview without deleting saved history
or changing the clipboard. Show actual history entry count and UTF-8 text size; this summary
excludes separately stored transcript files. Delete all applies to the history list only.
History remains limited to the current 20 entries until the archive/retention work in #47.

Keep system capability rows visually consistent and neutral. An unavailable login toggle stays
disabled without an explanatory paragraph. Match the refreshed titlebar's green Update action:
show it for an available or active update and open the details dialog before installation.
Put automatic-check preferences beside update status in About; keep unsupported Dev update
controls hidden. About uses the reference's compact logo/wordmark, identity, brief local-recognition
description and three project links. It should fit without vertical scrolling at the normal review
sizes; retain accessible scrolling at smaller sizes or when enlarged text genuinely needs it.
Document platform coverage through the README-linked guides.

Selecting Insert must request missing keyboard access immediately instead of silently
saving an unusable destination. Keep the previous output when access is cancelled or
unavailable. On macOS, guide the user to System Settings and allow an explicit retry
after access is granted. Permission help should explain insertion without portal internals.
Source-run Dev cannot reliably launch at login; use the existing packaged Dev admission
and an explicit isolated profile when reviewing that setting.

## Update dialog and release highlights

Follow the refreshed reference's compact titlebar Update action and centered details
dialog: installed and available versions, a few release highlights, the GitHub release
link, Later and the real update action. Project actual host states into the dialog;
the prototype's simulated progress, signature stages, restart-ready state and preview
channel are not evidence that those capabilities exist in the app.

Use `.github/release-notes.md` as the editorial source for a short highlights section.
The release workflow already uses it for the GitHub release body. The Linux feed and
macOS release reader accept notes. Publish the same curated highlights into Linux metadata
and carry a bounded plain-text list through the typed host/UI boundary. Render text safely
and link to the complete release for installation and platform details. Missing highlights
must not block an otherwise valid update. Avoid a second independently maintained `.txt`
asset or displaying the entire generated pull-request list in the dialog.

Display package size only when supplied by validated metadata. Keep installation behind the
explicit Download action and the existing recording, recovery, setup and download guards.
The current updater prepares and installs in one controlled operation; show its real status
instead of promising continued recording or inventing a separate restart-ready stage. Keep
the preview-channel selector deferred until a reviewed release-channel implementation exists
([#49](https://github.com/juferdinand/OpenWhisper/issues/49)).

## Recording-level presentation

Native capture reports callback peaks, not a PCM waveform or RMS. Adapt the Canvas
scrolling renderer from [ElevenLabs Live Waveform](https://github.com/elevenlabs/ui/blob/23c31bd3088814215a8b5d0bfb56b327cad1a578/apps/www/registry/elevenlabs-ui/ui/live-waveform.tsx)
to strict TypeScript in `app/ui/src/live-waveform.ts`, with the upstream
[MIT notice](../app/ui/public/licenses/elevenlabs-ui-LICENSE.txt) included in the renderer's
packaged assets. Reuse its rounded bars, HiDPI sizing and softened edges; feed the existing
validated recording telemetry instead of its React microphone acquisition. Keep the native
recorder as the sole audio owner and avoid adding React for this component.
This is adapted component source, not an installed ElevenLabs runtime dependency;
upstream changes require review and an explicit update to the local implementation.

Smooth only the incoming level with a time-based envelope, then move fixed historical
bars from right to left at a steady speed. Preserve each historical bar's height instead of
transitioning all heights on every sample. Bound the display history independently of the
recording duration, fade stale input to silence and clear it on stop or a new recording
generation. Do not generate activity during silence or transcription. For frame-paced
motion, use timestamps with
[requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
and preserve reduced-motion behavior. Web Audio's
[smoothingTimeConstant](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/smoothingTimeConstant)
applies to frequency data; it does not smooth the existing peak telemetry automatically.
Validate the presentation with synthetic speech-like pulses, silence, irregular telemetry,
stop/cancel, both window sizes and both main/overlay views before owner review. Dispose
animation and resize listeners when a canvas is replaced, and stop scheduling frames when
inactive or hidden.

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
| Raw/final text, optional cleanup, explicit vocabulary spellings/heard-form mappings and correction feedback | [#46](https://github.com/juferdinand/OpenWhisper/issues/46) |
| An optional unlimited archive, paged history, dates/duration and time-based retention | [#47](https://github.com/juferdinand/OpenWhisper/issues/47) |
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
