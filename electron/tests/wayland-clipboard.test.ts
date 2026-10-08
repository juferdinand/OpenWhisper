import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { WaylandClipboard, WaylandClipboardError, type WaylandClipboardEffects, type WaylandClipboardOwner } from "../src/services/wayland-clipboard.js";
import { deliverClipboard } from "../src/services/clipboard-output.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
class Owner implements WaylandClipboardOwner {
  isClosed = false;
  writeFails = false; closeFails = false;
  writeGate: ReturnType<typeof gate> | undefined;
  closeGate: ReturnType<typeof gate> | undefined;
  readonly writing = gate(); readonly closing = gate();
  text: string | undefined;
  constructor(readonly id: number, private readonly events: string[], private readonly publish: (text: string) => void) {}
  async write(text: string): Promise<void> {
    this.events.push(`write:${this.id}`); this.text = text; this.writing.release();
    await this.writeGate?.promise;
    if (this.writeFails) throw new Error("Clipboard unavailable.");
    this.publish(text);
  }
  async close(): Promise<void> {
    this.events.push(`close:${this.id}`); this.closing.release();
    await this.closeGate?.promise;
    if (this.closeFails) throw new Error("Clipboard cleanup failed.");
    this.isClosed = true; this.events.push(`closed:${this.id}`);
  }
}
function fixture() {
  const events: string[] = [], owners: Owner[] = [], limits: number[] = [];
  let value = "", prepared: Owner | undefined;
  const makeOwner = () => new Owner(owners.length + 1, events, (text) => { value = text; });
  const effects: WaylandClipboardEffects = {
    launch() {
      const owner = prepared ?? makeOwner(); prepared = undefined;
      owners.push(owner); events.push(`launch:${owner.id}`); return owner;
    },
    async read(maximumBytes) { limits.push(maximumBytes); events.push("read"); return value; },
  };
  return { events, owners, limits, clipboard: new WaylandClipboard(effects),
    prepare() { prepared = makeOwner(); return prepared; } };
}

test("Wayland publication confirms exact multilingual text through the independent reader", async () => {
  const { clipboard, owners, limits } = fixture(), text = "日本語 👩‍💻 äöü\nSecond line\n";
  await clipboard.writeText(text);
  assert.equal(await clipboard.readText(), text);
  assert.equal(owners.length, 1); assert.equal(owners[0]?.text, text);
  assert.ok(limits.length >= 2);
  assert.ok(limits.every((maximum) => maximum >= Buffer.byteLength(text, "utf8")));
  await clipboard.close(); assert.equal(owners[0]?.isClosed, true);
});

test("Wayland replacement waits for the previous owner to close before launching another", async () => {
  const { clipboard, owners, events } = fixture(); await clipboard.writeText("first");
  const previous = owners[0]; assert.ok(previous); previous.closeGate = gate();
  const replacement = clipboard.writeText("second");
  await previous.closing.promise;
  assert.equal(owners.length, 1); assert.equal(previous.isClosed, false);
  previous.closeGate.release(); await replacement;
  assert.equal(owners.length, 2); assert.equal(await clipboard.readText(), "second");
  assert.ok(events.indexOf("closed:1") < events.indexOf("launch:2"));
  await clipboard.close(); assert.ok(owners.every((owner) => owner.isClosed));
});

test("failed Wayland owner cleanup permanently refuses replacements", async () => {
  const { clipboard, owners } = fixture(); await clipboard.writeText("first");
  const previous = owners[0]; assert.ok(previous); previous.closeFails = true;
  await assert.rejects(clipboard.writeText("second"));
  assert.equal(owners.length, 1); assert.equal(previous.isClosed, false);
  await assert.rejects(clipboard.writeText("third")); assert.equal(owners.length, 1);
  await assert.rejects(clipboard.close()); assert.equal(owners.length, 1);
});

