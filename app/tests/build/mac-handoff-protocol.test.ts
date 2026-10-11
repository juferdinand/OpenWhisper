import assert from "node:assert/strict";
import test from "node:test";
import { usesBundleBackedMacHandoffPacket } from "../../scripts/mac-handoff-protocol.js";

test("distinguishes the old three-file handoff from the bundle-backed packet", () => {
  const oldWorkflow = `
      - name: Upload exact signed handoff inputs for a fresh Mac runner
        with:
          path: |
            \${{ runner.temp }}/mac-update-handoff-input/OpenWhisper-universal-0.4.1.zip
            \${{ runner.temp }}/mac-update-handoff-input/OpenWhisper-arm64-successor-0.4.2.zip
            \${{ runner.temp }}/mac-update-handoff-input/input.json
      - name: Upload private source receipt for same-run reconstruction
        with:
          path: |
            \${{ runner.temp }}/publisher-successor-source/successor.bundle
            \${{ runner.temp }}/publisher-successor-source/successor-source.json
`;
  const currentWorkflow = `
      - name: Upload exact signed handoff inputs for a fresh Mac runner
        with:
          path: |
            \${{ runner.temp }}/mac-update-handoff-input/successor.bundle
            \${{ runner.temp }}/mac-update-handoff-input/successor-source.json
`;
  assert.equal(usesBundleBackedMacHandoffPacket(oldWorkflow), false);
  assert.equal(usesBundleBackedMacHandoffPacket(currentWorkflow), true);
});
