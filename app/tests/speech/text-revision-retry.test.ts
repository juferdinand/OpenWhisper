import assert from "node:assert/strict";
import { test } from "node:test";
import { TextRevisionRetry } from "../../src/services/text/text-revision-retry.js";

const input = {
  generation: 8,
  attempt: 2,
  input: "post-vocabulary text",
  snippets: [{ id: "owned", trigger: "sign-off", expansion: "Best regards", enabled: true }],
  provider: "ollama" as const,
  settingsFingerprint: "settings-a",
};

test("retry retains text-stage input and captured snippets for the same provider", () => {
  const retry = new TextRevisionRetry();
  retry.offer(input);
  const attempt = retry.begin(8, "settings-a");
  assert.deepEqual(attempt, { ...input, attempt: 3 });
  assert.deepEqual(retry.snapshot(), { status: "processing", provider: "ollama" });
  assert.equal(retry.complete(8, 3, "settings-a", "revised text"), true);
  assert.equal(retry.result(8, "settings-a"), "revised text");
});

test("stale generations and changed settings cannot start or publish a retry", () => {
  const retry = new TextRevisionRetry();
  retry.offer(input);
  assert.equal(retry.begin(9, "settings-a"), undefined);
  assert.deepEqual(retry.snapshot(), { status: "idle" });
  retry.offer(input);
  const attempt = retry.begin(8, "settings-a");
  assert.ok(attempt);
  assert.equal(retry.complete(8, attempt.attempt, "settings-b", "stale result"), false);
  assert.equal(retry.result(8, "settings-a"), undefined);
});

test("failed and cancelled attempts are fenced while a later explicit retry receives a new attempt", () => {
  const retry = new TextRevisionRetry();
  retry.offer(input);
  const first = retry.begin(8, "settings-a");
  assert.ok(first);
  assert.equal(retry.fail(8, first.attempt, "settings-a"), true);
  assert.deepEqual(retry.snapshot(), { status: "failed", provider: "ollama" });
  const second = retry.begin(8, "settings-a");
  assert.ok(second);
  assert.equal(second.attempt, first.attempt + 1);
  assert.equal(retry.fail(8, first.attempt, "settings-a"), false);
  assert.equal(retry.fail(8, second.attempt, "settings-a", true), true);
  assert.deepEqual(retry.snapshot(), { status: "available", provider: "ollama" });
});
