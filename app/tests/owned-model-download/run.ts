import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readReviewedBundle, reviewedBundleSchema, type ReviewedBundle } from "./reviewed-bundle.js";
import { cleanupOwnedNamespace, type CleanupReceipt } from "./cleanup.js";
import { BOUNDS, HOME, IMAGE, REVIEW_TOKEN, FixtureError, bounded, validateSuite } from "./contracts.js";

const packageRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const observationSchema = z.object({ Id: z.string().regex(/^[a-f0-9]{64}$/u), Image: z.literal(IMAGE),
  Config: z.object({ User: z.literal("1000:1000") }), Mounts: z.array(z.unknown()).length(0),
  State: z.object({ Running: z.literal(false) }),
  HostConfig: z.object({ NetworkMode: z.literal("none"), Privileged: z.literal(false), CapAdd: z.array(z.string()).nullable(),
    CapDrop: z.array(z.string()), Devices: z.array(z.unknown()).nullable(), DeviceRequests: z.array(z.unknown()).nullable(),
    Binds: z.array(z.unknown()).nullable(), SecurityOpt: z.array(z.string()), PidMode: z.literal(""), IpcMode: z.literal("private"),
    Memory: z.literal(1_073_741_824), NanoCpus: z.literal(2_000_000_000), PidsLimit: z.literal(128),
    Ulimits: z.array(z.strictObject({ Name: z.literal("core"), Soft: z.literal(0), Hard: z.literal(0) })).length(1) }) });
export function validateContainer(input: unknown): z.infer<typeof observationSchema> {
  const value = observationSchema.parse(input), host = value.HostConfig;
  assert.equal(host.CapAdd?.length ?? 0, 0); assert.equal(host.Devices?.length ?? 0, 0);
  assert.equal(host.DeviceRequests?.length ?? 0, 0); assert.equal(host.Binds?.length ?? 0, 0);
  assert.deepEqual(host.CapDrop.map((item) => item.toUpperCase()), ["ALL"]);
  assert.equal(host.SecurityOpt.length, 1);
  assert.ok(host.SecurityOpt[0] === "no-new-privileges" || host.SecurityOpt[0] === "no-new-privileges:true");
  return value;
}
/** Reads only immutable inspection records in inert tests. */
export const constructedEnvironment = Object.freeze({ HOME, TMPDIR: join(HOME, "tmp"), XDG_CONFIG_HOME: join(HOME, "config"),
  XDG_DATA_HOME: join(HOME, "data"), XDG_CACHE_HOME: join(HOME, "cache"), PATH: "/opt/node/bin:/usr/bin:/bin", LANG: "C.UTF-8",
  OPENWHISPER_OWNED_MODEL_TLS_TEST: "1" });

interface Command { readonly operation: "image" | "create" | "inspect" | "copy-input" | "start" | "execute" | "copy-evidence" | "remove" | "absence";
  readonly exitCode: number; readonly milliseconds: number; readonly stdoutBytes: number; readonly stderrBytes: number;
  readonly closeObserved: boolean }
interface CLIReceipt { readonly child: ChildProcessWithoutNullStreams; readonly completion: Promise<number>; closeObserved: boolean }
/** Only this explicit reviewed entry may create a namespace. Importing the
 * builder/contracts/launcher has no socket, Docker or certificate effects. */
