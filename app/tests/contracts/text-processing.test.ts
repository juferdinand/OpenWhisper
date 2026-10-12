import assert from "node:assert/strict";
import { test } from "node:test";
import { textProcessingStageEventSchema } from "../../src/contracts/text/processing.js";
import { recordingHostReplySchema } from "../../src/workers/recording/recording-host-protocol.js";

const owner = { generation: 8, attempt: 2 };

test("text stages retain actual recognition progress and generation/attempt ownership", () => {
  const progress = textProcessingStageEventSchema.parse({ ...owner, stage: "recognition", status: "progress",
    completedSamples: 16000, totalSamples: 32000 });
  assert.equal(progress.completedSamples, 16000);
  assert.throws(() => textProcessingStageEventSchema.parse({ ...owner, stage: "snippets", status: "progress" }));
  assert.throws(() => textProcessingStageEventSchema.parse({ ...owner, stage: "recognition", status: "progress",
    completedSamples: 4, totalSamples: 3 }));
  assert.throws(() => textProcessingStageEventSchema.parse({ ...owner, stage: "model", status: "progress",
    completedSamples: 1, totalSamples: 3 }));
});

test("full intermediate text is not truncated in the worker protocol", () => {
  const text = "owned synthetic text 日本語 👩‍💻\n".repeat(300_000);
  const event = textProcessingStageEventSchema.parse({ ...owner, stage: "recognition", status: "completed", text });
  assert.strictEqual(event.text, text);
  const reply = recordingHostReplySchema.parse({ version: 1, channel: "recording-host", epoch: "123e4567-e89b-42d3-a456-426614174000",
    kind: "text-stage", event });
  assert.equal(reply.kind, "text-stage");
  if (reply.kind === "text-stage") assert.strictEqual(reply.event.text, text);
});
