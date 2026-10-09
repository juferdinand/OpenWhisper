import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, fork, spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { captureMetadataSchema, loadNativeCapture } from "../../src/workers/native-capture.js";

const execute = promisify(execFile);
const binding = process.argv[2], output = process.argv[3], fixturePath = process.argv[4];
const short = process.argv[5] === "--short";
const restartProbe = process.argv.includes("--restarts");
if (!binding || !output || !fixturePath || process.env.OPENWHISPER_OWNED_CAPTURE !== "1" || process.getuid?.() !== 1000) {
  throw new Error("Owned non-root capture container required.");
}
for (const path of ["/dev/snd", "/dev/input", "/dev/dri"]) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}
for (const key of ["PULSE_SERVER", "DBUS_SESSION_BUS_ADDRESS", "PIPEWIRE_REMOTE", "WAYLAND_DISPLAY", "DISPLAY"]) {
  if (process.env[key]) throw new Error("Inherited host surface refused.");
}
await mkdir(output, { recursive: true, mode: 0o700 });
const root = await mkdtemp("/tmp/openwhisper-owned-capture-"), runtime = join(root, "runtime");
await mkdir(runtime, { mode: 0o700 });
const config = join(root, "config");
await mkdir(join(config, "wireplumber/main.lua.d"), { recursive: true, mode: 0o700 });
await mkdir(join(config, "wireplumber/bluetooth.lua.d"), { recursive: true, mode: 0o700 });
await writeFile(join(config, "wireplumber/main.lua.d/89-owned-no-devices.lua"),
  "alsa_monitor.enabled = false\nv4l2_monitor.enabled = false\nlibcamera_monitor.enabled = false\n", { mode: 0o600 });
await writeFile(join(config, "wireplumber/bluetooth.lua.d/89-owned-no-devices.lua"), "bluez_monitor.enabled = false\n", { mode: 0o600 });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: config,
  XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PIPEWIRE_RUNTIME_DIR: runtime,
  PIPEWIRE_REMOTE: "pipewire-0", PULSE_SERVER: `unix:${runtime}/pulse/native`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
