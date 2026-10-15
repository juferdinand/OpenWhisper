import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("timeout still escalates the owned process group after its CLI leader closes", { skip: process.platform === "win32" }, async () => {
  const executable = await fixtureExecutable("");
  const directory = dirname(executable), pidFile = join(directory, "owned-pids.json"), marker = join(directory, "survived-sigkill-grace");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const marker = ${JSON.stringify(marker)};
const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'survived'), 2600)"], { stdio: ['ignore', 'pipe', 'ignore'] });
descendant.stdout.once('data', () => {
  fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ group: process.pid, descendant: descendant.pid }));
  process.stdout.write('ready\\n');
});
process.on('SIGTERM', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o700 });
  let group: number | undefined;
  try {
    let readyAt: number | undefined;
    let control: import("../../src/services/text/text-cli-process.js").TextCliDialogueControl | undefined;
    await assert.rejects(runTextCliProcess({ executable, args: [], input: "", signal: new AbortController().signal,
      timeoutMs: 100, startupTimeoutMs: 5_000, idleTimeoutMs: 1_000, keepStdinOpen: true,
      onControl: (value) => { control = value; }, onLine: (line) => {
        assert.equal(line, "ready");
        readyAt = performance.now();
        control!.waitForInput(); control!.beginRequest();
        return undefined;
      } }),
    (error: unknown) => error instanceof TextCliProcessError && error.code === "TIMEOUT");
    assert.notEqual(readyAt, undefined, "both fixture processes must install their signal handlers before the request deadline");
    assert.ok(performance.now() - readyAt! >= 1400, "CLI close must not cancel the pending SIGKILL escalation");
    const owners = JSON.parse(await readFile(pidFile, "utf8")) as { group: number; descendant: number };
    group = owners.group;
    await new Promise<void>((accept) => setTimeout(accept, Math.max(0, 2900 - (performance.now() - readyAt!))));
    await assert.rejects(readFile(marker), { code: "ENOENT" }, "descendant must not survive the process-group SIGKILL");
  } finally {
    if (group !== undefined) { try { process.kill(-group, "SIGKILL"); } catch { /* The owned fixture group has already exited. */ } }
  }
});

test("abort shortly before the operation deadline preserves CANCELLED during SIGKILL grace", async () => {
  const executable = await fixtureExecutable(`
    process.stdin.on('data', () => {});
    process.on('SIGTERM', () => process.exit(0));
  `);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 800);
  try {
    await assert.rejects(runTextCliProcess({ executable, args: [], input: "start\n", signal: controller.signal,
      timeoutMs: 1_000, keepStdinOpen: true, onLine: () => undefined }),
    (error: unknown) => error instanceof TextCliProcessError && error.code === "CANCELLED");
  } finally { clearTimeout(abortTimer); }
});

test("prepared dialogue separates startup, standby and inference deadlines and cannot restart a request", async () => {
  const executable = await fixtureExecutable(`
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      if (line === 'start') process.stdout.write('ready\\n');
      else setTimeout(() => process.stdout.write('done\\n'), 30);
    });
  `);
  let control: import("../../src/services/text/text-cli-process.js").TextCliDialogueControl | undefined;
  let ready!: () => void;
  const waiting = new Promise<void>((accept) => { ready = accept; });
  const running = runTextCliProcess({ executable, args: [], input: "start\n", signal: new AbortController().signal,
    timeoutMs: 150, startupTimeoutMs: 1_000, idleTimeoutMs: 1_000, keepStdinOpen: true, collectStdout: false,
    onControl: (value) => { control = value; }, onLine: (line) => {
      if (line === "ready") { control!.waitForInput(); ready(); }
      else control!.finishRequest();
      return undefined;
    } });
  await waiting;
  await new Promise<void>((accept) => setTimeout(accept, 220));
  control!.beginRequest(); control!.write("request\n");
  assert.equal((await running).byteLength, 0);
  assert.throws(() => control!.beginRequest(), TextCliProcessError);
  assert.throws(() => control!.write("late\n"), TextCliProcessError);
});

test("prepared dialogue expires standby without borrowing a new inference deadline", async () => {
  const executable = await fixtureExecutable("process.stdin.once('data', () => process.stdout.write('ready\\n')); process.stdin.resume();");
  let control: import("../../src/services/text/text-cli-process.js").TextCliDialogueControl | undefined;
  await assert.rejects(runTextCliProcess({ executable, args: [], input: "start\n", signal: new AbortController().signal,
    timeoutMs: 1_000, startupTimeoutMs: 1_000, idleTimeoutMs: 100, keepStdinOpen: true,
    onControl: (value) => { control = value; }, onLine: () => { control!.waitForInput(); return undefined; } }),
  (error: unknown) => error instanceof TextCliProcessError && error.code === "TIMEOUT");
  assert.throws(() => control!.beginRequest(), TextCliProcessError);
});

test("completed and unexpectedly exited standby dialogues retire same-group descendants", { skip: process.platform === "win32" }, async () => {
  for (const phase of ["idle", "complete"]) {
    const executable = await fixtureExecutable("");
    const marker = join(dirname(executable), "survived-successful-dialogue");
    await writeFile(executable, `#!/usr/bin/env node
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(" + ${JSON.stringify(JSON.stringify(marker))} + ", 'survived'), 2600)"], {stdio:'ignore'});
      process.stdin.once('data', () => { process.stdout.write('ready\\n'); if (${JSON.stringify(phase)} === 'idle') setTimeout(() => process.exit(0), 25); });
      process.stdin.on('end', () => process.exit(0));
    `, { mode: 0o700 });
    let control: import("../../src/services/text/text-cli-process.js").TextCliDialogueControl | undefined;
    const started = performance.now();
    await runTextCliProcess({ executable, args: [], input: "start\n", signal: new AbortController().signal,
      timeoutMs: 1_000, idleTimeoutMs: 1_000, keepStdinOpen: true,
      onControl: (value) => { control = value; }, onLine: () => {
        control!.waitForInput();
        if (phase === "complete") { control!.beginRequest(); control!.finishRequest(); }
        return undefined;
      } });
    assert.ok(performance.now() - started >= 1400);
    await new Promise<void>((accept) => setTimeout(accept, Math.max(0, 2800 - (performance.now() - started))));
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }
});
