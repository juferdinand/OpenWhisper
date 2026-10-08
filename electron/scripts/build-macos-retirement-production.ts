import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMacRetirementProduction } from "./build-macos-retirement.js";

// Explicit production target only; this entry never loads the addon.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildMacRetirementProduction();
