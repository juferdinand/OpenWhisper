# Optional text-model connections

Start with [README.md](../README.md) for released behavior. This branch implements
[Connections (#11)](https://github.com/juferdinand/OpenWhisper/issues/11); it is not part
of release 0.4.2. Ordinary recording remains independent of these optional integrations.

## Processing and selection

Text processing runs in this order: recognition, optional deterministic cleanup,
vocabulary correction, snippets, then an optional model. Cleanup removes recognized
artifacts; it does not promise semantic punctuation or filler-word removal. Disabling
cleanup preserves the recognition result for the following steps. Existing profiles
retain cleanup enabled by default.

Connections discovers running Ollama and LM Studio servers and installed CLI tools.
Discovery reads model metadata and the Claude CLI version; it never starts a server,
downloads a model, reads authentication files, or submits text. Use **Scan again** after
changing a server or installation. Enabled saved connections are checked before their
first processing request after launch.

All connections start disabled. Choose a local model before enabling its connection.
The ordered list defines priority: only the first enabled connection receives text,
using the shared instruction. A failed or unavailable connection never silently selects
another provider. Its deterministic input remains the result. Skipping model processing
also keeps that input; cancelling the recording or quitting abandons delivery.

The app and floating bar show host-reported stages. Recognition progress uses processed
audio samples; other stages do not invent percentages. Recognized source and final text
remain reviewable for the current recording, subject to display bounds. History still
stores the final result; durable source history, TTS and Obsidian are later increments.

## Provider boundaries

| Provider | Discovery | Processing |
| --- | --- | --- |
| Ollama | `127.0.0.1:11434/api/tags` | `POST /api/chat` |
| LM Studio 0.4+ | `127.0.0.1:1234/api/v1/models` | `POST /v1/chat/completions` |
| Claude Code | Installed executable and supported version | Fixed print-mode invocation using the existing CLI login |
| Codex | Installed executable | Unavailable until a complete model-tool boundary is verified |

LM Studio discovery uses typed native metadata to exclude embedding and decision models.
Local requests originate in the Electron host, with separate system/user messages,
temperature zero and non-streaming replies. Connections uses the fixed numeric IPv4
addresses above. The underlying adapter additionally accepts numeric IPv6 loopback
through its validated profile contract. Hostnames, credentials, remote addresses,
alternate paths, queries and fragments are rejected. Requests use no DNS resolution,
environment proxy, redirects, cookies or implicit credentials.

A loopback address does not prove that the server/model executes locally: the server
can forward text elsewhere. Check its configuration before enabling a connection.
Claude Code can use cloud models and its existing account. No API-key form or arbitrary
shell command is provided. Model replies are plain text, never executed as HTML or actions.

Claude Code must support `--safe-mode` (version 2.1.259 or later). The adapter uses
print mode, an empty tool list, safe mode, no session persistence and no permission
prompts. Model-requested tools and user/project customizations are disabled; trusted
administrator-managed CLI policy still applies, including managed hooks. This is not
a claim that the installed CLI executes no code. Input goes through stdin, with no shell,
from a private empty working directory. Output and total time are bounded; cancellation
terminates the owned process group. Authentication files are not read or copied by the app.

Codex read-only mode alone does not disable agent tools. Current public configuration
does not establish a complete empty tool registry, so discovery does not enable execution.

## Limits and storage

| Bound | Value |
| --- | --- |
| Model identifier | 256 UTF-8 bytes |
| Shared instruction | Nonblank; 8192 UTF-8 bytes |
| Model input / accepted reply | Nonblank; 65536 UTF-8 bytes each |
| Local output token budget / deadline | 1024 tokens / 30 seconds |
| Claude total deadline | 120 seconds |
| HTTP response / CLI stdout | 1048576 bytes |

Oversized model input is rejected rather than shortened, preserving the deterministic
result. These bounds do not limit recording duration or truncate audio. Local replies
must be completed assistant text; truncated answers, tool calls, refusals and unexpected
control characters are rejected. Only a successful Claude result envelope is accepted.
Diagnostics expose fixed failure categories, never submitted text or response bodies.

The connection registry lives in the active profile's `config/settings/text-connections.json`.
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
and [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
