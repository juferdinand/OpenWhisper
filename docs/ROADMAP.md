# OpenWhisper roadmap

The next priorities are broader Linux desktop acceptance and a small Obsidian output feature.
Optional language-model processing, configured agent actions, and spoken replies can follow
without making ordinary dictation depend on another service. These are planned features,
not current capabilities or promised release dates. Start with [README.md](../README.md) for
installation and current behavior.

## Delivery order

| Stage | Deliverable | Completion evidence |
| --- | --- | --- |
| 1 | Linux desktop acceptance and clearer platform boundaries | Package/session reports with passed, failed, skipped, and manual checks; accurate support matrix |
| 2 | Obsidian output | Append a reviewed dictation to a selected vault on both hosts without an LLM or vault-wide scan |
| 3 | Optional LM Studio/Ollama processing | Summarize or structure text with cancellation, raw-text fallback, and explicit provider selection |
| 4 | Configurable coding-agent and other actions | Previewed input, approved destination, structured results, and user control over execution |
| 5 | Short spoken conversations | LLM replies, optional local/BYOK speech output, interruption, and reliable microphone/playback separation |

Linux acceptance can continue alongside Obsidian work. Agent actions depend on the provider
and workflow contracts; conversation mode depends on cancellation and structured results.

## Linux desktop acceptance

KDE support is implemented through available KWin/KGlobalAccel services and optional KWin mouse
rebinding capabilities. [`kde::capabilities`](../linux/src-tauri/src/desktops/kde/bindings.rs) checks
services, Plasma version, plugin availability, and utilities; it does not check for CachyOS.
Compatibility beyond the primary host is therefore a plausible implementation path, while
successful linux/package testing remains outstanding.

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

The [acceptance report format](LINUX.md#acceptance-evidence) requires release/checksum,
distribution, linux/session, portals, package type, hardware, and a result for each feature.
Agents can run fixture, isolated compositor, and private virtual-source tests. Physical
microphone, permission dialogs, device events, and actual logout/login checks require an
explicitly supervised tester. Untested checks stay open.

## Platform structure and Electron

`shared/ui/` owns the settings and recording interface used by macOS and Linux.
`linux/` owns the Linux Rust host, packages, native build dependencies, and host tests.
Within the host, `desktops/kde/` owns direct trigger capture, KGlobalAccel and KWin recovery;
`desktops/shared/` owns desktop-independent portals, clipboard, session helpers and overlays.
GNOME, X11 and wlroots boundaries document the shared paths they use and the acceptance
work still required. They do not claim a separate completed native adapter.
The [platform architecture](PLATFORMS.md#source-ownership) maps these paths explicitly.
Both hosts build the same UI assets; configuration, tests, release tooling and license
packaging follow the shared location.

Electron is a viable alternative host, but changing the UI runtime would not establish global
input or paste support on every desktop. Electron itself uses the GlobalShortcuts portal on
Wayland ([Usage on Linux](https://www.electronjs.org/docs/latest/api/global-shortcut#usage-on-linux))
and documents rebuilding native modules for its runtime
([Native Node Modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)).
Our architectural recommendation is to retain the current shared UI and native services, then
revisit a runtime migration only with measured benefits and comparable integration tests.
The common whisper.cpp engines already serve both hosts; OS permissions, triggers, focus,
GPU backends, packaging, and updates account for the remaining platform-specific work.

## Linux installation

Terminal installation already exists through a downloaded `.deb` and `apt`, or a downloaded
AppImage and the per-user installer in a source checkout. See the
[terminal instructions](../README.md#install-from-the-linux-terminal).
There is no project-managed APT/RPM repository, AUR package, or Flatpak distribution today.

The next packaging step is a standalone installer that downloads a pinned release, verifies
its signature and version, and installs the AppImage, desktop identity, icon, and notices
without requiring a build or source checkout. Preserve existing settings and models. Evaluate
AUR, RPM, APT, and Flatpak channels separately; each adds maintenance and installation tests,
and sandboxed packaging must revalidate native helpers and desktop permissions.

## Obsidian output

Start with a selected local vault and destination note or inbox. Append dictation as Markdown,
with an optional timestamp/template and a visible result. This feature needs neither an LLM
nor indexing the entire vault. Preserve the original transcript on a failed write and avoid
duplicate appends when retrying.

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

GitHub issues track desktop acceptance, installation, architecture, Obsidian, providers,
actions, and TTS. Each issue contains completion criteria and relevant sources. Testing issues
must stay open until their stated evidence exists; implementation or a green CI run alone
does not close a desktop acceptance task.

| Work item | Issue |
| --- | --- |
| Track Linux desktop and distribution acceptance | [#3](https://github.com/juferdinand/OpenWhisper/issues/3) |
| Validate KDE Plasma integration beyond CachyOS | [#4](https://github.com/juferdinand/OpenWhisper/issues/4) |
| Validate GNOME Wayland portals and usable desktop fallbacks | [#5](https://github.com/juferdinand/OpenWhisper/issues/5) |
| Validate X11 desktops and define shortcut and paste fallback gaps | [#6](https://github.com/juferdinand/OpenWhisper/issues/6) |
| Validate Sway and Hyprland capability paths and compositor bindings | [#7](https://github.com/juferdinand/OpenWhisper/issues/7) |
| Provide a standalone verified Linux terminal installer | [#8](https://github.com/juferdinand/OpenWhisper/issues/8) |
| Clarify shared UI and Linux desktop adapter boundaries | [#9](https://github.com/juferdinand/OpenWhisper/issues/9) |
| Add optional Obsidian vault output for dictations | [#10](https://github.com/juferdinand/OpenWhisper/issues/10) |
| Add optional LM Studio and Ollama processing profiles | [#11](https://github.com/juferdinand/OpenWhisper/issues/11) |
| Add configurable workflow actions and coding-agent handoff | [#12](https://github.com/juferdinand/OpenWhisper/issues/12) |
| Add optional spoken replies with local and BYOK TTS providers | [#13](https://github.com/juferdinand/OpenWhisper/issues/13) |
