import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { loadNativeCapture, type NativeCaptureSession } from "../../src/workers/native-capture.js";
import { z } from "zod";

const binding = process.argv[2], source = process.argv[3], server = process.argv[4];
if (!binding || !source || !server || !process.send || process.env.OPENWHISPER_OWNED_CAPTURE !== "1") process.exit(1);
const native = loadNativeCapture(binding);
let owner: NativeCaptureSession | undefined;
const request = z.strictObject({ id: z.number().int().positive(), command: z.enum(["start", "status", "stop", "prepare", "release"]),
  generation: z.number().int().positive() });
let chain = Promise.resolve();
process.on("message", (input: unknown) => {
  chain = chain.then(async () => {
    const message = request.parse(input), before = performance.now();
    try {
      if (message.command === "start") {
        if (owner) throw new Error("CAPTURE_FAILED");
        owner = native.create(message.generation, { mode: "pulse", source, server });
        const meta = await owner.start(); process.send?.({ id: message.id, ok: true, meta });
      } else {
        if (!owner || owner.generation !== message.generation) throw new Error("OWNERSHIP_FAILED");
        if (message.command === "status") process.send?.({ id: message.id, ok: true, meta: owner.status() });
        if (message.command === "stop") {
          const meta = await owner.closeAndFence();
          process.send?.({ id: message.id, ok: true, meta, durationMs: performance.now() - before });
        }
        if (message.command === "prepare") {
          const meta = await owner.prepare(), hash = createHash("sha256");
          let count = 0, energy = 0, lastNonzero = -1, tailEnergy = 0;
          for (let i = 0; i < meta.chunkCount; i++) {
            const chunk = owner.readPreparedChunk(i); hash.update(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            for (const sample of chunk) {
              if (Math.abs(sample) > 0.015) lastNonzero = count;
              energy += sample * sample; if (count > meta.sampleCount - 32000) tailEnergy += sample * sample; count++;
            }
            if (i % 16 === 15) await new Promise<void>((resolve) => setImmediate(resolve));
          }
          process.send?.({ id: message.id, ok: true, meta, count, hash: hash.digest("hex"),
            rms: Math.sqrt(energy / Math.max(1, count)), lastNonzero, tailEnergy, durationMs: performance.now() - before });
        }
        if (message.command === "release") { await owner.release(); owner = undefined; process.send?.({ id: message.id, ok: true }); }
      }
    } catch { process.send?.({ id: message.id, ok: false, code: "CAPTURE_FAILED", ...(owner ? { meta: owner.status() } : {}) }); }
  }).catch(() => process.exit(1));
});
process.on("disconnect", () => { process.exit(0); });
process.send({ ready: true });
