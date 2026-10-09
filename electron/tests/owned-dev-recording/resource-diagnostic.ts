import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";
import { parseSessionBusAddress } from "../../src/platforms/linux/shared/bus.js";
import { developmentRecordingDescriptorSchema } from "../../src/main/development-recording-descriptor.js";
import { verifyDevelopmentLinuxBusArtifact } from "../../src/services/development-artifact.js";

type Role = "driver" | "server" | "supervisor" | "gui" | "cli" | "renderer" | "gpu" | "utility" | "zygote" | "owned-child";
type Identity = Readonly<{ pid: number; start: string }>;
export type DiagnosticRoot = Identity & Readonly<{ role: Role }>;
const identities = new Map<string, Identity>();
async function processStat(pid: number) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8"), tail = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/u);
  const ppid = Number(tail[1]), threads = Number(tail[17]), start = tail[19];
  assert.ok(Number.isInteger(ppid) && Number.isInteger(threads) && threads > 0 && start && /^[0-9]+$/u.test(start));
  return { pid, ppid, threads, start };
}
export async function diagnosticIdentity(pid: number, role: Role): Promise<DiagnosticRoot> {
  return { pid, start: (await processStat(pid)).start, role };
}
/** Namespace-only metadata: no argv, environment, paths, names or user content are emitted. */
export async function resourceSnapshot(roots: readonly DiagnosticRoot[]) {
  assert.equal(process.getuid?.(), 1000); assert.ok(roots.length <= 64);
  const cgroup: Record<string, string> = {};
  for (const field of ["pids.current", "pids.max", "pids.peak", "pids.events", "memory.events"]) cgroup[field] = (await readFile(`/sys/fs/cgroup/${field}`, "utf8")).slice(0, 1024);
  assert.equal(cgroup["pids.max"]?.trim(), "256");
  const names = (await readdir("/proc")).filter((name) => /^[1-9][0-9]*$/u.test(name)); assert.ok(names.length <= 256);
  const candidates: Awaited<ReturnType<typeof processStat>>[] = [];
  for (const name of names) {
    try { const pid = Number(name), value = await processStat(pid), status = await readFile(`/proc/${pid}/status`, "utf8");
      if (/^Uid:\s+1000\s+1000\s+1000\s+1000\s*$/mu.test(status)) candidates.push(value);
    } catch { /* A concurrently retired original process is not a new owner. */ }
  }
  const admitted = new Set<number>();
  for (const root of roots) if (candidates.some((value) => value.pid === root.pid && value.start === root.start)) admitted.add(root.pid);
  for (const identity of identities.values()) if (candidates.some((value) => value.pid === identity.pid && value.start === identity.start)) admitted.add(identity.pid);
  for (let depth = 0; depth < 32; depth++) for (const value of candidates) if (admitted.has(value.ppid)) admitted.add(value.pid);
  let remaining = 256;
  const processes = [];
  for (const value of candidates.filter((value) => admitted.has(value.pid)).sort((a, b) => a.pid - b.pid)) {
    let role: Role = roots.find((root) => root.pid === value.pid && root.start === value.start)?.role ?? "owned-child";
    const states: Record<string, number> = {}; let sampled = 0, changed = false;
    try {
      // Inspect only an already admitted same-user owner's fixed Chromium type.
      const command = await readFile(`/proc/${value.pid}/cmdline`); assert.ok(command.length <= 16 * 1024);
      const type = /(?:^|\0)--type=(renderer|gpu-process|utility|zygote)(?:\0|$)/u.exec(command.toString());
      if (type) role = type[1] === "gpu-process" ? "gpu" : type[1] as "renderer" | "utility" | "zygote";
      const tasks = (await readdir(`/proc/${value.pid}/task`)).filter((name) => /^[1-9][0-9]*$/u.test(name)); assert.ok(tasks.length <= 256);
      for (const task of tasks.slice(0, remaining)) {
        try { const status = await readFile(`/proc/${value.pid}/task/${task}/status`, "utf8");
          const state = /^State:\s+([RSDZTtXxKWPI])\b/mu.exec(status)?.[1] ?? "UNKNOWN"; states[state] = (states[state] ?? 0) + 1; sampled++; } catch { changed = true; }
      }
      remaining -= sampled; changed ||= (await processStat(value.pid)).start !== value.start;
    } catch { changed = true; }
    const key = `${value.pid}:${value.start}`; identities.set(key, { pid: value.pid, start: value.start });
    processes.push({ ...value, role, sampled, states, changed, threadsTruncated: sampled < value.threads });
  }
  assert.ok(identities.size <= 256);
  const present = new Set(processes.map((value) => `${value.pid}:${value.start}`));
  return { cgroup, processes, departed: [...identities].filter(([key]) => !present.has(key)).map(([, value]) => value),
    sampledThreads: 256 - remaining, scope: "OWNED_NAMESPACE_ORIGINAL_IDENTITIES_ONLY" };
}

