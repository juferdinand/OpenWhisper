import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PARAKEET_FIXTURE } from "../tests/fixtures/parakeet-model.js";
export { PARAKEET_FIXTURE } from "../tests/fixtures/parakeet-model.js";

function publicTransferUrl(input: URL): void {
  const host = input.hostname;
  if (input.protocol !== "https:" || input.username || input.password || input.port || input.hash ||
      !(host === "huggingface.co" || host === "cas-bridge.xethub.hf.co" || host === "transfer.xethub.hf.co" || host === "us.aws.cdn.hf.co" ||
        /^cdn-lfs(?:-[a-z0-9-]+)?\.hf\.co$/.test(host))) {
    throw new Error("Public fixture transfer used an unexpected origin.");
  }
}

async function response(signal: AbortSignal): Promise<Response> {
  let url = new URL(PARAKEET_FIXTURE.url);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    publicTransferUrl(url);
    const fetched = await fetch(url, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(fetched.status)) {
      const next = fetched.headers.get("location");
      await fetched.body?.cancel();
      if (!next) throw new Error("Public fixture redirect lacked a destination.");
      url = new URL(next, url);
      continue;
    }
    if (fetched.status !== 200 || !fetched.body) {
      await fetched.body?.cancel();
      throw new Error("Public fixture download was unavailable.");
    }
    const length = fetched.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== PARAKEET_FIXTURE.bytes)) {
      await fetched.body.cancel();
      throw new Error("Public fixture length did not match the pin.");
    }
    return fetched;
  }
  throw new Error("Public fixture exceeded its redirect limit.");
}

export async function fetchParakeetFixture(destination: string): Promise<void> {
  if (!isAbsolute(destination) || resolve(destination) === "/") throw new Error("Use an absolute new fixture directory.");
  // Refuse an existing destination, including any model cache. Never replace its contents.
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const temporary = join(destination, "model.partial");
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const started = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  try {
    const fetched = await response(controller.signal);
    reader = fetched.body?.getReader();
    if (!reader) throw new Error("Public fixture response was empty.");
    const hash = createHash("sha256");
    let count = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 4 * 1024 * 1024 || count + value.byteLength > PARAKEET_FIXTURE.bytes) {
        throw new Error("Public fixture exceeded its pinned byte count.");
      }
      hash.update(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const written = await file.write(value, offset, value.byteLength - offset);
        if (written.bytesWritten === 0) throw new Error("Public fixture write was incomplete.");
        offset += written.bytesWritten;
      }
      count += value.byteLength;
    }
    if (count !== PARAKEET_FIXTURE.bytes || hash.digest("hex") !== PARAKEET_FIXTURE.sha256) {
      throw new Error("Public fixture checksum or byte count did not match.");
    }
    await file.sync();
    await file.close(); closed = true;
    await rename(temporary, join(destination, PARAKEET_FIXTURE.filename));
    await writeFile(join(destination, "MODEL-ATTRIBUTION.md"),
      `# Public Parakeet acceptance fixture\n\nNVIDIA Parakeet TDT 0.6B v3, converted and Q4_0 quantized by ggml-org.\n\n` +
      `Original model card: ${PARAKEET_FIXTURE.originalCard}\n\nCC BY 4.0: ${PARAKEET_FIXTURE.license}\n\n` +
      `Conversion source: ${PARAKEET_FIXTURE.conversionCard}\n\n` +
      `The NVIDIA card declares CC BY 4.0; the conversion card declares MIT. ` +
      `This fixture retains the original model attribution and does not infer that the conversion relicenses NVIDIA's weights. ` +
      `The model is an opt-in test download, not bundled application data.\n`, { flag: "wx", mode: 0o600 });
    await writeFile(join(destination, "model-manifest.json"), JSON.stringify({ ...PARAKEET_FIXTURE,
      started, completed: new Date().toISOString(), verifiedBytes: count, verifiedSha256: PARAKEET_FIXTURE.sha256,
      transfer: "HTTPS public origins only; at most four redirects; streamed chunks; five-minute deadline; no signed redirect URL logged",
    }, null, 2), { flag: "wx", mode: 0o600 });
    const directory = await open(destination, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    controller.abort();
    await reader?.cancel().catch(() => {});
    throw new Error("Pinned public Parakeet fixture download failed; no model cache was changed.");
  } finally {
    clearTimeout(timer);
    if (!closed) await file.close();
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) {
    throw new Error("Usage: tsx scripts/fetch-parakeet-fixture.ts --output ABSOLUTE_NEW_DIRECTORY");
  }
  await fetchParakeetFixture(args[1]);
  console.log("PASS: pinned public Parakeet fixture streamed, verified and attributed.");
}
