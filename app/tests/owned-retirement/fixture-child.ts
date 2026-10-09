import { createLinuxProcfsReadProvider, MAX_PROC_STAT_BYTES, MAX_PROC_STATUS_BYTES,
  parseLinuxProcStat, parseLinuxProcStatus } from "../../src/services/platform-lifecycle/process-retirement.js";
import { childModeSchema, epochSchema, identitySchema, parseRequest, replySchema, FixtureError,
  type Reply } from "./contract.js";

export interface ChildPort { send(reply: Reply): Promise<void>; listen(listener: (input: unknown) => void): void }
export function startFixtureChild(port: ChildPort, args: readonly string[]): void {
  if (process.platform !== "linux" || process.getuid?.() !== 1000 || process.env.OPENWHISPER_OWNED_RETIREMENT_TEST !== "1" || args.length !== 2) throw new FixtureError();
  const epoch = epochSchema.parse(args[0]), mode = childModeSchema.parse(args[1]);
  const watchdog = setTimeout(() => { process.exit(72); }, 15_000);
  process.once("exit", () => { clearTimeout(watchdog); });
  // Fixed synthetic ignored-SIGTERM case only; no user workload or native addon.
  if (mode === "delayed-term") process.on("SIGTERM", () => {});
  const seen = new Set<string>(); let requests = 0, queue = Promise.resolve(), acted = false;
  const reader = createLinuxProcfsReadProvider();
  port.listen((input) => {
    queue = queue.then(async () => {
      const request = parseRequest(input);
      if (request.epoch !== epoch || seen.has(request.nonce) || ++requests > 16 || acted) throw new FixtureError();
      seen.add(request.nonce);
      if (request.kind === "challenge") {
        const signal = AbortSignal.timeout(1000);
        await reader.verify(signal);
        const first = parseLinuxProcStat(await reader.read(process.pid, "stat", MAX_PROC_STAT_BYTES, signal));
        const status = parseLinuxProcStatus(await reader.read(process.pid, "status", MAX_PROC_STATUS_BYTES, signal));
        const second = parseLinuxProcStat(await reader.read(process.pid, "stat", MAX_PROC_STAT_BYTES, signal));
        if (first.pid !== process.pid || second.pid !== first.pid || first.startTicks !== second.startTicks ||
          first.parentPid !== second.parentPid || status.pid !== process.pid || status.parentPid !== second.parentPid ||
          status.uids.some((uid) => uid !== 1000) || second.parentPid !== process.ppid || ["Z", "X", "x"].includes(second.state)) throw new FixtureError();
        await port.send(identitySchema.parse({ version: 1, kind: "identity", epoch, nonce: request.nonce,
          pid: process.pid, uid: 1000, parentPid: second.parentPid, startTicks: second.startTicks.toString(), mode }));
      } else {
        acted = true;
        if (request.action === "schedule-exit" && mode !== "delayed-term") throw new FixtureError();
        await port.send(replySchema.parse({ version: 1, kind: "ack", epoch, nonce: request.nonce, action: request.action }));
        setTimeout(() => { if (request.action === "abort") process.abort(); else process.exit(0); }, request.action === "schedule-exit" ? 1000 : 30);
      }
    }).catch(() => { process.exit(78); });
  });
}
