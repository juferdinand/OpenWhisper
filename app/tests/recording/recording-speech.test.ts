import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { BackendLease, BackendSpeechJob, BackendSupervisor } from "../../src/services/speech/backend-supervisor.js";
import { ModelInventory, type ModelLease } from "../../src/services/models/model-inventory.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile } from "../../src/services/settings/profiles.js";
import { createInventoryRecordingSpeechFactory } from "../../src/services/speech/recording-speech.js";
import { RecordingEffectError } from "../../src/workers/recording/recording-effects-protocol.js";
import type { SpeechModel } from "../../src/workers/speech/native-speech.js";

const catalog: unknown = JSON.parse(await readFile(new URL("../../data/models.json", import.meta.url), "utf8"));
const signal = () => new AbortController().signal;
const fails = (code: string) => (error: unknown) => error instanceof RecordingEffectError && error.code === code;
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  const end = performance.now() + 3000;
  while (performance.now() < end) { if (condition()) return; await setImmediate(); }
  assert.fail("Inert factory did not reach its retained boundary.");
}
async function fixture(run: (ctx: {
  inventory: ModelInventory; model: SpeechModel; secondInventory(): Promise<ModelInventory>;
}) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-recording-lease-")));
  try {
    const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
    const profile = prepareDevelopmentProfile(resolveDevelopmentProfile({ home }));
    const path = join(profile.paths.models, "ggml-tiny.bin");
    // Filesystem lease fixture only; these bytes are never loaded as weights.
    await writeFile(path, "Inert private inventory fixture", { mode: 0o600 });
    await run({ inventory: await ModelInventory.open(profile, catalog), model: { path, family: "whisper", gpu: false },
      secondInventory: () => ModelInventory.open(profile, catalog) });
  } finally { await rm(root, { recursive: true, force: true }); }
}
function backend() {
  let created = 0, inferred = 0, closed = 0;
  let closing: () => Promise<void> = () => Promise.resolve();
  let creating: ((lease: BackendLease) => void) | undefined;
  let infer: () => Promise<string> = async () => "Inert result";
  const supervisor: BackendSupervisor = { createJob(lease) {
    created++; creating?.(lease);
    return { prepare: async () => ({ backend: "cpu", requestedGpu: false, gpu: false, detection: "none" }),
      transcribeWindow: async () => { inferred++; return infer(); },
      close: () => { closed++; return closing(); } } satisfies BackendSpeechJob;
  } };
  return { supervisor, counts: () => ({ created, inferred, closed }),
    close: (hook: typeof closing) => { closing = hook; },
    create: (hook: NonNullable<typeof creating>) => { creating = hook; },
    inference: (hook: typeof infer) => { infer = hook; } };
}
function instrument(inventory: ModelInventory, wrap: (lease: ModelLease) => ModelLease | Promise<ModelLease>) {
  const original = inventory.acquire.bind(inventory);
  Object.defineProperty(inventory, "acquire", { value: async (...args: Parameters<ModelInventory["acquire"]>) => wrap(await original(...args)) });
}
const infer = (client: import("../../src/services/speech/recording-speech.js").RecordingInferenceClient, model: SpeechModel) =>
  client.transcribeWindow(model, new Float32Array(16000), "en", "", signal());

test("real private lease blocks deletion until the exact original job close fulfills", async () => fixture(async ({ inventory, model }) => {
  const b = backend(), stop = deferred(); b.close(() => stop.promise);
  let passed: Promise<void> | undefined;
  instrument(inventory, (lease) => ({ ...lease, release(original) { passed = original; return lease.release(original); } }));
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } });
  const client = await factory.open(model, signal()); assert.equal(await infer(client, model), "Inert result");
  await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
  const first = client.close(); assert.equal(client.close(), first); await until(() => passed !== undefined);
  assert.equal(passed, stop.promise); await assert.rejects(factory.open(model, signal()), fails("BUSY"));
  await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
  stop.resolve(); await first; await inventory.remove("tiny");
  assert.deepEqual(b.counts(), { created: 1, inferred: 1, closed: 1 });
}));

test("captured ID and no-GPU-elevation are checked on opening and every delegated window", async () => fixture(async ({ inventory, model }) => {
  const b = backend(), selection = { id: "tiny", gpu: false };
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection });
  selection.id = "foreign"; selection.gpu = true;
  await assert.rejects(factory.open({ ...model, gpu: true }, signal()), fails("OWNERSHIP_FAILED"));
  await assert.rejects(factory.open({ ...model, path: "/unowned/file.bin" }, signal()), fails("OWNERSHIP_FAILED"));
  assert.equal(b.counts().created, 0);
  const client = await factory.open(model, signal());
  for (const changed of [{ ...model, gpu: true }, { ...model, family: "parakeet" as const }, { ...model, path: "/unowned/file.bin" }]) {
    await assert.rejects(infer(client, changed), fails("OWNERSHIP_FAILED"));
  }
  assert.equal(b.counts().inferred, 0); await client.close();
  await inventory.remove("tiny");
}));

