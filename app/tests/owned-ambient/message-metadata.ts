// Owned diagnostic only: decode fixed D-Bus headers and discard every message body.
export interface MessageMetadata {
  readonly type: number;
  readonly flags: number;
  readonly serial: number;
  readonly bodyBytes: number;
  readonly sender?: string;
  readonly destination?: string;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly errorName?: string;
  readonly replySerial?: number;
  readonly signature?: string;
  readonly serviceCategory?: "login-manager" | "user-service-manager" | "desktop-portal" | "other-unretained";
}

const MAX_HEADER = 65536, MAX_BODY = 1048576, MAX_EVENTS = 2048;
const text = new TextDecoder("utf-8", { fatal: true });
const align = (offset: number, multiple: number): number => Math.ceil(offset / multiple) * multiple;

export class MetadataDecoder {
  private pending = Buffer.alloc(0);
  private events = 0;
  constructor(private readonly inspect?: (metadata: MessageMetadata, body: Uint8Array, little: boolean) => void) {}

  push(chunk: Uint8Array): MessageMetadata[] {
    if (chunk.byteLength + this.pending.byteLength > MAX_HEADER + MAX_BODY + 16) throw new Error("Monitor buffer exceeded its bound.");
    this.pending = Buffer.concat([this.pending, chunk]);
    const result: MessageMetadata[] = [];
    while (this.pending.byteLength >= 16) {
      const bytes = this.pending, endian = bytes[0];
      if ((endian !== 0x6c && endian !== 0x42) || bytes[3] !== 1) throw new Error("Invalid D-Bus wire version/endian.");
      const uint32 = (offset: number): number => endian === 0x6c ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      const bodyBytes = uint32(4), headerBytes = uint32(12), bodyStart = align(16 + headerBytes, 8);
      if (bodyBytes > MAX_BODY || headerBytes > MAX_HEADER) throw new Error("D-Bus frame exceeded its bound.");
      const total = bodyStart + bodyBytes;
      if (bytes.byteLength < total) break;
      const type = bytes[1], flags = bytes[2], serial = uint32(8);
      if (type === undefined || type < 1 || type > 4 || flags === undefined || serial === 0) throw new Error("Invalid D-Bus fixed header.");
      let offset = 16;
      const end = 16 + headerBytes, seen = new Set<number>();
      const fields: { sender?: string; destination?: string; path?: string; interface?: string; member?: string; errorName?: string; replySerial?: number; signature?: string } = {};
      const string = (signature: boolean): string => {
        if (!signature) offset = align(offset, 4);
        const width = signature ? 1 : 4;
        if (offset + width > end) throw new Error("Incomplete D-Bus header value.");
        const length = signature ? bytes[offset] : uint32(offset);
        if (length === undefined || length > MAX_HEADER) throw new Error("Invalid D-Bus header string size.");
        offset += width;
        if (offset + length + 1 > end || bytes[offset + length] !== 0) throw new Error("Invalid D-Bus header string.");
        const value = text.decode(bytes.subarray(offset, offset + length));
        if (value.includes("\0")) throw new Error("Invalid D-Bus header text.");
        offset += length + 1; return value;
      };
      while (offset < end) {
        offset = align(offset, 8);
        if (offset >= end) break;
        const code = bytes[offset++];
        if (code === undefined || code < 1 || code > 9 || seen.has(code)) throw new Error("Unknown or duplicate diagnostic header field.");
        seen.add(code);
        const variant = string(true), expected = code === 1 ? "o" : code === 5 || code === 9 ? "u" : code === 8 ? "g" : "s";
        if (variant !== expected) throw new Error("Unexpected D-Bus header variant.");
        if (variant === "u") {
          offset = align(offset, 4);
          if (offset + 4 > end) throw new Error("Incomplete D-Bus header integer.");
          const value = uint32(offset); offset += 4;
          if (code === 5) fields.replySerial = value;
          if (code === 9 && value !== 0) throw new Error("Owned diagnostic does not negotiate Unix FDs.");
        } else {
          const value = string(variant === "g");
          if (code === 1) fields.path = value;
          else if (code === 2) fields.interface = value;
          else if (code === 3) fields.member = value;
          else if (code === 4) fields.errorName = value;
          else if (code === 6) fields.destination = value;
          else if (code === 7) fields.sender = value;
          else if (code === 8) fields.signature = value;
        }
      }
      if (++this.events > MAX_EVENTS) throw new Error("Monitor event count exceeded its bound.");
      const metadata: MessageMetadata = { type, flags, serial, bodyBytes, ...fields };
      this.inspect?.(metadata, bytes.subarray(bodyStart, total), endian === 0x6c);
      const category = ownedServiceCategory(metadata, bytes.subarray(bodyStart, total), endian === 0x6c);
      result.push(category === undefined ? metadata : { ...metadata, serviceCategory: category });
      this.pending = Buffer.from(bytes.subarray(total));
    }
    return result;
  }

  finish(): void {
    if (this.pending.byteLength !== 0) throw new Error("Incomplete final D-Bus monitor frame.");
  }
}

// Only these owned daemon requests inspect one string transiently. Unknown values are never retained.
export function ownedServiceCategory(metadata: MessageMetadata, body: Uint8Array, little: boolean): MessageMetadata["serviceCategory"] {
  if (metadata.type !== 1 || metadata.destination !== "org.freedesktop.DBus" || metadata.interface !== "org.freedesktop.DBus"
    || !((metadata.member === "GetNameOwner" || metadata.member === "NameHasOwner") && metadata.signature === "s"
      || metadata.member === "StartServiceByName" && metadata.signature === "su")) return undefined;
  if (body.byteLength < 5) throw new Error("Incomplete owned service-category argument.");
  const data = Buffer.from(body.buffer, body.byteOffset, body.byteLength), length = little ? data.readUInt32LE(0) : data.readUInt32BE(0);
  if (length > 255 || length + 5 > data.byteLength || data[4 + length] !== 0) throw new Error("Invalid owned service-category argument.");
  const value = text.decode(data.subarray(4, 4 + length));
  if (value.includes("\0")) throw new Error("Invalid owned service-category text.");
  if (value === "org.freedesktop.login1") return "login-manager";
  if (value === "org.freedesktop.systemd1") return "user-service-manager";
  if (value === "org.freedesktop.portal.Desktop") return "desktop-portal";
  return "other-unretained";
}
