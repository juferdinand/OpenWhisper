import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { createServer, setGlobalProxyFromEnv, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import {
  applyLocalProcessingProfilePatch, cancelLocalProcessingInputSchema, decodeLocalProcessingProfile,
  defaultLocalProcessingProfile, localProcessingOutputSchema, localProcessingProfilePatchSchema,
  localProcessingProfileSchema, localProcessingProviderSchema, MAX_LOCAL_PROCESSING_RESPONSE_BYTES,
  MAX_LOCAL_PROCESSING_TEXT_BYTES, parseLocalProcessingEndpoint, parseLocalProcessingResponse,
  previewLocalProcessingInputSchema, type LocalProcessingProfile, type LocalProcessingProvider,
} from "../src/contracts/local-processing.js";
import { LocalProcessingError, LocalProcessingService, type LocalProcessingFailureCode } from "../src/services/local-processing.js";

const vectorsSchema = z.strictObject({
  valid_endpoints: z.array(z.strictObject({ provider: localProcessingProviderSchema, endpoint: z.string(), request_url: z.string() })),
  invalid_endpoints: z.array(z.string()),
  responses: z.array(z.strictObject({ provider: localProcessingProviderSchema, value: z.unknown(), expected: z.string().optional() })),
  invalid_profiles: z.array(z.record(z.string(), z.unknown())),
  valid_profile_patches: z.array(z.record(z.string(), z.unknown())),
});
const vectorsInput: unknown = JSON.parse(await readFile(new URL("../../shared/local-processing-vectors.json", import.meta.url), "utf8"));
const vectors = vectorsSchema.parse(vectorsInput);
const jsonSchemaInput: unknown = JSON.parse(await readFile(new URL("../../shared/local-processing.schema.json", import.meta.url), "utf8"));
const jsonSchema = z.object({ required: z.array(z.string()), properties: z.record(z.string(), z.object({ default: z.unknown() })) }).parse(jsonSchemaInput);
const profile = (changes: Partial<LocalProcessingProfile> = {}): LocalProcessingProfile =>
  localProcessingProfileSchema.parse({ ...defaultLocalProcessingProfile(), enabled: true, model: "owned-fixture", ...changes });
const isCode = (code: LocalProcessingFailureCode) => (error: unknown): boolean =>
  error instanceof LocalProcessingError && error.code === code && !error.message.includes("private fixture detail");

function responseValue(provider: LocalProcessingProvider, content = "A structured fixture plan."): unknown {
  const message = { role: "assistant", content };
  return provider === "lm_studio" ? { choices: [{ finish_reason: "stop", message }] } : { done: true, done_reason: "stop", message };
}

interface CapturedRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

function capture(request: IncomingMessage): Promise<CapturedRequest> {
  return new Promise((accept, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.setTimeout(2000, () => request.destroy(new Error("Owned fixture request deadline.")));
    request.on("data", (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { request.destroy(new Error("Invalid owned fixture bytes.")); return; }
      bytes += chunk.byteLength;
      if (bytes > 512 * 1024) { request.destroy(new Error("Owned fixture request limit.")); return; }
      chunks.push(chunk);
    });
    request.once("error", reject);
    request.once("aborted", () => reject(new Error("Owned fixture request aborted.")));
    request.once("end", () => {
      try {
        const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
        accept({ method: request.method, path: request.url, headers: request.headers, body });
      } catch { reject(new Error("Invalid owned fixture request.")); }
    });
  });
}

async function ownedServer(t: TestContext,
  handler: (request: CapturedRequest, response: ServerResponse, later: (callback: () => void, milliseconds: number) => void) => void,
  host: "127.0.0.1" | "::1" = "127.0.0.1",
) {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const captured: CapturedRequest[] = [];
  const waiters: ((value: CapturedRequest) => void)[] = [];
  let requestCount = 0;
  const later = (callback: () => void, milliseconds: number): void => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
  };
  const server = createServer({ requestTimeout: 2000, headersTimeout: 2000 }, (request, response) => {
    requestCount += 1;
    response.on("error", () => {});
    void capture(request).then((value) => {
      const waiter = waiters.shift();
      if (waiter) waiter(value); else captured.push(value);
      handler(value, response, later);
    }).catch(() => response.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(4000, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, host, accept); });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  });
  return {
    endpoint: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
    get requestCount() { return requestCount; },
    nextRequest(): Promise<CapturedRequest> {
      const ready = captured.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error("Owned fixture capture deadline.")), 2000);
        waiters.push((value) => { clearTimeout(timer); accept(value); });
      });
    },
  };
}

