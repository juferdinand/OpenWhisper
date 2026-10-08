import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelCatalog } from "../src/core/model-catalog.js";
import { ModelInventory, type ModelInventoryIO } from "../src/services/model-inventory.js";
import { prepareDevelopmentProfile, resolveDevelopmentProfile, type DevelopmentProfile } from "../src/services/profiles.js";
import type { DownloadHeaders, ModelDownloadExchange, ModelDownloadTransport } from "../src/services/model-download-transport.js";

export const catalog = parseModelCatalog(JSON.parse(await readFile(new URL("../../shared/models.json", import.meta.url), "utf8")));
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function deferred<T>() {
  let accept!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { accept = yes; reject = no; }); return { promise, accept, reject };
}
export async function fixture(run: (ctx: { profile: DevelopmentProfile; root: string; source: string;
  inventory: (effects?: Partial<ModelInventoryIO>) => Promise<ModelInventory> }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openwhisper-model-download-")));
  const home = join(root, "home"), source = join(root, "selected");
  await mkdir(home, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  const profile = resolveDevelopmentProfile({ home }); prepareDevelopmentProfile(profile);
  try { await run({ root, source, profile, inventory: (effects) => ModelInventory.open(profile, catalog, effects) }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
export const bytes = Buffer.alloc(1_000_017, 37);
export const metadata = (input = bytes): DownloadHeaders => ({ status: 302,
  raw: ["x-linked-etag", `"${digest(input)}"`, "x-linked-size", String(input.length), "Content-Length", "1135"] });
export interface ResponseScript {
  readonly headers: DownloadHeaders;
  readonly chunks?: readonly Uint8Array[];
  readonly headersGate?: Promise<void>;
  readonly bodyGate?: Promise<void>;
  readonly closeGate?: Promise<void>;
  readonly failed?: boolean;
  readonly complete?: boolean;
  readonly afterBody?: () => void;
}
export class FakeTransport implements ModelDownloadTransport {
  readonly requests: { method: string; url: URL }[] = [];
  readonly exchanges: ModelDownloadExchange[] = [];
  closes = 0; private closing: Promise<void> | undefined;
  constructor(private readonly scripts: ResponseScript[], private readonly closeGate?: Promise<void>) {}
  request(url: URL, method: "HEAD" | "GET", signal: AbortSignal): ModelDownloadExchange {
    if (signal.aborted || this.closing) throw new Error("Inert request was dispatched after closure.");
    this.requests.push({ method, url }); const script = this.scripts.shift();
    if (!script) throw new Error("Unexpected inert request.");
    let closing: Promise<void> | undefined, closed = false;
    const exchange: ModelDownloadExchange = { headers: (script.headersGate ?? Promise.resolve()).then(() => script.headers),
      body: { async *[Symbol.asyncIterator]() { if (script.bodyGate) await script.bodyGate;
        for (const chunk of script.chunks ?? []) yield chunk; script.afterBody?.(); } },
      completion: () => ({ complete: closed && script.complete !== false, failed: script.failed === true }),
      close: () => { closing ??= (script.closeGate ?? Promise.resolve()).then(() => { closed = true; }); return closing; },
    };
    this.exchanges.push(exchange); return exchange;
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      this.closes++; if (this.closeGate) await this.closeGate;
      await Promise.all(this.exchanges.map((exchange) => exchange.close()));
    }); return this.closing;
  }
}
export function scripts(input = bytes): ResponseScript[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < input.length; i += 60_000) chunks.push(input.subarray(i, i + 60_000));
  return [{ headers: metadata(input) }, { headers: { status: 200, raw: ["Content-Length", String(input.length)] }, chunks }];
}
