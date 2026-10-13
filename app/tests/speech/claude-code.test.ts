import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { ClaudeTextError, runClaudeCodeText } from "../../src/services/text/claude-code.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixtureExecutable(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-claude-test-"));
  directories.push(directory);
  const executable = join(directory, "claude-fake");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

test("Claude adapter disables model tools, uses a private cwd and stdin, and filters environment secrets", async () => {
  const executable = await fixtureExecutable(`
    let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const expected = ['--print','--model','claude-sonnet-4-5','--safe-mode','--tools','','--no-session-persistence','--input-format','text','--output-format','json','--permission-prompts','none'];
      const safe = JSON.stringify(process.argv.slice(2)) === JSON.stringify(expected)
        && process.env.ANTHROPIC_API_KEY === undefined && process.env.OPENAI_API_KEY === undefined
        && process.cwd().includes('openwhisper-text-') && input.includes('synthetic transcript')
        && input.includes('Summarize this memo into a short action-item list.')
        && !input.includes('Rewrite only the transcript');
      process.stdout.write(JSON.stringify({ type:'result',subtype:'success',is_error:false,result:safe ? 'revised transcript' : 'unsafe invocation' }));
    });
  `);
  const prior = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "synthetic-test-secret";
  const controller = new AbortController();
  try {
    assert.equal(await runClaudeCodeText({ executable, instruction: "Summarize this memo into a short action-item list.", text: "synthetic transcript",
      model: "claude-sonnet-4-5", signal: controller.signal }),
      "revised transcript");
  } finally {
    if (prior === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = prior;
  }
});

test("Claude adapter cancels and owns the child process group", async () => {
  const executable = await fixtureExecutable(`
    process.stdin.resume();
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const result = runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", signal: controller.signal });
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(result, (error: unknown) => error instanceof ClaudeTextError && error.code === "CANCELLED");
});

test("Claude adapter observes cancellation while creating its private work directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-claude-startup-test-"));
  directories.push(directory);
  const marker = join(directory, "spawned");
  const executable = await fixtureExecutable(`
    require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
    process.stdout.write(JSON.stringify({ type:'result',subtype:'success',is_error:false,result:'unexpected' }));
  `);
  const controller = new AbortController();
  const request = runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof ClaudeTextError && error.code === "CANCELLED");
  await assert.rejects(access(marker));
});

test("Claude adapter kills same-group descendants if the leader exits but keeps stdout open", async () => {
  const executable = await fixtureExecutable(`
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      { stdio: ['ignore','inherit','inherit'] });
    process.exit(0);
  `);
  const controller = new AbortController();
  const started = performance.now();
  await assert.rejects(runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text",
    signal: controller.signal, timeoutMs: 1000 }),
  (error: unknown) => error instanceof ClaudeTextError && error.code === "TIMEOUT");
  assert.ok(performance.now() - started < 5000, "process-group cleanup must remain bounded");
});

test("Claude adapter rejects malformed envelopes and oversized transcripts before spawning", async () => {
  const executable = await fixtureExecutable("process.stdout.write('not-json');");
  const controller = new AbortController();
  await assert.rejects(runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", signal: controller.signal }),
    (error: unknown) => error instanceof ClaudeTextError && error.code === "INVALID_RESPONSE");
  await assert.rejects(runClaudeCodeText({ executable, instruction: "instruction", text: "x".repeat(65_537), signal: controller.signal }),
    (error: unknown) => error instanceof ClaudeTextError && error.code === "INVALID_RESPONSE");
});

test("Claude adapter rejects invalid direct model values before spawning", async () => {
  const executable = await fixtureExecutable(`require('node:fs').writeFileSync(require('node:path').join(__dirname, 'spawned'), 'spawned');`);
  const marker = join(dirname(executable), "spawned");
  for (const model of ["bad\nmodel", "--sandbox=workspace-write"]) {
    await assert.rejects(runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", model,
      signal: new AbortController().signal }),
    (error: unknown) => error instanceof ClaudeTextError && error.code === "INVALID_RESPONSE");
  }
  await assert.rejects(access(marker));
});

test("Claude adapter requires a successful result and ignores additional metadata", async () => {
  const controller = new AbortController();
  for (const envelope of [
    { type: "result", subtype: "error", is_error: true, result: "unexpected" },
    { type: "result", subtype: "success", result: "missing error flag" },
  ]) {
    const executable = await fixtureExecutable(`process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});`);
    await assert.rejects(runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", signal: controller.signal }),
      (error: unknown) => error instanceof ClaudeTextError && error.code === "INVALID_RESPONSE");
  }
  const executable = await fixtureExecutable(`process.stdout.write(${JSON.stringify(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result: "processed text", future_metadata: { version: 2 },
  }))});`);
  assert.equal(await runClaudeCodeText({ executable, instruction: "instruction", text: "synthetic text", signal: controller.signal }), "processed text");
});
