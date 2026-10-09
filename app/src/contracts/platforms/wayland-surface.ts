import { z } from "zod";

export const WIDTH = 360;
export const HEIGHT = 64;
export const MAX_PNG_BYTES = 131_072;

const surfaceRegionSchema = z.strictObject({
  x: z.number().int().min(0).max(WIDTH - 1),
  y: z.number().int().min(0).max(HEIGHT - 1),
  width: z.number().int().positive().max(WIDTH),
  height: z.number().int().positive().max(HEIGHT),
}).refine((region) => region.x + region.width <= WIDTH && region.y + region.height <= HEIGHT);
export const surfaceRegionsSchema = z.array(surfaceRegionSchema).max(2);
export type SurfaceRegion = z.infer<typeof surfaceRegionSchema>;

// Check IHDR before allowing a native decoder to allocate an image.
export function isSurfacePng(png: Uint8Array): boolean {
  if (png.byteLength < 33 || png.byteLength > MAX_PNG_BYTES) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => png[index] === byte)) return false;
  const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return header.getUint32(8) === 13 && header.getUint32(12) === 0x49484452 &&
    header.getUint32(16) === WIDTH && header.getUint32(20) === HEIGHT;
}

export const surfaceHostMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("frame"), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    png: z.instanceof(Uint8Array).refine(isSurfacePng), regions: surfaceRegionsSchema }),
  z.strictObject({ type: z.literal("visibility"), visible: z.boolean() }),
  z.strictObject({ type: z.literal("close") }),
]);

export const surfaceReplySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), supported: z.boolean() }),
  z.strictObject({ type: z.literal("painted"), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), visible: z.boolean() }),
  z.strictObject({ type: z.literal("pointer"), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    action: z.enum(["move", "down", "up", "leave"]),
    x: z.number().finite().min(0).max(WIDTH), y: z.number().finite().min(0).max(HEIGHT) }),
  z.strictObject({ type: z.literal("closed") }),
  z.strictObject({ type: z.literal("failed"), stage: z.enum(["message", "frame", "visibility", "pump", "close"]) }),
]);
export type SurfaceReply = z.infer<typeof surfaceReplySchema>;
