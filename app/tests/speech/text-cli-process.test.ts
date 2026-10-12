import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, test } from "node:test";
import { runTextCliProcess, safeTextCliEnvironment, TextCliProcessError } from "../../src/services/text/text-cli-process.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixtureExecutable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-cli-process-test-"));
  directories.push(directory);
  const executable = join(directory, "child");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("CLI child environment keeps absolute executable lookup paths and omits injection variables", () => {
  const environment = safeTextCliEnvironment({
    HOME: "/synthetic-home", PATH: `.:relative${delimiter}/opt/custom/bin`, CODEX_HOME: "/synthetic-codex-home",
    LD_PRELOAD: "/untrusted.so", NODE_OPTIONS: "--require /untrusted.js", GEMINI_API_KEY: "synthetic-secret",
  }, "/usr/local/bin/custom-cli");
  const paths = environment.PATH?.split(delimiter) ?? [];
  assert.deepEqual(paths, ["/opt/custom/bin", "/usr/local/bin", dirname(process.execPath),
    "/synthetic-home/.local/bin", "/synthetic-home/.claude/local", "/synthetic-home/.npm-global/bin",
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter((path, index, values) => values.indexOf(path) === index));
  assert.equal(environment.CODEX_HOME, "/synthetic-codex-home");
  assert.equal(environment.HOME, "/synthetic-home");
  assert.equal(environment.LD_PRELOAD, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.GEMINI_API_KEY, undefined);
  assert.ok(paths.includes(join("/synthetic-home", ".local/bin")));
});

test("CLI JSONL dialogue decodes fragmented UTF-8 and closes stdin on request", async () => {
  const executable = await fixtureExecutable(`
    process.stdin.once('data', () => {
      const line = Buffer.from(JSON.stringify({ text: 'Grüße 🙂' }) + '\\n');
      const split = line.indexOf(Buffer.from('🙂')) + 2;
      process.stdout.write(line.subarray(0, split));
      setImmediate(() => process.stdout.write(line.subarray(split)));
    });
    process.stdin.on('end', () => process.exit(0));
  `);
  let received = "";
  const output = await runTextCliProcess({ executable, args: [], input: "start\n", signal: new AbortController().signal,
    timeoutMs: 2_000, keepStdinOpen: true, onLine: (line) => { received = line; return { end: true }; } });
  assert.equal(received, '{"text":"Grüße 🙂"}');
  assert.ok(output.byteLength > 0);
});

test("CLI JSONL dialogue rejects oversized lines and retires a stalled child at its deadline", async () => {
  const oversized = await fixtureExecutable("process.stdin.once('data', () => process.stdout.write('x'.repeat(65_537)));");
  await assert.rejects(runTextCliProcess({ executable: oversized, args: [], input: "start\n", signal: new AbortController().signal,
    timeoutMs: 2_000, maxStdoutBytes: 70_000, keepStdinOpen: true, onLine: () => undefined }),
  (error: unknown) => error instanceof TextCliProcessError && error.code === "INVALID_RESPONSE");

  const stalled = await fixtureExecutable("process.stdin.on('data', () => {});");
  await assert.rejects(runTextCliProcess({ executable: stalled, args: [], input: "start\n", signal: new AbortController().signal,
    timeoutMs: 150, keepStdinOpen: true, onLine: () => undefined }),
  (error: unknown) => error instanceof TextCliProcessError && error.code === "TIMEOUT");
});