test("shared PR17 endpoint/profile/default vectors retain exact contract", () => {
  const defaults = defaultLocalProcessingProfile();
  assert.equal(defaults.enabled, false);
  assert.deepEqual(decodeLocalProcessingProfile({}), defaults);
  for (const [key, value] of Object.entries(defaults)) {
    assert.deepEqual(jsonSchema.properties[key]?.default, value, key);
    assert.equal(jsonSchema.required.includes(key), true);
  }
  for (const value of vectors.valid_endpoints) {
    assert.equal(parseLocalProcessingEndpoint(value.provider, value.endpoint).requestURL, value.request_url);
    assert.equal(localProcessingProfileSchema.safeParse({ ...defaults, ...value, request_url: undefined }).success, false);
    assert.equal(localProcessingProfileSchema.safeParse({ ...defaults, provider: value.provider, endpoint: value.endpoint }).success, true);
  }
  for (const endpoint of vectors.invalid_endpoints) {
    assert.throws(() => decodeLocalProcessingProfile({ endpoint }), endpoint);
  }
  for (const value of vectors.invalid_profiles) assert.throws(() => decodeLocalProcessingProfile(value));
  for (const value of vectors.valid_profile_patches) assert.doesNotThrow(() => decodeLocalProcessingProfile(value));
});

test("shared PR17 response vectors preserve text and reject incomplete/action/error replies", () => {
  for (const [index, value] of vectors.responses.entries()) {
    if (value.expected === undefined) assert.throws(() => parseLocalProcessingResponse(value.provider, value.value), String(index));
    else assert.equal(parseLocalProcessingResponse(value.provider, value.value), value.expected, String(index));
  }
});

test("profile patches, Unicode byte bounds and IPC inputs reject malformed values without coercion", () => {
  const original = defaultLocalProcessingProfile();
  const changed = applyLocalProcessingProfilePatch(original, { provider: "ollama", endpoint: "http://127.0.0.1:11434", model: "⁦نموذج⁩👩‍💻" });
  assert.equal(changed.enabled, false);
  assert.equal(original.provider, "lm_studio");
  assert.equal(Object.isFrozen(changed), true);
  assert.throws(() => applyLocalProcessingProfilePatch(original, { provider: "ollama" }));
  for (const patch of [{ timeout_seconds: NaN }, { max_tokens: Infinity }, { enabled: undefined }, { instruction: "é".repeat(4097) }, { model: "é".repeat(129) }, { arbitrary: true }]) {
    assert.equal(localProcessingProfilePatchSchema.safeParse(patch).success, false);
  }
  assert.equal(previewLocalProcessingInputSchema.safeParse({ requestId: "request", text: "é".repeat(32768) }).success, true);
  for (const value of [
    { requestId: "", text: "Original" }, { requestId: "é".repeat(65), text: "Original" },
    { requestId: "request", text: "é".repeat(32769) }, { requestId: "request", text: " \t\n" },
    { requestId: "request", text: "Original", path: "/private" }, { requestId: "request", text: "\ud800" },
  ]) assert.equal(previewLocalProcessingInputSchema.safeParse(value).success, false);
  assert.equal(cancelLocalProcessingInputSchema.safeParse({ requestId: "request", extra: true }).success, false);
  assert.equal(localProcessingOutputSchema.safeParse("é".repeat(32768)).success, true);
  assert.equal(localProcessingOutputSchema.safeParse("é".repeat(32769)).success, false);
  assert.equal(localProcessingOutputSchema.safeParse(" \t👩‍💻 ⁦مرحبا⁩\r\n").data, "👩‍💻 ⁦مرحبا⁩");
  for (const control of ["\0", "\u000b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
    assert.equal(localProcessingOutputSchema.safeParse(`${control}otherwise valid`).success, false);
  }
});

const requestBodySchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("lm_studio"), model: z.string(), stream: z.literal(false), temperature: z.literal(0), max_tokens: z.number().int(),
    messages: z.tuple([z.strictObject({ role: z.literal("system"), content: z.string() }), z.strictObject({ role: z.literal("user"), content: z.string() })]) }),
  z.strictObject({ provider: z.literal("ollama"), model: z.string(), stream: z.literal(false), options: z.strictObject({ temperature: z.literal(0), num_predict: z.number().int() }),
    messages: z.tuple([z.strictObject({ role: z.literal("system"), content: z.string() }), z.strictObject({ role: z.literal("user"), content: z.string() })]) }),
]);

