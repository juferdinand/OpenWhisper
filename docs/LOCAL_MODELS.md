# Manual text-model preview

Start with [README.md](../README.md) for current release behavior. This document describes
the isolated [Electron Dev build](ELECTRON-DEVELOPMENT.md), implementing the first slice of
[#11](https://github.com/juferdinand/OpenWhisper/issues/11). Release 0.2.5 does not include it.
The functional migration requires user acceptance before merging or replacing an installation.

## Setup and behavior

In **Models**, scroll to **Text processing preview**. Choose LM Studio or Ollama, enter a
model identifier, review the instruction and destination, then enable manual previews.
Paste text into **Text to send** and choose **Send preview**. Review the plain-text reply
and copy it manually if useful. No model server is contacted simply by opening settings.

| Provider | Default endpoint | Host request |
| --- | --- | --- |
| LM Studio | `http://127.0.0.1:1234/v1` | `POST /v1/chat/completions` |
| Ollama | `http://127.0.0.1:11434` | `POST /api/chat` |

The adapters send separate system/user messages, the chosen model, `stream: false`,
temperature zero and the configured token limit. The protocol follows [LM Studio chat
completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions) and
[Ollama chat](https://docs.ollama.com/api/chat).

The preview never replaces the original transcript or runs automatically after dictation.
Server failures, missing models, timeouts, cancellation and invalid replies leave the
input available for retry. **Use latest dictation** copies an available transcript into
the preview field; capture itself is not available in the initial Electron Dev build.
Settings save as field patches. Input and replies disappear when that renderer session ends.

## Privacy and limits

Requests originate in the Electron host. The sandboxed renderer cannot fetch model endpoints.
Only HTTP with exact numeric `127.0.0.1` or `[::1]`, an explicit port from 1 to 65535 and
the provider's base path is accepted. Hostnames, credentials, remote addresses, alternate
paths, queries and fragments are rejected. The host uses no DNS resolution, environment
proxy, redirects, cookies, implicit credentials, API-key field or cloud fallback.

A loopback destination does not prove that the chosen server/model executes locally.
Check that server's configuration before sending; it can itself forward text elsewhere.
Replies are displayed as text and never executed as instructions, HTML or coding-agent actions.
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

The [shared profile schema](../shared/local-processing.schema.json) and
[endpoint/profile/response vectors](../shared/local-processing-vectors.json) retain PR17's
contract. Runtime schemas additionally validate UTF-8 bytes. Optional preferences live in
the Dev profile's `config/settings/local-processing.json` with mode `0600`, outside ordinary
preferences. Invalid saved content is preserved while disabled defaults are used in memory;
only an explicit valid edit replaces that file. Unsafe filesystem paths still fail closed.

## Evidence and acceptance

Owned HTTP tests cover both providers over IPv4/IPv6, exact multilingual input, response
validation, proxy bypass, redirect rejection, byte bounds, header/body/trickle deadlines,
server disconnection, cancellation and reuse. Typed browser fixtures cover delayed patches,
focus, failed saves and stale preview/cancellation responses. The real owned Electron UI
also tests its actual IPC, profile persistence, cancellation/retry and categorical errors.
These checks use synthetic servers; they do not establish model quality.

With the installed application still available, review a separate Dev build:

1. Confirm previews begin disabled and opening settings sends nothing.
2. Select an explicit LM Studio model, review the destination, and send short German and
   English samples. Repeat with Ollama and review quality and meaning.
3. Edit provider/model/instruction, change language and restart. Confirm saved fields
   persist while unsaved preview input/results disappear.
4. Stop the server, choose a missing model, shorten the timeout and cancel a slow request.
   Confirm clear feedback, unchanged input and a successful subsequent request.
5. Check that remote/hostname/credential/invalid-port endpoints are rejected. At minimum
   window size, scroll through the controls and review both English/German layouts.

Record app/build, OS and server/model versions with the result. Keep #11 open for cloud/BYOK
secrets, automatic workflows and later scope. TTS, Obsidian and coding-agent actions remain
later stages; ordinary local dictation remains independent of them.
