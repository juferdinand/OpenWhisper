import assert from "node:assert/strict";
import { test } from "node:test";
import { rootFirstPathAncestry } from "../../src/services/filesystem/path-ancestry.js";

test("root-first ancestry preserves root and nested path traversal order", () => {
  assert.deepEqual(rootFirstPathAncestry("/"), ["/"]);
  assert.deepEqual(rootFirstPathAncestry("/tmp/openwhisper/models"), ["/", "/tmp", "/tmp/openwhisper", "/tmp/openwhisper/models"]);
});

test("relative input ancestry remains lexical for callers to validate at their boundary", () => {
  assert.deepEqual(rootFirstPathAncestry("owned/models"), [".", "owned", "owned/models"]);
});
