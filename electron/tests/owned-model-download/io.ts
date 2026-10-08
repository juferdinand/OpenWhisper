import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, request } from "node:https";
import type { AgentOptions, RequestOptions } from "node:https";
import type { Socket } from "node:net";
import type { ModelDownloadHTTPSIO } from "../../src/services/model-download-transport.js";
import { FixtureError, route, type Case, type Component } from "./contracts.js";
import { NotificationGate, Witness } from "./witness.js";

/** Only transport's forwarded registrations are delayed; Node internals keep
 * their original object and methods. All ordinary cases return originals. */
function view<T extends EventEmitter>(original: T, component: Component, held: Component, gate: NotificationGate,
  socketView: (socket: Socket) => Socket): T {
  return new Proxy(original, { get(target, key) {
    if (key === "once") return (event: string | symbol, callback: (...args: unknown[]) => void): T => {
      if (event === "close" && component === held) target.once(event, (...args: unknown[]) => { gate.receive(() => { callback.apply(target, args); }); });
      else if (event === "socket" && component === "request") target.once(event, (socket: Socket) => { callback(socketView(socket)); });
      else target.once(event, callback);
      return original;
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export class OwnedHTTPSIO implements ModelDownloadHTTPSIO {
  readonly witness = new Witness(); readonly gate = new NotificationGate();
  requestCount = 0; apparentEOFObserved = false; localErrorObserved = false;
  parserIncompleteObserved = false;
  readonly held: Component | undefined;
  constructor(private readonly port: number, private readonly ca: Buffer, private readonly scenario: Case) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || ca.length > 16_384 || !ca.length) throw new FixtureError();
    this.held = scenario === "held-request" ? "request" : scenario === "held-response" ? "response" : scenario === "held-socket" ? "socket" : undefined;
  }
  createAgent(options: AgentOptions): Agent {
    assert.deepEqual(options, { keepAlive: false, rejectUnauthorized: true, proxyEnv: {} });
    // Private fixture CA, never a production configuration or global trust edit.
    return new Agent({ ...options, ca: this.ca });
  }
  request(url: URL, options: RequestOptions, callback: (message: IncomingMessage) => void): ClientRequest {
    const destination = route(url, options.method); if (++this.requestCount > 7) throw new FixtureError();
    assert.equal(options.rejectUnauthorized, true); assert.ok(options.agent instanceof Agent);
    assert.deepEqual(options.headers, { "Accept-Encoding": "identity" }); assert.equal(options.maxHeaderSize, 16 * 1024);
    assert.deepEqual(Object.keys(options).sort(), ["agent", "headers", "maxHeaderSize", "method", "rejectUnauthorized"]);
    const held = destination === "payload" ? this.held : undefined;
    const socketView = (socket: Socket): Socket => held ? view(socket, "socket", held, this.gate, (item) => item) : socket;
    const owned = request(url, { ...options, port: this.port, servername: url.hostname, family: 4,
      lookup(hostname, _options, reply) {
        if (hostname !== "huggingface.co" && hostname !== "us.aws.cdn.hf.co") { reply(new FixtureError(), "", 4); return; }
        reply(null, "127.0.0.1", 4);
      } }, (message) => {
      this.witness.observe(message, "response");
      message.once("close", () => { if (destination === "payload" && !message.complete) this.parserIncompleteObserved = true; });
      if (destination === "payload" && this.scenario === "late-local-error") {
        message.prependOnceListener("end", () => {
          this.apparentEOFObserved = message.complete;
          // Real stream destruction with a locally injected categorical error,
          // distinct from a demonstrated remote TLS failure after EOF.
          message.destroy(new Error("OWNED_TERMINAL_FAILURE"));
        });
        message.on("error", () => { if (this.apparentEOFObserved) this.localErrorObserved = true; });
      }
      callback(held ? view(message, "response", held, this.gate, socketView) : message);
    });
    this.witness.observe(owned, "request");
    owned.prependOnceListener("socket", (socket: Socket) => { this.witness.observe(socket, "socket"); });
    return held ? view(owned, "request", held, this.gate, socketView) : owned;
  }
}
