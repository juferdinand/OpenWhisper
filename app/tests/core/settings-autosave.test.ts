import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsAutosave, type SettingsSaveStatus } from "../../ui/src/settings-autosave.js";

const turn = async () => { await Promise.resolve(); await Promise.resolve(); };

test("text edits coalesce to the latest write and share one completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SettingsSaveStatus[] = [];
  const saves: string[] = [];
  const autosave = new SettingsAutosave({ onState: ({ status }) => statuses.push(status) });
  const first = autosave.save("text", async () => { saves.push("old"); return true; }, 450);
  const latest = autosave.save("text", async () => { saves.push("latest"); return true; }, 450);
  assert.deepEqual(statuses, ["saving"]);
  t.mock.timers.tick(449);
  await turn();
  assert.deepEqual(saves, []);
  t.mock.timers.tick(1);
  assert.deepEqual(await Promise.all([first, latest]), [true, true]);
  assert.deepEqual(saves, ["latest"]);
  assert.deepEqual(statuses, ["saving", "saved"]);
  t.mock.timers.tick(1_600);
  assert.deepEqual(statuses, ["saving", "saved", "idle"]);
});

test("flush cancels debounce and serializes independent immediate writes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order: string[] = [];
  let release!: (value: boolean) => void;
  const firstWrite = new Promise<boolean>((resolve) => { release = resolve; });
  const autosave = new SettingsAutosave({ onState: () => {} });
  const first = autosave.save("preferences", async () => { order.push("preferences:start"); return firstWrite; });
  const second = autosave.save("connections", async () => { order.push("connections"); return true; }, 450);
  const flushing = autosave.flush();
  await turn();
  assert.deepEqual(order, ["preferences:start"]);
  release(true);
  assert.deepEqual(await Promise.all([first, second, flushing]), [true, true, true]);
  assert.deepEqual(order, ["preferences:start", "connections"]);
});

test("a stale in-flight success waits for the newer edit before reporting success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SettingsSaveStatus[] = [];
  let release!: (value: boolean) => void;
  const oldWrite = new Promise<boolean>((resolve) => { release = resolve; });
  const saves: string[] = [];
  const autosave = new SettingsAutosave({ onState: ({ status }) => statuses.push(status) });
  const oldRequest = autosave.save("vocabulary", async () => { saves.push("old"); return oldWrite; });
  t.mock.timers.tick(0);
  await turn();
  const latestRequest = autosave.save("vocabulary", async () => { saves.push("latest"); return true; }, 450);
  release(true);
  await turn();
  assert.deepEqual(statuses, ["saving"]);
  assert.deepEqual(saves, ["old"]);
  t.mock.timers.tick(450);
  assert.deepEqual(await Promise.all([oldRequest, latestRequest]), [true, true]);
  assert.deepEqual(saves, ["old", "latest"]);
  assert.deepEqual(statuses, ["saving", "saved"]);
});

test("write failure stays retryable and retry reports only after the latest failed writer settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: SettingsSaveStatus[] = [];
  let attempts = 0;
  const autosave = new SettingsAutosave({ onState: ({ status }) => statuses.push(status) });
  const result = autosave.save("snippets", async () => { attempts++; throw new Error("disk full"); });
  t.mock.timers.tick(0);
  assert.equal(await result, false);
  assert.deepEqual(statuses, ["saving", "error"]);

  const retry = autosave.retry();
  t.mock.timers.tick(0);
  assert.equal(await retry, false);
  assert.equal(attempts, 2);
  assert.equal(statuses.at(-1), "error");
});

test("flush returns false on failure without retrying it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const statuses: SettingsSaveStatus[] = [];
  const autosave = new SettingsAutosave({ onState: ({ status }) => statuses.push(status) });
  const write = autosave.save("history", async () => { attempts++; return false; }, 450);
  const flushed = autosave.flush();
  assert.equal(await write, false);
  assert.equal(await flushed, false);
  assert.equal(attempts, 1);
  assert.deepEqual(statuses, ["saving", "error"]);
});
