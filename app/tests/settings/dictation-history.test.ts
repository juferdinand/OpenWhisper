import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DictationHistory } from "../../src/services/history/dictation-history.js";

test("history starts fresh instead of importing old text-only rows, then stores dated bounded entries", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "openwhisper-history-"));
  const path = join(root, "history.json");
  try {
    writeFileSync(path, JSON.stringify(["Old text-only transcript"]), { mode: 0o600 });
    const history = await DictationHistory.open(path);
    assert.deepEqual(history.snapshot(), []);

    for (let index = 0; index < 21; index++) await history.add(`Synthetic transcript ${index}`, 12_345);
    const entries = history.snapshot();
    assert.equal(entries.length, 20);
    assert.equal(entries[0]?.text, "Synthetic transcript 20");
    assert.equal(entries.at(-1)?.text, "Synthetic transcript 1");
    assert.ok(entries.every((entry) => entry.duration_ms === 12_345));
    assert.ok(entries.every((entry) => Number.isFinite(Date.parse(entry.recorded_at))));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), entries);

    await history.clear();
    assert.deepEqual(history.snapshot(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