test("a captured GPU selection permits lower CPU windows without changing the host selection", async () => fixture(async ({ inventory, model }) => {
  const b = backend();
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: true } });
  const client = await factory.open({ ...model, gpu: true }, signal());
  await infer(client, { ...model, gpu: true }); await infer(client, model);
  assert.equal(b.counts().inferred, 2); await client.close();
}));

test("cancelled accepted acquisition retains its real lease and prevents a replacement factory", async () => fixture(async ({ inventory, model }) => {
  const b = backend(), held = deferred(); let acquired = false;
  instrument(inventory, async (lease) => { acquired = true; await held.promise; return lease; });
  const options = { inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } };
  const factory = createInventoryRecordingSpeechFactory(options), abort = new AbortController();
  const opening = factory.open(model, abort.signal); void opening.catch(() => {});
  await until(() => acquired); abort.abort();
  await assert.rejects(createInventoryRecordingSpeechFactory(options).open(model, signal()), fails("BUSY"));
  await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
  held.resolve(); await assert.rejects(opening, fails("CANCELLED"));
  assert.equal(b.counts().created, 0); await inventory.remove("tiny");
}));

test("held release remains shared across helper factories after original job closure", async () => fixture(async ({ inventory, model }) => {
  const b = backend(), held = deferred(); let releasing = false;
  instrument(inventory, (lease) => ({ ...lease, async release(original) {
    await original; releasing = true; await held.promise; await lease.release(original);
  } }));
  const options = { inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } };
  const client = await createInventoryRecordingSpeechFactory(options).open(model, signal());
  const closing = client.close(); await until(() => releasing);
  await assert.rejects(createInventoryRecordingSpeechFactory(options).open(model, signal()), fails("BUSY"));
  await assert.rejects(inventory.remove("tiny"), { code: "LEASED" }); held.resolve(); await closing;
  const next = await createInventoryRecordingSpeechFactory(options).open(model, signal()); await next.close();
  assert.equal(b.counts().created, 2);
}));

test("failed release after successful job close cannot be bypassed by a new selection or helper", async () => fixture(async ({ inventory, model }) => {
  const b = backend();
  instrument(inventory, (lease) => ({ ...lease, async release(original) { await original; throw new Error("Inert lease release refusal."); } }));
  const options = { inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } };
  const client = await createInventoryRecordingSpeechFactory(options).open(model, signal());
  const closing = client.close(); await assert.rejects(closing, fails("TEARDOWN_FAILED"));
  assert.equal(client.close(), closing);
  await assert.rejects(createInventoryRecordingSpeechFactory({ ...options, selection: { id: "other", gpu: true } }).open(model, signal()), fails("TEARDOWN_FAILED"));
  await assert.rejects(inventory.remove("tiny"), { code: "LEASED" }); assert.equal(b.counts().created, 1);
}));

test("failed or synchronously refusing original close retains the actual inventory lease", async () => {
  for (const synchronous of [false, true]) await fixture(async ({ inventory, model }) => {
    const b = backend(); b.close(() => {
      if (synchronous) throw new Error("Inert synchronous close refusal.");
      return Promise.reject(new Error("Inert original close refusal."));
    });
    const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } });
    const client = await factory.open(model, signal());
    await assert.rejects(client.close(), fails("TEARDOWN_FAILED"));
    await assert.rejects(factory.open(model, signal()), fails("TEARDOWN_FAILED"));
    await assert.rejects(inventory.remove("tiny"), { code: "LEASED" });
  });
});

test("pure job-construction refusal releases a pre-process lease without claiming kernel evidence", async () => fixture(async ({ inventory, model }) => {
  const b = backend(); b.create(() => { throw { code: "INVALID_INPUT" }; });
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } });
  await assert.rejects(factory.open(model, signal()), fails("OWNERSHIP_FAILED"));
  assert.deepEqual(b.counts(), { created: 1, inferred: 0, closed: 0 }); await inventory.remove("tiny");
}));

test("native integrity remains terminal and original inventory binding cannot be replaced", async () => fixture(async ({ inventory, model, secondInventory }) => {
  const b = backend(); b.inference(async () => { throw { code: "INTEGRITY_FAILED" }; });
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } });
  const client = await factory.open(model, signal());
  await assert.rejects(infer(client, model), fails("OWNERSHIP_FAILED")); await client.close();
  const alias = await secondInventory();
  assert.throws(() => createInventoryRecordingSpeechFactory({ inventory: alias, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } }), fails("OWNERSHIP_FAILED"));
}));

test("invalid host selection and absent private model fail before any job or inference", async () => fixture(async ({ inventory, model }) => {
  const b = backend();
  for (const selection of [{ id: "../tiny", gpu: false }, { id: "tiny", gpu: false, path: model.path }, { id: "tiny" }]) {
    assert.throws(() => createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection }), fails("OWNERSHIP_FAILED"));
  }
  await inventory.remove("tiny");
  const factory = createInventoryRecordingSpeechFactory({ inventory, supervisor: b.supervisor, selection: { id: "tiny", gpu: false } });
  await assert.rejects(factory.open(model, signal()), fails("OWNERSHIP_FAILED")); assert.equal(b.counts().created, 0);
}));
