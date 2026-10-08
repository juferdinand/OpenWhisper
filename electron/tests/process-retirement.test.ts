import assert from "node:assert/strict";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  bindLinuxProcessRetirement, createLinuxProcfsReadProvider, MAX_PROC_STAT_BYTES, MAX_PROC_STATUS_BYTES,
  parseLinuxProcStat, parseLinuxProcStatus, PROCFS_MAGIC, ProcessRetirementError,
  type LinuxProcfsIO, type ProcessRetirementReadProvider, type ProcField,
} from "../src/services/process-retirement.js";

const uid = process.getuid?.(); assert.notEqual(uid, undefined);
const launch = { pid: 70001, uid, parentPid: process.pid, epoch: randomUUID() };
const timing = { deadlineMs: 250, pollMs: 1 };
const error = (value: unknown): boolean => value instanceof ProcessRetirementError && value.code === "TEARDOWN_FAILED" &&
  value.message === "Process retirement: TEARDOWN_FAILED.";
function stat(options: { pid?: number; parentPid?: number; start?: string; state?: string; comm?: string } = {}): Buffer {
  const fields = [options.state ?? "S", String(options.parentPid ?? process.pid), ...Array.from({ length: 48 }, () => "0")];
  fields[19] = options.start ?? "123456789";
  return Buffer.from(`${options.pid ?? launch.pid} (${options.comm ?? "owned fixture"}) ${fields.join(" ")}\n`);
}
function status(options: { pid?: number; parentPid?: number; uid?: number } = {}): Buffer {
  const id = options.pid ?? launch.pid, owner = options.uid ?? uid;
  return Buffer.from(`Name:\towned fixture\nState:\tS (sleeping)\nTgid:\t${id}\nPid:\t${id}\nPPid:\t${options.parentPid ?? process.pid}\nUid:\t${owner}\t${owner}\t${owner}\t${owner}\n`);
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Deferred not initialized."); };
  let reject: (error: unknown) => void = () => { throw new Error("Deferred not initialized."); };
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject };
}
function provider(read: ProcessRetirementReadProvider["read"] = async (_pid, field) => field === "stat" ? stat() : status()): ProcessRetirementReadProvider {
  return { verify: async () => {}, read };
}

test("stat/status parsers retain numeric identity without retaining comm or unrelated status data", () => {
  const parsed = parseLinuxProcStat(stat({ comm: "fixture) with (parens\nand newline", start: "18446744073709551615" }));
  assert.deepEqual(parsed, { pid: launch.pid, parentPid: process.pid, startTicks: (1n << 64n) - 1n, state: "S" });
  assert.ok(Object.isFrozen(parsed)); assert.equal("comm" in parsed, false);
  const truncatedName = stat(); truncatedName[`${launch.pid} (`.length] = 0xff;
  assert.equal(parseLinuxProcStat(truncatedName).pid, launch.pid);
  const metadata = parseLinuxProcStatus(Buffer.concat([status(), Buffer.from("Groups:\t1000 2000\n") ]));
  assert.deepEqual(metadata, { pid: launch.pid, parentPid: process.pid, uids: [uid, uid, uid, uid] });
  assert.ok(Object.isFrozen(metadata.uids)); assert.equal("Groups" in metadata, false);
});

test("parsers reject partial records, numeric overflows, invalid state, duplicate identity and truncated UID data", () => {
  for (const value of [stat().subarray(0, 40), stat({ start: "18446744073709551616" }), stat({ start: "0" }),
    stat({ pid: 0 }), stat({ parentPid: 0x8000_0000 }), stat({ state: "?" }), stat().subarray(0, stat().length - 1),
    Buffer.alloc(MAX_PROC_STAT_BYTES + 1), "untrusted string"]) assert.throws(() => parseLinuxProcStat(value), error);
  for (const value of [status().subarray(0, status().length - 3), Buffer.concat([status(), Buffer.from(`Pid:\t${launch.pid}\n`)]),
    Buffer.from(status().toString().replace(`Tgid:\t${launch.pid}`, "Tgid:\t1")),
    Buffer.from(status().toString().replace(/Uid:.+\n/u, "Uid:\t1\t2\t3\n")), Buffer.alloc(MAX_PROC_STATUS_BYTES + 1)]) {
    assert.throws(() => parseLinuxProcStatus(value), error);
  }
});

