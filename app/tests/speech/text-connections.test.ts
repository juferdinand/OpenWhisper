import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  defaultTextConnectionAvailability, defaultTextConnectionSettings, textConnectionSettingsSchema, textConnectionsStateSchema,
} from "../../src/contracts/text/connections.js";
import { validateCommandInput, appStateSchema } from "../../src/contracts/ui/state.js";
import { ensureTextProviderAvailability, LocalTextConnectionScanner, resolveTextCliExecutable,
  validateTextConnectionChanges } from "../../src/services/text/connections.js";
import { boundedTextPreview } from "../../src/services/text/text-preview.js";
import { OptionalTextProcessing } from "../../src/services/text/optional-text-processing.js";

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function serve(handler: (path: string, response: import("node:http").ServerResponse) => void): Promise<number> {
  const server = createServer((request, response) => handler(request.url ?? "", response));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

test("text connections default disabled and preserve explicit provider order", () => {
  const defaults = defaultTextConnectionSettings();
  assert.deepEqual(defaults.connections.map(({ provider }) => provider), ["ollama", "lm_studio", "claude_code", "codex"]);
  assert.ok(defaults.connections.every(({ enabled }) => !enabled));
  assert.ok(defaultTextConnectionAvailability().filter(({ provider }) => provider === "claude_code" || provider === "codex")
    .every((entry) => !entry.detected && entry.reason === "not_installed"));
  const reordered = { ...defaults, connections: [...defaults.connections].reverse() };
  assert.deepEqual(textConnectionSettingsSchema.parse(reordered).connections.map(({ provider }) => provider),
    ["codex", "claude_code", "lm_studio", "ollama"]);
  assert.throws(() => textConnectionSettingsSchema.parse({ ...defaults,
    connections: [defaults.connections[0], defaults.connections[0], ...defaults.connections.slice(2)] }));
});

test("saved offline providers can be disabled one at a time", () => {
  const defaults = defaultTextConnectionSettings();
  const bothEnabled = { ...defaults, connections: defaults.connections.map((entry) => ({
    ...entry, enabled: entry.provider === "ollama" || entry.provider === "lm_studio",
  })) };
  const ollamaDisabled = { ...bothEnabled, connections: bothEnabled.connections.map((entry) => ({
    ...entry, enabled: entry.provider === "lm_studio",
  })) };
  validateTextConnectionChanges(bothEnabled, ollamaDisabled, defaultTextConnectionAvailability());
  const allDisabled = { ...ollamaDisabled, connections: ollamaDisabled.connections.map((entry) => ({ ...entry, enabled: false })) };
  validateTextConnectionChanges(ollamaDisabled, allDisabled, defaultTextConnectionAvailability());
});

test("newly enabled unavailable, model-less, or Codex providers are rejected at any priority", () => {
  const defaults = defaultTextConnectionSettings();
  const previous = { ...defaults, connections: defaults.connections.map((entry) => ({
    ...entry, enabled: entry.provider === "ollama",
  })) };
  const enable = (provider: "lm_studio" | "codex", model = "") => ({ ...previous,
    connections: previous.connections.map((entry) => entry.provider === provider
      ? { ...entry, enabled: true, ...(entry.provider === "lm_studio" ? { model } : {}) } : entry),
  });
  assert.throws(() => validateTextConnectionChanges(previous, enable("lm_studio", "qwen"),
    defaultTextConnectionAvailability()), /available model/u);
  const changeEnabledModel = { ...previous, connections: previous.connections.map((entry) => entry.provider === "ollama"
    ? { ...entry, model: "qwen" } : entry) };
  assert.throws(() => validateTextConnectionChanges(previous, changeEnabledModel, defaultTextConnectionAvailability()), /available model/u);
  const availableOllama = defaultTextConnectionAvailability().map((entry) => entry.provider === "ollama"
    ? { ...entry, usable: true, detected: true, models: ["qwen"], reason: null } : entry);
  assert.doesNotThrow(() => validateTextConnectionChanges(previous, changeEnabledModel, availableOllama));
  const availableWithoutSelection = defaultTextConnectionAvailability().map((entry) => entry.provider === "lm_studio"
    ? { ...entry, usable: true, detected: true, models: ["qwen"], reason: null } : entry);
  assert.throws(() => validateTextConnectionChanges(previous, enable("lm_studio"), availableWithoutSelection), /available model/u);
  assert.throws(() => validateTextConnectionChanges(previous, enable("codex"), availableWithoutSelection), /not available/u);
});

test("bounded transcript previews preserve UTF-8 boundaries and report omitted text", () => {
  assert.deepEqual(boundedTextPreview("é🙂", 3), { text: "é", omitted: true });
  assert.deepEqual(boundedTextPreview("é🙂", 6), { text: "é🙂", omitted: false });
});

test("state and IPC validate connection settings and host-owned availability", () => {
  const state = appStateSchema.parse({
    platform: "linux", version: "test", status: "idle", message: "", transcript: "", history: [],
    preferences: { ui_language: "en", setup_completed: false, model: "model", language: "en",
      microphone: "", vocabulary: "", snippets: [], output: "clipboard", hold_to_record: false,
      gpu: false, keep_history: false },
    updates: { configured: false, status: "idle", version: null, progress: 0, error: null, package: "development" },
    models: [], installed: [], microphones: [], session: "unknown", desktop: "unknown", clipboard_available: false,
    shortcut_portal: false, paste_portal: false, shortcut: null, paste_ready: false, gpu_available: false,
    download: null, progress: 0, elapsed: 0, model_directory: "/models",
  });
  assert.deepEqual(state.text_connections.available, defaultTextConnectionAvailability());
  assert.equal(state.text_processing, null);
  assert.equal(validateCommandInput("save_connections", { settings: defaultTextConnectionSettings() }).settings.instruction,
    defaultTextConnectionSettings().instruction);
  assert.throws(() => validateCommandInput("save_connections", { settings: { ...defaultTextConnectionSettings(), extra: true } }));
});

test("optional processor snapshot matches the strict AppState text-connection wire schema", () => {
  const settings = defaultTextConnectionSettings();
  const processor = new OptionalTextProcessing({
    settings: () => settings,
    scan: async () => defaultTextConnectionAvailability(),
    runProvider: async (_connection, _instruction, text) => text,
    isShuttingDown: () => false,
  });
  const snapshot = processor.snapshot();
  assert.deepEqual(Object.keys(snapshot).sort(), ["available", "processing", "scanning"]);
  assert.deepEqual(textConnectionsStateSchema.parse({ settings, ...snapshot }), {
    settings, available: defaultTextConnectionAvailability(), scanning: false,
    processing: { status: "idle", provider: null, reason: null },
  });
});

test("local discovery uses only fixed loopback routes and reports bounded model choices", async () => {
  const port = await serve((path, response) => {
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/tags") response.end(JSON.stringify({ models: [{ name: "qwen-local" }] }));
    else if (path === "/api/v1/models") response.end(JSON.stringify({ models: [
      { key: "llama-local", type: "llm" }, { key: "nomic-embed", type: "embedding" },
      { key: "decision-model", type: "decision" },
    ] }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  const available = await new LocalTextConnectionScanner({ PATH: "", HOME: "/nonexistent" }, { ollama: port, lm_studio: port }).scan();
  assert.deepEqual(available.find(({ provider }) => provider === "ollama"), {
    provider: "ollama", detected: true, usable: true, models: ["qwen-local"], reason: null,
  });
  assert.deepEqual(available.find(({ provider }) => provider === "lm_studio"), {
    provider: "lm_studio", detected: true, usable: true, models: ["llama-local"], reason: null,
  });
  const codex = available.find(({ provider }) => provider === "codex");
  assert.ok(codex);
  assert.equal(codex.usable, false);
  assert.ok(codex.reason === "not_installed" || codex.reason === "unsupported");
});

test("an enabled provider refreshes stale startup availability before first use", async () => {
  const stale = defaultTextConnectionAvailability();
  const discovered = stale.map((entry) => entry.provider === "ollama"
    ? { ...entry, detected: true, usable: true, models: ["qwen-local"], reason: null }
    : entry);
  let scans = 0;
  const refreshed = await ensureTextProviderAvailability("ollama", stale, async () => { scans += 1; return discovered; });
  assert.equal(scans, 1);
  assert.deepEqual(refreshed.find(({ provider }) => provider === "ollama"), discovered[0]);
  await ensureTextProviderAvailability("ollama", refreshed, async () => { scans += 1; return stale; });
  assert.equal(scans, 1, "a usable cached provider does not need another startup scan");
});

test("local discovery never follows redirects and distinguishes empty model inventory", async () => {
  let targetHits = 0;
  const targetPort = await serve((_path, response) => { targetHits += 1; response.end(JSON.stringify({ models: [{ name: "unexpected" }] })); });
  const redirectPort = await serve((_path, response) => {
    response.statusCode = 302; response.setHeader("Location", `http://127.0.0.1:${targetPort}/api/tags`); response.end();
  });
  const emptyPort = await serve((_path, response) => response.end(JSON.stringify({ models: [] })));
  const available = await new LocalTextConnectionScanner({ PATH: "", HOME: "/nonexistent" }, { ollama: redirectPort, lm_studio: emptyPort }).scan();
  assert.equal(targetHits, 0);
  assert.equal(available.find(({ provider }) => provider === "ollama")?.reason, "scan_failed");
  assert.equal(available.find(({ provider }) => provider === "lm_studio")?.reason, "no_models");
});

test("CLI detection resolves executable files from PATH without running them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-cli-discovery-test-"));
  directories.push(directory);
  const executable = join(directory, "claude");
  await writeFile(executable, "#!/bin/sh\nprintf '2.1.260 (Claude Code)\\n'\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  const codexExecutable = join(directory, "codex");
  await writeFile(codexExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(codexExecutable, 0o700);
  const canonicalExecutable = await realpath(executable);
  assert.equal(await resolveTextCliExecutable("claude", directory), canonicalExecutable);
  const directoryAlias = join(directory, "alias");
  await symlink(directory, directoryAlias, "dir");
  assert.equal(await resolveTextCliExecutable("claude", directoryAlias), canonicalExecutable);
  assert.equal(await resolveTextCliExecutable("claude", ".", "/nonexistent"), undefined);
  const emptyPort = await serve((path, response) => response.end(JSON.stringify(path === "/api/tags" ? { models: [] } : { models: [
    { key: "nomic-embed", type: "embedding" }, { key: "decision-model", type: "decision" },
  ] })));
  const availability = await new LocalTextConnectionScanner({ PATH: directory, HOME: directory },
    { ollama: emptyPort, lm_studio: emptyPort }).scan();
  assert.deepEqual(availability.find(({ provider }) => provider === "claude_code"), {
    provider: "claude_code", detected: true, usable: true, models: [], reason: null,
  });
  const codex = availability.find(({ provider }) => provider === "codex");
  assert.deepEqual(codex, { provider: "codex", detected: true, usable: false, models: [], reason: "unsupported" });
});
