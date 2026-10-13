import { execFileSync } from "node:child_process";

/**
 * macOS virtual machines (for example CI runners) expose a paravirtual GPU whose Metal probe can
 * fail in ways that are not a clean CPU fallback. Optional Metal acceleration is not offered there.
 */
export function runsInMacosVirtualMachine(read: () => string = () =>
  execFileSync("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8", timeout: 2000 })): boolean {
  try { return read().trim() === "1"; }
  catch { return false; }
}
