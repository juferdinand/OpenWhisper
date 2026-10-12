import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  cliTextModelSchema, customCliConnectionSchema, defaultTextConnectionAvailability, defaultTextConnectionSettings,
  textConnectionAvailabilitySchema, textConnectionSettingsSchema, textConnectionsStateSchema,
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
  assert.deepEqual(defaults.connections.filter((entry) => entry.provider === "claude_code" || entry.provider === "codex")
    .map((entry) => "model" in entry ? entry.model : undefined), ["", ""]);
  assert.ok(defaultTextConnectionAvailability().filter(({ provider }) => provider === "claude_code" || provider === "codex")
    .every((entry) => !entry.detected && entry.reason === "not_installed"));
  const reordered = { ...defaults, connections: [...defaults.connections].reverse() };
  assert.deepEqual(textConnectionSettingsSchema.parse(reordered).connections.map(({ provider }) => provider),
    ["codex", "claude_code", "lm_studio", "ollama"]);
  assert.throws(() => textConnectionSettingsSchema.parse({ ...defaults,
    connections: [defaults.connections[0], defaults.connections[0], ...defaults.connections.slice(2)] }));
});

test("optional CLI model options are bounded typed display metadata", () => {
  const defaults = defaultTextConnectionAvailability();
  const claude = defaults.find(({ provider }) => provider === "claude_code");
  assert.ok(claude);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: [{ value: "claude-sonnet-5-5", display_name: "Sonnet 5.5", source: "catalog" }],
  }).success, true);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: [{ value: "--unsafe", display_name: "Bad model", source: "catalog" }],
  }).success, false);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: [{ value: "sonnet", display_name: "Bad\nmodel", source: "cli" }],
  }).success, false);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: [{ value: "sonnet", display_name: "Sonnet", source: "guess" }],
  }).success, false);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: [{ value: "sonnet", display_name: "🙂".repeat(65), source: "catalog" }],
  }).success, false);
  assert.equal(textConnectionAvailabilitySchema.safeParse({ ...claude,
    model_options: Array.from({ length: 129 }, () => ({ value: "sonnet", display_name: "Sonnet", source: "catalog" })),
  }).success, false);
});

