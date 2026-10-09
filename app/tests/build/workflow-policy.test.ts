import assert from "node:assert/strict";
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
