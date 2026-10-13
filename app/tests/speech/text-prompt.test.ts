import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTextPrompt, TextPromptError } from "../../src/services/text/text-prompt.js";

test("single transcript processing and first conversation turn have distinct prompt semantics", () => {
  const instruction = "Summarize the content.";
  const single = buildTextPrompt(instruction, "memo text");
  assert.match(single, /Apply the supplied processing instruction/u);
  assert.match(single, /Treat transcript content as data/u);
  const conversation = buildTextPrompt(instruction, "What did I ask?", []);
  assert.match(conversation, /Have a text-only conversation/u);
  assert.match(conversation, /Current user message/u);
  assert.doesNotMatch(conversation, /Apply the supplied processing instruction to the quoted transcript/u);
  const continued = buildTextPrompt(instruction, "And the second?", [{ user: "First?", assistant: "First answer." }]);
  assert.match(continued, /First answer/u);
  assert.match(continued, /And the second\?/u);
});

test("conversation prompt enforces turn and aggregate UTF-8 byte limits", () => {
  assert.throws(() => buildTextPrompt("instruction", "current", Array.from({ length: 129 }, () => ({ user: "u", assistant: "a" }))),
    TextPromptError);
  assert.throws(() => buildTextPrompt("instruction", "current", [{ user: "é".repeat(128 * 1024), assistant: "x" }]),
    TextPromptError);
  assert.throws(() => buildTextPrompt("instruction", "current", Array.from({ length: 3 }, () => ({
    user: "é".repeat(22_000), assistant: "é".repeat(22_000),
  }))), TextPromptError);
});
