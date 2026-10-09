import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { platformReplySchema, type PlatformRequest } from "../../src/workers/platform/platform-protocol.js";
import { parseBusValues } from "../../src/platforms/linux/shared/bus-values.js";
import { fixtureKey, type PlatformEntryFixture } from "../fixtures/platform-entry-bus.js";

async function until(condition: () => boolean): Promise<void> {
  for (let count = 0; count < 500; count++) { if (condition()) return; await delay(2); }
  throw new Error("Owned worker fixture did not settle.");
}

/** Drives the real entry and control/portal code against a synthetic owned bus. */
async function owner(run: (fixture: PlatformEntryFixture, send: (request: unknown) => Promise<unknown>) => Promise<void>,
  failSubscribe = false): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-platform-entry-"));
  const entry = fileURLToPath(new URL("../../src/workers/platform-entry.ts", import.meta.url));
  const replacement = fileURLToPath(new URL("../fixtures/platform-entry-bus.ts", import.meta.url));
  const output = join(directory, "entry.mjs");
  const fixture: PlatformEntryFixture = { buses: [], failSubscribe, exitCodes: [] };
  const messages: unknown[] = [];
  let receive: ((event: { data: unknown }) => void) | undefined;
  const previousPort = Object.getOwnPropertyDescriptor(process, "parentPort");
  const previousFixture = Object.getOwnPropertyDescriptor(process, fixtureKey);
  try {
    await build({ entryPoints: [entry], outfile: output, bundle: true, format: "esm", platform: "node", target: "node24",
      logLevel: "silent", plugins: [{ name: "owned-platform-bus", setup(builder) {
        builder.onResolve({ filter: /^\./ }, (args) => {
          if (resolve(dirname(args.importer), args.path) === resolve(dirname(entry), "../platforms/linux/shared/bus.js")) {
            return { path: replacement };
          }
          return undefined;
        });
        builder.onLoad({ filter: /platform-entry\.ts$/ }, async () => ({ loader: "ts", resolveDir: dirname(entry),
          contents: `import { fixtureExit } from ${JSON.stringify(replacement)};\n${(await readFile(entry, "utf8")).replaceAll("process.exit(", "fixtureExit(")}` }));
      } }] });
    Object.defineProperty(process, fixtureKey, { configurable: true, value: fixture });
    Object.defineProperty(process, "parentPort", { configurable: true, value: {
      on(event: string, listener: (event: { data: unknown }) => void) { assert.equal(event, "message"); receive = listener; },
      postMessage(value: unknown) { messages.push(value); },
    } });
    await import(pathToFileURL(output).href);
    assert.deepEqual(messages.shift(), { version: 1, type: "ready" });
    await run(fixture, async (request) => {
      assert.ok(receive); receive({ data: request });
      if (typeof request === "object" && request !== null && typeof Reflect.get(request, "id") === "string") {
        const id: unknown = Reflect.get(request, "id");
        await until(() => messages.some((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === id));
        const index = messages.findIndex((message) => typeof message === "object" && message !== null && Reflect.get(message, "id") === id);
        return platformReplySchema.parse(messages.splice(index, 1)[0]);
      }
      await until(() => fixture.exitCodes.length > 0); return undefined;
    });
  } finally {
    if (previousPort) Object.defineProperty(process, "parentPort", previousPort); else Reflect.deleteProperty(process, "parentPort");
    if (previousFixture) Object.defineProperty(process, fixtureKey, previousFixture); else Reflect.deleteProperty(process, fixtureKey);
    await rm(directory, { recursive: true, force: true });
  }
}
const initialize = (appId?: "io.github.whisperfree.dev" | "io.github.whisperfree"): PlatformRequest => ({
  version: 1, id: randomUUID(), command: "initialize", address: "unix:path=/owned/synthetic-bus",
  ...(appId === undefined ? {} : { appId }),
});
const shutdown = (): PlatformRequest => ({ version: 1, id: randomUUID(), command: "shutdown" });

