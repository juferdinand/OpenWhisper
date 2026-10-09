import { z } from "zod";

const MAX_BUS_BYTES = 65_536;
const MAX_BUS_NODES = 4096;
const MAX_BUS_DEPTH = 16;

/** Internal transport values; handles refer only to FDs owned by this helper. */
export type BusValue =
  | { type: "b"; value: boolean }
  | { type: "y" | "n" | "q" | "i" | "u" | "d"; value: number }
  | { type: "x" | "t" | "s" | "o" | "g"; value: string }
  | { type: "h"; token: string }
  | { type: "a"; element: string; value: BusValue[] }
  | { type: "r"; value: BusValue[] }
  | { type: "dict"; key: string; member: string; value: { key: BusValue; value: BusValue }[] }
  | { type: "v"; signature: string; value: BusValue };

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 === value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const text = z.string().max(8192).refine((value) => validUnicode(value) && !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 8192);
export const busSignatureSchema = z.string().max(128).regex(/^[ybnqiuxtdsoghva{}()]*$/).refine((value) => validSignature(value));
export const busUniqueNameSchema = z.string().max(255).regex(/^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/);
export const busPathSchema = z.string().max(1024).regex(/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/);
export const busInterfaceSchema = z.string().max(255).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/);
export const busMemberSchema = z.string().max(255).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const signed64 = z.string().regex(/^(?:0|-?[1-9][0-9]{0,18})$/).refine((value) => {
  const number = BigInt(value); return number >= -(1n << 63n) && number < (1n << 63n);
});
const unsigned64 = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine((value) => BigInt(value) < (1n << 64n));

const busValueSchema: z.ZodType<BusValue> = z.lazy(() => z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("b"), value: z.boolean() }),
  z.strictObject({ type: z.literal("y"), value: z.int().min(0).max(255) }),
  z.strictObject({ type: z.literal("n"), value: z.int().min(-32768).max(32767) }),
  z.strictObject({ type: z.literal("q"), value: z.int().min(0).max(65535) }),
  z.strictObject({ type: z.literal("i"), value: z.int().min(-2147483648).max(2147483647) }),
  z.strictObject({ type: z.literal("u"), value: z.int().min(0).max(4294967295) }),
  z.strictObject({ type: z.literal("d"), value: z.number().finite() }),
  z.strictObject({ type: z.literal("x"), value: signed64 }),
  z.strictObject({ type: z.literal("t"), value: unsigned64 }),
  z.strictObject({ type: z.literal("s"), value: text }),
  z.strictObject({ type: z.literal("o"), value: busPathSchema }),
  z.strictObject({ type: z.literal("g"), value: busSignatureSchema }),
  z.strictObject({ type: z.literal("h"), token: z.uuid() }),
  z.strictObject({ type: z.literal("a"), element: busSignatureSchema.min(1), value: z.array(busValueSchema).max(1024) }),
  z.strictObject({ type: z.literal("r"), value: z.array(busValueSchema).min(1).max(32) }),
  z.strictObject({ type: z.literal("dict"), key: z.enum(["s", "o", "g", "b", "y", "n", "q", "i", "u", "x", "t"]),
    member: busSignatureSchema.min(1), value: z.array(z.strictObject({ key: busValueSchema, value: busValueSchema })).max(1024) }),
  z.strictObject({ type: z.literal("v"), signature: busSignatureSchema.min(1), value: busValueSchema }),
]));

/** Validate external size/depth before recursively parsing schemas. */
export function boundBusInput(input: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) break;
    nodes += 1;
    if (nodes > MAX_BUS_NODES || item.depth > MAX_BUS_DEPTH) throw new Error("Invalid bus value bounds.");
    if (typeof item.value === "string") {
      if (!validUnicode(item.value)) throw new Error("Invalid bus Unicode text.");
      bytes += Buffer.byteLength(item.value, "utf8");
    }
    else if (typeof item.value === "object" && item.value !== null) {
      if (Array.isArray(item.value)) {
        for (const child of item.value) stack.push({ value: child, depth: item.depth + 1 });
      } else {
        const prototype: unknown = Object.getPrototypeOf(item.value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error("Invalid bus value object.");
        for (const [key, child] of Object.entries(item.value)) {
          if (!validUnicode(key)) throw new Error("Invalid bus Unicode key.");
          bytes += Buffer.byteLength(key, "utf8"); stack.push({ value: child, depth: item.depth + 1 });
        }
      }
    } else if (item.value !== null && !["boolean", "number"].includes(typeof item.value)) throw new Error("Invalid bus value primitive.");
    if (bytes > MAX_BUS_BYTES) throw new Error("Bus frame exceeds its byte limit.");
  }
  const encoded: unknown = JSON.stringify(input);
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > MAX_BUS_BYTES) throw new Error("Bus frame exceeds its byte limit.");
}

export function validSignature(signature: string, single = false): boolean {
  let index = 0;
  function consume(depth: number, entry = false): boolean {
    if (depth > MAX_BUS_DEPTH) return false;
    const kind = signature[index++];
    if (!kind) return false;
    if ("ybnqiuxtdsoghv".includes(kind)) return true;
    if (kind === "a") return consume(depth + 1, true);
    if (kind === "(") {
      const start = index;
      while (signature[index] !== ")") if (!consume(depth + 1)) return false;
      index += 1; return index > start + 1;
    }
    if (kind === "{" && entry) {
      const key = signature[index];
      if (!key || !"ybnqiuxtdsog".includes(key)) return false;
      index += 1;
      if (!consume(depth + 1) || signature[index++] !== "}") return false;
      return true;
    }
    return false;
  }
  let members = 0;
  while (index < signature.length) {
    if (!consume(0)) return false;
    members += 1;
  }
  return !single || members === 1;
}

export function signatureOf(value: BusValue): string {
  switch (value.type) {
    case "a":
      if (!validSignature(value.element, true) || value.value.some((child) => signatureOf(child) !== value.element)) throw new Error("Invalid bus array signature.");
      return `a${value.element}`;
    case "r": return `(${value.value.map(signatureOf).join("")})`;
    case "dict": {
      if (!validSignature(value.member, true)) throw new Error("Invalid bus dictionary signature.");
      const keys = new Set<string>();
      for (const entry of value.value) {
        if (signatureOf(entry.key) !== value.key || signatureOf(entry.value) !== value.member) throw new Error("Invalid bus dictionary member.");
        const key = JSON.stringify(entry.key);
        if (keys.has(key)) throw new Error("Duplicate bus dictionary key.");
        keys.add(key);
      }
      return `a{${value.key}${value.member}}`;
    }
    case "v":
      if (!validSignature(value.signature, true) || signatureOf(value.value) !== value.signature) throw new Error("Invalid bus variant signature.");
      return "v";
    default: return value.type;
  }
}

export function parseBusValues(input: unknown): BusValue[] {
  boundBusInput(input);
  const values = z.array(busValueSchema).max(32).parse(input);
  for (const value of values) signatureOf(value);
  return values;
}
