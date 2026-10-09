import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findAmbiguousRunContinuations } from "../../scripts/workflow-policy.js";

const workflow = (run: string): string => `name: fixture
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: ${run}`;

test("rejects the original plain multiline run continuation", () => {
  const source = workflow(String.raw`node scripts/build.ts \
          --artifact /tmp/app --mode test`);
  assert.equal(findAmbiguousRunContinuations(source, "plain.yml").length, 1);
});

test("rejects a folded run scalar with a shell continuation", () => {
  const source = `name: fixture
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: >
          node scripts/build.ts \\
            --artifact /tmp/app --mode test
`;
  assert.equal(findAmbiguousRunContinuations(source, "folded.yml").length, 1);
});

test("allows shell continuations in a literal run block", () => {
  const source = `name: fixture
on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: |
          node scripts/build.ts \\
            --artifact /tmp/app --mode test
`;
  assert.deepEqual(findAmbiguousRunContinuations(source, "literal.yml"), []);
});

test("release signing keychain guards receive their required ownership marker and commit cleanup input only after parsing", async () => {
  const source = await readFile(new URL("../../../.github/workflows/electron-macos-build.yml", import.meta.url), "utf8");
  const steps = [...source.matchAll(/      - name: Import the existing persistent identity into an isolated keychain\n([\s\S]*?)(?=      - name: |$)/gu)];
  assert.equal(steps.length, 2);
  for (const step of steps) {
    assert.match(step[1]!, /OPENWHISPER_OWNED_MAC_PUBLISHER: '1'/u);
    assert.match(step[1]!, /keychain-list > "\$private\/previous-keychains\.partial"\n\s+mv "\$private\/previous-keychains\.partial" "\$private\/previous-keychains"/u);
    assert.doesNotMatch(step[1]!, /keychain-list > "\$private\/previous-keychains"\n/u);
  }
});
