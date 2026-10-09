import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { safeFailure, witnessDetailSchema } from "./diagnostics.js";
import type { z } from "zod";

export interface Birth { readonly pid: number; readonly parentPid: number; readonly ticks: string }
export interface Snapshot extends Birth { readonly state: string }
export type Observation = Readonly<{ level: "running" | "non-running" | "absent"; reason: "same-birth" | "zombie" | "dead" | "absence" }>;
export interface ProcReader { (path: string): Promise<string | null> }
type Detail = z.infer<typeof witnessDetailSchema>;
export class WitnessRefusal extends Error {
  constructor(readonly reason: Detail["reason"], readonly component: Detail["component"], readonly ioCode: Detail["ioCode"] = null) {
    super("Owned process observation refused.");
  }
}
export const readProc: ProcReader = async (path) => {
  try { return await readFile(path, "utf8"); }
  catch (error: unknown) { if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") return null; throw error; }
};
/** Parse only PID/parent/state/birth. Process names and unrelated status content are never retained. */
export function parseStat(raw: string): Snapshot {
  if (raw.length > 4096) throw new WitnessRefusal("STAT_INVALID", "FIRST_STAT");
  const open = raw.indexOf(" ("), end = raw.lastIndexOf(") ");
  if (open < 1 || end <= open) throw new WitnessRefusal("STAT_INVALID", "FIRST_STAT");
  const pidText = raw.slice(0, open), columns = raw.slice(end + 2).trim().split(/\s+/u);
  const state = columns[0], parent = columns[1], ticks = columns[19];
  if (!/^[1-9][0-9]*$/u.test(pidText) || !parent || !/^[1-9][0-9]*$/u.test(parent) ||
      !state || !/^[RSDZTtWXxKWPIN]$/u.test(state) || !ticks || !/^[1-9][0-9]{0,19}$/u.test(ticks) ||
      BigInt(ticks) > (1n << 64n) - 1n) throw new WitnessRefusal("STAT_INVALID", "FIRST_STAT");
  const pid = Number(pidText), parentPid = Number(parent);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) throw new WitnessRefusal("STAT_INVALID", "FIRST_STAT");
  return { pid, parentPid, state, ticks };
}
function sameBirth(first: Birth, second: Birth): boolean {
  return first.pid === second.pid && first.parentPid === second.parentPid && first.ticks === second.ticks;
}
function validateUid(status: string): void {
  if (status.length > 16384 || !/^Uid:\s+1000\s+1000\s+1000\s+1000\s*$/mu.test(status)) throw new WitnessRefusal("UID_CHANGED", "STATUS");
}
async function snapshot(pid: number, parentPid: number, reader: ProcReader): Promise<Snapshot | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid <= 0) throw new WitnessRefusal("STAT_INVALID", "LOOKUP");
  const read = async (component: Detail["component"], file: "stat" | "status"): Promise<string | null> => {
    try { return await reader(`/proc/${pid}/${file}`); }
    catch (error: unknown) { throw new WitnessRefusal("READ_REFUSED", component, safeFailure("PROCESS_OBSERVATION", error).code); }
  };
  const parse = (value: string, component: Detail["component"]): Snapshot => {
    try { return parseStat(value); } catch { throw new WitnessRefusal("STAT_INVALID", component); }
  };
  const first = await read("FIRST_STAT", "stat"); if (first === null) return null;
  const before = parse(first, "FIRST_STAT"); const status = await read("STATUS", "status");
  const second = await read("SECOND_STAT", "stat"); if (second === null) return null;
  if (status === null) throw new WitnessRefusal("STATUS_ABSENT_WITH_STAT_PRESENT", "STATUS");
  validateUid(status); const after = parse(second, "SECOND_STAT");
  if (before.pid !== after.pid || before.parentPid !== after.parentPid || after.pid !== pid || after.parentPid !== parentPid) throw new WitnessRefusal("TOPOLOGY_CHANGED", "SECOND_STAT");
  if (before.ticks !== after.ticks) throw new WitnessRefusal("BIRTH_CHANGED", "SECOND_STAT");
  return after;
}
export async function bindBirth(pid: number, parentPid: number, reader: ProcReader = readProc): Promise<Birth> {
  const value = await snapshot(pid, parentPid, reader);
  if (!value || ["Z", "X", "x"].includes(value.state)) throw new WitnessRefusal("ADMISSION_REFUSED", "LOOKUP");
  return Object.freeze({ pid, parentPid, ticks: value.ticks });
}
export async function observeBirth(birth: Birth, reader: ProcReader = readProc): Promise<Observation> {
  const current = await snapshot(birth.pid, birth.parentPid, reader);
  if (!current) return { level: "absent", reason: "absence" };
  if (!sameBirth(birth, current)) throw new WitnessRefusal("BIRTH_CHANGED", "LOOKUP");
  if (current.state === "Z") return { level: "non-running", reason: "zombie" };
  if (current.state === "X" || current.state === "x") return { level: "non-running", reason: "dead" };
  return { level: "running", reason: "same-birth" };
}
export async function awaitNonRunning(birth: Birth, bound: number, reader: ProcReader = readProc): Promise<Observation> {
  if (!Number.isFinite(bound) || bound <= 0) throw new WitnessRefusal("DEADLINE_EXPIRED", "LOOKUP");
  const end = performance.now() + bound;
  const observation = (async () => {
    for (;;) {
      const current = await observeBirth(birth, reader);
      if (performance.now() >= end) throw new WitnessRefusal("DEADLINE_EXPIRED", "LOOKUP");
      if (current.level !== "running") return current;
      await pause(10);
    }
  })();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WitnessRefusal("LOOKUP_UNCONFIRMED", "LOOKUP")), Math.max(0, bound));
  });
  try { return await Promise.race([observation, expiry]); }
  finally { if (timer) clearTimeout(timer); }
}
