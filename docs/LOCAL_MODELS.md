# Optional text-model connections

Start with [README.md](../README.md) for released behavior. This branch implements
[Connections (#11)](https://github.com/juferdinand/OpenWhisper/issues/11); it is not part
of release 0.4.2. Ordinary recording remains independent of these optional integrations.

The [implementation plan](https://github.com/juferdinand/OpenWhisper/blob/dcbf89e/docs/LOCAL_MODELS.md#expanded-implementation-plan-for-11)
records the expanded scope agreed before implementation.

## Processing and selection

Text processing runs in this order: recognition, optional deterministic cleanup,
vocabulary correction, snippets, then an optional model. Cleanup removes recognized
artifacts; it does not promise semantic punctuation or filler-word removal. Disabling
cleanup preserves the recognition result for the following steps. Existing profiles
retain cleanup enabled by default.

Connections discovers running Ollama and LM Studio servers and installed CLI tools.
Discovery reads model metadata, the Claude CLI version and Codex help capabilities; it never starts a server,
downloads a model, reads authentication files, or submits text. Use **Scan again** after
changing a server or installation. Enabled saved connections are checked before their
first processing request after launch.

All connections start disabled. Choose a local model before enabling its connection.
The ordered list defines priority: only the first enabled connection receives text,
using the instruction for the selected mode. A failed or unavailable connection never silently selects
another provider. Its deterministic input remains the result. Skipping model processing
also keeps that input; cancelling the recording or quitting abandons delivery.

The app and floating bar show host-reported stages. Recognition progress uses processed
audio samples; other stages do not invent percentages. Recognized source and final text
remain reviewable for the current recording, subject to display bounds. History still
stores the final result; durable source history, TTS and Obsidian are later increments.

**Single recording** processes each recording independently. **Conversation** uses a
separate instruction and includes successful earlier user/assistant turns. The app
owns this context and replays it on each request; it does not resume native CLI sessions.
**New chat** clears the active context. Recording history remains a separate setting.
Changing the selected connection, its model/command or the conversation instruction
starts a fresh context. Cancelled, skipped, failed or undelivered results add no turn.

## Provider boundaries

| Provider | Discovery | Processing |
| --- | --- | --- |
| Ollama | `127.0.0.1:11434/api/tags` | `POST /api/chat` |
| LM Studio 0.4+ | `127.0.0.1:1234/api/v1/models` | `POST /v1/chat/completions` |
| Claude Code | Installed executable and supported version | Fixed print-mode invocation using the existing CLI login |
| Codex | Installed executable and required help capabilities | Non-interactive JSONL invocation using the existing CLI login |
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

For Claude Code and Codex, enter a model identifier in **Settings → Connections**.
An empty field uses the CLI's configured default; an explicit identifier is passed as
`--model` without changing global CLI settings. Claude also offers alias suggestions.
These fields do not list account entitlements: the installed CLI determines which
models are available. The selection persists in the active profile, and changing the
selected connection's model starts a fresh conversation.

## Custom CLI configuration

Add a connection and supply its display name and executable (an absolute path or a
program name found in the supported search paths). Enter arguments individually,
including any flags needed for non-interactive operation. The configured command is
never passed to a shell. Discovery resolves the executable without invoking its
configured arguments. New connections remain disabled until explicitly enabled.

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
[Ollama chat](https://docs.ollama.com/api/chat), [Ollama model list](https://docs.ollama.com/api/tags),
[Claude Code CLI](https://code.claude.com/docs/en/cli-usage),
[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
and [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
plus [Gemini CLI headless mode](https://geminicli.com/docs/cli/headless/).