test("custom CLI entries are bounded argv data with safe output selectors and compatible legacy defaults", () => {
  const defaults = defaultTextConnectionSettings();
  const legacy = textConnectionSettingsSchema.parse({ connections: defaults.connections, instruction: defaults.instruction });
  assert.equal(legacy.mode, "single");
  assert.ok(legacy.conversationInstruction.trim().length > 0);
  const legacyCli = textConnectionSettingsSchema.parse({ ...defaults, connections: defaults.connections.map((entry) =>
    entry.provider === "claude_code" || entry.provider === "codex"
      ? { provider: entry.provider, enabled: entry.enabled } : entry) });
  assert.deepEqual(legacyCli.connections.filter((entry) => entry.provider === "claude_code" || entry.provider === "codex")
    .map((entry) => "model" in entry ? entry.model : undefined), ["", ""]);
  const codexModel = legacyCli.connections.find((entry) => entry.provider === "codex");
  assert.ok(codexModel && "model" in codexModel);
  assert.equal(cliTextModelSchema.safeParse("--sandbox=workspace-write").success, false);
  assert.equal(cliTextModelSchema.safeParse("gpt-5.4-codex").success, true);
  assert.equal(textConnectionSettingsSchema.safeParse({ ...legacyCli, connections: legacyCli.connections.map((entry) =>
    entry.provider === "codex" ? { ...entry, model: " gpt-5.4 " } : entry) }).success, false);
  const custom = customCliConnectionSchema.parse({ provider: "custom:123e4567-e89b-42d3-a456-426614174000",
    enabled: false, name: "Owned wrapper", command: "owned-wrapper", args: ["--prompt", "{prompt}"] });
  assert.equal(custom.stdin, "{prompt}");
  assert.equal(custom.output, "text");
  assert.equal(custom.responsePath, "");
  for (const bad of [
    { ...custom, command: "owned-wrapper && touch /tmp/marker" },
    { ...custom, output: "json", responsePath: "answer.__proto__.value" },
    { ...custom, output: "json", responsePath: "" },
    { ...custom, args: ["--no-prompt"] , stdin: "" },
  ]) assert.equal(customCliConnectionSchema.safeParse(bad).success, false);
  assert.equal(textConnectionSettingsSchema.safeParse({ ...defaults, mode: "conversation", connections: [
    ...defaults.connections, { ...custom, enabled: true, args: ["--mode", "dialog"], stdin: "{text}" },
  ] }).success, false);
  const complete = textConnectionSettingsSchema.parse({ ...defaults, mode: "conversation", connections: [
    ...defaults.connections, { ...custom, enabled: true },
  ] });
  assert.equal(complete.connections.length, 5);
  assert.equal(textConnectionSettingsSchema.safeParse({ ...complete,
    connections: [...complete.connections, complete.connections[4]] }).success, false);
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

test("newly enabled unavailable providers and model-less local connections are rejected", () => {
  const defaults = defaultTextConnectionSettings();
  const previous = { ...defaults, connections: defaults.connections.map((entry) => ({
    ...entry, enabled: entry.provider === "ollama",
  })) };
  const enable = (provider: "lm_studio" | "codex", model = "") => ({ ...previous,
    connections: previous.connections.map((entry) => entry.provider === provider
      ? { ...entry, enabled: true, model } : entry),
  });
  assert.throws(() => validateTextConnectionChanges(previous, enable("lm_studio", "qwen"),
    defaultTextConnectionAvailability()), /available provider/u);
  const changeEnabledModel = { ...previous, connections: previous.connections.map((entry) => entry.provider === "ollama"
    ? { ...entry, model: "qwen" } : entry) };
  assert.throws(() => validateTextConnectionChanges(previous, changeEnabledModel, defaultTextConnectionAvailability()), /available provider/u);
  const availableOllama = defaultTextConnectionAvailability().map((entry) => entry.provider === "ollama"
    ? { ...entry, usable: true, detected: true, models: ["qwen"], reason: null } : entry);
  assert.doesNotThrow(() => validateTextConnectionChanges(previous, changeEnabledModel, availableOllama));
  const availableWithoutSelection = defaultTextConnectionAvailability().map((entry) => entry.provider === "lm_studio"
    ? { ...entry, usable: true, detected: true, models: ["qwen"], reason: null } : entry);
  assert.throws(() => validateTextConnectionChanges(previous, enable("lm_studio"), availableWithoutSelection), /available model/u);
  const codexAvailable = defaultTextConnectionAvailability().map((entry) => entry.provider === "codex"
    ? { ...entry, detected: true, usable: true, reason: null } : entry);
  assert.doesNotThrow(() => validateTextConnectionChanges(previous, enable("codex"), codexAvailable));
  assert.doesNotThrow(() => validateTextConnectionChanges(previous, enable("codex", "gpt-5.4-codex"), codexAvailable));
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
    conversation: { id: "", provider: null, turns: [] },
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
  assert.equal(codex.usable, codex.reason === null);
  assert.ok(codex.reason === "not_installed" || codex.reason === "unsupported" || codex.reason === null);
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

test("CLI discovery resolves executables and reads model metadata without starting a model turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-cli-discovery-test-"));
  directories.push(directory);
  const executable = join(directory, "claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('2.1.260 (Claude Code)\\n'); process.exit(0); }
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { pending += chunk; for (const line of pending.split('\\n').slice(0, -1)) {
  pending = pending.slice(line.length + 1); if (!line) continue;
  const request = JSON.parse(line);
  if (request.type !== 'control_request' || request.request?.subtype !== 'initialize') process.exit(41);
  process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id,
    subtype: 'success', response: { models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet' }] } } }) + '\\n');
} });
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const codexExecutable = join(directory, "codex");
  await writeFile(codexExecutable, `#!/usr/bin/env node
if (process.argv.includes('exec') && process.argv.includes('--help')) {
  process.stdout.write('--json --sandbox --skip-git-repo-check --ephemeral --model --color\\n'); process.exit(0);
}
if (process.argv.includes('--help')) { process.stdout.write('-a --color\\n'); process.exit(0); }
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { pending += chunk; while (pending.includes('\\n')) {
  const end = pending.indexOf('\\n'), line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
  else if (request.method === 'initialized') { if (request.id !== undefined) process.exit(42); }
  else if (request.method === 'model/list') process.stdout.write(JSON.stringify({ id: request.id, result: {
    data: [{ id: 'gpt-5.4-codex', hidden: false }, { id: 'hidden', hidden: true }], nextCursor: null,
  } }) + '\\n');
  else process.exit(43);
} });
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o700 });
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
  const fixturePath = [directory, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const availability = await new LocalTextConnectionScanner({ PATH: fixturePath, HOME: directory },
    { ollama: emptyPort, lm_studio: emptyPort }).scan();
  const claude = availability.find(({ provider }) => provider === "claude_code");
  assert.deepEqual(claude?.models, ["sonnet", "claude-sonnet-5-5"]);
  assert.equal(claude?.model_options?.find(({ value }) => value === "sonnet")?.source, "cli");
  assert.equal(claude?.model_options?.find(({ value }) => value === "claude-sonnet-5")?.source, "catalog");
  const codex = availability.find(({ provider }) => provider === "codex");
  assert.deepEqual(codex, { provider: "codex", detected: true, usable: true, models: ["gpt-5.4-codex"], reason: null });
});

test("CLI metadata failure leaves a supported installed CLI usable with its inherited model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-cli-empty-catalog-test-"));
  directories.push(directory);
  const executable = join(directory, "claude");
  await writeFile(executable, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('2.1.260\\n'); process.exit(0); }
process.stdin.once('data', () => process.stdout.write('{not-json}\\n'));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const emptyPort = await serve((_path, response) => response.end(JSON.stringify({ models: [] })));
  const fixturePath = [directory, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const availability = await new LocalTextConnectionScanner({ PATH: fixturePath, HOME: directory },
    { ollama: emptyPort, lm_studio: emptyPort }).scan();
  assert.deepEqual(availability.find(({ provider }) => provider === "claude_code"), {
    provider: "claude_code", detected: true, usable: true, models: [], reason: null,
  });
});
