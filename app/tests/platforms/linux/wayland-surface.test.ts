import assert from "node:assert/strict";
import test from "node:test";
import { HEIGHT, MAX_PNG_BYTES, WIDTH, isSurfacePng, surfaceHostMessageSchema, surfaceRegionsSchema,
  surfaceReplySchema, type SurfaceRegion, type SurfaceReply } from "../../../src/contracts/platforms/wayland-surface.js";
import { WaylandSurface, type SurfaceNative, type SurfaceNativeFactory } from "../../../src/platforms/linux/shared/wayland-surface.js";

function png(width = WIDTH, height = HEIGHT): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = new DataView(bytes.buffer);
  header.setUint32(8, 13); header.setUint32(12, 0x49484452);
  header.setUint32(16, width); header.setUint32(20, height);
  return bytes;
}
const regions: SurfaceRegion[] = [{ x: 4, y: 8, width: 36, height: 48 }, { x: 300, y: 8, width: 36, height: 48 }];
function fixture() {
  const replies: SurfaceReply[] = [], calls: string[] = [];
  let pointer: Parameters<SurfaceNativeFactory>[0] = () => {};
  let failApply = false, failVisibility = false, failPump = false, failClose = false;
  const native: SurfaceNative = {
    applyFrame(_png, appliedRegions) { calls.push("frame"); assert.deepEqual(appliedRegions, regions); if (failApply) throw new Error("Inert failure."); },
    setVisible(visible) { calls.push(`visible:${visible}`); if (failVisibility) throw new Error("Inert failure."); },
    pump() { calls.push("pump"); if (failPump) throw new Error("Inert failure."); },
    close() { calls.push("close"); if (failClose) throw new Error("Inert failure."); },
  };
  const surface = new WaylandSurface((reply) => replies.push(reply), (emit) => { pointer = emit; return { status: "available", native }; });
  return { surface, replies, calls, pointer: (action: "move" | "down" | "up" | "leave", x = 10, y = 12) => pointer({ action, x, y }),
    failApply: () => { failApply = true; }, failVisibility: () => { failVisibility = true; },
    failPump: () => { failPump = true; }, failClose: () => { failClose = true; } };
}

test("surface frame bounds require fixed PNG metadata and at most two contained regions", () => {
  assert.equal(isSurfacePng(png()), true);
  assert.equal(isSurfacePng(png(100_000, 100_000)), false);
  const badSignature = png(); badSignature[0] = 0;
  assert.equal(isSurfacePng(badSignature), false);
  const oversized = new Uint8Array(MAX_PNG_BYTES + 1); oversized.set(png());
  assert.equal(isSurfacePng(oversized), false);
  const nonIhdr = png(); new DataView(nonIhdr.buffer).setUint32(12, 0x49444154);
  assert.equal(isSurfacePng(nonIhdr), false);
  assert.equal(surfaceHostMessageSchema.safeParse({ type: "frame", sequence: 1, png: png(), regions }).success, true);
  for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(surfaceHostMessageSchema.safeParse({ type: "frame", sequence, png: png(), regions }).success, false);
  }
  assert.equal(surfaceRegionsSchema.safeParse([{ x: 0, y: 0, width: WIDTH, height: HEIGHT }]).success, true);
  for (const input of [[...regions, regions[0]], [{ x: -1, y: 0, width: 1, height: 1 }],
    [{ x: 0, y: 0, width: 0, height: 1 }], [{ x: 359, y: 0, width: 2, height: 1 }],
    [{ x: 0, y: 63, width: 1, height: 2 }]]) assert.equal(surfaceRegionsSchema.safeParse(input).success, false);
});

test("surface replies exclude nonfinite or out of bounds pointer coordinates", () => {
  for (const x of [-1, WIDTH + 1, NaN, Infinity]) {
    assert.equal(surfaceReplySchema.safeParse({ type: "pointer", sequence: 1, action: "down", x, y: 0 }).success, false);
  }
  assert.equal(surfaceReplySchema.safeParse({ type: "pointer", sequence: 1, action: "up", x: WIDTH, y: HEIGHT }).success, true);
  assert.equal(surfaceHostMessageSchema.safeParse({ type: "close", arbitrary: true }).success, false);
  assert.equal(surfaceReplySchema.safeParse({ type: "ready", supported: false }).success, false);
  assert.equal(surfaceReplySchema.safeParse({ type: "ready", supported: false, reason: "runtime" }).success, true);
});

