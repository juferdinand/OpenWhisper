import { Buffer } from "node:buffer";
import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import {
  decodeLocalProcessingProfile, MAX_LOCAL_PROCESSING_RESPONSE_BYTES,
  parseLocalProcessingEndpoint, parseLocalProcessingResponse, previewLocalProcessingInputSchema,
  type LocalProcessingProfile, type PreviewLocalProcessingInput,
} from "../contracts/local-processing.js";

const messages = Object.freeze({
  INVALID_REQUEST: "Invalid preview request",
  INVALID_PROFILE: "Invalid text processing profile",
  DISABLED: "Text processing preview is disabled",
  MODEL_REQUIRED: "Enter a text model identifier",
  BUSY: "A text processing preview is already running",
  CANCELLED: "Text processing cancelled; your dictation is unchanged",
  CLOSED: "Text processing preview is unavailable",
  TIMEOUT: "Text processing timed out; your dictation is unchanged",
  CONNECTION_FAILED: "Could not connect to the selected local server; your dictation is unchanged",
  HTTP_REJECTED: "The local server rejected the request; check its model and authentication settings",
  RESPONSE_TOO_LARGE: "The model response exceeded the preview limit",
  RESPONSE_READ_FAILED: "Could not read the model response",
  INVALID_RESPONSE: "The model returned an invalid or incomplete text response",
});
export type LocalProcessingFailureCode = keyof typeof messages;
/** Error messages are fixed: never include submitted text, server bodies or transport exceptions. */
export class LocalProcessingError extends Error {
  constructor(readonly code: LocalProcessingFailureCode) { super(messages[code]); this.name = "LocalProcessingError"; }
}

function requestBody(profile: LocalProcessingProfile, text: string): Buffer {
  const base = { model: profile.model, messages: [
    { role: "system", content: profile.instruction }, { role: "user", content: text },
  ], stream: false };
  return Buffer.from(JSON.stringify(profile.provider === "lm_studio"
    ? { ...base, temperature: 0, max_tokens: profile.max_tokens }
    : { ...base, options: { temperature: 0, num_predict: profile.max_tokens } }), "utf8");
}

function send(profile: LocalProcessingProfile, text: string, signal: AbortSignal): Promise<string> {
  const endpoint = parseLocalProcessingEndpoint(profile.provider, profile.endpoint);
  const body = requestBody(profile, text);
  return new Promise<string>((accept, reject) => {
    // The global agent may inherit NODE_USE_ENV_PROXY. This request owns a proxy-free
    // agent and numeric socket destination; no cookies, credentials or redirects exist.
    const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let settled = false;
    const finish = (result: { ok: true; value: string } | { ok: false; error: LocalProcessingError }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      incoming?.destroy();
      outgoing?.destroy();
      agent.destroy();
      if (result.ok) accept(result.value); else reject(result.error);
    };
    const fail = (code: LocalProcessingFailureCode): void => finish({ ok: false, error: new LocalProcessingError(code) });
    const abort = (): void => fail("CANCELLED");
    // A total deadline covers connect, headers, and every body chunk, not merely socket inactivity.
    const timer = setTimeout(() => fail("TIMEOUT"), profile.timeout_seconds * 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try {
      outgoing = request({
        protocol: "http:", hostname: endpoint.hostname, port: endpoint.port, path: endpoint.path,
        method: "POST", agent, family: endpoint.hostname === "::1" ? 6 : 4,
        maxHeaderSize: 16 * 1024, insecureHTTPParser: false,
        // Literal IPs bypass lookup; fail closed if a future edit introduces a DNS lookup.
        lookup: (_hostname, _options, callback) => callback(new LocalProcessingError("INVALID_PROFILE"), "", 4),
        headers: { "Content-Type": "application/json", "Content-Length": body.byteLength, "Accept-Encoding": "identity" },
      }, (response) => {
        incoming = response;
        if (settled) { response.destroy(); return; }
        const status = response.statusCode;
        if (status === undefined || status < 200 || status > 299) { fail("HTTP_REJECTED"); return; }
        const length = response.headers["content-length"];
        if (length !== undefined && (typeof length !== "string" || !/^[0-9]+$/u.test(length) ||
            !Number.isSafeInteger(Number(length)) || Number(length) > MAX_LOCAL_PROCESSING_RESPONSE_BYTES)) {
          fail("RESPONSE_TOO_LARGE"); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: unknown) => {
          if (settled) return;
          if (!Buffer.isBuffer(chunk)) { fail("INVALID_RESPONSE"); return; }
          bytes += chunk.byteLength;
          if (bytes > MAX_LOCAL_PROCESSING_RESPONSE_BYTES) { fail("RESPONSE_TOO_LARGE"); return; }
          chunks.push(chunk);
        });
        response.on("error", () => fail("RESPONSE_READ_FAILED"));
        response.on("aborted", () => fail("RESPONSE_READ_FAILED"));
        response.on("end", () => {
          if (settled) return;
          if (!response.complete) { fail("RESPONSE_READ_FAILED"); return; }
          try {
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)));
            finish({ ok: true, value: parseLocalProcessingResponse(profile.provider, value) });
          } catch { fail("INVALID_RESPONSE"); }
        });
      });
      outgoing.on("error", () => fail("CONNECTION_FAILED"));
      outgoing.on("upgrade", (_response, socket) => { socket.destroy(); fail("HTTP_REJECTED"); });
      outgoing.on("connect", (_response, socket) => { socket.destroy(); fail("HTTP_REJECTED"); });
      outgoing.end(body);
    } catch { fail("CONNECTION_FAILED"); }
  });
}

