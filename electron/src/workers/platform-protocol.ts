import { z } from "zod";
import { controlStatusSchema } from "../platforms/linux/shared/control.js";

const envelope = { version: z.literal(1), id: z.uuid() };
const address = z.string().max(1024).regex(/^unix:(?:path=\/[A-Za-z0-9_./%\-]+|abstract=[A-Za-z0-9_./%\-]+)(?:,guid=[a-fA-F0-9]{32})?$/);
export const platformRequestSchema = z.discriminatedUnion("command", [
  z.strictObject({ ...envelope, command: z.literal("initialize"), address }),
  z.strictObject({ ...envelope, command: z.literal("status") }),
  z.strictObject({ ...envelope, command: z.literal("shutdown") }),
]);
export const platformReadySchema = z.strictObject({ version: z.literal(1), type: z.literal("ready") });
export const platformReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ ...envelope, ok: z.literal(true), value: z.union([
    z.strictObject({ command: z.literal("initialize"), generation: z.uuid(), captureAvailable: z.literal(false) }),
    z.strictObject({ command: z.literal("status"), status: controlStatusSchema }),
    z.strictObject({ command: z.literal("shutdown") }),
  ]) }),
  z.strictObject({ ...envelope, ok: z.literal(false), code: z.enum(["UNAVAILABLE", "BUSY", "INVALID_FRAME", "TEARDOWN_FAILED"]) }),
]);
export type PlatformRequest = z.infer<typeof platformRequestSchema>;
export type PlatformReply = z.infer<typeof platformReplySchema>;

/** Finite content-free helper frames; reject accessors/objects before parsing. */
export function boundPlatformFrame(input: unknown): void {
  const queue: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (queue.length > 0) {
    const item = queue.pop(); if (!item || ++nodes > 64 || item.depth > 4) throw new Error("Invalid platform frame.");
    const value = item.value;
    if (typeof value === "string") { if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("Invalid platform frame."); }
    else if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Invalid platform frame."); }
    else if (value !== null && typeof value === "object") {
      if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid platform frame.");
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || key.length > 64) throw new Error("Invalid platform frame.");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("Invalid platform frame.");
        const child: unknown = descriptor.value;
        queue.push({ value: child, depth: item.depth + 1 });
      }
    } else if (typeof value !== "boolean" && value !== null) throw new Error("Invalid platform frame.");
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 8192) throw new Error("Invalid platform frame.");
}
