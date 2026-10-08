import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MetadataDecoder, type MessageMetadata } from "./message-metadata.js";
import { OwnedServices } from "./owned-services.js";

const enabled = process.env.OPENWHISPER_OWNED_AMBIENT_TEST === "1";
interface TimedMetadata extends MessageMetadata { readonly milliseconds: number; readonly observedAtUs: string }
interface BusMonitor {
  readonly name: string;
  readonly address: string;
  readonly config: string;
  readonly daemon: ChildProcess;
  readonly monitor: ChildProcess;
  readonly events: TimedMetadata[];
  readonly check: () => void;
  readonly finish: () => void;
  readonly diagnostics: () => { daemon: string; monitor: string };
}

async function absent(path: string): Promise<boolean> {
  try { await access(path); return false; }
  catch (error: unknown) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true; throw error; }
}
async function waitFor(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Owned diagnostic readiness expired.");
    await new Promise<void>((accept) => { setTimeout(accept, 5); });
  }
}
async function reap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((accept) => { child.once("close", () => { accept(); }); });
  child.kill("SIGTERM"); const force = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("Owned process cleanup was not confirmed.")); }, 5000); });
  try { await Promise.race([exit, bound]); } finally { clearTimeout(force); if (timer) clearTimeout(timer); }
}
async function seed(address: string, env: Record<string, string>): Promise<void> {
  const child = spawn("/usr/bin/dbus-send", [`--bus=${address}`, "--dest=org.freedesktop.DBus", "--type=method_call", "--print-reply",
    "/org/freedesktop/DBus", "org.freedesktop.DBus.GetId"], { env, stdio: ["ignore", "ignore", "ignore"] });
  let force: NodeJS.Timeout | undefined, expired = false;
  const timer = setTimeout(() => { expired = true; child.kill("SIGTERM"); force = setTimeout(() => { child.kill("SIGKILL"); }, 500); }, 2000);
  try {
    const code = await new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
    assert.equal(expired, false); assert.equal(code, 0);
  } finally { clearTimeout(timer); if (force) clearTimeout(force); await reap(child); }
}

