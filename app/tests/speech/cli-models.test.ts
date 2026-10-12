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
            { id: 'codex-one', hidden: false }, { id: 'hidden-model', hidden: true },
          ], nextCursor: 'next-page' } }) + '\\n');
        } else if (message.method === 'model/list') {
          if (seen.join(',') !== 'initialize,initialized,model/list,model/list' || message.params.cursor !== 'next-page' ||
              message.params.limit !== 127 || message.params.includeHidden !== false) process.exit(33);
          process.stdout.write(JSON.stringify({ id: message.id, result: { data: [
            { id: 'codex-one', hidden: false }, { id: '--unsafe-id', hidden: false }, { id: 'codex-two', hidden: false },
          ], nextCursor: null } }) + '\\n');
        } else process.exit(34);
      }
    });
  `);
  assert.deepEqual(await discoverCodexModels(executable), ["codex-one", "codex-two"]);
});

test("Codex metadata errors and repeated cursors fail closed without returning partial catalogs", async () => {
  const errorExecutable = await fixtureExecutable(`
    process.stdin.on('data', chunk => {
      const message = JSON.parse(chunk.toString().trim());
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\\n');
    });
  `);
  assert.deepEqual(await discoverCodexModels(errorExecutable), []);

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
  assert.deepEqual(await discoverCodexModels(cursorExecutable), []);
});

test("Claude metadata discovery sends only initialize and extracts bounded unique model values", async () => {
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
            { value: 'claude-sonnet', displayName: 'Sonnet' }, { value: 'claude-opus', displayName: 'Opus' },
            { value: 'claude-sonnet', displayName: 'Duplicate' }, { value: '--invalid', displayName: 'Invalid' },
            { value: 'bad\\nmodel', displayName: 'Invalid control' },
          ] } } }) + '\\n');
      }
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  assert.deepEqual(await discoverClaudeModels(executable), ["claude-sonnet", "claude-opus"]);
});

test("Claude malformed or mismatched initialize responses return an empty catalog", async () => {
  const executable = await fixtureExecutable(`
    process.stdin.once('data', () => process.stdout.write(JSON.stringify({ type: 'control_response', response: {
      request_id: 'not-openwhisper-request', subtype: 'success', response: { models: [{ value: 'wrong', displayName: 'Wrong' }] },
    } }) + '\\n'));
  `);
  assert.deepEqual(await discoverClaudeModels(executable), []);
});
