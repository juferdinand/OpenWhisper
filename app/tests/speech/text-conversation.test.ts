import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { defaultTextConnectionSettings, type TextConnectionSettings } from "../../src/contracts/text/connections.js";
import { TextConversationStore, textConversationFingerprint } from "../../src/services/text/conversation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privatePath(): Promise<string> {
  // macOS exposes /var through a symlink to /private/var; PrivateStateStore
  // intentionally rejects symlinked ancestors, so own the fixture under its canonical path.
  const root = await mkdtemp(join(await realpath(tmpdir()), "openwhisper-text-conversation-"));
  roots.push(root);
  const directory = join(root, "settings");
  await mkdir(directory, { mode: 0o700 });
  return join(directory, "conversation.json");
}

function customSettings(): TextConnectionSettings {
  return {
    ...defaultTextConnectionSettings(),
    mode: "conversation",
    connections: [...defaultTextConnectionSettings().connections,
      { provider: "custom:123e4567-e89b-42d3-a456-426614174000", enabled: true, name: "Owned CLI",
        command: "owned-cli", args: ["--prompt", "{prompt}"], stdin: "", output: "text", responsePath: "" }],
  };
}

test("conversation turns persist privately and a fresh chat replaces visible context", async () => {
  const path = await privatePath();
  const settings = customSettings();
  const store = await TextConversationStore.open(path, settings);
  const initial = store.snapshot();
  assert.ok(initial.id.length > 0);
  assert.equal(initial.provider, settings.connections[4]?.provider);
  const committed = await store.commit({ user: "synthetic user turn", assistant: "synthetic assistant turn" }, settings);
  assert.equal(committed.turns.length, 1);
  const reopened = await TextConversationStore.open(path, settings);
  assert.deepEqual(reopened.snapshot(), committed);
  const fresh = await reopened.newConversation(settings);
  assert.notEqual(fresh.id, committed.id);
  assert.deepEqual(fresh.turns, []);
  assert.deepEqual((await TextConversationStore.open(path, settings)).snapshot(), fresh);
});

test("conversation fingerprint resets only when the selected connection or instruction changes", async () => {
  const path = await privatePath();
  const settings = customSettings();
  const store = await TextConversationStore.open(path, settings);
  await store.commit({ user: "question", assistant: "answer" }, settings);

  const renamed = { ...settings, connections: settings.connections.map((entry) => "command" in entry
    ? { ...entry, name: "Renamed display label" } : entry) };
  assert.equal(textConversationFingerprint(renamed), textConversationFingerprint(settings));
  await store.syncSettings(renamed);
  assert.equal(store.snapshot().turns.length, 1);

  const changedCommand = { ...renamed, connections: renamed.connections.map((entry) => "command" in entry
    ? { ...entry, command: "/private/new-owned-command" } : entry) };
  assert.notEqual(textConversationFingerprint(changedCommand), textConversationFingerprint(settings));
  await store.syncSettings(changedCommand);
  assert.deepEqual(store.snapshot().turns, []);
  await store.commit({ user: "question two", assistant: "answer two" }, changedCommand);
  const changedInstruction = { ...changedCommand, conversationInstruction: "Answer briefly." };
  await store.syncSettings(changedInstruction);
  assert.deepEqual(store.snapshot().turns, []);
});

test("CLI model selection is part of the conversation identity", () => {
  const defaults = defaultTextConnectionSettings();
  const base = { ...defaults, connections: defaults.connections.map((entry) => entry.provider === "codex"
    ? { ...entry, enabled: true } : entry) };
  const legacy = { ...base, connections: base.connections.map((entry) => entry.provider === "codex"
    ? { provider: entry.provider, enabled: entry.enabled } : entry) };
  const selected = { ...base, connections: base.connections.map((entry) => entry.provider === "codex"
    ? { ...entry, model: "gpt-5.4-codex" } : entry) };
  assert.equal(textConversationFingerprint(legacy), textConversationFingerprint(base));
  const historicalFingerprint = createHash("sha256").update(JSON.stringify({
    selected: { provider: "codex" }, instruction: defaults.conversationInstruction,
  })).digest("hex");
  assert.equal(textConversationFingerprint(base), historicalFingerprint);
  assert.notEqual(textConversationFingerprint(selected), textConversationFingerprint(base));
});

test("context overflow rejects the new turn without dropping or shortening earlier turns", async () => {
  const path = await privatePath();
  const settings = customSettings();
  const store = await TextConversationStore.open(path, settings);
  const turn = { user: "u".repeat(50_000), assistant: "a".repeat(50_000) };
  await store.commit(turn, settings);
  await store.commit(turn, settings);
  const before = store.snapshot();
  await assert.rejects(store.commit(turn, settings));
  assert.deepEqual(store.snapshot(), before);
});

test("a failed provider-change reset never exposes old context under the new settings", async () => {
  const path = await privatePath();
  const settings = customSettings();
  const store = await TextConversationStore.open(path, settings);
  await store.commit({ user: "old provider question", assistant: "old provider answer" }, settings);
  const changed = { ...settings, connections: settings.connections.map((entry) => "command" in entry
    ? { ...entry, command: "/private/next-provider" } : entry) };
  const directory = join(path, "..");
  await rename(directory, `${directory}-retained`);
  await mkdir(directory, { mode: 0o700 });
  await assert.rejects(store.syncSettings(changed));
  assert.equal(store.snapshotFor(changed), undefined);
  assert.deepEqual(store.snapshotFor(settings)?.turns, [{ user: "old provider question", assistant: "old provider answer" }]);
});