test("binding validates closed trusted parent input before any provider effect", async () => {
  let effects = 0; const read = { verify: async () => { effects++; }, read: async () => { effects++; return stat(); } };
  for (const input of [{ ...launch, parentPid: process.pid + 1 }, { ...launch, uid: (uid ?? 0) + 1 },
    { ...launch, pid: "../unsafe" }, { ...launch, epoch: "not-uuid" }, { ...launch, path: "/anywhere" }, { ...launch, pid: NaN }]) {
    await assert.rejects(bindLinuxProcessRetirement(input, timing, read), error);
  }
  for (const options of [{ deadlineMs: 8001 }, { deadlineMs: 10, pollMs: 20 }, { deadlineMs: Infinity }, { arbitrary: true }]) {
    await assert.rejects(bindLinuxProcessRetirement(launch, options, read), error);
  }
  assert.equal(effects, 0);
});

test("binding reads stat-status-stat in order and captures an immutable usable original birth", async () => {
  const reads: ProcField[] = [];
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (pid, field, limit) => {
    assert.equal(pid, launch.pid); assert.equal(limit, field === "stat" ? MAX_PROC_STAT_BYTES : MAX_PROC_STATUS_BYTES);
    reads.push(field); return field === "stat" ? stat() : status();
  }));
  assert.deepEqual(reads, ["stat", "status", "stat"]);
  assert.deepEqual(witness.initial, { level: "running", canAdmit: true, identity: { ...launch, startTicks: 123456789n } });
  assert.ok(Object.isFrozen(witness.initial)); assert.ok(Object.isFrozen(witness.initial.identity));
});

test("ordinary scheduler state changes between stat reads preserve consistent original identity", async () => {
  let stats = 0;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => field === "status" ? status()
    : stat({ state: ++stats === 1 ? "R" : "S" })));
  assert.equal(witness.initial.canAdmit, true); assert.equal(witness.initial.identity?.startTicks, 123456789n);
});

test("initial absence is already retired with no usable identity and does not initiate later reads", async () => {
  let reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async () => { reads++; return null; }));
  assert.deepEqual(witness.initial, { level: "reaped", canAdmit: false, identity: null });
  await witness.waitForRetirement(); assert.equal((await witness.observe()).level, "reaped"); assert.equal(reads, 1);
});

test("lookup refusal or mismatched UID/parent/birth returns a retained ambiguous unusable witness", async () => {
  for (const phase of ["verify", "permission", "uid", "parent", "pid", "birth", "status-missing"] as const) {
    let stats = 0;
    const read = provider(async (_pid, field) => {
      if (phase === "permission") throw Object.assign(new Error("Private refusal detail"), { code: "EACCES" });
      if (field === "status") return phase === "status-missing" ? null : status(phase === "uid" ? { uid: (uid ?? 0) + 1 } : {});
      stats++; return stat(phase === "parent" ? { parentPid: process.pid + 1 } : phase === "pid" ? { pid: launch.pid + 1 }
        : phase === "birth" && stats === 2 ? { start: "123456790" } : {});
    });
    const witness = await bindLinuxProcessRetirement(launch, timing, phase === "verify" ? { ...read, verify: async () => { throw new Error("Private procfs detail"); } } : read);
    assert.deepEqual(witness.initial, { level: "ambiguous", canAdmit: false, identity: null });
    await assert.rejects(witness.waitForRetirement(), error); assert.equal((await witness.observe()).level, "ambiguous");
  }
});

test("initial exit between status and final stat never yields a usable owner", async () => {
  let stats = 0;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => {
    if (field === "status") return null; return ++stats === 1 ? stat() : null;
  }));
  assert.deepEqual(witness.initial, { level: "reaped", canAdmit: false, identity: null });
});

