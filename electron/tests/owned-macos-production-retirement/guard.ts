import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { checkedBytes, sha256 } from "./input.js";
import { digest, nativeGuardCode } from "./contracts.js";

const schema = z.strictObject({ binding: z.string().refine((path) => isAbsolute(path) && !path.includes("\0")), sha256: digest });
// This process receives no kernel target, UID, parent, epoch or native owner.
const target = schema.parse(parentPort ? workerData : { binding: process.argv[2], sha256: process.argv[3] });
let result: "TEARDOWN_FAILED" | "LOAD_REFUSED" | "UNEXPECTED_LOAD" = "LOAD_REFUSED";
try {
  if (sha256(await checkedBytes(target.binding)) !== target.sha256) throw new Error("INPUT_REFUSED");
  createRequire(import.meta.url)(target.binding); result = "UNEXPECTED_LOAD";
} catch (error: unknown) { result = nativeGuardCode(error); }
const frame = { context: parentPort ? "worker" : "node", result, kernelTargetProvided: false, nodeVersion: process.versions.node, architecture: process.arch };
if (parentPort) { parentPort.postMessage(frame); parentPort.close(); } else process.stdout.write(JSON.stringify(frame));
process.exitCode = result === "TEARDOWN_FAILED" ? 0 : 1;
