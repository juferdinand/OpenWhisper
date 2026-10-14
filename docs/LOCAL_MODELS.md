# Optional text-model connections

Start with [README.md](../README.md) for the current release. This guide describes the
optional text-model integrations and their provider and privacy boundaries. Ordinary
recording remains independent of these optional integrations.

The [implementation plan](https://github.com/juferdinand/OpenWhisper/blob/dcbf89e/docs/LOCAL_MODELS.md#expanded-implementation-plan-for-11)
records the expanded scope agreed before implementation.

## Processing and selection

Single-recording text processing runs in this order: recognition, optional deterministic
cleanup, vocabulary correction, optional AI revision, then snippets. Snippets are applied
after revision so their exact configured expansions remain intact. Cleanup removes
recognized artifacts; it does not promise semantic punctuation or filler-word removal.
Disabling cleanup preserves the recognition result for the following steps. Existing
profiles retain cleanup enabled by default.

AI models discovers running Ollama and LM Studio servers and installed CLI tools.
Discovery reads model metadata, the Claude CLI version and Codex help capabilities.
Short-lived CLI metadata sessions supply the Claude and Codex model dropdowns without
starting a conversation or submitting text. Discovery never launches Ollama or LM Studio,
downloads a model, runs inference or imports authentication files. At app startup, saved
connections that are enabled or already have a selected model are scanned in the background;
otherwise, opening **AI models** starts discovery. Use **Scan again** after changing a server
or installation. Enabled saved connections are checked before their first processing request
after launch.

All connections start disabled. Choose a local model before enabling its connection.
The ordered list defines priority: only the first enabled connection receives text,
using the instruction for the selected mode. A failed or unavailable connection never silently selects
another provider. Its deterministic input remains the result. Skipping model processing
also keeps that input; cancelling the recording or quitting abandons delivery.

The app and floating bar use one Processing indicator, below the transcript in the main
window. Its estimated overall fill uses host-reported stage milestones and measured
recognition samples; unknown-duration work stays animated without clock-based completion
or a timeout. Intermediate text stays hidden until delivery finishes. Recognized source
and final text remain reviewable for the current recording, subject to display bounds. History still
stores the final result; durable source history, TTS and Obsidian are later increments.

Stopped recordings retain their existing retry and discard actions. Recognition retry
reuses the retained audio but starts a new recognition pass. Optional AI failure keeps
the usable deterministic result and its fallback notice; retrying AI alone is a separate
feature ([#70](https://github.com/juferdinand/OpenWhisper/issues/70)).

**Single recording** processes each recording independently. **Conversation** uses a
separate instruction and includes successful earlier user/assistant turns. The app
owns this context and replays it on each request; it does not resume native CLI sessions.
**New chat** clears the active context. Recording history remains a separate setting.
Changing the selected connection, its model/command or the conversation instruction
starts a fresh context. Cancelled, skipped, failed or undelivered results add no turn.

### Optional AI revision

AI revision is a separate master switch and starts off. Its independent rules cover
spelling and grammar, clear verbal corrections, paragraph breaks, and number/time
formatting (HH:MM times and DD.MM.YYYY dates, preserving represented values). The first
two are selected in new settings; the other two are off. Up to 32 additional user rules
can be stored, each bounded to 8192 UTF-8 bytes and together bounded to 7000 UTF-8 bytes.
Only enabled rules are compiled into the fixed revision instruction, which preserves language, meaning,
facts, details and wording and prohibits summaries, translations, added facts, answers,
or actions. These are instructions to the chosen model, not guarantees of output quality.

With the master switch off, or no active rules, single recordings skip provider discovery
and inference and retain the deterministic result. Existing saved custom instructions and
legacy linguistic settings remain stored but are not used for single-recording revision;
they are never silently substituted for the explicit rules. Conversation mode retains its
separate instruction and context. Snippets are expanded before conversation processing,
and after AI revision for ordinary single recordings.

Settings save automatically: switches and selections immediately, text edits after
450 ms. The header confirms successful persistence and retains a retry action on
failure. Closing or changing settings pages flushes pending edits; unresolved failures
keep the edited page open. Incomplete snippet rows must be completed or removed.

## Provider boundaries

| Provider | Discovery | Processing |
| --- | --- | --- |
| Ollama | `127.0.0.1:11434/api/tags` | `POST /api/chat` |
| LM Studio 0.4+ | `127.0.0.1:1234/api/v1/models` | `POST /api/v1/chat` |
| Claude Code | Installed executable, supported version and initialization model catalog | Fixed print-mode invocation using the existing CLI login |
| Codex | Installed executable, required help capabilities and `model/list` catalog | Non-interactive JSONL invocation using the existing CLI login |
| Custom CLI | Configured executable only | User-configured arguments and stdin; text or selected JSON-field response |

LM Studio discovery uses typed native metadata to exclude embedding and decision models.
Local requests originate in the Electron host, with separate system/user messages,
temperature zero and non-streaming replies. Connections uses the fixed numeric IPv4
addresses above. The underlying adapter additionally accepts numeric IPv6 loopback
through its validated profile contract. Hostnames, credentials, remote addresses,
alternate paths, queries and fragments are rejected. Requests use no DNS resolution,
environment proxy, redirects, cookies or implicit credentials.

A loopback address does not prove that the server/model executes locally: the server
can forward text elsewhere. Check its configuration before enabling a connection.
CLI tools can use cloud models and their existing accounts. Model replies are plain
text, never executed by OpenWhisper as HTML or actions. Custom CLI connections run
the program selected by the user with that program's own tool and permission policy.

Claude Code must support `--safe-mode` (version 2.1.259 or later). The adapter uses
print mode, an empty tool list, safe mode, no session persistence and no permission
prompts. Model-requested tools and user/project customizations are disabled; trusted
administrator-managed CLI policy still applies, including managed hooks. This is not
a claim that the installed CLI executes no code. Input goes through stdin, with no shell,
from a private empty working directory. Output and total time are bounded; cancellation
terminates the owned process group. Authentication files are not read or copied by the app.

Codex uses `-a never exec --sandbox read-only --skip-git-repo-check --ephemeral --json
--color never -`. It retains the CLI's configured login. Read-only mode
does not remove agent tools, and configured CLI policy still applies. Only a completed
successful turn's assistant answer is accepted; progress and commentary are excluded.

Choose Claude Code and Codex models from the dropdowns in **Settings → AI models**.
**Use tool settings** omits `--model`, leaving model selection to the CLI's configuration
and policy. This does not resume the model or chat from an unrelated CLI process.
An explicit selection is passed as `--model` without changing global CLI settings.
Discovered choices come from the installed CLI:
Codex's app-server `model/list` and Claude's initialization control response. Metadata
sessions use private pipes and the existing owned process boundary, then close; no
model turn is started. OpenWhisper does not read or copy CLI credentials.

Claude's initialization response lists its picker entries, which can be aliases rather
than every model version. The dropdown shows plain model names, including the current
family choice and specific versions. Codex uses the display names returned by its CLI;
local model identifiers use readable labels while retaining version and tag distinctions.
The displayed label never changes the selected model identifier; values such as Fable's
`[1m]` suffix remain unchanged when selected. Claude's separate `default` alias is not
offered alongside the inherited setting. An existing saved `default` selection remains
available as **Recommended Claude model**, preserving its explicit `--model default`
behavior.

Additional versions come from a small catalog of active Anthropic model IDs, verified
against the official model lifecycle reference
on October 12, 2026. Suggestions are limited to observed canonical model families and
versions no newer than the resolved CLI model. Custom provider IDs do not imply support
for Anthropic's canonical IDs. This catalog is maintained with the application; scanning
does not download it or discover every version enabled for the account.

Neither the CLI list nor the additional catalog verifies CLI authentication or account
entitlements. Claude checks access and applies its configured model restrictions when a request
runs. If
metadata discovery fails, the inherited setting and any saved model remain selectable. Saved
models absent from the refreshed choices remain selectable. The selection persists in
the active profile, and changing the selected connection's model starts a fresh
conversation.

## Reasoning effort

The AI models page shows **Reasoning effort** only when the selected provider reports
choices for that model. **Use model default** leaves the provider's own default in control.
An explicit choice is saved for that connection and cleared when its model changes.
The choices are the provider's advertised values; OpenWhisper does not invent levels for
unknown models. Ollama and LM Studio expose model-specific settings, Codex reports
supported levels in its model catalog, and Claude Code exposes its CLI effort choices for
known first-party model IDs. An explicit value rejected by the provider fails that AI
step; the app does not retry with a different reasoning level, and the deterministic text
is retained.

Some Ollama versions report that a model supports `thinking` but omit its selectable
values and default from `/api/show`. In that case OpenWhisper follows the model default
until the user chooses on or off; it exposes named effort levels only when Ollama reports them.

Custom CLI commands have no shared reasoning-effort protocol. Add the relevant flag in
that connection's arguments when the selected tool supports one. OpenWhisper passes those
arguments unchanged and does not infer a level from the command name.

## Custom CLI configuration

Add a connection and supply its display name and executable (an absolute path or a
program name found in the supported search paths). Enter arguments individually,
including any flags needed for non-interactive operation. The configured command is
never passed to a shell. Discovery resolves the executable without invoking its
configured arguments. New connections remain disabled until explicitly enabled.

The creation/editing subpage has an explicit Save/Cancel footer. New connections receive
the complete app prompt through stdin; the input template is not an editable UI field.
Editing an older connection preserves its existing template without rewriting it.

The placeholders `{prompt}`, `{instruction}` and `{text}` can appear in arguments or
the stdin template. `{prompt}` supplies the complete instruction and, in conversation
mode, previous turns plus the current message. `{text}` supplies only the current
message. Replacements remain one argument or stdin data, even when they contain shell
syntax. For conversation context, include `{prompt}` in the configured input.

Choose plain text when the tool writes its answer to stdout, or JSON with a response
field such as `response` or `message.content`. Nested paths use dots; prototype paths
are rejected. For Gemini CLI, a configuration example is executable `gemini`, arguments
`["--output-format", "json"]`, stdin `{prompt}`, output JSON and response field `response`.
Non-TTY stdin activates its headless mode. Other CLI tools and local wrappers can use
the same configuration without a new built-in adapter. Their exact authentication and
command flags belong to the installed tool; OpenWhisper does not copy credentials.

## Limits and storage

| Bound | Value |
| --- | --- |
| Model identifier | 256 UTF-8 bytes |
| Shared instruction | Nonblank; 8192 UTF-8 bytes |
| Model input / accepted reply | Nonblank; 65536 UTF-8 bytes each |
| Local output token budget / deadline | 1024 tokens / 30 seconds |
| CLI total deadline | 120 seconds |
| HTTP response / CLI stdout | 1048576 bytes |
| Active conversation | 128 turns; 262144 UTF-8 bytes of serialized turns |
| Connection registry | Four built-ins plus up to 16 custom entries |

Oversized model input is rejected rather than shortened, preserving the deterministic
result. A full conversation asks for a new chat rather than silently dropping earlier
turns. These bounds do not limit recording duration or truncate audio. Local replies
must be completed assistant text; truncated answers, tool calls, refusals and unexpected
control characters are rejected. Only a successful Claude result envelope is accepted.
Diagnostics expose fixed failure categories, never submitted text or response bodies.

The connection registry lives in the active profile's `config/settings/text-connections.json`.
Conversation mode persists its active context in `text-conversation.json` beside it,
independently of the recording-history switch. Stable and Dev profiles stay separate.
Its canonical schema is `app/src/contracts/text/connections.ts`; storage uses the existing
private state store. The older optional `local-processing.json` profile remains intact.
Local adapter contracts live in `app/src/contracts/speech/local-processing.ts`, with
independent regression vectors under `app/tests/fixtures/local-processing/`.

## Validation

Synthetic HTTP, fake-process, pipeline and renderer tests cover discovery, priority,
disabled defaults, model selection, cancellation, failures, source/final delivery,
stage ownership, byte bounds and transparent overlay margins. They do not establish
live model quality or physical desktop/device coverage. Live local-model trials use
synthetic text only and are reported separately. Cloud-account calls are not required
for automated checks. New feature acceptance remains required before merge.

Primary references: [LM Studio Chat Completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions),
[LM Studio native model metadata](https://lmstudio.ai/docs/developer/rest/list),
[LM Studio native chat](https://lmstudio.ai/docs/developer/rest/chat),
[Ollama chat](https://docs.ollama.com/api/chat), [Ollama model list](https://docs.ollama.com/api/tags),
[Ollama thinking](https://docs.ollama.com/capabilities/thinking),
[Claude Code CLI](https://code.claude.com/docs/en/cli-usage),
[Claude SDK model metadata](https://code.claude.com/docs/en/agent-sdk/typescript#query-object),
[Claude model configuration](https://code.claude.com/docs/en/model-config),
[Claude model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
[Codex app-server model catalog](https://learn.chatgpt.com/docs/app-server#list-models-modellist),
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
and [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
plus [Gemini CLI headless mode](https://geminicli.com/docs/cli/headless/).