for (const profile of ["empty-owner", "login-owner", "desktop-owners"] as const) {
test(`owned early Electron ambient metadata with ${profile}`, { skip: !enabled, timeout: 30_000 }, async () => {
  assert.equal(process.getuid?.(), 1000); assert.equal(await absent("/.dockerenv"), false);
  assert.equal(process.env.OPENWHISPER_AMBIENT_EVIDENCE, "/evidence");
  for (const device of ["/dev/snd", "/dev/input", "/dev/uinput", "/dev/dri"]) assert.equal(await absent(device), true);
  const root = await mkdtemp("/tmp/openwhisper-owned-ambient-"); await chmod(root, 0o700);
  for (const directory of ["home", "runtime", "config", "data", "cache", "empty-services"]) await mkdir(join(root, directory), { mode: 0o700 });
  const env: Record<string, string> = { PATH: "/opt/node/bin:/usr/bin:/bin", HOME: join(root, "home"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    XDG_RUNTIME_DIR: join(root, "runtime"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
    PULSE_SERVER: `unix:${root}/disabled-pulse`, PIPEWIRE_RUNTIME_DIR: join(root, "runtime"), PIPEWIRE_REMOTE: "disabled-pipewire",
    OPENWHISPER_OWNED_AMBIENT_TEST: "1" };
  const buses: BusMonitor[] = [], children: ChildProcess[] = [], epoch = performance.now();
  const services: OwnedServices[] = [];
  let runtimeChild: ChildProcess | undefined;
  try {
    for (const name of ["system", "session", "explicit-native"]) {
      const socket = join(root, "runtime", `${name}-bus`), configPath = join(root, `${name}.conf`);
      const ownedNames = name === "system" ? '<allow own="org.freedesktop.login1"/>' : name === "session"
        ? '<allow own="org.freedesktop.systemd1"/><allow own="org.freedesktop.portal.Desktop"/>' : "";
      const config = `<busconfig><type>${name === "system" ? "system" : "session"}</type><listen>unix:path=${socket}</listen><auth>EXTERNAL</auth><servicedir>${root}/empty-services</servicedir><policy context="default"><allow user="1000"/><allow send_destination="*"/><allow receive_sender="*"/>${ownedNames}</policy></busconfig>`;
      await writeFile(configPath, config, { mode: 0o600 });
      const daemon = spawn("/usr/bin/dbus-daemon", [`--config-file=${configPath}`, "--nofork", "--print-address=1"], { env, stdio: ["ignore", "pipe", "pipe"] });
      children.push(daemon);
      let daemonOutput = "", daemonError = "", daemonOverflow = false;
      daemon.stdout?.on("data", (chunk: Buffer) => {
        if (daemonOverflow) return;
        const text = chunk.toString();
        if (daemonOutput.length + text.length > 8192) { daemonOverflow = true; daemon.kill("SIGTERM"); return; }
        daemonOutput += text;
      });
      daemon.stderr?.on("data", (chunk: Buffer) => { daemonError += chunk.toString(); if (daemonError.length > 8192) daemon.kill("SIGTERM"); });
      await waitFor(() => daemonOutput.includes("\n") || daemonOverflow || daemon.exitCode !== null);
      if (daemonOverflow) throw new Error("Owned bus stdout exceeded its bound.");
      const address = daemonOutput.trim(); assert.ok(address.startsWith(`unix:path=${socket},guid=`)); assert.match(address.split("guid=")[1] ?? "", /^[a-f0-9]{32}$/);
      const monitor = spawn("/usr/bin/dbus-monitor", ["--binary", "--address", address], { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(monitor);
      const decoder = new MetadataDecoder(), events: TimedMetadata[] = [];
      let monitorFailure: unknown, monitorError = "";
      monitor.stdout?.on("data", (chunk: Buffer) => {
        try { for (const event of decoder.push(chunk)) events.push({ ...event, milliseconds: performance.now() - epoch, observedAtUs: (process.hrtime.bigint() / 1000n).toString() }); }
        catch (error: unknown) { monitorFailure = error; monitor.kill("SIGTERM"); }
      });
      monitor.stderr?.on("data", (chunk: Buffer) => { monitorError += chunk.toString(); if (monitorError.length > 8192) monitor.kill("SIGTERM"); });
      // Prove the monitor receives messages before starting Electron; body bytes are never retained.
      await new Promise<void>((accept) => { setTimeout(accept, 30); });
      await seed(address, env);
      await waitFor(() => events.some((event) => event.member === "GetId") || monitorFailure !== undefined || monitor.exitCode !== null);
      const check = (): void => {
        if (monitorFailure) throw monitorFailure;
        if (daemonOverflow) throw new Error("Owned bus stdout exceeded its bound.");
        assert.equal(monitor.exitCode, null); assert.equal(daemon.exitCode, null);
        assert.equal(monitorError, "");
        assert.match(daemonError, /^dbus-daemon\[\d+\]: \[(system|session uid=1000 pid=\d+)\] Connection :\d+\.\d+ \(uid=1000 pid=\d+ comm="\/usr\/bin\/dbus-monitor --binary --address unix:path"\) became a monitor\.\n$/);
      };
      check(); buses.push({ name, address, config, daemon, monitor, events, check, finish: () => { decoder.finish(); },
        diagnostics: () => ({ daemon: daemonError, monitor: monitorError }) });
    }
    const system = buses.find((bus) => bus.name === "system"), session = buses.find((bus) => bus.name === "session"), explicit = buses.find((bus) => bus.name === "explicit-native");
    assert.ok(system && session && explicit);
    env.DBUS_SYSTEM_BUS_ADDRESS = system.address; env.DBUS_SESSION_BUS_ADDRESS = session.address;
    env.OPENWHISPER_OWNED_ASYNC_BUS_ADDRESS = explicit.address;
    if (profile !== "empty-owner") services.push(await OwnedServices.open(system.address, ["org.freedesktop.login1"]));
    if (profile === "desktop-owners") services.push(await OwnedServices.open(session.address, ["org.freedesktop.systemd1", "org.freedesktop.portal.Desktop"]));
    for (const service of services) service.check();
    const executable = "/owned-app/node_modules/electron/dist/electron", bytes = await readFile(executable);
    const executableSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(executableSha256, "10a14d05c6ff4f94075cfb3eeb6ed6571be33ebcc08cbd675b5ce9ff84706564");
    const fuseMarker = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), fuseOffset = bytes.indexOf(fuseMarker);
    assert.ok(fuseOffset >= 0); assert.equal(bytes.indexOf(fuseMarker, fuseOffset + 1), -1);
    const fuseStart = fuseOffset + fuseMarker.length;
    assert.equal(bytes[fuseStart], 1); assert.equal(bytes[fuseStart + 1], 9);
    const fuses = [...bytes.subarray(fuseStart + 2, fuseStart + 11)]; assert.deepEqual(fuses, [49, 48, 49, 49, 48, 48, 48, 49, 49]);
    const firstIndices = buses.map((bus) => bus.events.length), started = performance.now(), runtimeSpawnAtUs = (process.hrtime.bigint() / 1000n).toString();
    const argv = ["/owned-app/tests/owned-ambient/dwell-package"];
    runtimeChild = spawn(executable, argv, { env, stdio: ["ignore", "pipe", "pipe"] }); children.push(runtimeChild);
    const owner = runtimeChild; let stdout = "", stderr = "", expired = false, force: NodeJS.Timeout | undefined;
    owner.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16384) owner.kill("SIGTERM"); });
    owner.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 16384) owner.kill("SIGTERM"); });
    const timer = setTimeout(() => { expired = true; owner.kill("SIGTERM"); force = setTimeout(() => { owner.kill("SIGKILL"); }, 1000); }, 8000);
    const exit = await new Promise<{ code: number | null; signal: string | null }>((accept, reject) => {
      owner.once("error", reject); owner.once("close", (code, signal) => { accept({ code, signal }); });
    }).finally(() => { clearTimeout(timer); if (force) clearTimeout(force); });
    const seconds = (performance.now() - started) / 1000, runtimeExitAtUs = (process.hrtime.bigint() / 1000n).toString();
    // A daemon request/reply fence after runtime exit lets monitor stdout drain before snapshotting.
    for (const bus of buses) {
      const prior = bus.events.filter((event) => event.member === "GetId").length;
      await seed(bus.address, env); await waitFor(() => bus.events.filter((event) => event.member === "GetId").length > prior); bus.check();
    }
    const reports = buses.map((bus, index) => {
      const events = bus.events.slice(firstIndices[index]);
      return { name: bus.name, config: bus.config, diagnostics: bus.diagnostics(), events, startServiceByName: events.filter((event) => event.type === 1 && event.member === "StartServiceByName"),
        activationCapableNonDaemon: events.filter((event) => event.type === 1 && event.destination !== "org.freedesktop.DBus" && (event.flags & 2) === 0) };
    });
    for (const service of services) service.check();
    await writeFile(`/evidence/ambient-${profile}.json`, JSON.stringify({ profile, ...exit, expired, seconds, runtimeSpawnAtUs, runtimeExitAtUs, stdout, stderr, executableSha256, argv, fuses, reports,
      owners: services.flatMap((service) => service.owners), fixedOwnerCalls: services.flatMap((service) => service.calls),
      environment: { display: false, waylandDisplay: false, runtimeOverrides: false }, bodiesRetained: false,
      scope: "Early ESM 1.4-second dwell/native GetId with private empty-activation buses and fixed synthetic owners; no production CLI/no-ambient guarantee." }, null, 2), { mode: 0o600 });
    assert.equal(expired, false); assert.equal(exit.signal, null); assert.equal(exit.code, 0);
    // Write categorical findings first; activation/provider changes must then fail this exact-profile gate.
    for (const report of reports) {
      assert.deepEqual(report.startServiceByName, [], "Unexpected ambient service-start request.");
      assert.deepEqual(report.activationCapableNonDaemon, [], "Unexpected activation-capable non-daemon request.");
    }
    assert.equal(services.flatMap((service) => service.calls).length, 0, "Unexpected early provider call in this exact profile.");
    const response = z.object({ result: z.literal("PASS"), readyBefore: z.literal(false), readyAfter: z.literal(false), ready: z.array(z.literal(false)).length(3),
      milestones: z.array(z.strictObject({ stage: z.enum(["entry", "before-native", "native-closed", "dwell-complete"]), monotonicUs: z.string().regex(/^[1-9][0-9]{0,19}$/), ready: z.literal(false) })).length(4),
      seconds: z.number().min(1.4).max(2), nativeAsyncGetId: z.literal(true), busClosed: z.literal(true) }).passthrough().parse(JSON.parse(stdout));
    assert.ok(response.seconds < 2);
    assert.ok(reports.find((report) => report.name === "explicit-native")?.events.some((event) => event.member === "GetId" && (event.flags & 2) === 2));
    assert.ok(reports.find((report) => report.name === "system")?.events.some((event) => event.member === "GetNameOwner" && event.serviceCategory === "login-manager"));
    for (const service of services) await service.close();
    for (const bus of buses) { await reap(bus.monitor); bus.finish(); }
  } finally { for (const service of services) await service.close(); for (const child of children.reverse()) await reap(child); }
});
}
