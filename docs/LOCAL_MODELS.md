# Local model communication groundwork

Start with [README.md](../README.md) for current release behavior. The isolated Dev host
contains optional LM Studio and Ollama adapters for [#11](https://github.com/juferdinand/OpenWhisper/issues/11).
The former manual preview form has been removed from the redesigned UI at the owner's request.
The future Connections interface is deferred; opening settings and ordinary dictation do not
contact these providers. Existing optional profile files remain intact.

The current Text processing settings contain vocabulary and snippet editing only. They do
not imply LLM cleanup, conversation, automatic provider discovery or text-to-speech.

## Provider boundary

| Provider | Default endpoint | Host request |
| --- | --- | --- |
| LM Studio | `http://127.0.0.1:1234/v1` | `POST /v1/chat/completions` |
| Ollama | `http://127.0.0.1:11434` | `POST /api/chat` |

The adapters send separate system/user messages, the chosen model, `stream: false`,
temperature zero and the configured token limit. Their contracts remain covered by synthetic
HTTP tests. Live LM Studio/Ollama quality trials and the future interface remain follow-up work.

## Privacy and limits

Requests originate in the Electron host. The sandboxed renderer cannot fetch model endpoints.
Only HTTP with exact numeric `127.0.0.1` or `[::1]`, an explicit port from 1 to 65535 and
the provider's base path is accepted. Hostnames, credentials, remote addresses, alternate
paths, queries and fragments are rejected. The host uses no DNS resolution, environment
proxy, redirects, cookies, implicit credentials, API-key field or cloud fallback.

A loopback destination does not prove that the chosen server/model executes locally.
Check that server's configuration before sending; it can itself forward text elsewhere.
Replies are plain text and never executed as instructions, HTML or coding-agent actions.
Diagnostics expose only fixed categories, never submitted text or server response bodies.

| Bound | Value |
| --- | --- |
| Endpoint / model identifier | 256 UTF-8 bytes each |
| Processing instruction | Nonblank; 8192 UTF-8 bytes |
| Preview input / valid reply | Nonblank; 65536 UTF-8 bytes each |
| Output tokens | 32–4096; default 1024 |
| Total request deadline | 1–120 seconds; default 30 |
| HTTP response body | 1048576 bytes, including chunked bodies |

Oversized content is rejected rather than shortened. These preview bounds do not limit
recording duration. Replies must contain a completed assistant text response; truncated
answers, tool calls, refusals and unexpected control characters are rejected.

The runtime profile contract and defaults are defined by the Zod schemas in
`app/src/contracts/speech/local-processing.ts`. Shared endpoint, profile and response regression
vectors live under `app/tests/fixtures/local-processing/`; runtime schemas also validate UTF-8
bytes. Optional preferences live in
the Dev profile's `config/settings/local-processing.json` with mode `0600`, outside ordinary
preferences. Invalid saved content is preserved while disabled defaults are used in memory;
only an explicit valid edit replaces that file. Unsafe filesystem paths still fail closed.

## Automated evidence

Owned HTTP and contract tests cover both providers over IPv4/IPv6, exact multilingual input,
response validation, proxy bypass, redirect rejection, byte bounds, header/body/trickle deadlines,
server disconnection, cancellation and reuse. These checks use synthetic servers and do not
establish model quality. Renderer and owned Electron checks verify that the removed preview
is absent, settings preserve ordinary preferences, and no provider traffic starts automatically.

TTS, Obsidian and coding-agent actions remain later stages; ordinary local dictation stays
independent of optional integrations. See the [roadmap](ROADMAP.md) for delivery order.
