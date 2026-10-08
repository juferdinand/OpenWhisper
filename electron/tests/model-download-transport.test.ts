import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Agent, AgentOptions, RequestOptions } from "node:https";
import { globalAgent } from "node:https";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { createModelDownloadTransport, ModelDownloadTransportError, type ModelDownloadHTTPSIO } from "../src/services/model-download-transport.js";

class InertSocket extends EventEmitter {
  destroyed = false; closed = false; hold = false;
  destroy(): this { this.destroyed = true; if (!this.hold) queueMicrotask(() => { this.finish(); }); return this; }
  finish(): void { if (!this.closed) { this.closed = true; this.emit("close"); } }
}
class InertResponse extends Readable {
  complete = false; statusCode = 200; rawHeaders = ["Content-Length", "4"];
  constructor(private readonly data: Uint8Array = Buffer.from("test")) { super({ autoDestroy: true }); }
  override _read(): void { this.complete = true; this.push(this.data); this.push(null); }
}
class InertRequest extends EventEmitter {
  destroyed = false; closed = false; endCalls = 0; destroyCalls = 0;
  readonly socket = new InertSocket(); readonly response = new InertResponse();
  holdHeaders = false;
  constructor(private readonly reply: (message: IncomingMessage) => void) { super(); }
  end(): void {
    this.endCalls++; queueMicrotask(() => {
      this.emit("socket", this.socket); if (!this.holdHeaders && !this.destroyed) this.sendHeaders();
    });
  }
  sendHeaders(): void { this.reply(this.response as unknown as IncomingMessage); }
  destroy(): this {
    if (this.destroyed) return this; this.destroyCalls++; this.destroyed = true;
    queueMicrotask(() => { this.closed = true; this.emit("close"); }); return this;
  }
}
function effects(prepare: (request: InertRequest) => void = () => {}) {
  const requests: InertRequest[] = [], requestOptions: RequestOptions[] = [], agentOptions: AgentOptions[] = [];
  const agent = { destroy() {} } as unknown as Agent;
  const io: ModelDownloadHTTPSIO = { createAgent(options) { agentOptions.push(options); return agent; },
    request(_url, options, reply) {
      requestOptions.push(options); const owned = new InertRequest(reply); prepare(owned); requests.push(owned);
      return owned as unknown as ClientRequest;
    } };
  return { io, agent, requests, requestOptions, agentOptions };
}
test("fixed HTTPS effects force certificate verification empty proxy policy and no environment credentials", async () => {
  const names = ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_USE_ENV_PROXY", "HTTPS_PROXY", "ALL_PROXY", "HF_TOKEN"] as const;
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"; process.env["NODE_USE_ENV_PROXY"] = "1";
    process.env["HTTPS_PROXY"] = "http://inert:credential@proxy.invalid"; process.env["ALL_PROXY"] = "http://proxy.invalid";
    process.env["HF_TOKEN"] = "inert-token-never-transmitted";
    const fake = effects(), transport = createModelDownloadTransport(fake.io), controller = new AbortController();
    assert.notEqual(fake.agent, globalAgent);
    assert.deepEqual(fake.agentOptions, [{ keepAlive: false, rejectUnauthorized: true, proxyEnv: {} }]);
    const exchange = transport.request(new URL("https://huggingface.co/inert"), "GET", controller.signal);
    await exchange.headers; const chunks: Uint8Array[] = [];
    for await (const chunk of exchange.body) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from("test"));
    const first = exchange.close(); assert.equal(exchange.close(), first); await first;
    assert.deepEqual(exchange.completion(), { complete: true, failed: false });
    assert.equal(fake.requestOptions[0]?.rejectUnauthorized, true);
    assert.equal(fake.requestOptions[0]?.agent, fake.agent);
    assert.deepEqual(fake.requestOptions[0]?.headers, { "Accept-Encoding": "identity" });
    assert.equal(fake.requests[0]?.destroyCalls, 1); await transport.close();
  } finally { for (const name of names) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
test("canceled pre-header request owns and closes its request and socket without allocating a second channel", async () => {
  const fake = effects((req) => { req.holdHeaders = true; }), transport = createModelDownloadTransport(fake.io), controller = new AbortController();
  const exchange = transport.request(new URL("https://hf.co/inert"), "HEAD", controller.signal);
  const rejection = assert.rejects(exchange.headers, ModelDownloadTransportError);
  await new Promise<void>((accept) => { setImmediate(accept); }); controller.abort(); await rejection; await exchange.close();
  assert.equal(fake.requests[0]?.closed, true); assert.equal(fake.requests[0]?.socket.closed, true);
  assert.equal(fake.requests.length, 1); await transport.close();
});
test("a held socket close keeps the same close promise pending after request close", async () => {
  const fake = effects((req) => { req.socket.hold = true; }), transport = createModelDownloadTransport(fake.io);
  const exchange = transport.request(new URL("https://hf.co/inert"), "GET", new AbortController().signal);
  await exchange.headers; const closing = exchange.close(); let settled = false;
  void closing.then(() => { settled = true; }); await new Promise<void>((accept) => { setImmediate(accept); });
  assert.equal(fake.requests[0]?.closed, true); assert.equal(settled, false); assert.equal(exchange.close(), closing);
  fake.requests[0]?.socket.finish(); await closing; await transport.close();
});
test("a terminal response error after apparent EOF remains failed before closure confirmation", async () => {
  const fake = effects(), transport = createModelDownloadTransport(fake.io);
  const exchange = transport.request(new URL("https://hf.co/inert"), "GET", new AbortController().signal);
  await exchange.headers;
  for await (const _chunk of exchange.body) { /* Inert body is intentionally consumed. */ }
  fake.requests[0]?.response.emit("error", new Error("Inert terminal failure must not escape."));
  await exchange.close(); assert.equal(exchange.completion().failed, true); await transport.close();
});
test("forbidden destinations or already aborted signals call no request effect", async () => {
  const fake = effects(), transport = createModelDownloadTransport(fake.io), controller = new AbortController();
  for (const address of ["http://hf.co/inert", "https://hf.co.evil.invalid/inert", "https://user@hf.co/inert", "https://hf.co./inert"]) {
    assert.throws(() => transport.request(new URL(address), "GET", controller.signal), ModelDownloadTransportError);
  }
  controller.abort(); assert.throws(() => transport.request(new URL("https://hf.co/inert"), "GET", controller.signal), ModelDownloadTransportError);
  assert.equal(fake.requests.length, 0); await transport.close();
});