test("same-birth zombie/dead states stay reserved; a proven different birth or absence retires", async () => {
  for (const retiredBy of ["absence", "reuse"] as const) {
    let state = "S", birth = "123456789", absent = false, reused = false;
    const read = provider(async (_pid, field) => absent ? null : field === "stat" ? stat({ state, start: birth,
      parentPid: reused ? process.pid + 1 : process.pid }) : status(reused ? { uid: (uid ?? 0) + 1, parentPid: process.pid + 1 } : {}));
    const witness = await bindLinuxProcessRetirement(launch, timing, read);
    for (const nonrunning of ["Z", "X", "x"]) { state = nonrunning; assert.equal((await witness.observe()).level, "non-running"); }
    state = "Z"; let settled = false;
    const waiting = witness.waitForRetirement().then(() => { settled = true; });
    await delay(10); assert.equal(settled, false); assert.equal(witness.current.level, "non-running");
    if (retiredBy === "absence") absent = true; else { reused = true; birth = "123456790"; state = "S"; }
    await waiting; assert.equal(witness.current.level, "reaped");
    assert.equal(witness.initial.identity?.startTicks, 123456789n);
  }
});

test("running, sleeping, stopped and uninterruptible original states are not reaped", async () => {
  let state = "R";
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => field === "stat" ? stat({ state }) : status()));
  for (const next of ["R", "S", "D", "T", "t", "I"]) { state = next; assert.equal((await witness.observe()).level, "running"); }
});

test("retirement deadline fails closed permanently even if later absence becomes visible", async () => {
  let absent = false;
  const witness = await bindLinuxProcessRetirement(launch, { deadlineMs: 25, pollMs: 1 }, provider(async (_pid, field) => absent ? null : field === "stat" ? stat({ state: "Z" }) : status()));
  await assert.rejects(witness.waitForRetirement(), error); absent = true;
  assert.equal((await witness.observe()).level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
});

test("same-birth ownership changes and post-bind read errors poison instead of reporting retirement", async () => {
  for (const phase of ["parent", "uid", "permission", "partial"] as const) {
    let changed = false;
    const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => {
      if (!changed) return field === "stat" ? stat() : status();
      if (phase === "permission") throw Object.assign(new Error("Private metadata detail"), { code: "EPERM" });
      return field === "stat" ? phase === "partial" ? stat().subarray(0, 10) : stat(phase === "parent" ? { parentPid: process.pid + 1 } : {})
        : status(phase === "uid" ? { uid: (uid ?? 0) + 1 } : phase === "parent" ? { parentPid: process.pid + 1 } : {});
    }));
    changed = true; assert.equal((await witness.observe()).level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
  }
});

test("cleanup cancellation retains late reader completion and cannot publish a late retirement", async () => {
  const held = deferred<Uint8Array | null>(), started = deferred<void>(); let hold = false;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field, _limit, signal) => {
    if (hold) { started.resolve(); const result = await held.promise; assert.equal(signal.aborted, true); return result; }
    return field === "stat" ? stat() : status();
  }));
  hold = true; const cleanup = new AbortController(), observing = witness.observe(cleanup.signal);
  await started.promise; cleanup.abort(); assert.equal((await observing).level, "ambiguous");
  let readersSettled = false; const readers = witness.settleReads().then(() => { readersSettled = true; });
  await delay(5); assert.equal(readersSettled, false); held.resolve(null); await readers;
  assert.equal(witness.current.level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
});

test("already aborted cleanup poisons without starting another read or reporting owner rollback", async () => {
  let reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => { reads++; return field === "stat" ? stat() : status(); }));
  const before = reads, cleanup = new AbortController(); cleanup.abort();
  assert.equal((await witness.observe(cleanup.signal)).level, "ambiguous");
  await witness.settleReads(); assert.equal(reads, before); await assert.rejects(witness.waitForRetirement(), error);
  assert.equal(witness.initial.identity?.startTicks, 123456789n);
});