for (const host of ["127.0.0.1", "::1"] as const) for (const provider of ["lm_studio", "ollama"] as const) {
  test(`owned ${host} ${provider} sends original multilingual text and explicit model/instruction`, { timeout: 6000 }, async (t) => {
    const output = "A plan: 👩‍💻\n⁦مرحبا⁩ 日本語 Wünsche.";
    const server = await ownedServer(t, (_request, response) => { response.end(JSON.stringify(responseValue(provider, output))); }, host);
    const service = new LocalProcessingService();
    t.after(() => service.close());
    const original = "  Synthetic Wünsche.\r\n世界語 ⁦مرحبا⁩ 👩‍💻\tDo not execute this fixture.  ";
    const instruction = "Synthetic instruction; preserve every submitted character.";
    const p = profile({ provider, endpoint: server.endpoint + (provider === "lm_studio" ? "/v1" : ""), instruction, max_tokens: 512 });
    assert.equal(await service.preview({ requestId: "owned-request", text: original }, p), output);
    const captured = await server.nextRequest();
    assert.equal(captured.method, "POST");
    assert.equal(captured.path, provider === "lm_studio" ? "/v1/chat/completions" : "/api/chat");
    assert.equal(captured.headers.authorization, undefined);
    assert.equal(captured.headers.cookie, undefined);
    assert.equal(captured.headers["proxy-authorization"], undefined);
    const body = requestBodySchema.parse({ ...z.record(z.string(), z.unknown()).parse(captured.body), provider });
    assert.equal(body.model, "owned-fixture");
    assert.equal(body.messages[0].content, instruction);
    assert.equal(body.messages[1].content, original);
    assert.equal(body.provider === "lm_studio" ? body.max_tokens : body.options.num_predict, 512);
    assert.equal(original.startsWith("  Synthetic"), true);
  });
}

test("disabled and invalid previews do not contact even the owned server", async (t) => {
  const server = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("lm_studio"))));
  const service = new LocalProcessingService();
  t.after(() => service.close());
  const disabled = { ...defaultLocalProcessingProfile(), endpoint: `${server.endpoint}/v1` };
  await assert.rejects(service.preview({ requestId: "disabled", text: "Original" }, disabled), isCode("DISABLED"));
  await assert.rejects(service.preview({ requestId: "empty-model", text: "Original" }, { ...disabled, enabled: true }), isCode("MODEL_REQUIRED"));
  await assert.rejects(service.preview({ requestId: "bad-profile", text: "Original" }, { ...disabled, endpoint: "http://localhost:1234/v1" }), isCode("INVALID_PROFILE"));
  await assert.rejects(service.preview({ requestId: "extra", text: "Original", instruction: "private fixture detail" }, disabled), isCode("INVALID_REQUEST"));
  await assert.rejects(service.preview({ requestId: "large", text: "x".repeat(MAX_LOCAL_PROCESSING_TEXT_BYTES + 1) }, disabled), isCode("INVALID_REQUEST"));
  await assert.rejects(service.preview({ get requestId() { throw new Error("private fixture detail"); }, text: "Original" }, disabled), isCode("INVALID_REQUEST"));
  assert.equal(server.requestCount, 0);
});