test("terminal Wayland reader cleanup retires the copy owner once while preserving terminal refusal", async () => {
  const events: string[] = [], owner = new Owner(1, events, () => {}); let launches = 0;
  const clipboard = new WaylandClipboard({
    launch() { launches++; return owner; },
    async read() { throw new WaylandClipboardError("TEARDOWN_FAILED"); },
  });
  const terminal = (error: unknown) => error instanceof WaylandClipboardError && error.code === "TEARDOWN_FAILED";
  await assert.rejects(clipboard.writeText("dictation"), terminal);
  assert.equal(owner.isClosed, true); assert.equal(events.filter((event) => event === "close:1").length, 1);
  await assert.rejects(clipboard.writeText("replacement"), terminal);
  await assert.rejects(clipboard.close(), terminal); await assert.rejects(clipboard.close(), terminal);
  assert.equal(launches, 1); assert.equal(events.filter((event) => event === "close:1").length, 1);
});

test("matching Wayland readback after copy owner closure cannot confirm the write", async () => {
  const events: string[] = [], owner = new Owner(1, events, () => {}), reading = gate(), response = gate();
  let reads = 0;
  const clipboard = new WaylandClipboard({
    launch() { return owner; },
    async read() { reads++; reading.release(); await response.promise; return "dictation"; },
  });
  const writing = clipboard.writeText("dictation"); void writing.catch(() => {});
  await reading.promise; owner.isClosed = true; response.release();
  await assert.rejects(writing, (error: unknown) => error instanceof WaylandClipboardError && error.code === "WRITE_FAILED");
  assert.equal(reads, 1); assert.equal(events.filter((event) => event === "close:1").length, 1);
  await clipboard.close(); assert.equal(events.filter((event) => event === "close:1").length, 1);
});

test("concurrent Wayland writes refuse the second publication without another owner", async () => {
  const fixtureState = fixture(), owner = fixtureState.prepare(); owner.writeGate = gate();
  const first = fixtureState.clipboard.writeText("first"); await owner.writing.promise;
  await assert.rejects(fixtureState.clipboard.writeText("second"));
  assert.equal(fixtureState.owners.length, 1); assert.equal(owner.text, "first");
  owner.writeGate.release(); await first;
  assert.equal(await fixtureState.clipboard.readText(), "first"); await fixtureState.clipboard.close();
});

test("missing Wayland clipboard tools clean the attempted owner and retain a failed replayable delivery", async () => {
  const fixtureState = fixture(), owner = fixtureState.prepare(); owner.writeFails = true;
  let pastes = 0;
  const receipt = await deliverClipboard("Preserved dictation", { generation: 3, attempt: 2, signal: new AbortController().signal }, {
    writeText: (text) => fixtureState.clipboard.writeText(text), readText: () => fixtureState.clipboard.readText(),
    paste: async () => { pastes++; return true; },
  });
  assert.deepEqual(receipt, { generation: 3, attempt: 2, outcome: "failed", clipboardConfirmed: false });
  assert.equal(pastes, 0); assert.equal(owner.isClosed, true); assert.equal(fixtureState.limits.length, 0);
  await fixtureState.clipboard.writeText("retry"); assert.equal(await fixtureState.clipboard.readText(), "retry");
  await fixtureState.clipboard.close();
});

test("app closure waits for the original Wayland write and owner cleanup before refusing later reads", async () => {
  const fixtureState = fixture(), owner = fixtureState.prepare(); owner.writeGate = gate(); owner.closeGate = gate();
  const writing = fixtureState.clipboard.writeText("pending");
  void writing.catch(() => {}); await owner.writing.promise;
  let finished = false;
  const closing = fixtureState.clipboard.close().then(() => { finished = true; });
  await nextTurn();
  assert.equal(finished, false); assert.equal(fixtureState.events.includes("close:1"), false);
  owner.writeGate.release(); await owner.closing.promise;
  assert.equal(finished, false); assert.equal(owner.isClosed, false);
  owner.closeGate.release(); await closing; await Promise.allSettled([writing]);
  assert.equal(owner.isClosed, true); assert.equal(fixtureState.owners.length, 1);
  await assert.rejects(fixtureState.clipboard.readText()); await assert.rejects(fixtureState.clipboard.writeText("later"));
  assert.equal(fixtureState.owners.length, 1);
});