interface ActivePreview {
  readonly requestId: string;
  readonly generation: number;
  readonly controller: AbortController;
}

/** Manual, one-request service. It never reads or writes dictation, history, or recovery state. */
export class LocalProcessingService {
  private active: ActivePreview | undefined;
  private generation = 0;
  private closed = false;

  async preview(input: unknown, profileInput: unknown, signal?: AbortSignal): Promise<string> {
    let parsed: PreviewLocalProcessingInput;
    try { parsed = previewLocalProcessingInputSchema.parse(input); }
    catch { throw new LocalProcessingError("INVALID_REQUEST"); }
    let profile: LocalProcessingProfile;
    try { profile = decodeLocalProcessingProfile(profileInput); }
    catch { throw new LocalProcessingError("INVALID_PROFILE"); }
    if (this.closed) throw new LocalProcessingError("CLOSED");
    if (this.active) throw new LocalProcessingError("BUSY");
    if (signal?.aborted) throw new LocalProcessingError("CANCELLED");
    if (!profile.enabled) throw new LocalProcessingError("DISABLED");
    if (profile.model.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").length === 0) {
      throw new LocalProcessingError("MODEL_REQUIRED");
    }
    const active: ActivePreview = { requestId: parsed.requestId, generation: ++this.generation, controller: new AbortController() };
    this.active = active;
    const abort = (): void => { if (this.active === active) this.cancel(active.requestId); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const output = await send(profile, parsed.text, active.controller.signal);
      if (this.active !== active || active.generation !== this.generation || active.controller.signal.aborted || this.closed) {
        throw new LocalProcessingError("CANCELLED");
      }
      return output;
    } catch (error: unknown) {
      if (error instanceof LocalProcessingError) throw error;
      throw new LocalProcessingError("CONNECTION_FAILED");
    } finally {
      signal?.removeEventListener("abort", abort);
      // Cancellation frees the slot immediately. An old completion cannot clear a newer owner.
      if (this.active === active) this.active = undefined;
    }
  }

  cancel(requestId: string): void {
    const active = this.active;
    if (!active || active.requestId !== requestId) return;
    this.active = undefined;
    this.generation += 1;
    active.controller.abort();
  }

  close(): void {
    this.closed = true;
    if (this.active) this.cancel(this.active.requestId);
  }
}