test("synthetic worker exports exactly its stable or Dev control identity", { skip: process.platform !== "linux" }, async () => {
  for (const appId of [undefined, "io.github.whisperfree.dev", "io.github.whisperfree"] as const) {
    await owner(async (fixture, send) => {
      const ready = platformReplySchema.parse(await send(initialize(appId)));
      assert.equal(ready.ok, true); assert.equal(fixture.buses.length, 1);
      const bus = fixture.buses[0]!;
      assert.equal(bus.exportCount, 1);
      const requested = bus.calls.filter((call) => call.member === "RequestName").map((call) => parseBusValues(call.body)[0]);
      assert.deepEqual(requested, [{ type: "s", value: appId === "io.github.whisperfree" ? "io.github.whisperfree.Control" : "io.github.whisperfree.dev.Control" }]);
      const repeat = platformReplySchema.parse(await send(initialize(appId)));
      assert.deepEqual(repeat.ok ? null : repeat.code, "BUSY"); assert.equal(fixture.buses.length, 1);
      assert.equal(platformReplySchema.parse(await send(shutdown())).ok, true);
      await until(() => fixture.exitCodes.length === 1);
      assert.deepEqual(fixture.exitCodes, [0]); assert.equal(bus.closeCount, 1); assert.equal(bus.subscriptions.size, 0);
    });
  }
});
test("synthetic stable worker closes an acquired bus on control initialization failure and refuses replay", { skip: process.platform !== "linux" }, async () => {
  await owner(async (fixture, send) => {
    const failed = platformReplySchema.parse(await send(initialize("io.github.whisperfree")));
    assert.deepEqual(failed.ok ? null : failed.code, "UNAVAILABLE");
    assert.equal(fixture.buses.length, 1); const bus = fixture.buses[0]!;
    assert.equal(bus.closeCount, 1); assert.equal(bus.exportCount, 0); assert.equal(bus.subscriptions.size, 0);
    const repeat = platformReplySchema.parse(await send(initialize("io.github.whisperfree")));
    assert.deepEqual(repeat.ok ? null : repeat.code, "BUSY"); assert.equal(fixture.buses.length, 1);
    assert.equal(platformReplySchema.parse(await send(shutdown())).ok, true);
    await until(() => fixture.exitCodes.length === 1); assert.equal(bus.closeCount, 1);
  }, true);
});
test("synthetic stable worker closes its bus before rejecting an invalid owner frame", { skip: process.platform !== "linux" }, async () => {
  await owner(async (fixture, send) => {
    assert.equal(platformReplySchema.parse(await send(initialize("io.github.whisperfree"))).ok, true);
    await send({ invalid: true });
    assert.deepEqual(fixture.exitCodes, [1]); assert.equal(fixture.buses[0]?.closeCount, 1);
    assert.equal(fixture.buses[0]?.subscriptions.size, 0);
  });
});
test("synthetic stable worker retains a pending bus acquisition across invalid-frame retirement", { skip: process.platform !== "linux" }, async () => {
  await owner(async (fixture, send) => {
    let release!: () => void;
    fixture.openingGate = new Promise<void>((accept) => { release = accept; });
    const initialization = send(initialize("io.github.whisperfree"));
    await until(() => fixture.buses.length === 1);
    const invalid = send({ invalid: true }); await delay(5);
    assert.deepEqual(fixture.exitCodes, []); assert.equal(fixture.buses[0]?.closeCount, 0);
    release(); await invalid;
    const refused = platformReplySchema.parse(await initialization);
    assert.deepEqual(refused.ok ? null : refused.code, "TEARDOWN_FAILED");
    assert.deepEqual(fixture.exitCodes, [1]); assert.equal(fixture.buses[0]?.closeCount, 1);
    assert.equal(fixture.buses[0]?.exportCount, 0); assert.equal(fixture.buses[0]?.subscriptions.size, 0);
  });
});
test("synthetic worker retires a late portal or control acquisition before exit and never reports initialized", { skip: process.platform !== "linux" }, async () => {
  for (const appId of ["io.github.whisperfree", "io.github.whisperfree.dev"] as const) {
    await owner(async (fixture, send) => {
      let release!: () => void;
      fixture.subscriptionGate = new Promise<void>((accept) => { release = accept; });
      const initialization = send(initialize(appId));
      await until(() => fixture.buses[0]?.subscriptions.size === 1);
      const invalid = send({ invalid: true }); await delay(5);
      assert.deepEqual(fixture.exitCodes, []); assert.equal(fixture.buses[0]?.closeCount, 0);
      release(); await invalid;
      const refused = platformReplySchema.parse(await initialization);
      assert.deepEqual(refused.ok ? null : refused.code, "TEARDOWN_FAILED");
      assert.deepEqual(fixture.exitCodes, [1]); assert.equal(fixture.buses[0]?.closeCount, 1);
      assert.equal(fixture.buses[0]?.subscriptions.size, 0);
      assert.equal(fixture.buses[0]?.exportCount, 1);
    });
  }
});
