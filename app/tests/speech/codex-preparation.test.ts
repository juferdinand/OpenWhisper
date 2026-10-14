import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { CodexTextError } from "../../src/services/text/codex.js";
import { CodexTextPreparation, prepareCodexText } from "../../src/services/text/codex-preparation.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function fixture(behavior = ""): Promise<{ executable: string; events: () => Promise<string[]> }> {
  const directory = await mkdtemp(join(tmpdir(), "openwhisper-codex-preparation-"));
  directories.push(directory);
  const executable = join(directory, "codex");
  const receipt = join(directory, "events");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const note = value => fs.appendFileSync(${JSON.stringify(receipt)}, value + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const server = process.argv[2] === 'app-server';
note(server ? 'prepare' : 'exec');
if (!server) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    send({type:'item.completed',phase:'final_answer',item:{type:'agent_message',text:'cold result'}});
    send({type:'turn.completed'});
  });
} else {
  ${behavior}
  readline.createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      if (message.params.capabilities.experimentalApi !== false) process.exit(20);
      send({id:1,result:{}});
    } else if (message.method === 'thread/start') {
      const p = message.params;
      if (p.ephemeral !== true || p.approvalPolicy !== 'never' || p.sandbox !== 'read-only') process.exit(21);
      note('thread');
      send({id:2,result:{thread:{id:'thread',ephemeral:true},model:p.model || 'configured-model',
        approvalPolicy:'never',sandbox:{type:'readOnly'},reasoningEffort:process.argv.includes('model_reasoning_effort="low"') ? 'low' : null}});
      if (typeof idle === 'function') idle();
    } else if (message.method === 'turn/start') {
      note('turn');
      const p = message.params;
      if (p.threadId !== 'thread' || p.input.length !== 1 || p.input[0].type !== 'text') process.exit(22);
      if (typeof turn === 'function') { turn(p); return; }
      send({id:3,result:{turn:{id:'turn'}}});
      send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'commentary',text:'ignore'}}});
      send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'full corrected text Grüße 🙂'}}});
      send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',error:null}}});
    }
  }).on('close', () => { if (typeof hang !== 'undefined') setInterval(() => {}, 1000); });
}
`, { mode: 0o700 });
  return { executable, events: async () => (await readFile(receipt, "utf8")).trim().split("\n") };
}
const input = () => ({ instruction: "Correct the full text.", text: "synthetic source", signal: new AbortController().signal });

test("prepared Codex starts only metadata until input and keeps full-text output, model, effort and privacy", async () => {
  const child = await fixture(`
    if (process.env.OPENAI_API_KEY !== undefined || !process.cwd().includes('openwhisper-text-')) process.exit(23);
    function turn(p) {
      if (p.model !== 'chosen-model' || p.effort !== 'low' || !p.input[0].text.includes('synthetic source')) process.exit(24);
      send({id:3,result:{turn:{id:'turn'}}});
      send({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'full corrected text Grüße 🙂'}}});
      send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',error:null}}});
    }
  `);
  const prepared = await prepareCodexText({ executable: child.executable, model: "chosen-model", reasoning_effort: "low" }, new AbortController().signal);
  assert.deepEqual(await child.events(), ["prepare", "thread"]);
  assert.equal(await prepared.run(input()), "full corrected text Grüße 🙂");
  await prepared.close();
  assert.deepEqual(await child.events(), ["prepare", "thread", "turn"]);
  await assert.rejects(prepared.run(input()), (error: unknown) => error instanceof CodexTextError && error.code === "UNAVAILABLE");
});

test("pending or mismatched preparation uses exec immediately without sending a standby turn", async () => {
  for (const mismatch of [false, true]) {
    const child = await fixture();
    const manager = new CodexTextPreparation();
    const pending = manager.prepare(1, { executable: child.executable });
    if (mismatch) await pending;
    assert.equal(await manager.run(mismatch ? 2 : 1, { executable: child.executable, ...input() }), "cold result");
    await manager.close();
    assert.ok(!(await child.events()).includes("turn"));
  }
});

test("an exited standby and an oversized escaped envelope use exec before any prepared turn", async () => {
  for (const behavior of ["function idle() { setTimeout(() => process.exit(0), 25); }", ""]) {
    const child = await fixture(behavior);
    const manager = new CodexTextPreparation();
    await manager.prepare(1, { executable: child.executable });
    if (behavior) await new Promise<void>((accept) => setTimeout(accept, 100));
    assert.equal(await manager.run(1, { executable: child.executable, ...input(), ...(behavior ? {} : { text: "\u0001".repeat(60_000) }) }), "cold result");
    await manager.close();
    assert.deepEqual((await child.events()).filter((event) => event === "turn" || event === "exec"), ["exec"]);
  }
});

test("failed inference is never repeated with exec and a foreign turn is rejected", async () => {
  for (const behavior of [
    "function turn() { send({id:3,error:{code:-1,message:'synthetic'}}); }",
    "function turn() { send({method:'turn/completed',params:{threadId:'foreign',turn:{id:'turn',status:'completed'}}}); }",
  ]) {
    const child = await fixture(behavior);
    const manager = new CodexTextPreparation();
    await manager.prepare(1, { executable: child.executable });
    await assert.rejects(manager.run(1, { executable: child.executable, ...input() }), CodexTextError);
    await manager.close();
    assert.deepEqual(await child.events(), ["prepare", "thread", "turn"]);
  }
});

test("shutdown cancels an active prepared request and retires its private directory", async () => {
  const child = await fixture("function turn() { note(process.cwd()); }");
  const manager = new CodexTextPreparation();
  await manager.prepare(1, { executable: child.executable });
  const running = manager.run(1, { executable: child.executable, ...input() });
  const rejected = assert.rejects(running, (error: unknown) => error instanceof CodexTextError && error.code === "CANCELLED");
  let events = await child.events();
  for (let attempt = 0; attempt < 100 && !events.some((event) => event.includes("openwhisper-text-")); attempt += 1) {
    await new Promise<void>((accept) => setTimeout(accept, 10)); events = await child.events();
  }
  await manager.close(); await rejected;
  const cwd = events.find((event) => event.includes("openwhisper-text-"));
  assert.ok(cwd);
  await assert.rejects(stat(cwd), { code: "ENOENT" });
  assert.notEqual(dirname(cwd), dirname(child.executable));
});

test("completed full text survives bounded retirement of a child that ignores stdin EOF", async () => {
  const child = await fixture("const hang = true;");
  const prepared = await prepareCodexText({ executable: child.executable }, new AbortController().signal);
  const started = performance.now();
  assert.equal(await prepared.run(input()), "full corrected text Grüße 🙂");
  await prepared.close();
  assert.ok(performance.now() - started < 5_000, "terminal cleanup must not wait for the 120-second inference deadline");
});

test("stale and cancelled calls leave the next recording's prepared owner available", async () => {
  const child = await fixture();
  const manager = new CodexTextPreparation();
  await manager.prepare(2, { executable: child.executable });
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(manager.run(1, { executable: child.executable, ...input(), signal: cancelled.signal }),
    (error: unknown) => error instanceof CodexTextError && error.code === "CANCELLED");
  assert.equal(await manager.run(1, { executable: child.executable, ...input() }), "cold result");
  assert.equal(await manager.run(2, { executable: child.executable, ...input() }), "full corrected text Grüße 🙂");
  await manager.close();
  assert.deepEqual(await child.events(), ["prepare", "thread", "exec", "turn"]);
});

test("conversation keeps exec and server approval requests never repeat inference", async () => {
  for (const conversation of [true, false]) {
    const child = await fixture("function turn() { send({id:100,method:'item/commandExecution/requestApproval',params:{}}); }");
    const manager = new CodexTextPreparation();
    await manager.prepare(1, { executable: child.executable });
    const running = manager.run(1, { executable: child.executable, ...input(), ...(conversation ? { context: [] } : {}) });
    if (conversation) assert.equal(await running, "cold result");
    else await assert.rejects(running, CodexTextError);
    await manager.close();
    assert.deepEqual((await child.events()).filter((event) => event === "exec" || event === "turn"), [conversation ? "exec" : "turn"]);
  }
});
