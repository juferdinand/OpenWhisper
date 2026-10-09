import type {} from "electron";
import { isAbsolute } from "node:path";
import { failureSchema, progressSchema, resultSchema } from "./contracts.js";
import type { CaptureCase } from "./contracts.js";
import { probeMacCapture } from "./probe.js";

const port = process.parentPort, binding = process.argv[2];
if (!port || process.platform !== "darwin" || process.getuid?.() === 0 || process.env["GITHUB_ACTIONS"] !== "true"
  || !binding || !isAbsolute(binding) || !binding.endsWith("/dist/native/openwhisper_macos_capture.node") || binding.includes("\0")) process.exit(1);
// Synthetic-only probe; neither the main fixture nor any renderer loads this addon.
let phase: CaptureCase["name"] | null = null;
void probeMacCapture(binding, (value) => { phase = value; port.postMessage(progressSchema.parse({ fixture: "macos-capture-progress", phase })); })
  .then((result) => { port.postMessage(resultSchema.parse(result)); }, () => {
  port.postMessage(failureSchema.parse({ fixture: "macos-capture-failure", code: "SYNTHETIC_CAPTURE_FAILED", phase }));
});