export async function runOwnedTLS(reviewToken: string, reviewedBundle: ReviewedBundle): Promise<string> {
  if (reviewToken !== REVIEW_TOKEN || process.env.OPENWHISPER_RUN_REVIEWED_OWNED_MODEL_TLS !== "1" ||
    process.platform !== "linux" || process.arch !== "x64" || process.getuid?.() !== 1000) throw new FixtureError();
  const deadline = performance.now() + BOUNDS.outerMs;
  const selected = reviewedBundleSchema.parse(reviewedBundle);
  const frozen = await bounded(readReviewedBundle(selected), 10_000);
  const id = randomUUID(), container = `openwhisper-owned-model-tls-${id}`;
  const parent = join(packageRoot, ".local/owned-model-tls"), output = join(parent, id);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStats = await lstat(parent);
  assert.ok(parentStats.isDirectory() && !parentStats.isSymbolicLink()); assert.equal(parentStats.uid, process.getuid());
  assert.equal(parentStats.mode & 0o7777, 0o700); await mkdir(output, { mode: 0o700 });
  const commands: Command[] = [], receipts: CLIReceipt[] = []; let active: CLIReceipt | undefined;
  let attemptedCreate = false, createdConfirmed = false, removed = false, executed = false, status = "FAIL";
  let cleanupReceipt: CleanupReceipt | undefined;
  const sourceInputSha256 = createHash("sha256").update(frozen["input.json"]).digest("hex");
  const command = async (operation: Command["operation"], args: string[], milliseconds: number = BOUNDS.dockerMs,
    cleanup = false): Promise<{ code: number; output: string }> => {
    if (active && !cleanup) throw new FixtureError();
    const started = performance.now();
    // Docker receives only its local CLI environment, never inherited
    // DOCKER_HOST/CONTEXT/CONFIG or credential/proxy overrides.
    const child = spawn("/usr/bin/docker", args, { shell: false, stdio: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: output, LANG: "C.UTF-8" } });
    child.stdin.end(); let stdoutBytes = 0, stderrBytes = 0, value = "", overflow = false;
    child.stdout.on("data", (bytes: Buffer) => { stdoutBytes += bytes.length;
      if (stdoutBytes > 1024 * 1024) { overflow = true; child.kill("SIGKILL"); } else value += bytes.toString("utf8"); });
    child.stderr.on("data", (bytes: Buffer) => { stderrBytes += bytes.length;
      if (stderrBytes > 1024 * 1024) { overflow = true; child.kill("SIGKILL"); } });
    let failed = false;
    const completion = new Promise<number>((yes) => {
      child.once("error", () => { failed = true; });
      child.once("close", (code) => {
        receipt.closeObserved = true; if (active === receipt) active = undefined; yes(failed ? 1 : code ?? 1);
      });
    });
    const receipt: CLIReceipt = { child, completion, closeObserved: false }; receipts.push(receipt); if (!cleanup) active = receipt;
    let code = 1;
    try { code = await bounded(completion, milliseconds); }
    catch { child.kill("SIGKILL"); await bounded(completion, 500).catch(() => {}); throw new FixtureError(); }
    finally { commands.push({ operation, exitCode: code, milliseconds: performance.now() - started, stdoutBytes, stderrBytes,
      closeObserved: receipt.closeObserved }); }
    if (overflow) throw new FixtureError(); return { code, output: value };
  };
  const required = async (operation: Command["operation"], args: string[]): Promise<string> => {
    const value = await command(operation, args); if (value.code !== 0) throw new FixtureError(); return value.output;
  };
  const work = (async () => {
    try {
      await mkdir(join(output, "payload"), { mode: 0o700 });
      for (const [name, bytes] of Object.entries(frozen)) await writeFile(join(output, "payload", name), bytes, { mode: 0o600, flag: "wx" });
      const image = z.array(z.object({ Id: z.literal(IMAGE) })).length(1).parse(JSON.parse(await required("image", ["image", "inspect", IMAGE])));
      assert.equal(image[0]?.Id, IMAGE);
      attemptedCreate = true;
      const created = (await required("create", ["create", "--name", container, "--network", "none", "--user", "1000:1000",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "1g", "--cpus", "2",
        "--ulimit", "core=0:0", "--entrypoint", "/bin/sleep", IMAGE, "300"])).trim();
      assert.match(created, /^[a-f0-9]{64}$/u);
      createdConfirmed = true;
      const records = z.array(z.unknown()).length(1).parse(JSON.parse(await required("inspect", ["inspect", container])));
      const observed = validateContainer(records[0]); assert.equal(observed.Id, created);
      await writeFile(join(output, "container-observation.json"), JSON.stringify(observed, null, 2), { mode: 0o600 });
      await required("copy-input", ["cp", "--archive", join(output, "payload") + "/.", `${container}:/payload`]);
      // --archive preserves the launcher's required UID1000 on private files.
      // The payload is public source and synthetic data, never a host mount.
      await required("start", ["start", container]);
      executed = true;
      const execution = await command("execute", ["exec", "--user", "1000:1000", container, "/usr/bin/env", "-i",
        ...Object.entries(constructedEnvironment).map(([name, value]) => `${name}=${value}`), "/opt/node/bin/node", "/payload/fixture.mjs"], BOUNDS.executeMs);
      if (execution.code !== 0) throw new FixtureError();
    } finally {
      // The original command's exact completion remains in receipts even if
      // it ignores a kill. Separately supervised cleanup must still run.
      for (const receipt of receipts) if (!receipt.closeObserved) receipt.child.kill("SIGKILL");
      if (attemptedCreate) {
        // These actions address only the unguessable name selected before the
        // owned create call. No labels, broad selectors or user containers.
        cleanupReceipt = await bounded(cleanupOwnedNamespace({
          creationConfirmed: createdConfirmed,
          capture: async () => { assert.equal((await command("copy-evidence", ["cp", `${container}:/evidence`, join(output, "evidence")], 5500, true)).code, 0); },
          remove: async () => { assert.equal((await command("remove", ["rm", "--force", container], 5500, true)).code, 0); },
          absence: async () => { const value = await command("absence", ["ps", "--all", "--quiet", "--filter", `name=^/${container}$`], 5500, true);
            assert.equal(value.code, 0); assert.equal(value.output.trim(), ""); },
          originalsClosed: async () => { await bounded(Promise.all(receipts.map((receipt) => receipt.completion)), 1000);
            assert.ok(receipts.every((receipt) => receipt.closeObserved)); },
        }), 20_000);
        removed = createdConfirmed && cleanupReceipt.namespaceCleanupConfirmed;
        if (!removed || !cleanupReceipt.evidenceCaptured) throw new FixtureError();
      } else {
        await bounded(Promise.all(receipts.map((receipt) => receipt.completion)), 1000);
      }
    }
    const bytes = await readFile(join(output, "evidence/result.json")); assert.ok(bytes.length < 256 * 1024);
    validateSuite(JSON.parse(bytes.toString("utf8")));
    status = "PASS";
    return output;
  })();
  try { return await bounded(work, Math.max(1, deadline - performance.now())); }
  finally {
    await writeFile(join(output, "launcher.json"), JSON.stringify({ status, containerRemovedAndAbsent: removed,
      image: IMAGE, bounds: BOUNDS, commands, fixtureExecutionAttempted: executed, noProviderDownload: true,
      sourceInputSha256, reviewedInputSha256: selected.inputSha256, cleanupReceipt: cleanupReceipt ?? null,
      originalCLIClosuresObserved: receipts.every((receipt) => receipt.closeObserved), createdConfirmed }, null, 2), { mode: 0o600 });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--reviewed" || !args[1] || args[2] !== "--bundle" || !args[3] ||
    args[4] !== "--input-sha256" || !args[5]) throw new FixtureError();
  await runOwnedTLS(args[1], { directory: args[3], inputSha256: args[5] });
}