test("maximum UTF-8 input is sent intact rather than truncated", async (t) => {
  const server = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("ollama"))));
  const service = new LocalProcessingService();
  t.after(() => service.close());
  const original = "é".repeat(MAX_LOCAL_PROCESSING_TEXT_BYTES / 2);
  await service.preview({ requestId: "boundary", text: original }, profile({ provider: "ollama", endpoint: server.endpoint }));
  const body = requestBodySchema.parse({ ...z.record(z.string(), z.unknown()).parse((await server.nextRequest()).body), provider: "ollama" });
  assert.equal(body.messages[1].content, original);
  assert.equal(Buffer.byteLength(body.messages[1].content, "utf8"), MAX_LOCAL_PROCESSING_TEXT_BYTES);
});

test("redirects are rejected without following Location or disclosing server detail", async (t) => {
  const destination = await ownedServer(t, (_request, response) => response.end("private fixture detail"));
  for (const status of [301, 302, 303, 307, 308]) {
    const server = await ownedServer(t, (_request, response) => {
      response.writeHead(status, { Location: `${destination.endpoint}/never-follow` });
      response.end("private fixture detail");
    });
    const service = new LocalProcessingService();
    await assert.rejects(service.preview({ requestId: `redirect-${status}`, text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("HTTP_REJECTED"));
    service.close();
  }
  assert.equal(destination.requestCount, 0);
});

test("authentication/server failures and invalid JSON expose only fixed safe errors", async (t) => {
  for (const status of [401, 403, 500, 503]) {
    const server = await ownedServer(t, (_request, response) => {
      response.writeHead(status, { "WWW-Authenticate": "Basic realm=private" });
      response.end("private fixture detail");
    });
    await assert.rejects(new LocalProcessingService().preview({ requestId: `error-${status}`, text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("HTTP_REJECTED"));
    assert.equal(server.requestCount, 1);
  }
  const invalid = await ownedServer(t, (_request, response) => response.end("private fixture detail; not JSON"));
  await assert.rejects(new LocalProcessingService().preview({ requestId: "invalid", text: "Synthetic original" }, profile({ endpoint: `${invalid.endpoint}/v1` })), isCode("INVALID_RESPONSE"));
});

test("owned servers returning truncated/tool/refusal/error/control output are rejected", async (t) => {
  for (const [index, fixture] of vectors.responses.entries()) {
    if (fixture.expected !== undefined) continue;
    const server = await ownedServer(t, (_request, response) => response.end(JSON.stringify(fixture.value)));
    const p = profile({ provider: fixture.provider, endpoint: server.endpoint + (fixture.provider === "lm_studio" ? "/v1" : "") });
    await assert.rejects(new LocalProcessingService().preview({ requestId: `fixture-${index}`, text: "Synthetic original" }, p), isCode("INVALID_RESPONSE"));
  }
});

test("declared and chunked response byte limits stop owned HTTP bodies", async (t) => {
  for (const framing of ["length", "chunked"] as const) {
    const server = await ownedServer(t, (_request, response) => {
      if (framing === "length") {
        response.writeHead(200, { "Content-Length": MAX_LOCAL_PROCESSING_RESPONSE_BYTES + 1 });
        response.flushHeaders();
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write(Buffer.alloc(MAX_LOCAL_PROCESSING_RESPONSE_BYTES / 2, 0x20));
        response.end(Buffer.alloc(MAX_LOCAL_PROCESSING_RESPONSE_BYTES / 2 + 1, 0x20));
      }
    });
    await assert.rejects(new LocalProcessingService().preview({ requestId: framing, text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("RESPONSE_TOO_LARGE"));
  }
});

test("exact response and UTF-8 output byte limits succeed while a larger text output fails", async (t) => {
  const output = "é".repeat(MAX_LOCAL_PROCESSING_TEXT_BYTES / 2);
  const encoded = Buffer.from(JSON.stringify(responseValue("lm_studio", output)), "utf8");
  const exactBody = Buffer.concat([encoded, Buffer.alloc(MAX_LOCAL_PROCESSING_RESPONSE_BYTES - encoded.byteLength, 0x20)]);
  const exact = await ownedServer(t, (_request, response) => response.end(exactBody));
  assert.equal(await new LocalProcessingService().preview({ requestId: "exact-response", text: "Synthetic original" }, profile({ endpoint: `${exact.endpoint}/v1` })), output);
  const larger = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("lm_studio", `${output}é`))));
  await assert.rejects(new LocalProcessingService().preview({ requestId: "larger-output", text: "Synthetic original" }, profile({ endpoint: `${larger.endpoint}/v1` })), isCode("INVALID_RESPONSE"));
});

test("invalid UTF-8 and lone JSON surrogates cannot become silently replaced model text", async (t) => {
  for (const body of [Buffer.from([0xc3, 0x28]), Buffer.from('{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"\\ud800"}}]}'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(responseValue("lm_studio")))])]) {
    const server = await ownedServer(t, (_request, response) => response.end(body));
    await assert.rejects(new LocalProcessingService().preview({ requestId: "invalid-unicode", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("INVALID_RESPONSE"));
  }
});

test("incomplete HTTP body and incomplete JSON reject rather than publish partial text", async (t) => {
  for (const incompleteHTTP of [true, false]) {
    const server = await ownedServer(t, (_request, response, later) => {
      if (incompleteHTTP) {
        response.writeHead(200, { "Content-Length": 1000 });
        response.write('{"private fixture detail":');
        later(() => response.destroy(), 20);
      } else response.end('{"private fixture detail":');
    });
    await assert.rejects(new LocalProcessingService().preview({ requestId: "partial", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode(incompleteHTTP ? "RESPONSE_READ_FAILED" : "INVALID_RESPONSE"));
  }
});

for (const stage of ["headers", "body", "trickle"] as const) {
  test(`total timeout includes ${stage} and allows a clean retry`, { timeout: 6000 }, async (t) => {
    const server = await ownedServer(t, (_request, response, later) => {
      if (stage === "headers") later(() => response.end(JSON.stringify(responseValue("ollama"))), 1600);
      else {
        response.writeHead(200);
        response.flushHeaders();
        if (stage === "body") later(() => response.end(JSON.stringify(responseValue("ollama"))), 1600);
        else for (const milliseconds of [200, 400, 600, 800, 1200]) later(() => response.write(" "), milliseconds);
      }
    });
    const service = new LocalProcessingService();
    t.after(() => service.close());
    const start = performance.now();
    await assert.rejects(service.preview({ requestId: stage, text: "Synthetic original" }, profile({ provider: "ollama", endpoint: server.endpoint, timeout_seconds: 1 })), isCode("TIMEOUT"));
    assert.ok(performance.now() - start < 2500);
    const retry = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("ollama", "Retry ready."))));
    assert.equal(await service.preview({ requestId: "retry", text: "Synthetic original" }, profile({ provider: "ollama", endpoint: retry.endpoint })), "Retry ready.");
  });
}

test("cancellation has exact request ownership and old completions cannot clear a newer generation", async (t) => {
  const service = new LocalProcessingService();
  t.after(() => service.close());
  let lateAttempts = 0;
  const old = await ownedServer(t, (_request, response, later) => later(() => {
    lateAttempts += 1;
    response.end(JSON.stringify(responseValue("ollama", "Old result must not publish.")));
  }, 150));
  const next = await ownedServer(t, (_request, response, later) => later(() => response.end(JSON.stringify(responseValue("ollama", "New result."))), 300));
  const original = "Synthetic original 👩‍💻 Wünsche.";
  const rejectedOld = assert.rejects(service.preview({ requestId: "same-id", text: original }, profile({ provider: "ollama", endpoint: old.endpoint })), isCode("CANCELLED"));
  await old.nextRequest();
  service.cancel("wrong-id");
  await assert.rejects(service.preview({ requestId: "busy", text: original }, profile({ provider: "ollama", endpoint: next.endpoint })), isCode("BUSY"));
  assert.equal(next.requestCount, 0);
  service.cancel("same-id");
  const newest = service.preview({ requestId: "same-id", text: original }, profile({ provider: "ollama", endpoint: next.endpoint }));
  await rejectedOld;
  await next.nextRequest();
  await assert.rejects(service.preview({ requestId: "still-busy", text: original }, profile({ provider: "ollama", endpoint: next.endpoint })), isCode("BUSY"));
  assert.equal(await newest, "New result.");
  assert.equal(lateAttempts, 1);
  assert.equal(original, "Synthetic original 👩‍💻 Wünsche.");
});

test("external cancellation and service close stop an actual response and refuse later use", async (t) => {
  const server = await ownedServer(t, (_request, response) => { response.writeHead(200); response.flushHeaders(); response.write(" "); });
  const service = new LocalProcessingService();
  t.after(() => service.close());
  const controller = new AbortController();
  const cancelled = assert.rejects(service.preview({ requestId: "abort", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` }), controller.signal), isCode("CANCELLED"));
  await server.nextRequest();
  controller.abort();
  await cancelled;
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(service.preview({ requestId: "pre-abort", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` }), alreadyAborted.signal), isCode("CANCELLED"));
  const closing = assert.rejects(service.preview({ requestId: "close", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("CANCELLED"));
  await server.nextRequest();
  service.close();
  service.close();
  await closing;
  await assert.rejects(service.preview({ requestId: "closed", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), isCode("CLOSED"));
  assert.equal(server.requestCount, 2);
});

test("server-off connection failure is bounded and does not prevent another owned request", async (t) => {
  const temporary = createServer();
  await new Promise<void>((accept) => temporary.listen(0, "127.0.0.1", accept));
  const address = temporary.address();
  assert.ok(address !== null && typeof address !== "string");
  await new Promise<void>((accept, reject) => temporary.close((error) => error ? reject(error) : accept()));
  const service = new LocalProcessingService();
  t.after(() => service.close());
  await assert.rejects(service.preview({ requestId: "server-off", text: "Synthetic original" }, profile({ endpoint: `http://127.0.0.1:${address.port}/v1`, timeout_seconds: 1 })), isCode("CONNECTION_FAILED"));
  const server = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("lm_studio"))));
  assert.equal(await service.preview({ requestId: "retry", text: "Synthetic original" }, profile({ endpoint: `${server.endpoint}/v1` })), "A structured fixture plan.");
});

test("a global environment proxy never receives the private numeric-loopback request", async (t) => {
  const proxy = await ownedServer(t, (_request, response) => response.end("private fixture detail"));
  const server = await ownedServer(t, (_request, response) => response.end(JSON.stringify(responseValue("ollama"))));
  const reset = setGlobalProxyFromEnv({ HTTP_PROXY: proxy.endpoint, NO_PROXY: "" });
  t.after(reset);
  const service = new LocalProcessingService();
  t.after(() => service.close());
  assert.equal(await service.preview({ requestId: "proxy-free", text: "Synthetic original" }, profile({ provider: "ollama", endpoint: server.endpoint })), "A structured fixture plan.");
  assert.equal(server.requestCount, 1);
  assert.equal(proxy.requestCount, 0);
});
