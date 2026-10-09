import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MACOS_UPDATE_SIGNATURE_FLAGS } from "../../../src/services/update/macos/macos-update-signature.js";
import { copyMacosPublisherAdversary, MacosPublisherSignatureError, readMacosPublisherRequirement } from "../../../scripts/macos-publisher-signature.js";

const original = "/owned/Original.app";
const candidate = "/owned/Candidate.app";
const binaryRequirement = Buffer.from([0xfa, 0xde, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x01]);

test("Mac publisher adversarial copy preserves relative framework links verbatim", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mac-publisher-framework-copy-"));
  try {
    const source = join(temporary, "source", "OpenWhisper.app");
    const destination = join(temporary, "adversary", "OpenWhisper.app");
    const versions = join(source, "Contents/Frameworks/Whisper.framework/Versions");
    await mkdir(join(versions, "A"), { recursive: true });
    await writeFile(join(versions, "A/Whisper"), "signed framework binary\n");
    await symlink("A", join(versions, "Current"));
    await copyMacosPublisherAdversary(source, destination);
    assert.equal(await readlink(join(destination, "Contents/Frameworks/Whisper.framework/Versions/Current")), "A");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

function fixture(options: { originalStatus?: number; candidateStatus?: number } = {}) {
  const calls: string[] = [];
  const released: bigint[] = [];
  let disposed = 0;
  const native = {
    createFileURL(bytes: Uint8Array) { calls.push(`url:${Buffer.from(bytes).toString("utf8")}`); return calls.filter((call) => call.startsWith("url:")).length === 1 ? 10n : 14n; },
    createStaticCode(url: bigint, flags: number, output: unknown[]) {
      assert.equal(flags, 0);
      const index = calls.filter((call) => call.startsWith("static:")).length;
      calls.push(`static:${url}`); output[0] = index === 0 ? 11n : 15n; return 0;
    },
    checkValidity(code: bigint, flags: number, requirement: bigint) {
      calls.push(`check:${code}:${flags}:${requirement}`);
      assert.equal(flags, MACOS_UPDATE_SIGNATURE_FLAGS);
      return code === 11n ? (options.originalStatus ?? 0) : (options.candidateStatus ?? 0);
    },
    copyDesignatedRequirement(code: bigint, flags: number, output: unknown[]) {
      calls.push(`copy-requirement:${code}:${flags}`); output[0] = 12n; return 0;
    },
    copyRequirementData(requirement: bigint, flags: number, output: unknown[]) {
      calls.push(`copy-data:${requirement}:${flags}`); output[0] = 13n; return 0;
    },
    readRequirementData(data: bigint) { calls.push(`read-data:${data}`); return binaryRequirement; },
    release(reference: bigint) { released.push(reference); },
    dispose() { disposed++; },
  };
  return { native, calls, released, get disposed() { return disposed; } };
}

test("Mac publisher requirement is extracted from the strictly validated original binary signature", () => {
  const state = fixture();
  const receipt = readMacosPublisherRequirement(original, () => state.native);
  assert.deepEqual(receipt, { bytes: binaryRequirement.length, sha256: createHash("sha256").update(binaryRequirement).digest("hex") });
  assert.deepEqual(state.calls, [
    `url:${original}`, "static:10", `check:11:${MACOS_UPDATE_SIGNATURE_FLAGS}:0`, "copy-requirement:11:0",
    "copy-data:12:0", "read-data:13", `url:${original}`, "static:14", `check:15:${MACOS_UPDATE_SIGNATURE_FLAGS}:12`,
  ]);
  assert.deepEqual(state.released, [15n, 14n, 13n, 12n, 11n, 10n]);
  assert.equal(state.disposed, 1);
});

test("Mac publisher requirement extraction refuses an invalid original before deriving authority", () => {
  const state = fixture({ originalStatus: -67050 });
  assert.throws(() => readMacosPublisherRequirement(original, () => state.native),
    (error: unknown) => error instanceof MacosPublisherSignatureError && error.category === "ORIGINAL_SIGNATURE_REFUSED");
  assert.equal(state.calls.some((call) => call.startsWith("copy-requirement:")), false);
  assert.deepEqual(state.released, [11n, 10n]);
  assert.equal(state.disposed, 1);
});

test("Mac publisher requirement check refuses a candidate rejected by the original binary requirement", () => {
  const state = fixture({ candidateStatus: -67062 });
  assert.throws(() => readMacosPublisherRequirement(original, () => state.native),
    (error: unknown) => error instanceof MacosPublisherSignatureError && error.category === "CANDIDATE_SIGNATURE_REFUSED");
  assert.deepEqual(state.released, [15n, 14n, 13n, 12n, 11n, 10n]);
  assert.equal(state.disposed, 1);
});