test("startup timeout retains its witness and owns a late rejected read without unhandled rejection", async () => {
  const held = deferred<Uint8Array | null>(), begun = deferred<void>();
  const binding = bindLinuxProcessRetirement(launch, { deadlineMs: 15, pollMs: 1 }, provider(async () => { begun.resolve(); return held.promise; }));
  await begun.promise; const witness = await binding;
  assert.deepEqual(witness.initial, { level: "ambiguous", canAdmit: false, identity: null });
  let settled = false; const closure = witness.settleReads().then(() => { settled = true; });
  await delay(2); assert.equal(settled, false); held.reject(new Error("Private late read detail")); await closure;
  assert.equal(witness.current.level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
});

test("observations serialize around a pending read rather than mixing two process snapshots", async () => {
  const held = deferred<Uint8Array | null>(), began = deferred<void>(); let pending = false, reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, timing, provider(async (_pid, field) => {
    reads++; if (pending) { pending = false; began.resolve(); return held.promise; } return field === "stat" ? stat() : status();
  }));
  pending = true; const first = witness.observe(); await began.promise; const before = reads, second = witness.observe();
  await delay(5); assert.equal(reads, before); held.resolve(stat());
  assert.equal((await first).level, "running"); assert.equal((await second).level, "running"); assert.equal(reads, before + 5);
});

test("reader barrier includes all observations accepted while their reads are still queued", async () => {
  const gates = [deferred<Uint8Array | null>(), deferred<Uint8Array | null>(), deferred<Uint8Array | null>()];
  const starts = [deferred<void>(), deferred<void>(), deferred<void>()]; let observing = false, reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, { deadlineMs: 500, pollMs: 1 }, provider(async (_pid, field) => {
    if (observing && reads++ % 3 === 0) {
      const index = Math.floor((reads - 1) / 3), gate = gates[index], started = starts[index];
      assert.ok(gate); assert.ok(started); started.resolve(); return gate.promise;
    }
    return field === "stat" ? stat() : status();
  }));
  observing = true;
  const observations = [witness.observe(), witness.observe(), witness.observe()];
  let settled = false; const barrier = witness.settleReads().then(() => { settled = true; });
  try {
    for (let index = 0; index < gates.length; index++) {
      const gate = gates[index], started = starts[index]; assert.ok(gate); assert.ok(started);
      await started.promise; await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "A previously accepted observation still owns a pending read."); gate.resolve(stat());
    }
    assert.deepEqual((await Promise.all(observations)).map((value) => value.level), ["running", "running", "running"]);
    await barrier; assert.equal(settled, true); assert.equal(reads, 9);
  } finally { for (const gate of gates) gate.resolve(stat()); await Promise.allSettled([...observations, barrier]); }
});

test("reader barrier excludes observations admitted after its synchronous snapshot", async () => {
  const first = deferred<Uint8Array | null>(), later = deferred<Uint8Array | null>(), laterStarted = deferred<void>();
  let observing = false, reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, { deadlineMs: 500, pollMs: 1 }, provider(async (_pid, field) => {
    if (observing && reads++ % 3 === 0) {
      if (reads === 1) return first.promise;
      laterStarted.resolve(); return later.promise;
    }
    return field === "stat" ? stat() : status();
  }));
  observing = true; const accepted = witness.observe(), barrier = witness.settleReads();
  let laterSettled = false; const afterBarrier = witness.observe().then((value) => { laterSettled = true; return value; });
  try {
    first.resolve(stat()); await laterStarted.promise; await barrier;
    assert.equal((await accepted).level, "running"); assert.equal(laterSettled, false);
    later.resolve(stat()); assert.equal((await afterBarrier).level, "running");
  } finally { first.resolve(stat()); later.resolve(stat()); await Promise.allSettled([accepted, barrier, afterBarrier]); }
});

test("reader barrier waits for late failed reads and their closure after queued observations time out", async () => {
  const result = deferred<Uint8Array | null>(), started = deferred<void>(), closing = deferred<void>(), closed = deferred<void>();
  let hold = false, reads = 0;
  const witness = await bindLinuxProcessRetirement(launch, { deadlineMs: 15, pollMs: 1 }, provider(async (_pid, field) => {
    reads++;
    if (hold) {
      started.resolve();
      try { return await result.promise; } finally { closing.resolve(); await closed.promise; }
    }
    return field === "stat" ? stat() : status();
  }));
  hold = true; const observations = [witness.observe(), witness.observe()];
  let settled = false; const barrier = witness.settleReads().then(() => { settled = true; });
  try {
    await started.promise;
    assert.deepEqual((await Promise.all(observations)).map((value) => value.level), ["ambiguous", "ambiguous"]);
    assert.equal(settled, false); assert.equal(reads, 4, "The poisoned queued observation must not start another read.");
    result.reject(new Error("Private late read failure.")); await closing.promise;
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false, "Reader closure is still pending.");
    closed.resolve(); await barrier; assert.equal(witness.current.level, "ambiguous");
    await assert.rejects(witness.waitForRetirement(), error);
  } finally { result.resolve(null); closed.resolve(); await Promise.allSettled([...observations, barrier]); }
});

