# OpenWhisper roadmap

Remaining priorities include Linux desktop acceptance. New integrations start with optional
language-model communication, followed by speech output, then structured
Obsidian notes. Ordinary dictation remains independent of these services. These are planned features,
not current capabilities or promised release dates. Start with [README.md](../README.md) for
installation and current behavior.

## Delivery order

| Stage | Deliverable | Completion evidence |
| --- | --- | --- |
| 1 | Linux installation, desktop acceptance, and clearer platform boundaries | Verified installer tests; package/session reports with passed, failed, skipped, and manual checks; accurate support matrix |
| 2 | Optional LM Studio/Ollama communication | Explicitly send text to a chosen provider/model, preview the result, cancel safely, and preserve the input on failure |
| 3 | Optional speech output and short spoken conversations | Speak reviewed model replies with interruption and reliable microphone/playback separation |
| 4 | Structured Obsidian output | Review and save a model-structured note to a selected vault on both hosts, preserving the original dictation |
| Later | Configurable coding-agent and other actions | Previewed input, approved destination, structured results, and user control over execution |

Linux reliability and acceptance work can continue alongside provider development. Deliver
new integrations one stage at a time: model communication before TTS, then Obsidian.
Agent actions depend on the provider and workflow contracts; conversation mode depends on
cancellation and structured results. Prepare isolated branches, automated evidence, and focused
acceptance steps before requesting user review of new integrations. Linux reliability changes
can merge after their documented automated checks pass. Replacing the actively used installation
still requires an explicit instruction from the user.

## Linux desktop acceptance

