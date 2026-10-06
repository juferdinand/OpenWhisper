# Manual text processing preview

Start with [README.md](../README.md) for installation and current release behavior. This document
describes the first development slice of [#11](https://github.com/juferdinand/OpenWhisper/issues/11).
It is prepared on an isolated branch and requires supervised acceptance before merging or replacing
an installation. The 0.2.4 release does not include it.

## Scope and setup

The existing **Models** page has an optional **Text processing preview** section. It is disabled
by default. Choose LM Studio or Ollama, enter an explicit model identifier, review the processing
instruction and destination, and enable manual previews. Paste text into **Text to send**, or use
**Use latest dictation** to copy the latest transcript into that field. Only **Send preview** sends
the visible input to the selected server. Review the result and copy it manually if useful.

The preview never changes the original transcript, history, clipboard, recording, or recovery WAV.
It does not run automatically after dictation. An unavailable model, timeout, cancellation, or invalid
reply leaves the input available for review and retry. Changing provider also selects its usual endpoint;
you can then edit the port. Settings persist as field patches. Preview input and results remain only in
the current UI session; they are not saved into preferences, history, or diagnostics.

| Provider | Default endpoint | Native request |
| --- | --- | --- |
| LM Studio | `http://127.0.0.1:1234/v1` | `POST /v1/chat/completions` |
| Ollama | `http://127.0.0.1:11434` | `POST /api/chat` |

The adapters follow the official [LM Studio chat-completions](https://lmstudio.ai/docs/developer/openai-compat/chat-completions)
and [Ollama chat](https://docs.ollama.com/api/chat) contracts. They send separate system/user messages,
the selected model, `stream: false`, temperature zero, and the configured output-token limit.
Owned synthetic HTTP fixtures establish request/response compatibility; they do not establish model
quality or acceptance of a particular installed server version.

## Transport and limits

Requests originate in the Linux Rust host or macOS Swift host. The renderer's content-security policy
still permits native IPC only. Endpoints must be HTTP with the exact numeric host `127.0.0.1` or
`[::1]`, an explicit port from 1 to 65535, and the provider's base path. Port 80 is accepted only when
explicitly entered; leading-zero ports normalize to the same numeric port. Credentials, host names,
non-loopback addresses, query strings, fragments, alternate paths, redirects, system proxies, cookies,
and implicit credentials are rejected or disabled. There is no API-key field or cloud fallback.

On macOS, ATS exceptions allow HTTP for exactly `127.0.0.1` and `::1`. The app has no general arbitrary-load
exception. Apple's [ATS exception-domain documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)
supports individual IP exceptions on macOS 14 and later. A separate bundled-app smoke test exercises both
addresses; a successful Swift test executable alone would not establish the bundled app's transport policy.

Loopback defines the transport destination. A server can forward requests or select a cloud model,
including through its own proxy configuration. The UI explicitly asks you to check that configuration
before sending. Local recognition remains independent of this optional server.

| Bound | Value |
| --- | --- |
| Endpoint | 256 UTF-8 bytes |
| Model identifier | 256 UTF-8 bytes; no C0/C1 control characters |
| Processing instruction | Nonblank; 8192 UTF-8 bytes |
| Preview input | Nonblank; 65536 UTF-8 bytes |
| Output limit | 32–4096 tokens; default 1024 |
| Request timeout, including response body | 1–120 seconds; default 30 |
| Received HTTP body | 1048576 bytes, including chunked responses |
| Valid preview result | Nonblank; 65536 UTF-8 bytes |

Replies must contain one completed assistant text response. Tool calls, refusals, partial/truncated
responses, non-text content, and C0/C1 controls other than line breaks and tabs are rejected. Emoji,
zero-width joiners, and multilingual formatting remain text. Replies are displayed as plain text and
are never treated as instructions, links to execute, or commands. Host diagnostics do not expose request
text, instructions, model replies, credentials, or server response bodies.

The shared [profile schema](../shared/local-processing.schema.json) describes complete snapshots;
preference updates are partial field patches. Native validators additionally enforce UTF-8 byte limits,
which JSON Schema's character counts cannot express. Both hosts use the same
[endpoint/profile/response fixtures](../shared/local-processing-vectors.json) and schema defaults.
At startup, a malformed optional profile falls back to a disabled default profile while retaining
ordinary dictation settings. Newly edited invalid profiles remain rejected.
This preview contains no TTS, Obsidian writes, coding-agent actions, cloud/BYOK providers, automatic
profile classification, or processing of ordinary dictation.

## Automated evidence and remaining acceptance

Linux `make linux-test` covers the shared frontend build, workspace Rust tests, Clippy, asset/translation
parity, exact ATS exceptions, and the IPC-only renderer policy. Native model tests use owned random-port
loopback servers and synthetic text only. They cover both adapters, separate instructions/original text,
invalid profiles/endpoints/replies, HTTP failures, redirects, disconnected servers, response bounds with
and without Content-Length, header/body timeouts, cancellation, and a subsequent preview.

The shared UI suite covers the existing 29 tests plus both host adapters' manual previews, rapid/delayed
field patches, stable switch nodes and focused fields through state changes, failed saves, profile persistence,
renderer-session-only text, cancellation across page changes, English/German UI, and unchanged transcript/history.
Run `cd shared/ui && npm run test:ui` after installing Playwright Chromium. Where the bundled browser cannot
start, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:ui` selects the installed browser.

Swift tests use the same shared fixtures and owned Python HTTP servers. Native CI also builds the app and
runs `--local-processing-smoke-test` with `WF_LOCAL_PROCESSING_FIXTURE` pointing to
`shared/tests/local-processing-server.py`. That mode owns fresh IPv4/IPv6 fixtures for both providers,
sends fixed synthetic text, and exits before normal hotkey/model initialization. It never enables or
saves the preview setting. The CI run and macOS bundle checks remain required evidence on a Mac runner.

Before acceptance, launch a separate development build with a disposable settings profile; keep the
running installation available. Do not replace it or merge the functional branch until the user accepts:

1. Confirm the preview begins disabled; normal dictation, history, clipboard/pasting, and Linux recovery
   retain their existing behavior without either model server running.
2. With an explicitly selected local LM Studio model, verify the visible endpoint/model, send a short
   German and English fixture, review the result, and confirm the original remains unchanged. Repeat with Ollama.
3. Change provider/model/instruction while saves are delayed or the app state changes; confirm controls
   retain focus and each saved field survives restarting the development build. Confirm unsaved preview
   text and results are cleared on restart.
4. Stop the server, choose a missing model, use a short timeout, and cancel a slow preview. Confirm a clear
   diagnostic, preserved input, empty result, and that another preview remains possible.
5. Try a remote host, `localhost`, credentials, a redirect, and an invalid port. Confirm rejection without
   a remote request or disclosure of server detail. Confirm the renderer cannot fetch model endpoints directly.
6. Switch English/German at normal and minimum window sizes, then navigate away and back during a preview.
   Confirm input is retained and cancellation still works. Review both native hosts separately.

Record server/model versions, host/build revision, OS, and results. Synthetic HTTP/UI checks, native Mac
CI, and supervised desktop/model checks are distinct evidence. Actual LM Studio/Ollama models, physical
microphone/hotkey/paste behavior, and macOS bundle execution are not inferred from Linux fixture success.
Keep #11 and outstanding desktop checks open until their full completion criteria are met.