test("visibility cannot map before a frame and pointers use the applied frame sequence", () => {
  const f = fixture();
  f.surface.receive({ type: "visibility", visible: true });
  assert.deepEqual(f.calls, ["visible:false"]);
  f.pointer("down"); assert.equal(f.replies.length, 1);
  f.surface.receive({ type: "frame", sequence: 2, png: png(), regions });
  assert.deepEqual(f.calls, ["visible:false", "frame", "visible:true"]);
  assert.deepEqual(f.replies.at(-1), { type: "painted", sequence: 2, visible: true });
  f.pointer("move"); f.pointer("down"); f.pointer("up"); f.pointer("leave");
  assert.deepEqual(f.replies.slice(-4).map((reply) => reply.type === "pointer" ? [reply.sequence, reply.action] : null),
    [[2, "move"], [2, "down"], [2, "up"], [2, "leave"]]);
  f.surface.receive({ type: "frame", sequence: 9, png: png(), regions });
  f.pointer("down"); assert.deepEqual(f.replies.at(-1), { type: "pointer", sequence: 9, action: "down", x: 10, y: 12 });
  f.surface.receive({ type: "visibility", visible: false });
  const count = f.replies.length; f.pointer("down"); assert.equal(f.replies.length, count);
  assert.equal(f.calls.at(-1), "visible:false");
  f.surface.close();
});

test("invalid frame is rejected before native calls and closes its original surface", () => {
  const f = fixture();
  f.surface.receive({ type: "frame", sequence: 1, png: png(100_000, 100_000), regions });
  assert.deepEqual(f.calls, ["close"]);
  assert.deepEqual(f.replies, [{ type: "ready", supported: true }, { type: "failed", stage: "message" }, { type: "closed" }]);
  f.surface.receive({ type: "frame", sequence: 2, png: png(), regions }); f.surface.close(); f.surface.pump();
  assert.deepEqual(f.calls, ["close"]);
});

test("stale frame cannot replace the frame used by pointer callbacks", () => {
  const f = fixture();
  f.surface.receive({ type: "frame", sequence: 2, png: png(), regions });
  f.surface.receive({ type: "frame", sequence: 2, png: png(), regions });
  assert.deepEqual(f.calls, ["frame", "visible:false", "close"]);
  assert.equal(f.surface.isClosed, true);
  assert.deepEqual(f.replies.at(-2), { type: "failed", stage: "frame" });
});

test("native apply and pump failures close once without acknowledging an unapplied frame", () => {
  for (const operation of ["apply", "pump"]) {
    const f = fixture();
    if (operation === "apply") { f.failApply(); f.surface.receive({ type: "frame", sequence: 1, png: png(), regions }); }
    else { f.failPump(); f.surface.pump(); }
    assert.equal(f.replies.some((reply) => reply.type === "painted"), false);
    assert.equal(f.replies.filter((reply) => reply.type === "failed").length, 1);
    assert.deepEqual(f.replies.at(-2), { type: "failed", stage: operation === "apply" ? "frame" : "pump" });
    assert.equal(f.calls.filter((call) => call === "close").length, 1);
    f.surface.close(); assert.equal(f.calls.filter((call) => call === "close").length, 1);
  }
});

test("visibility failure is categorized after the frame was applied", () => {
  const f = fixture(); f.failVisibility();
  f.surface.receive({ type: "frame", sequence: 1, png: png(), regions });
  assert.deepEqual(f.calls, ["frame", "visible:false", "close"]);
  assert.deepEqual(f.replies, [{ type: "ready", supported: true }, { type: "failed", stage: "visibility" }, { type: "closed" }]);
});

test("unsupported surface never maps and closes normally", () => {
  const replies: SurfaceReply[] = [];
  const surface = new WaylandSurface((reply) => replies.push(reply), () => ({ status: "unavailable", reason: "unsupported" }));
  surface.receive({ type: "visibility", visible: true });
  surface.receive({ type: "frame", sequence: 1, png: png(), regions });
  assert.equal(surface.isSupported, false);
  assert.equal(surface.unavailableReason, "unsupported");
  surface.receive({ type: "close" });
  assert.deepEqual(replies, [{ type: "ready", supported: false, reason: "unsupported" }, { type: "closed" }]);
});

test("surface runtime failures are not mislabeled as compositor protocol support", () => {
  const replies: SurfaceReply[] = [];
  const surface = new WaylandSurface((reply) => replies.push(reply), () => ({ status: "unavailable", reason: "runtime" }));
  assert.equal(surface.isSupported, false);
  assert.equal(surface.unavailableReason, "runtime");
  assert.deepEqual(replies, [{ type: "ready", supported: false, reason: "runtime" }]);
});

test("failed native close does not claim successful cleanup or permit more work", () => {
  const f = fixture(); f.failClose();
  f.surface.close(); f.surface.close(); f.surface.pump();
  assert.deepEqual(f.replies, [{ type: "ready", supported: true }, { type: "failed", stage: "close" }]);
  assert.deepEqual(f.calls, ["close"]);
});