Linux desktop integration is organized under `app/src/platforms/linux/`: `kde/` owns KDE
bindings, `x11/` owns X11-specific paths, and `shared/` contains common Linux services. The
Electron source layout is described in [platform architecture](PLATFORMS.md#electron-source-layout).
The [Linux validation notes](LINUX.md) describe the published 0.2.5 evidence; consult
[current Electron status](ELECTRON-STATUS.md) for replacement evidence and its limits.

| Test track | Initial environments | Features to establish |
| --- | --- | --- |
| KDE | Fedora KDE, Kubuntu, Debian KDE, openSUSE, Arch KDE | Plasma version, native keys/mouse, portals, installation, restart, input cleanup |
| GNOME | Ubuntu LTS, Fedora Workstation, Debian GNOME | Portal versions and consent, insertion, tray/window fallback, unsupported overlay |
| X11 | Xfce, Cinnamon, MATE, KDE X11 | Clipboard, focus, available shortcut paths, insertion limitations, overlay |
| Other Wayland compositors | Sway, Hyprland | Portal capabilities, layer-shell, usable fallback, possible explicit compositor bindings |

These are selected coverage targets, not a ranking of desktop popularity or support claims.
Record the exact installed desktop version: an older Plasma release may lack required native
capabilities even when the distribution name matches a target. Test released AppImages first;
test `.deb` installation separately on Debian-family systems. A package build or container test
cannot substitute for an actual graphical session.

The [acceptance report format](LINUX.md#checks-and-evidence) requires release/checksum,
distribution, desktop/session, portals, package type, hardware, and a result for each feature.
Agents can run fixture, isolated compositor, owned permission-dialog and private virtual-source
tests. Physical microphones, device events and actual logout/login remain separately identified
coverage limits. The user waived an additional proactive manual Linux acceptance round in favor
of bug reports; completed automated acceptance issues can close with those limits documented.

## Current source and historical hosts

This replacement branch uses the Electron application in `app/`. `app/ui/` owns its renderer,
settings and recording interface; `app/src/main/`, `app/src/preload/`, `app/src/contracts/`,
`app/src/services/`, `app/src/platforms/`, and `app/src/workers/` contain the host and feature code.
Linux adapters are grouped in
`app/src/platforms/linux/{kde,x11,shared}/`. The [platform architecture](PLATFORMS.md) maps the
current source layout. The original native macOS and Linux hosts belong to the published 0.2.5
release and remain available at its [immutable source commit](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4); their behavior and evidence are historical references, not current source paths.

## Linux installation

The published 0.2.5 packages and their legacy per-user installer are documented in the
[README](../README.md#linux-025) and [Linux status](LINUX.md). The installer source is available
at the immutable [0.2.5 commit](https://github.com/juferdinand/OpenWhisper/tree/d69b43bf6e7017c61089e117e79af34f57f297c4); it applies only to that AppImage. Electron package formats,
construction evidence and remaining release checks are recorded in
[current Electron status](ELECTRON-STATUS.md). Distribution channels such as AUR, RPM, APT
repositories and Flatpak remain separate future work, each with its own installation and
desktop-permission considerations.

## Obsidian output

Implement this stage after model communication and speech output have been reviewed. Use the
provider result to create a structured note with a title, headings, and concise content, rather
than automatically appending unstructured dictation. Preview and edit the note before writing
to a selected local vault and destination. Keep the original transcript available, preserve it
on a failed write, and avoid duplicate appends when retrying. Speech output remains optional
when saving notes; the delivery sequence does not require audio playback for every note.
Whole-vault indexing is later work.

Obsidian's official [URI documentation](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI),
under **Create note**, supports note content and append operations. A URI adapter is useful for
opening a result, while direct writes to a user-selected vault can handle long dictations
without putting the text into command arguments. Decide the default during implementation;
test Unicode, long text, locked/missing vaults, Linux URI registration, and Flatpak access.
Vault synchronization follows the user's Obsidian setup and must be disclosed independently
of local recognition. Vault reading or retrieval is a later opt-in feature.

## Optional language models

Use host-side provider adapters, with one shared workflow schema and shared settings UI:

| Step | Initial selection | Later selection |
| --- | --- | --- |
| Speech recognition | Local Whisper/Parakeet | Remains local |
| Cleanup or summary | Disabled; optional local LM Studio/Ollama | Explicitly configured cloud text provider |
| Intent proposal | User-selected profile or deterministic rule | Optional local/cloud classifier |
| Destination | Clipboard/cursor or selected Obsidian note | Configured coding agent or another adapter |
| Spoken response | Disabled | Local engine or explicitly configured BYOK service |

[LM Studio Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
supports an API server with an OpenAI-compatible endpoint; its Python example uses
`http://localhost:1234/v1`. [Ollama Chat](https://docs.ollama.com/api/chat) documents
`POST /api/chat`, with a local example at `http://localhost:11434`.
These are API feasibility references, not evidence of a completed OpenWhisper integration.

Configure endpoint, model, template, timeout, output length, and permitted destination per
profile. Call providers from native services; keep keys outside UI state and logs. Preserve
raw recognition text if a model is missing, offline, slow, cancelled, or returns invalid data.
Choosing a loopback URL does not prove the server uses local models: provider configuration
must distinguish local execution from any remote/cloud model. Remote processing is opt-in
per step, with the destination and transmitted text visible. Do not silently fall back to cloud.

## Configurable actions

Start with explicit profiles such as **Dictate**, **Save note**, **Summarize plan**, and
**Send to coding agent**. Optional classification proposes a profile; it does not grant action
permissions. Speech, note contents, and model output are input data, not executable commands.
Adapters receive structured arguments, scoped destinations, cancellation, and typed results.

An agent handoff should preview a structured brief: objective, requirements, constraints,
acceptance checks, and unresolved questions. Delivery must not automatically submit a terminal
command or start code execution. Add bidirectional adapters only when the chosen agent exposes
a documented interface; then return concise progress/questions/results. Keep the original
dictation and unsent brief recoverable if delivery fails. A whole-vault agent or unrestricted
shell integration is outside the first implementation.

## Spoken conversations

The language model or connected agent generates the answer; text-to-speech renders that answer
as audio. Begin with explicit turn-taking, concise replies, an expandable text record, Stop,
and cancellation. Prevent playback from being recorded as the next user turn. Add hands-free
turn detection only after echo handling, interruption, and device-change tests.

[Piper](https://github.com/OHF-Voice/piper1-gpl) provides a local neural TTS engine with CLI and
API interfaces. Its current repository uses GPL-3.0; engine/voice license and distribution
choices need review before bundling. This is a feasibility note, not a legal conclusion or a
voice-quality comparison. A user-installed engine or OS speech can be evaluated as alternatives.
[ElevenLabs Create speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
offers a cloud TTS endpoint accepting text. A BYOK adapter must clearly show that response text
leaves the machine; local STT/LLM plus cloud TTS is a mixed configuration. Evaluate German and
English quality, latency, offline behavior, resource usage, and licenses with shared fixtures.

## Work tracking

Issues #3–#9 are closed historical references for the earlier acceptance and architecture
work. The current expanded Linux desktop follow-ups are tracked in [#21](https://github.com/juferdinand/OpenWhisper/issues/21),
[#29](https://github.com/juferdinand/OpenWhisper/issues/29) and
[#30](https://github.com/juferdinand/OpenWhisper/issues/30); Windows implementation is tracked
in [#35](https://github.com/juferdinand/OpenWhisper/issues/35). Their current scope and status belong to those issues and
the [Electron status page](ELECTRON-STATUS.md).

Future integrations retain this delivery order: model communication, speech output, then
structured Obsidian output. Their criteria and issue references remain:

| Work item | Issue |
| --- | --- |
| Add optional Obsidian vault output for dictations | [#10](https://github.com/juferdinand/OpenWhisper/issues/10) |
| Add optional LM Studio and Ollama processing profiles | [#11](https://github.com/juferdinand/OpenWhisper/issues/11) |
| Add configurable workflow actions and coding-agent handoff | [#12](https://github.com/juferdinand/OpenWhisper/issues/12) |
| Add optional spoken replies with local and BYOK TTS providers | [#13](https://github.com/juferdinand/OpenWhisper/issues/13) |