if (process.argv[2] === "--native-open-probe") {
  assert.equal(process.argv.length, 3); assert.equal(process.getuid?.(), 1000); assert.equal(process.platform, "linux");
  assert.ok((await lstat("/.dockerenv")).isFile()); assert.equal(process.versions.electron, "44.7.0"); assert.equal(process.versions.node, "24.21.0");
  assert.equal(process.env.OPENWHISPER_RESOURCE_DIAGNOSTIC, "1");
  const app = "/opt/openwhisper/resources/app", descriptorBytes = await readFile(join(app, "dist/main/development-recording-build.js"));
  const module: unknown = await import(join(app, "dist/main/development-recording-build.js"));
  assert.ok(typeof module === "object" && module !== null);
  const descriptor = developmentRecordingDescriptorSchema.parse(Reflect.get(module, "DEVELOPMENT_RECORDING_BUILD"));
  assert.ok(descriptor.platform === "linux" && descriptor.platformServices);
  const artifact = descriptor.platformServices.bus, path = await verifyDevelopmentLinuxBusArtifact(app, artifact);
  const binding: unknown = createRequire(import.meta.url)(path); assert.ok(typeof binding === "object" && binding !== null);
  const begin: unknown = Reflect.get(binding, "beginOpen"), close: unknown = Reflect.get(binding, "close");
  assert.ok(typeof begin === "function" && typeof close === "function");
  const category = z.enum(["CONNECT_FAILED", "CANCELLED", "TIMEOUT", "CLOSED", "INVALID_FRAME", "TEARDOWN_FAILED"]);
  let phase = "begin", outcome = "UNKNOWN", token: string | undefined, ready: Promise<unknown> | undefined, closeObserved = false;
  const deadline = process.hrtime.bigint() / 1000n + 5_000_000n;
  try {
    const raw: unknown = Reflect.apply(begin, binding, [parseSessionBusAddress(process.env.DBUS_SESSION_BUS_ADDRESS), String(deadline), () => {}]);
    if (typeof raw === "object" && raw !== null) {
      const owned = z.uuid().safeParse(Reflect.get(raw, "connection")), pending: unknown = Reflect.get(raw, "ready");
      if (owned.success) token = owned.data; if (pending instanceof Promise) { ready = pending; void ready.catch(() => {}); }
    }
    const opened = z.strictObject({ connection: z.uuid(), ready: z.instanceof(Promise) }).parse(raw); token = opened.connection; ready = opened.ready;
    phase = "ready"; const value: unknown = await ready;
    const identity = z.strictObject({ connection: z.uuid(), uniqueName: z.string().regex(/^:[0-9]+\.[0-9]+$/u) }).parse(value);
    assert.equal(identity.connection, token); assert.ok(process.hrtime.bigint() / 1000n < deadline); outcome = "OPENED";
  } catch (error: unknown) { const code = typeof error === "object" && error !== null ? category.safeParse(Reflect.get(error, "code")) : undefined;
    outcome = code?.success ? code.data : "UNKNOWN";
  } finally {
    if (token) { try { const closing = Promise.resolve(Reflect.apply(close, binding, [token])); void closing.catch(() => {});
      await Promise.allSettled([ready]); await closing; closeObserved = true; }
      catch { outcome = "TEARDOWN_FAILED"; process.exitCode = 1; } }
    await writeFile("/evidence/native-open-sidecar.json", JSON.stringify({ phase, outcome, closeObserved,
      descriptorSha256: createHash("sha256").update(descriptorBytes).digest("hex"), nativeSha256: artifact.sha256,
      scope: "SEPARATE_POST_CLI_NATIVE_OPEN_PROBE_NOT_ORIGINAL_CLI_CATEGORY", pid: process.pid, versions: { node: process.versions.node, electron: process.versions.electron } }), { mode: 0o600, flag: "wx" });
  }
}
