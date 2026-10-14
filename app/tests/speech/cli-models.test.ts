import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { discoverClaudeModels, discoverCodexModels } from "../../src/services/text/cli-models.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixtureExecutable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-cli-models-test-"));
  directories.push(directory);
  const executable = join(directory, "cli-fake");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("Codex metadata discovery performs initialized paginated model/list only", async () => {
  const executable = await fixtureExecutable(`
    let pending = '';
    const seen = [];
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\\n')) {
        const end = pending.indexOf('\\n');
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line); seen.push(message.method);
        if (message.method === 'initialize') {
          if (message.params.clientInfo.name !== 'openwhisper' || message.params.capabilities.experimentalApi !== false) process.exit(31);
          process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
        } else if (message.method === 'initialized') {
          if (message.id !== undefined || seen.join(',') !== 'initialize,initialized') process.exit(35);
        } else if (message.method === 'model/list' && seen.filter(item => item === 'model/list').length === 1) {
          if (seen.join(',') !== 'initialize,initialized,model/list' || message.params.limit !== 128 || message.params.includeHidden !== false) process.exit(32);
          process.stdout.write(JSON.stringify({ id: message.id, result: { data: [
            { id: 'codex-one', hidden: false, isDefault: true, displayName: 'GPT-5.4 Codex', defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
            { id: 'hidden-model', hidden: true, displayName: 'Hidden', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }] },
          ], nextCursor: 'next-page' } }) + '\\n');
        } else if (message.method === 'model/list') {
          if (seen.join(',') !== 'initialize,initialized,model/list,model/list' || message.params.cursor !== 'next-page' ||
              message.params.limit !== 127 || message.params.includeHidden !== false) process.exit(33);
          process.stdout.write(JSON.stringify({ id: message.id, result: { data: [
            { id: 'codex-one', hidden: false, displayName: 'Duplicate label' }, { id: '--unsafe-id', hidden: false },
            { id: 'codex-two', hidden: false }, { id: 'codex-three', hidden: false, displayName: 'Bad\\nlabel' },
          ], nextCursor: null } }) + '\\n');
        } else process.exit(34);
      }
    });
  `);
  const discovery = await discoverCodexModels(executable);
  assert.deepEqual(discovery.models, ["codex-one", "codex-two", "codex-three"]);
  assert.deepEqual(discovery.model_options, [
    { value: "codex-one", display_name: "GPT-5.4 Codex", source: "cli" },
    { value: "codex-two", display_name: "codex-two", source: "cli" },
    { value: "codex-three", display_name: "codex-three", source: "cli" },
  ]);
  assert.deepEqual(discovery.model_reasoning, [
    { model: "codex-one", options: ["low", "medium", "high"], default: "medium" },
    { model: "default", options: ["low", "medium", "high"], default: "medium" },
  ]);
});

test("Codex metadata errors and repeated cursors fail closed without returning partial catalogs", async () => {
  const errorExecutable = await fixtureExecutable(`
    process.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.toString().trim());
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\\n');
    });
  `);
  assert.deepEqual(await discoverCodexModels(errorExecutable), { models: [], model_options: [], model_reasoning: [] });

  const cursorExecutable = await fixtureExecutable(`
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { pending += chunk; while (pending.includes('\\n')) {
      const end = pending.indexOf('\\n'), line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
      else if (message.method === 'model/list') {
        process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: 'partial', hidden: false }], nextCursor: 'repeat' } }) + '\\n');
      }
    }});
  `);
  assert.deepEqual(await discoverCodexModels(cursorExecutable), { models: [], model_options: [], model_reasoning: [] });
});

test("Claude metadata discovery preserves aliases and resolved IDs and adds bounded active-version suggestions", async () => {
  const executable = await fixtureExecutable(`
    let pending = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      pending += chunk;
      while (pending.includes('\\n')) {
        const end = pending.indexOf('\\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type !== 'control_request' || message.request?.subtype !== 'initialize' ||
            message.request_id !== 'openwhisper-model-catalog') process.exit(41);
        process.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: message.request_id,
          subtype: 'success', response: { account: { private: 'not returned' }, models: [
            { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
            { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
            { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
            { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
            { value: 'custom-haiku', resolvedModel: 'vendor-haiku-latest', displayName: 'Gateway Haiku' },
            { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Duplicate' },
            { value: '--invalid', displayName: 'Invalid' },
            { value: 'bad\\nmodel', displayName: 'Invalid control' },
          ] } } }) + '\\n');
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  const discovery = await discoverClaudeModels(executable);
  assert.deepEqual(discovery.models, ["default", "claude-opus-5-5", "opus", "claude-fable-5-1[1m]", "claude-fable-5-1",
    "sonnet", "claude-sonnet-5", "custom-haiku", "vendor-haiku-latest"]);
  const option = (value: string) => discovery.model_options.find((candidate) => candidate.value === value);
  assert.deepEqual(option("default"), { value: "default", display_name: "Default", source: "cli" });
  assert.deepEqual(option("opus"), { value: "opus", display_name: "Opus", source: "cli" });
  assert.deepEqual(option("claude-opus-5-5"), { value: "claude-opus-5-5", display_name: "Opus 5.5", source: "cli" });
  assert.deepEqual(option("claude-fable-5-1[1m]"), {
    value: "claude-fable-5-1[1m]", display_name: "Fable 5.1 1M", source: "cli",
  });
  assert.deepEqual(option("sonnet"), { value: "sonnet", display_name: "Sonnet", source: "cli" });
  assert.equal(option("claude-fable-5")?.source, "catalog");
  assert.equal(option("claude-sonnet-5-5"), undefined, "versions newer than the resolved Sonnet model are not suggested");
  assert.equal(option("claude-sonnet-4-6")?.source, "catalog");
  assert.equal(option("vendor-haiku-latest")?.source, "cli");
  assert.equal(option("vendor-haiku-latest")?.display_name, "vendor-haiku-latest");
  assert.equal(option("claude-haiku-5-5"), undefined, "provider-specific IDs do not seed first-party family suggestions");
  assert.ok(discovery.model_options.every(({ value }) => !value.includes("mythos")));
  assert.deepEqual(discovery.model_reasoning.find(({ model }) => model === "default"), {
    model: "default", options: ["low", "medium", "high", "xhigh", "max"], default: "medium",
  });
  assert.deepEqual(discovery.model_reasoning.find(({ model }) => model === "claude-opus-4-7"), {
    model: "claude-opus-4-7", options: ["low", "medium", "high", "xhigh", "max"], default: "xhigh",
  });
  assert.deepEqual(discovery.model_reasoning.find(({ model }) => model === "claude-sonnet-4-6"), {
    model: "claude-sonnet-4-6", options: ["low", "medium", "high", "max"], default: "high",
  });
  assert.equal(discovery.model_reasoning.some(({ model }) => model === "vendor-haiku-latest"), false,
    "unknown provider model IDs do not get guessed reasoning controls");
});

test("Claude malformed or mismatched initialize responses return an empty catalog", async () => {
  const executable = await fixtureExecutable(`
    process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      request_id: 'not-openwhisper-request', subtype: 'success', response: { models: [{ value: 'wrong', displayName: 'Wrong' }] },
    } }) + '\\n'));
  `);
  assert.deepEqual(await discoverClaudeModels(executable), { models: [], model_options: [], model_reasoning: [] });
});
