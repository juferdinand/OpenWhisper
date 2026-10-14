import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTextRevisionEdits, TextRevisionEditsError } from "../../src/core/text/text-revision-edits.js";

test("revision edits preserve multilingual text, whitespace and untouched details exactly", () => {
  const source = "  Grüße 🙂!\n\nDas Team haben die Unterlagen geschickt.\t東京 bleibt.\nWir nehmen Blau, nein, Grün. Kosten: 350 Euro; Termin: 14:30.  ";
  const response = JSON.stringify([
    { find: "Wir nehmen Blau, nein, Grün.", replace: "Wir nehmen Grün." },
    { find: "Das Team haben", replace: "Das Team hat" },
  ]);
  assert.equal(applyTextRevisionEdits(source, response),
    "  Grüße 🙂!\n\nDas Team hat die Unterlagen geschickt.\t東京 bleibt.\nWir nehmen Grün. Kosten: 350 Euro; Termin: 14:30.  ");
  assert.equal(applyTextRevisionEdits(source, "[]"), source);
});

test("edits match the original once and never cascade through earlier replacements", () => {
  assert.equal(applyTextRevisionEdits("red blue", JSON.stringify([
    { find: "red", replace: "blue" }, { find: "blue", replace: "green" },
  ])), "blue green");
  assert.equal(applyTextRevisionEdits("one two one", JSON.stringify([
    { find: "two one", replace: "two three" },
  ])), "one two three");
  assert.equal(applyTextRevisionEdits("Hello.World", JSON.stringify([
    { find: ".", replace: ".\n\n" },
  ])), "Hello.\n\nWorld");
  assert.equal(applyTextRevisionEdits("Keep the the detail.", JSON.stringify([
    { find: "the the ", replace: "the " },
  ])), "Keep the detail.");
});

test("invalid or ambiguous edit sets fail atomically with a content-free error", () => {
  const source = "private detail; one two one; Grüße 🙂";
  const invalid: unknown[] = [
    null, {}, { edits: [] }, ["text"], [{ find: "one", replace: "three" }],
    [{ find: "missing", replace: "invented" }], [{ find: "", replace: "prefix" }],
    [{ find: "one two", replace: "three" }, { find: "two one", replace: "four" }],
    [{ find: "private", replace: "public" }, { find: "missing", replace: "partial change" }],
    [{ find: "private", replace: "first" }, { find: "private", replace: "second" }],
    [{ find: "private", replace: 1 }], [{ find: "private" }],
    [{ find: "private", replace: "text", extra: true }],
    [{ find: "private", replace: "\u0000" }],
    [{ find: "\ud83d", replace: "broken emoji" }], [{ find: "private", replace: "\ud83d" }],
    [{ find: source, replace: " " }],
  ];
  for (const response of [...invalid.map((value) => JSON.stringify(value)),
    "revised transcript", "```json\n[]\n```", "[] trailing", "[", "[]".padEnd(65_537),
  ]) {
    assert.throws(() => applyTextRevisionEdits(source, response), (error: unknown) => {
      assert.ok(error instanceof TextRevisionEditsError);
      assert.equal(error.message, "The model returned invalid transcript edits.");
      return true;
    });
  }
  assert.throws(() => applyTextRevisionEdits("aaa", '[{"find":"aa","replace":"b"}]'), TextRevisionEditsError);
});

test("edits retain a long transcript and enforce the complete output byte bound", () => {
  const source = "ä".repeat(32_760) + " end";
  assert.equal(applyTextRevisionEdits(source, '[{"find":" end","replace":" END"}]'),
    "ä".repeat(32_760) + " END");
  assert.throws(() => applyTextRevisionEdits(source, JSON.stringify([
    { find: " end", replace: "x".repeat(32) },
  ])), TextRevisionEditsError);
  assert.throws(() => applyTextRevisionEdits("x".repeat(65_537), "[]"), TextRevisionEditsError);
  assert.throws(() => applyTextRevisionEdits("x" + " ".repeat(65_536), "[]"), TextRevisionEditsError);
  assert.throws(() => applyTextRevisionEdits("x" + " ".repeat(65_535),
    '[{"find":"x","replace":"xx"}]'), TextRevisionEditsError);
});
