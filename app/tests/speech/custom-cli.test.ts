import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { customCliConnectionSchema, type CustomCliConnection } from "../../src/contracts/text/connections.js";
import { CustomCliTextError, runCustomCliText, testCustomCliConnection } from "../../src/services/text/custom-cli.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixtureExecutable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-custom-cli-test-"));
  directories.push(directory);
  const executable = join(directory, "custom-fake");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

function connection(overrides: Partial<CustomCliConnection> = {}) {
  return customCliConnectionSchema.parse({
    provider: "custom:8b6ee8c9-b1eb-4c13-9eac-53a07e17c362", enabled: true, name: "Synthetic CLI",
    command: "custom-fake", args: [], stdin: "{prompt}", output: "text", responsePath: "", ...overrides,
  });
}

test("custom CLI substitutes literal argument and stdin data without shell interpretation", async () => {
  const marker = join(tmpdir(), `openwhisper-shell-marker-${process.pid}`);
  await rm(marker, { force: true });
  const text = `memo; $(touch ${marker}) &`;
  const expectedArgs = [`--payload=${text}`, "--task=Summarize safely"];
  const executable = await fixtureExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const safe = JSON.stringify(args) === ${JSON.stringify(JSON.stringify(expectedArgs))}
        && input.includes('previous turn user') && input.includes('previous turn assistant')
        && input.includes(${JSON.stringify(text)}) && input.includes('Summarize safely')
        && process.cwd().includes('openwhisper-text-');
      process.stdout.write(JSON.stringify({ result: { answer: safe ? 'mapped custom answer' : 'unsafe invocation' } }));
    });
  `);
  const controller = new AbortController();
  try {
    assert.equal(await runCustomCliText({ executable, connection: connection({
      args: ["--payload={text}", "--task={instruction}"], stdin: "{prompt}", output: "json", responsePath: "result.answer",
    }), instruction: "Summarize safely", text,
    context: [{ user: "previous turn user", assistant: "previous turn assistant" }], signal: controller.signal }), "mapped custom answer");
    await assert.rejects(access(marker));
  } finally { await rm(marker, { force: true }); }
});

test("custom CLI supports plain text and rejects unsafe or missing JSON response paths", async () => {
  const executable = await fixtureExecutable("process.stdout.write(' plain text result \\n');");
  const controller = new AbortController();
  assert.equal(await runCustomCliText({ executable, connection: connection(), instruction: "Clean text", text: "synthetic", signal: controller.signal }),
    "plain text result");
  const jsonExecutable = await fixtureExecutable("process.stdout.write(JSON.stringify({ safe: 'mapped text', result: { answer: 'nested text' } }));");
  assert.equal(await runCustomCliText({ executable: jsonExecutable,
    connection: connection({ output: "json", responsePath: "result.answer" }), instruction: "Clean text", text: "synthetic", signal: controller.signal }),
  "nested text");
  assert.throws(() => connection({ output: "json", responsePath: "" }));
  for (const path of ["__proto__.polluted", "result..answer", "constructor.prototype"]) {
    await assert.rejects(runCustomCliText({ executable: jsonExecutable, connection: { ...connection({ output: "json", responsePath: "safe" }), responsePath: path },
      instruction: "Clean text", text: "synthetic", signal: controller.signal }),
    (error: unknown) => error instanceof CustomCliTextError && error.code === "INVALID_RESPONSE");
  }
});

test("custom CLI smoke test uses synthetic input and returns only elapsed time", async () => {
  const executable = await fixtureExecutable(`
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => process.stdout.write(
      input.includes('OpenWhisper CLI connection test.') ? 'synthetic test reply' : ''
    ));
  `);
  const elapsed = await testCustomCliConnection({
    executable,
    connection: connection(),
    signal: new AbortController().signal,
  });
  assert.equal(Number.isInteger(elapsed), true);
  assert.ok(elapsed >= 0 && elapsed <= 15_000);
});

test("custom CLI requires transcript placeholders and explicit prompt delivery for conversation history", async () => {
  const executable = await fixtureExecutable("process.stdout.write('unexpected');");
  const marker = join(dirname(executable), "spawned");
  const controller = new AbortController();
  assert.throws(() => connection({ stdin: "static text" }));
  await assert.rejects(runCustomCliText({ executable, connection: connection({ stdin: "{text}" }),
    instruction: "instruction", text: "transcript", context: [], signal: controller.signal }),
  (error: unknown) => error instanceof CustomCliTextError && error.code === "INVALID_RESPONSE");
  await assert.rejects(access(marker), { code: "ENOENT" }, "invalid template must be refused before spawning");
});

test("custom CLI enforces bounded conversation context before starting a process", async () => {
  const marker = join(tmpdir(), `openwhisper-custom-limit-${process.pid}`);
  await rm(marker, { force: true });
  const executable = await fixtureExecutable(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
  const controller = new AbortController();
  await assert.rejects(runCustomCliText({ executable, connection: connection(), instruction: "instruction", text: "text",
    context: [{ user: "x".repeat(256 * 1024), assistant: "y" }], signal: controller.signal }),
  (error: unknown) => error instanceof CustomCliTextError && error.code === "INVALID_RESPONSE");
  await assert.rejects(access(marker));
});

test("custom CLI rejects an expanded argv entry beyond the cross-platform argument limit before spawning", async () => {
  const marker = join(tmpdir(), `openwhisper-custom-argv-limit-${process.pid}`);
  await rm(marker, { force: true });
  const executable = await fixtureExecutable(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');`);
  const controller = new AbortController();
  await assert.rejects(runCustomCliText({ executable, connection: connection({ args: ["{prompt}"], stdin: "" }),
    instruction: "Respond briefly", text: "current message", context: [
      { user: "x".repeat(62 * 1024), assistant: "answer" },
      { user: "y".repeat(62 * 1024), assistant: "answer" },
    ],
    signal: controller.signal }),
  (error: unknown) => error instanceof CustomCliTextError && error.code === "INVALID_RESPONSE");
  await assert.rejects(access(marker));
});
