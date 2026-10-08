import test from "node:test";
import assert from "node:assert/strict";
import { baselineAbi, IMAGE, oldChecks, packageSchema, sameHashes, validateContainer } from "./launch-contracts.js";
import { awaitNonRunning, bindBirth, observeBirth, parseStat, type ProcReader } from "./process-witness.js";
import { parseArguments } from "./run.js";

function stat(state = "S", ticks = "123", parent = "42"): string {
  return `77 (owned ) fixture) ${[state, parent, ...Array<string>(17).fill("0"), ticks].join(" ")}\n`;
}
const uid = "Uid:\t1000\t1000\t1000\t1000\n";
const reader = (state = "S", ticks = "123"): ProcReader => async (path) => path.endsWith("/stat") ? stat(state, ticks) : uid;
function inspection() {
  return [{ Image: IMAGE, State: { Running: false }, Config: { User: "1000:1000", Entrypoint: ["/bin/sleep"], Cmd: ["1800"],
    Env: ["PATH=/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], Volumes: null },
    HostConfig: { NetworkMode: "none", Privileged: false, CapAdd: null, CapDrop: ["ALL"], Devices: [], DeviceRequests: null,
      Binds: null, VolumesFrom: null, PidMode: "", IpcMode: "private", SecurityOpt: ["seccomp=/owned-policy"],
      Init: true, UsernsMode: "", CgroupnsMode: "private", GroupAdd: null,
      Ulimits: [{ Name: "core", Soft: 0, Hard: 0 }],
      PidsLimit: 256, Memory: 3 * 1024 ** 3, ShmSize: 256 * 1024 ** 2 }, Mounts: [] }];
}
test("pre-start inspection refuses host access and runtime override even for the pinned image", () => {
  validateContainer(inspection(), "/owned-policy");
  for (const kind of ["uid", "running", "mount", "device", "network", "capability", "seccomp", "environment", "core", "extra-limit", "missing-limit"] as const) {
    const value = inspection(); const item = value[0]; assert.ok(item);
    if (kind === "uid") item.Config.User = "0:0";
    if (kind === "running") item.State.Running = true;
    const raw: unknown = value;
    if (kind === "mount") Reflect.set(item, "Mounts", [{ Type: "bind", Source: "/tmp" }]);
    if (kind === "device") Reflect.set(item.HostConfig, "Devices", [{ PathOnHost: "/dev/input" }]);
    if (kind === "network") item.HostConfig.NetworkMode = "host";
    if (kind === "capability") Reflect.set(item.HostConfig, "CapAdd", ["SYS_ADMIN"]);
    if (kind === "seccomp") item.HostConfig.SecurityOpt = ["seccomp=unconfined"];
    if (kind === "environment") item.Config.Env.push("NODE_OPTIONS=--require=/ambient");
    if (kind === "core") item.HostConfig.Ulimits[0] = { Name: "core", Soft: 1, Hard: 1 };
    if (kind === "extra-limit") item.HostConfig.Ulimits.push({ Name: "nofile", Soft: 1024, Hard: 1024 });
    if (kind === "missing-limit") Reflect.deleteProperty(item.HostConfig, "Ulimits");
    assert.throws(() => validateContainer(raw, "/owned-policy"), kind);
  }
});
test("frozen byte manifest rejects missing added changed and traversal inputs", () => {
  const first = { "runtime/electron": "a".repeat(64) }; sameHashes(first, { ...first });
  for (const changed of [{}, { ...first, extra: "a".repeat(64) }, { "runtime/electron": "b".repeat(64) }]) assert.throws(() => sameHashes(changed, first));
  assert.equal(packageSchema.shape.payload.safeParse({ "../outside": "a".repeat(64) }).success, false);
  assert.equal(oldChecks.length, 19);
});
test("birth parser handles parenthesized names without retaining their contents", () => {
  assert.deepEqual(parseStat(stat()), { pid: 77, parentPid: 42, ticks: "123", state: "S" });
  assert.throws(() => parseStat(stat("S", "0123"))); assert.throws(() => parseStat(stat("S", "18446744073709551616")));
});
test("admission requires stat-status-stat exact UID parent and unchanged birth", async () => {
  const calls: string[] = []; const good: ProcReader = async (path) => { calls.push(path); return reader()(path); };
  assert.deepEqual(await bindBirth(77, 42, good), { pid: 77, parentPid: 42, ticks: "123" });
  assert.deepEqual(calls, ["/proc/77/stat", "/proc/77/status", "/proc/77/stat"]);
  for (const fault of ["birth", "uid", "parent", "permission", "absent"] as const) {
    let stats = 0;
    const bad: ProcReader = async (path) => {
      if (fault === "permission") throw new Error("Synthetic permission refusal.");
      if (fault === "absent") return null;
      if (path.endsWith("/status")) return fault === "uid" ? uid.replaceAll("1000", "1001") : uid;
      stats++; return stat("S", fault === "birth" && stats === 2 ? "124" : "123", fault === "parent" ? "43" : "42");
    };
    await assert.rejects(bindBirth(77, 42, bad), fault);
  }
});
test("generic exit is not proof and same-birth zombie is explicitly not full reap", async () => {
  const birth = await bindBirth(77, 42, reader());
  await assert.rejects(awaitNonRunning(birth, 0, reader()));
  assert.deepEqual(await observeBirth(birth, reader("Z")), { level: "non-running", reason: "zombie" });
  assert.deepEqual(await awaitNonRunning(birth, 100, async () => null), { level: "absent", reason: "absence" });
  for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await assert.rejects(awaitNonRunning(birth, budget, async () => null));
  await assert.rejects(observeBirth(birth, reader("S", "124")));
  await assert.rejects(observeBirth(birth, async (path) => path.endsWith("/status") ? null : stat()));
  await assert.rejects(observeBirth(birth, async () => { throw new Error("Synthetic proc lookup refusal."); }));
  await assert.rejects(awaitNonRunning(birth, 5, async () => new Promise<string | null>(() => undefined)));
});
for (const state of ["absence", "Z"] as const) {
  test(`late ${state === "Z" ? "zombie" : state} observation cannot certify after its monotonic deadline`, async () => {
    const birth = await bindBirth(77, 42, reader()); let delayed = false;
    const late: ProcReader = async (path) => {
      if (!delayed) {
        delayed = true;
        // Hold only this inert test loop so observation resolves before a
        // queued timeout callback can run, but after the real deadline.
        const end = performance.now() + 15; while (performance.now() < end) { /* Synthetic late reply. */ }
      }
      return state === "absence" ? null : path.endsWith("/stat") ? stat("Z") : uid;
    };
    await assert.rejects(awaitNonRunning(birth, 5, late));
  });
}
test("owned ABI metadata refuses missing requirements and a host-only future libc", () => {
  assert.deepEqual(baselineAbi("GLIBC_2.34 GLIBCXX_3.4.22 CXXABI_1.3.13"), { GLIBC: ["2.34"], GLIBCXX: ["3.4.22"], CXXABI: ["1.3.13"] });
  for (const raw of ["", "GLIBC_2.43 GLIBCXX_3.4.22 CXXABI_1.3.13", "GLIBC_2.34 GLIBCXX_3.4.31 CXXABI_1.3.13"]) assert.throws(() => baselineAbi(raw));
});
test("prepare and execution arguments are disjoint and reject unknown additional flags", () => {
  assert.equal(parseArguments(["--prepare", "--output", "/new", "--headers", "/pin", "--seccomp", "/profile"]).mode, "prepare");
  assert.equal(parseArguments(["--execute", "--package", "/frozen"]).mode, "execute");
  for (const args of [[], ["--execute"], ["--execute", "--package", "/frozen", "--no-sandbox"], ["--prepare", "--package", "/frozen"]]) assert.throws(() => parseArguments(args));
});
