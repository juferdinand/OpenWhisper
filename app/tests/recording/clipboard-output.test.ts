import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { deliverClipboard } from "../../src/services/recording/clipboard-output.js";
import { DeliveryReceiptCache, MainRecordingEffects } from "../../src/main/recording-effects.js";
const context = () => ({ generation: 1, attempt: 1, signal: new AbortController().signal });
test("paste starts only after exact clipboard confirmation and preserves user text", async () => {
  const events: string[] = [], value = "日本語 👩‍💻 äöü"; let clipboard = "";
  const receipt = await deliverClipboard(value, context(), { writeText: (text) => { clipboard = text; events.push("write"); },
    readText: () => { events.push("read"); return clipboard; }, paste: async () => { events.push("paste"); return true; } });
  assert.deepEqual(events, ["write", "read", "paste"]); assert.equal(receipt.outcome, "paste"); assert.equal(clipboard, value);
});
test("clipboard ownership loss retains failed delivery and never requests paste", async () => {
  let pastes = 0; const result = await deliverClipboard("dictation", context(), { writeText: () => {}, readText: () => "another owner",
    paste: async () => { pastes++; return true; } });
  assert.equal(result.outcome, "failed"); assert.equal(result.clipboardConfirmed, false); assert.equal(pastes, 0);
});
test("cancellation after confirmed copy skips paste but keeps the irreversible clipboard commit", async () => {
  const abort = new AbortController(); let pastes = 0;
  const result = await deliverClipboard("dictation", { generation: 1, attempt: 1, signal: abort.signal }, {
    writeText: () => {}, readText: () => { abort.abort(); return "dictation"; }, paste: async () => { pastes++; return true; } });
  assert.equal(result.outcome, "clipboard"); assert.equal(result.clipboardConfirmed, true); assert.equal(pastes, 0);
});
test("uncertain paste reply commits clipboard fallback once across recovery-helper replacement", async () => {
  const cache = new DeliveryReceiptCache(); let writes = 0, pastes = 0, clipboard = "";
  const broker = (epoch: string) => new MainRecordingEffects({ epoch, platform: "linux", receipts: cache,
    speech: { async open() { throw new Error("Inference was not requested."); } },
    delivery: { deliver: (text, context) => deliverClipboard(text, context, {
      writeText: (text) => { writes++; clipboard = text; }, readText: () => clipboard,
      paste: async () => { pastes++; throw new Error("Reply lost after key notification."); } }) } });
  const identity = { kind: "recovery", token: randomUUID() } as const;
  for (const epoch of [randomUUID(), randomUUID()]) {
    const owner = broker(epoch), reply = await owner.handle({ version: 1, epoch, id: randomUUID(), generation: 1, attempt: 1,
      command: "deliver", identity, text: "Preserved dictation" });
    assert.ok(reply?.kind === "deliver"); assert.equal(reply.receipt.outcome, "clipboard"); await owner.close();
  }
  assert.equal(writes, 1); assert.equal(pastes, 1);
});
