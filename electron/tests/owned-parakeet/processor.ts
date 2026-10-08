import type {} from "electron";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { processRawSpeechParts } from "../../src/services/adaptive-speech.js";

const request = z.strictObject({ version: z.literal(1), id: z.string().uuid(), raw: z.string().min(1).max(8192) });
if (!process.parentPort) process.exit(1);
process.parentPort.on("message", async (event) => {
  try {
    const input: unknown = event.data;
    const parsed = request.parse(input);
    // The misspelled canonical term makes vocabulary-before-snippet order observable.
    const text = processRawSpeechParts(["[Music]", parsed.raw], {
      model: { path: "/fixtures/ggml-parakeet-tdt-0.6b-v3-q4_0.bin", family: "parakeet", gpu: false },
      language: "en", vocabulary: "COUNTRI",
      snippets: [{ id: "public-fixture", trigger: "COUNTRI", expansion: "OWNED-FIXTURE 日本語 👩‍💻", enabled: true }],
    });
    process.parentPort?.postMessage({ version: 1, id: parsed.id, sha256: createHash("sha256").update(text).digest("hex"),
      characters: text.length, vocabularyThenSnippet: text.includes("OWNED-FIXTURE 日本語 👩‍💻") && !/countri/i.test(text),
      cleanupApplied: !text.includes("[Music]"), pid: process.pid,
      nativeLoaded: (await readFile(`/proc/${process.pid}/maps`, "utf8")).includes("openwhisper_speech.node") });
  } catch { process.exit(1); }
});
process.parentPort.postMessage({ version: 1, type: "ready" });