test("monotonic deadline rejects late snapshots even before a delayed timer callback", async () => {
  let clock = 100, jump = false;
  const read = provider(async (_pid, field) => { if (jump) clock = 1000; return field === "stat" ? stat() : status(); });
  const witness = await bindLinuxProcessRetirement(launch, timing, { ...read, now: () => clock });
  jump = true; assert.equal((await witness.observe()).level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
});

test("backwards or nonfinite injected clocks are ambiguous, never an extended ownership timeout", async () => {
  for (const bad of [NaN, Infinity, -1]) {
    let clock = 100; const witness = await bindLinuxProcessRetirement(launch, timing, { ...provider(), now: () => clock });
    clock = bad; assert.equal((await witness.observe()).level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
  }
});

interface FilesystemFixture { readonly root: string; readonly proc: string; readonly child: string;
  readonly io: LinuxProcfsIO; readonly opened: { flags: number; path: string }[]; readonly closes: () => number }
async function filesystem(run: (fixture: FilesystemFixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-proc-fixture-"))), proc = join(root, "proc"), child = join(proc, String(launch.pid));
  await mkdir(proc, { mode: 0o700 }); await mkdir(child, { mode: 0o700 });
  await writeFile(join(child, "stat"), stat(), { mode: 0o600 }); await writeFile(join(child, "status"), status(), { mode: 0o600 });
  const opened: { flags: number; path: string }[] = []; let closes = 0;
  const ownedPath = (path: string): string => { assert.ok(path === "/proc" || /^\/proc\/70001(?:\/(?:stat|status))?$/u.test(path)); return join(proc, path.slice(6)); };
  // Real private filesystem operations; only the filesystem magic/platform are
  // injected. This cannot establish genuine kernel procfs or Electron topology.
  const io: LinuxProcfsIO = { platform: "linux", lstat: (path) => lstat(ownedPath(path), { bigint: true }),
    statfs: async () => ({ type: PROCFS_MAGIC }), async open(path, flags) {
      opened.push({ path, flags }); const file = await open(ownedPath(path), flags), close = file.close.bind(file);
      file.close = async () => { closes++; await close(); }; return file;
    } };
  try { await run({ root, proc, child, io, opened, closes: () => closes }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("fixed-path proc reader completes real bounded partial reads and closes all owned descriptors", async () => filesystem(async (ctx) => {
  let maximum = 0;
  const reader = createLinuxProcfsReadProvider({ ...ctx.io, async open(path, flags) {
    const file = await ctx.io.open(path, flags);
    if (path.endsWith("/stat") || path.endsWith("/status")) return {
      stat: (options) => file.stat(options), close: () => file.close(),
      read: async (buffer, offset, length, position) => {
        maximum = Math.max(maximum, length); return file.read(buffer, offset, Math.min(3, length), position);
      },
    }; return file;
  } });
  const witness = await bindLinuxProcessRetirement(launch, timing, reader);
  assert.equal(witness.initial.canAdmit, true); assert.equal(ctx.opened.length, ctx.closes());
  assert.equal(maximum, MAX_PROC_STATUS_BYTES + 1);
  assert.ok(ctx.opened.every((entry) => (entry.flags & constants.O_NOFOLLOW) !== 0 && (entry.flags & constants.O_NONBLOCK) !== 0));
  await unlink(join(ctx.child, "stat")); assert.equal((await witness.observe()).level, "reaped");
  assert.equal(ctx.opened.length, ctx.closes());
}));

test("proc reader rejects non-procfs, unsupported platforms, root symlinks and inode replacement", async () => {
  await filesystem(async (ctx) => {
    for (const reader of [createLinuxProcfsReadProvider({ ...ctx.io, statfs: async () => ({ type: 0xef53n }) }),
      createLinuxProcfsReadProvider({ ...ctx.io, platform: "darwin" })]) {
      const witness = await bindLinuxProcessRetirement(launch, timing, reader); assert.equal(witness.initial.level, "ambiguous");
    }
    const reader = createLinuxProcfsReadProvider(ctx.io), witness = await bindLinuxProcessRetirement(launch, timing, reader);
    assert.equal(witness.initial.canAdmit, true);
    await rename(ctx.proc, join(ctx.root, "old-proc")); await mkdir(ctx.proc, { mode: 0o700 });
    assert.equal((await witness.observe()).level, "ambiguous");
  });
  await filesystem(async (ctx) => {
    await rename(ctx.proc, join(ctx.root, "old-proc")); await symlink(join(ctx.root, "old-proc"), ctx.proc);
    assert.equal((await bindLinuxProcessRetirement(launch, timing, createLinuxProcfsReadProvider(ctx.io))).initial.level, "ambiguous");
  });
});

test("proc reader rejects symlink/nonregular/oversize records and directory replacement without escaping private files", async () => {
  for (const phase of ["symlink", "directory", "oversize", "child-symlink"] as const) await filesystem(async (ctx) => {
    if (phase === "child-symlink") { await rename(ctx.child, join(ctx.root, "old-child")); await symlink(join(ctx.root, "old-child"), ctx.child); }
    else {
      const path = join(ctx.child, "stat"); await unlink(path);
      if (phase === "symlink") await symlink(join(ctx.child, "status"), path);
      if (phase === "directory") await mkdir(path, { mode: 0o700 });
      if (phase === "oversize") await writeFile(path, Buffer.alloc(MAX_PROC_STAT_BYTES + 1), { mode: 0o600 });
    }
    const witness = await bindLinuxProcessRetirement(launch, timing, createLinuxProcfsReadProvider(ctx.io));
    assert.equal(witness.initial.level, "ambiguous"); assert.equal(ctx.opened.length, ctx.closes());
  });
});

test("proc root loss during an ENOENT record read is ambiguity rather than false original absence", async () => filesystem(async (ctx) => {
  let changed = false;
  const reader = createLinuxProcfsReadProvider({ ...ctx.io, async lstat(path) {
    if (!changed && path === `/proc/${launch.pid}`) {
      changed = true; await rename(ctx.proc, join(ctx.root, "old-proc")); await mkdir(ctx.proc, { mode: 0o700 });
    }
    return ctx.io.lstat(path);
  } });
  assert.equal((await bindLinuxProcessRetirement(launch, timing, reader)).initial.level, "ambiguous");
  assert.equal(ctx.opened.length, ctx.closes());
}));

test("real file read/close faults and replacement after open stay categorical and close every descriptor", async () => {
  for (const phase of ["read", "close", "replacement"] as const) await filesystem(async (ctx) => {
    let changed = false;
    const reader = createLinuxProcfsReadProvider({ ...ctx.io, async open(path, flags) {
      const file = await ctx.io.open(path, flags);
      if (!path.endsWith("/stat")) return file;
      return { stat: (options) => file.stat(options),
        read: async (buffer, offset, length, position) => {
          if (phase === "read") throw new Error("Private read failure path/content detail");
          if (phase === "replacement" && !changed) {
            changed = true; await rename(join(ctx.child, "stat"), join(ctx.child, "previous-stat"));
            await writeFile(join(ctx.child, "stat"), stat({ start: "123456790" }), { mode: 0o600 });
          } return file.read(buffer, offset, length, position);
        }, close: async () => { await file.close(); if (phase === "close") throw new Error("Private close failure detail"); },
      };
    } });
    const witness = await bindLinuxProcessRetirement(launch, timing, reader);
    assert.equal(witness.initial.level, "ambiguous"); await assert.rejects(witness.waitForRetirement(), error);
    assert.equal(ctx.opened.length, ctx.closes());
  });
});