const children: ChildProcess[] = [];
function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { env, stdio: "ignore", shell: false }); children.push(child); return child;
}
async function socket(path: string, child: ChildProcess): Promise<void> {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Owned server exited.");
    try { const stat = await lstat(path); if (stat.isSocket() && stat.uid === 1000) return; } catch { /* bounded wait */ }
    await delay(50);
  }
  throw new Error("Owned socket unavailable.");
}
async function pactl(args: string[]): Promise<string> {
  return (await execute("pactl", args, { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}
const sourceName = "openwhisper_owned_capture.monitor", sinkName = "openwhisper_owned_capture";
let module: string | undefined;
let alternateModule: string | undefined;
let worker: ChildProcess | undefined;
let nativeStdoutBytes = 0, nativeStderrBytes = 0;
try {
  const bus = start("dbus-daemon", ["--session", "--nofork", `--address=unix:path=${runtime}/bus`]); await socket(join(runtime, "bus"), bus);
  const pipewire = start("pipewire", []); await socket(join(runtime, "pipewire-0"), pipewire);
  start("wireplumber", []);
  const pulse = start("pipewire-pulse", []); await socket(join(runtime, "pulse/native"), pulse);
  const before = await pactl(["list", "short", "sources"]);
  const initial = before.trim().split("\n").filter(Boolean).map((row) => row.split("\t")[1]);
  assert.ok(initial.every((name) => name === "auto_null.monitor"), "Unexpected hardware source refused before capture.");
  module = (await pactl(["load-module", "module-null-sink", `sink_name=${sinkName}`, "rate=48000", "channels=1"])).trim();
  assert.match(module, /^[0-9]+$/);
  await pactl(["set-default-sink", sinkName]);
  let sources: string[] = [];
  for (let i = 0; i < 100; i++) {
    sources = (await pactl(["list", "short", "sources"])).trim().split("\n").filter(Boolean).map((row) => row.split("\t")[1] ?? "");
    assert.ok(sources.every((name) => name === sourceName || name === "auto_null.monitor"));
    if (sources.includes(sourceName)) break; await delay(50);
  }
  assert.deepEqual(sources, [sourceName]);
  await writeFile(join(output, "source-preflight.json"), JSON.stringify({ uid: process.getuid?.(), source: sourceName,
    server: "private-unix", noHostDevices: true, initial, final: sources }, null, 2), { mode: 0o600 });
  const absent = loadNativeCapture(resolve(binding)).create(1000, { mode: "pulse", source: "openwhisper_missing_source",
    server: env.PULSE_SERVER ?? "" });
  await assert.rejects(absent.start());
  const failedStart = await absent.closeAndFence();
  assert.equal(failedStart.running, false); assert.equal(failedStart.frameCount, "0");
  assert.ok(failedStart.streamClosed && failedStart.finalSamplesFenced && failedStart.failed);
  await absent.release();

  const reply = z.strictObject({ id: z.number().int(), ok: z.boolean(), code: z.string().optional(),
    meta: captureMetadataSchema.extend({ sampleCount: z.number().optional(), chunkCount: z.number().optional() }).optional(),
    durationMs: z.number().optional(), count: z.number().optional(), hash: z.string().optional(), rms: z.number().optional(),
    lastNonzero: z.number().optional(), tailEnergy: z.number().optional() });
  const pending = new Map<number, { resolve: (value: z.infer<typeof reply>) => void; reject: (error: Error) => void }>();
  worker = fork(fileURLToPath(new URL("./capture-worker.ts", import.meta.url)), [resolve(binding), sourceName, env.PULSE_SERVER ?? ""],
    { cwd: resolve(fileURLToPath(new URL("../../", import.meta.url))), env, execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "advanced" });
  worker.stdout?.on("data", (block: Buffer) => { nativeStdoutBytes += block.byteLength; });
  worker.stderr?.on("data", (block: Buffer) => { nativeStderrBytes += block.byteLength; });
  const owningWorker = worker;
  const ready = new Promise<void>((accept, reject) => {
    const timeout = setTimeout(() => reject(new Error("Capture worker not ready.")), 10000);
    owningWorker.on("message", (input: unknown) => {
      if (z.strictObject({ ready: z.literal(true) }).safeParse(input).success) { clearTimeout(timeout); accept(); return; }
      const frame = reply.parse(input), operation = pending.get(frame.id); pending.delete(frame.id);
      if (!operation) throw new Error("Unsolicited capture worker reply."); operation.resolve(frame);
    });
    owningWorker.on("exit", () => { reject(new Error("Capture worker exited.")); for (const entry of pending.values()) entry.reject(new Error("Capture worker exited.")); pending.clear(); });
  });
  let id = 0;
  async function command(command: string, generation: number, timeout = 15000) {
    const identifier = ++id;
    return await new Promise<z.infer<typeof reply>>((accept, reject) => {
      const timer = setTimeout(() => { pending.delete(identifier); reject(new Error("Owned capture operation timed out.")); }, timeout);
      pending.set(identifier, { resolve: (value) => { clearTimeout(timer); accept(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      owningWorker.send({ id: identifier, command, generation });
    });
  }
  await ready;
  const startResult = await command("start", 1); assert.equal(startResult.ok, true);
  assert.equal(startResult.meta?.running, true);
  const durationSeconds = short ? 2 : 305, rate = 48000, frameCount = durationSeconds * rate + 17;
  const audio = Buffer.alloc(frameCount * 4);
  for (let i = 0; i < frameCount; i++) audio.writeFloatLE(0.125 * Math.sin(2 * Math.PI * 440 * i / rate), i * 4);
  const publicSpeech = await readFile(fixturePath);
  assert.equal(createHash("sha256").update(publicSpeech).digest("hex"), "ebd52851100536db02d12c49fddd010372dcdc70243562e057553d476b706ae0");
  assert.equal(publicSpeech.length, 176000 * 4);
  for (let i = 0; i < Math.min(176000, Math.floor(frameCount / 3)); i++) {
    const sample = publicSpeech.readFloatLE(i * 4);
    for (let repeat = 0; repeat < 3; repeat++) audio.writeFloatLE(sample, (i * 3 + repeat) * 4);
  }
  // Public/generated signal only. A distinct final 0.7-second tone makes a lost final fragment observable.
  for (let i = frameCount - 33617; i < frameCount; i++) audio.writeFloatLE(0.375 * Math.sin(2 * Math.PI * 880 * i / rate), i * 4);
  const audioPath = join(root, "generated-finite.f32"); await writeFile(audioPath, audio, { mode: 0o600 });
  const begun = performance.now();
  const playback = execute("paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sinkName}`, audioPath],
    { env, timeout: 360000, maxBuffer: 1024 });
  // Finite playback drives the actual source for >300s; no capture-side duration cutoff exists.
  await playback;
  await delay(100);
  const stopped = await command("stop", 1), elapsedMs = performance.now() - begun;
  await writeFile(join(output, "01-stop.json"), JSON.stringify({ stopped, elapsedMs, durationSeconds }), { mode: 0o600 });
  assert.equal(stopped.ok, true); assert.ok(stopped.meta?.streamClosed && stopped.meta.finalSamplesFenced);
  assert.equal(stopped.meta.failed, false); assert.ok(short || elapsedMs > 300000);
  assert.ok(short || Number(stopped.meta.frameCount) >= generatedFramesMinimum(stopped.meta.sampleRate), "No 300-second capture truncation.");
  const late = await command("status", 1); assert.equal(late.meta?.frameCount, stopped.meta.frameCount);
  const prepared = await command("prepare", 1, 60000); assert.equal(prepared.ok, true);
  await writeFile(join(output, "02-prepared.json"), JSON.stringify({ prepared, unchanged: late.meta?.frameCount === stopped.meta.frameCount }), { mode: 0o600 });
  assert.equal(prepared.count, Math.floor(Number(stopped.meta.frameCount) * 16000 / stopped.meta.sampleRate));
  assert.ok((prepared.rms ?? 0) > 0.05); assert.ok((prepared.tailEnergy ?? 0) > 100);
  assert.ok((prepared.lastNonzero ?? 0) > (prepared.count ?? 0) - 16000);
  assert.ok((stopped.durationMs ?? Infinity) < 2000, "Stop fencing precedes duration-heavy preparation.");
  await command("release", 1);

  if (restartProbe) {
    const cycles = [];
    for (let generation = 10; generation < 40; generation++) {
      const started = await command("start", generation);
      await delay(150);
      const stopped = await command("stop", generation);
      await command("release", generation);
      cycles.push({ started, stopped });
      await writeFile(join(output, "02-restart-probe.json"), JSON.stringify({ cycles }), { mode: 0o600 });
    }
    assert.ok(cycles.every((cycle) => cycle.started.ok && !cycle.stopped.meta?.failed), "Quiet-source fresh sessions must restart cleanly.");
  }

  // Actual owned source removal/recreation: no host service/device is touched.
  const faultAudio = Buffer.alloc(48000 * 4);
  for (let i = 0; i < 48000; i++) faultAudio.writeFloatLE(0.25 * Math.sin(2 * Math.PI * 440 * i / 48000), i * 4);
  const faultPath = join(root, "fault-tone.f32"); await writeFile(faultPath, faultAudio, { mode: 0o600 });
  const nextStart = await command("start", 2);
  await writeFile(join(output, "02-next-start.json"), JSON.stringify({ nextStart }), { mode: 0o600 });
  assert.equal(nextStart.ok, true);
  const removalPlayer = start("paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sinkName}`, faultPath]);
  await delay(350);
  alternateModule = (await pactl(["load-module", "module-null-sink", "sink_name=openwhisper_owned_other", "rate=48000", "channels=1"])).trim();
  const sourceOutputs = (await pactl(["list", "short", "source-outputs"])).trim().split("\n").filter(Boolean);
  assert.equal(sourceOutputs.length, 1);
  const sourceOutput = sourceOutputs[0]?.split("\t")[0]; assert.ok(sourceOutput && /^[0-9]+$/.test(sourceOutput));
  let moveRejected = false;
  try { await pactl(["move-source-output", sourceOutput, "openwhisper_owned_other.monitor"]); }
  catch { moveRejected = true; }
  await delay(150);
  const afterMove = await command("status", 2);
  if (!moveRejected) {
    assert.equal(afterMove.meta?.failed, true);
    await delay(150); assert.equal((await command("status", 2)).meta?.frameCount, afterMove.meta?.frameCount,
      "A changed source cannot append audio to the original recording.");
  }
  await writeFile(join(output, "03-source-identity.json"), JSON.stringify({ moveRejected, afterMove }), { mode: 0o600 });
  await pactl(["unload-module", module]); module = undefined;
  removalPlayer.kill("SIGTERM");
  const removed = await command("stop", 2); assert.equal(removed.ok, true);
  await writeFile(join(output, "03-source-removal.json"), JSON.stringify({ removed }), { mode: 0o600 });
  await pactl(["unload-module", alternateModule]); alternateModule = undefined;
  assert.equal(removed.meta?.streamClosed, true); assert.equal(removed.meta?.failed, true);
  const salvage = await command("prepare", 2); assert.equal(salvage.ok, true); assert.ok((salvage.rms ?? 0) > 0.05);
  await command("release", 2);
  await writeFile(join(output, "04-partial-retained.json"), JSON.stringify({ salvage }), { mode: 0o600 });
  module = (await pactl(["load-module", "module-null-sink", `sink_name=${sinkName}`, "rate=48000", "channels=1"])).trim();
  await delay(200); assert.equal((await command("start", 3)).ok, true); await delay(100);
  assert.equal((await command("stop", 3)).ok, true); await command("release", 3);
  assert.equal((await command("start", 4)).ok, true);
  const daemonPlayer = start("paplay", ["--raw", "--format=float32le", "--rate=48000", "--channels=1", `--device=${sinkName}`, faultPath]);
  await delay(350);
  pulse.kill("SIGTERM"); await delay(300);
  daemonPlayer.kill("SIGTERM");
  const daemonLoss = await command("stop", 4); assert.equal(daemonLoss.ok, true);
  await writeFile(join(output, "05-daemon-loss.json"), JSON.stringify({ daemonLoss }), { mode: 0o600 });
  assert.ok(daemonLoss.meta?.streamClosed && daemonLoss.meta.finalSamplesFenced && daemonLoss.meta.failed);
  const daemonSalvage = await command("prepare", 4); assert.equal(daemonSalvage.ok, true); assert.ok((daemonSalvage.rms ?? 0) > 0.05);
  await command("release", 4);
  assert.equal(nativeStdoutBytes, 0); assert.equal(nativeStderrBytes, 0);
  await writeFile(join(output, "virtual-result.json"), JSON.stringify({ status: short ? "SHORT_PASS" : "PASS", sourceScope: "owned-pipewire-pulse-only",
    elapsedMs, publicSpeechSha256: createHash("sha256").update(publicSpeech).digest("hex"),
    generatedInputFrames: frameCount, generatedInputSha256: createHash("sha256").update(audio).digest("hex"),
    stop: stopped, prepared, unchangedAfterFence: late.meta?.frameCount === stopped.meta.frameCount,
    failedStartRollback: failedStart, sourceIdentity: { moveRejected, afterMove },
    sourceRemoval: removed, salvaged: salvage, restart: true, daemonLoss, daemonSalvage,
    nativeDiagnostics: { stdoutBytes: nativeStdoutBytes, stderrBytes: nativeStderrBytes } }, null, 2), { mode: 0o600 });
} finally {
  if (worker?.connected) worker.disconnect();
  if (module) { try { await pactl(["unload-module", module]); } catch { /* owned teardown only */ } }
  if (alternateModule) { try { await pactl(["unload-module", alternateModule]); } catch { /* owned teardown only */ } }
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

function generatedFramesMinimum(sampleRate: number): number { return 300 * sampleRate; }
