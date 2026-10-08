import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const captureSourceSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,255}$/u),
  name: z.string().max(255).refine((value) => Buffer.byteLength(value, "utf8") <= 255 && Buffer.from(value, "utf8").toString("utf8") === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)),
  isDefault: z.boolean(),
});
export const captureSourcesSchema = z.array(captureSourceSchema).max(128).refine((sources) =>
  new Set(sources.map((source) => source.id)).size === sources.length && sources.filter((source) => source.isDefault).length <= 1);
export type CaptureSource = Readonly<z.infer<typeof captureSourceSchema>>;
const serverSchema = z.string().min(6).max(4096).refine((value) => {
  if (!value.startsWith("unix:") || /[\s,;{}\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  const path = value.slice(5); return isAbsolute(path) && resolve(path) === path;
});
const enumerateRequestSchema = z.strictObject({ server: serverSchema });
const selectionRequestSchema = enumerateRequestSchema.extend({ source: z.union([z.literal(""), captureSourceSchema.shape.id]) });
export interface NativeCaptureSources {
  enumerate(server: string): Promise<readonly CaptureSource[]>;
}
export type ResolvedCaptureSource = Readonly<{ mode: "pulse"; server: string; source: string }>;
export class CaptureSourceError extends Error {
  readonly code = "CAPTURE_SOURCE_FAILED";
  constructor() { super("The capture sources are unavailable."); }
}
function checkedSources(value: unknown): readonly CaptureSource[] {
  return Object.freeze(captureSourcesSchema.parse(value).map((source) => Object.freeze(source)));
}
/** Host-only adapter over an already verified addon, also used by inert contract tests. */
export function nativeCaptureSourcesFromAddon(addon: unknown): NativeCaptureSources {
  if (typeof addon !== "object" || addon === null || !("enumerate" in addon)) throw new CaptureSourceError();
  const enumerate: unknown = Reflect.get(addon, "enumerate");
  if (typeof enumerate !== "function") throw new CaptureSourceError();
  return Object.freeze({ enumerate: async (server: string): Promise<readonly CaptureSource[]> => {
    try {
      serverSchema.parse(server);
      const value: unknown = await Reflect.apply(enumerate, addon, [server]);
      return checkedSources(value);
    } catch { throw new CaptureSourceError(); }
  } });
}
/** Dedicated capture utility only. The caller must verify the fixed artifact before loading. */
export function loadNativeCaptureSources(bindingPath: string): NativeCaptureSources {
  if (!isAbsolute(bindingPath) || resolve(bindingPath) !== bindingPath || !bindingPath.endsWith(".node") || bindingPath.includes("\0")) throw new CaptureSourceError();
  try {
    const addon: unknown = createRequire(import.meta.url)(bindingPath);
    return nativeCaptureSourcesFromAddon(addon);
  } catch { throw new CaptureSourceError(); }
}
async function ownedSocket(server: string) {
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) throw new CaptureSourceError();
  const socket = await lstat(server.slice(5), { bigint: true });
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== BigInt(uid)) throw new CaptureSourceError();
  return socket;
}
/** Enumerates metadata without opening a stream. Each operation remains utility-local and uncached.
 * The utility owner must retain an outstanding operation across cancel/close; a UI timeout is not native completion.
 * The main host supplies its checked fixed local server. No renderer server, fallback or autospawn is accepted.
 */
export class PulseSourceDevices {
  constructor(private readonly native: NativeCaptureSources) {}
  async enumerate(request: { readonly server: string }): Promise<readonly CaptureSource[]> {
    try {
      const { server } = enumerateRequestSchema.parse(request), before = await ownedSocket(server);
      const sources = checkedSources(await this.native.enumerate(server)), after = await ownedSocket(server);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new CaptureSourceError();
      return sources;
    } catch { throw new CaptureSourceError(); }
  }
  async resolve(request: { readonly server: string; readonly source: string }): Promise<ResolvedCaptureSource> {
    try {
      const { server, source } = selectionRequestSchema.parse(request), sources = await this.enumerate({ server });
      const selected = source === "" ? sources.find((item) => item.isDefault) : sources.find((item) => item.id === source);
      if (!selected) throw new CaptureSourceError();
      return Object.freeze({ mode: "pulse", server, source: selected.id });
    } catch { throw new CaptureSourceError(); }
  }
}
