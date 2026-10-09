import { build } from "esbuild";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { captureSpeechEntryGraph, SPEECH_ENTRY_FILES } from "../src/services/speech/speech-entry-graph.js";

async function metadata(path: string, bytes: number, sha256: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await file.stat({ bigint: true });
    if (!first.isFile() || first.nlink !== 1n || first.size !== BigInt(bytes) || bytes > 4 * 1024 * 1024) throw new Error("Invalid fixed speech metadata.");
    const buffer = Buffer.alloc(bytes + 1); let count = 0;
    while (count < buffer.length) { const read = await file.read(buffer, count, buffer.length - count, null); if (!read.bytesRead) break; count += read.bytesRead; }
    const last = await file.stat({ bigint: true });
    if (count !== bytes || createHash("sha256").update(buffer.subarray(0, count)).digest("hex") !== sha256 ||
      first.dev !== last.dev || first.ino !== last.ino || first.size !== last.size || first.mtimeNs !== last.mtimeNs || first.ctimeNs !== last.ctimeNs) throw new Error("Invalid fixed speech metadata.");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count))); return value;
  } finally { await file.close(); }
}

/** Build-input capture only. Admission consumes a separately reviewed expected
 * record; it must never invoke this function to accept current runtime bytes. */
export async function buildSpeechEntryGraph(root: string) {
  const graph = await captureSpeechEntryGraph(root);
  const fixedMetadata = async (path: string): Promise<unknown> => {
    const entry = graph.entries.find((value) => value.path === path);
    if (!entry) throw new Error("Missing fixed speech metadata.");
    return metadata(resolve(root, path), entry.bytes, entry.sha256);
  };
  const application = await fixedMetadata("package.json");
  z.object({ name: z.literal("openwhisper-electron"), type: z.literal("module"),
    dependencies: z.object({ zod: z.literal("4.6.5") }) }).parse(application);
  const dependency = await fixedMetadata("node_modules/zod/package.json");
  z.object({ name: z.literal("zod"), version: z.literal("4.6.5"), type: z.literal("module"),
    exports: z.object({ ".": z.object({ import: z.literal("./index.js"), require: z.literal("./index.cjs") }) }) }).parse(dependency);
  const result = await build({ entryPoints: [resolve(root, "dist/workers/speech-entry.js")], absWorkingDir: root,
    bundle: true, write: false, metafile: true, platform: "node", format: "esm", target: "node24", logLevel: "silent" });
  const paths = new Set(graph.entries.map((entry) => entry.path));
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    if (!paths.has(path) || (!SPEECH_ENTRY_FILES.includes(path) && !path.startsWith("node_modules/zod/"))) {
      throw new Error("Speech entry imports outside its fixed reviewed graph.");
    }
    for (const imported of input.imports) {
      if (imported.external && imported.path !== "node:path" && imported.path !== "node:module") {
        throw new Error("Speech entry imports an unexpected external module.");
      }
    }
  }
  if (JSON.stringify(graph) !== JSON.stringify(await captureSpeechEntryGraph(root))) throw new Error("Fixed speech graph changed during build capture.");
  return Object.freeze({ graph, importedFiles: Object.keys(result.metafile.inputs).sort() });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== "--write") throw new Error("Usage: build-speech-entry-graph.ts --write");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const captured = await buildSpeechEntryGraph(root);
  await writeFile(resolve(root, "dist/resources/speech-entry-graph.json"), JSON.stringify(captured.graph, null, 2), { mode: 0o600, flag: "wx" });
}
