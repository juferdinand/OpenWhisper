import { createConnection, type Socket } from "node:net";
import { MetadataDecoder, type MessageMetadata } from "./message-metadata.js";

type Scalar = { type: "s" | "o"; value: string } | { type: "u"; value: number } | { type: "b"; value: boolean };
export type OwnedBody = Scalar | { type: "v"; value: Scalar };
const utf8 = new TextDecoder("utf-8", { fatal: true });
const align = (offset: number, size: number): number => Math.ceil(offset / size) * size;
function uint(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid owned wire integer.");
  const result = Buffer.alloc(4); result.writeUInt32LE(value); return result;
}
function signature(value: string): Buffer {
  if (!/^[a-z(){}]{0,64}$/.test(value)) throw new Error("Invalid owned wire signature.");
  return Buffer.concat([Buffer.from([value.length]), Buffer.from(value, "ascii"), Buffer.from([0])]);
}
function string(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 512 || value.includes("\0") || utf8.decode(bytes) !== value) throw new Error("Invalid owned wire text.");
  return Buffer.concat([uint(bytes.length), bytes, Buffer.from([0])]);
}
export function encodeOwnedBody(values: readonly OwnedBody[]): Buffer {
  const parts: Buffer[] = []; let offset = 0;
  for (const item of values) {
    const value: Scalar = item.type === "v" ? item.value : item;
    if (item.type === "v") { const prefix = signature(item.value.type); parts.push(prefix); offset += prefix.length; }
    const padding = align(offset, 4) - offset; parts.push(Buffer.alloc(padding)); offset += padding;
    const bytes = value.type === "u" ? uint(value.value) : value.type === "b" ? uint(Number(value.value)) : string(value.value);
    parts.push(bytes); offset += bytes.length;
  }
  return Buffer.concat(parts);
}
export function readOwnedStrings(bytes: Uint8Array, little: boolean, count: 1 | 2): string[] {
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), values: string[] = []; let offset = 0;
  for (let index = 0; index < count; index++) {
    offset = align(offset, 4); if (offset + 4 > body.length) throw new Error("Incomplete owned argument.");
    const length = little ? body.readUInt32LE(offset) : body.readUInt32BE(offset); offset += 4;
    if (length > 512 || offset + length + 1 > body.length || body[offset + length] !== 0) throw new Error("Invalid owned argument size.");
    const value = utf8.decode(body.subarray(offset, offset + length)); if (value.includes("\0")) throw new Error("Invalid owned argument text.");
    values.push(value); offset += length + 1;
  }
  if (offset !== body.length) throw new Error("Unexpected owned argument fields."); return values;
}

export function encodeOwnedMessage(metadata: MessageMetadata, body: Buffer): Buffer {
  if (body.length > 65536) throw new Error("Owned reply exceeded its bound.");
  const fields: Buffer[] = []; let offset = 16;
  function field(code: number, type: "s" | "o" | "u" | "g", value: string | number): void {
    const padding = align(offset, 8) - offset; fields.push(Buffer.alloc(padding)); offset += padding;
    const prefix = Buffer.concat([Buffer.from([code]), signature(type)]); fields.push(prefix); offset += prefix.length;
    const extra = align(offset, type === "g" ? 1 : 4) - offset; fields.push(Buffer.alloc(extra)); offset += extra;
    const encoded = type === "u" && typeof value === "number" ? uint(value)
      : typeof value === "string" ? type === "g" ? signature(value) : string(value) : undefined;
    if (!encoded) throw new Error("Invalid owned header field."); fields.push(encoded); offset += encoded.length;
  }
  if (metadata.path) field(1, "o", metadata.path);
  if (metadata.interface) field(2, "s", metadata.interface);
  if (metadata.member) field(3, "s", metadata.member);
  if (metadata.errorName) field(4, "s", metadata.errorName);
  if (metadata.replySerial !== undefined) field(5, "u", metadata.replySerial);
  if (metadata.destination) field(6, "s", metadata.destination);
  if (metadata.signature) field(8, "g", metadata.signature);
  const header = Buffer.alloc(16); header[0] = 0x6c; header[1] = metadata.type; header[2] = metadata.flags; header[3] = 1;
  uint(body.length).copy(header, 4); uint(metadata.serial).copy(header, 8); uint(offset - 16).copy(header, 12);
  return Buffer.concat([header, ...fields, Buffer.alloc(align(offset, 8) - offset), body]);
}

export interface FixedReply { readonly signature: string; readonly body: readonly OwnedBody[] }
export function fixedOwnedReply(metadata: MessageMetadata, body: Uint8Array, little: boolean): FixedReply | undefined {
  if (metadata.type !== 1) return undefined;
  if (metadata.path === "/org/freedesktop/systemd1" && metadata.interface === "org.freedesktop.systemd1.Manager") {
    if (metadata.member === "StartTransientUnit" && metadata.signature === "ssa(sv)a(sa(sv))") return { signature: "o", body: [{ type: "o", value: "/org/freedesktop/systemd1/job/1" }] };
    if (metadata.member === "GetUnit" && metadata.signature === "s") { readOwnedStrings(body, little, 1); return { signature: "o", body: [{ type: "o", value: "/org/freedesktop/systemd1/unit/owned" }] }; }
  }
  if (metadata.path === "/org/freedesktop/portal/desktop" && metadata.interface === "org.freedesktop.portal.Registry"
    && metadata.member === "Register" && metadata.signature === "sa{sv}") return { signature: "", body: [] };
  if (metadata.interface === "org.freedesktop.DBus.Properties" && metadata.member === "Get" && metadata.signature === "ss") {
    const [name, property] = readOwnedStrings(body, little, 2);
    if (metadata.path === "/org/freedesktop/systemd1/unit/owned" && name === "org.freedesktop.systemd1.Unit" && property === "ActiveState") {
      return { signature: "v", body: [{ type: "v", value: { type: "s", value: "active" } }] };
    }
    if (metadata.path === "/org/freedesktop/portal/desktop" && name === "org.freedesktop.portal.FileChooser" && property === "version") {
      return { signature: "v", body: [{ type: "v", value: { type: "u", value: 3 } }] };
    }
    if (metadata.path === "/org/freedesktop/portal/desktop" && name === "org.freedesktop.portal.PowerProfileMonitor" && property === "power-saver-enabled") {
      return { signature: "v", body: [{ type: "v", value: { type: "b", value: false } }] };
    }
  }
  return undefined;
}

/** Test-only fixed synthetic owners. No production transport/API imports or exported arbitrary actions. */
export class OwnedServices {
  readonly owners: { category: string; uniqueName: string }[] = [];
  readonly calls: { interface: string; member: string; signature: string; result: "fixed-success" | "fixed-refusal" }[] = [];
  private serial = 0;
  private closed = false;
  private failure: Error | undefined;
  private authPending = Buffer.alloc(0);
  private authenticated = false;
  private authAccept: (() => void) | undefined;
  private authReject: ((error: Error) => void) | undefined;
  private readonly pending = new Map<number, { accept: (body: Buffer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly decoder: MetadataDecoder;
  private constructor(private readonly socket: Socket) {
    this.decoder = new MetadataDecoder((metadata, body, little) => { this.receive(metadata, body, little); });
    socket.on("data", (bytes: Buffer) => {
      try {
        if (!this.authenticated) {
          if (this.authPending.length + bytes.length > 1024) throw new Error("Owned authentication exceeded its bound.");
          this.authPending = Buffer.concat([this.authPending, bytes]);
          if (!this.authPending.includes("\r\n")) return;
          if (!/^OK [a-f0-9]{32}\r\n$/.test(this.authPending.toString("ascii"))) throw new Error("Owned EXTERNAL authentication was refused.");
          this.authPending = Buffer.alloc(0); this.authenticated = true; socket.write("BEGIN\r\n"); this.authAccept?.();
        } else this.decoder.push(bytes);
      } catch (error: unknown) {
        const detail = error instanceof Error && ["Invalid owned daemon reply.", "Owned EXTERNAL authentication was refused.",
          "Unexpected D-Bus header variant.", "Unknown or duplicate diagnostic header field.", "Invalid D-Bus header string.",
          "Invalid D-Bus header text.", "Invalid D-Bus fixed header.", "Invalid D-Bus wire version/endian.",
          "Owned diagnostic does not negotiate Unix FDs."].includes(error.message) ? error.message : "bounded-frame";
        this.fail(detail);
      }
    });
    socket.on("error", () => { this.fail(); });
    socket.on("close", () => { if (!this.closed) this.fail(); });
  }
  private fail(detail = "transport"): void {
    if (this.failure) return; const error = new Error(`Owned synthetic service failed (${detail}).`); this.failure = error;
    this.authReject?.(error);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear(); this.socket.destroy();
  }
  static async open(address: string, names: readonly ("org.freedesktop.login1" | "org.freedesktop.systemd1" | "org.freedesktop.portal.Desktop")[]): Promise<OwnedServices> {
    if (process.getuid?.() !== 1000 || !/^unix:path=\/tmp\/openwhisper-owned-ambient-[A-Za-z0-9]+\/runtime\/(system|session)-bus,guid=[a-f0-9]{32}$/.test(address)
      || names.length < 1 || names.length > 2) throw new Error("Fixed owned service bus required.");
    const path = address.slice("unix:path=".length).split(",")[0]; if (!path) throw new Error("Missing owned socket.");
    const socket = createConnection({ path }), owner = new OwnedServices(socket);
    try {
      await new Promise<void>((accept, reject) => {
        const cleanup = (): void => { clearTimeout(timer); socket.removeListener("connect", connected); socket.removeListener("error", refused); };
        const connected = (): void => { cleanup(); accept(); };
        const refused = (): void => { cleanup(); reject(new Error("Owned socket connection was refused.")); };
        const timer = setTimeout(() => { cleanup(); owner.fail("connect-timeout"); reject(new Error("Owned socket connection expired.")); }, 2000);
        socket.once("connect", connected); socket.once("error", refused);
      });
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => { owner.fail(); }, 2000);
        owner.authAccept = () => { clearTimeout(timer); accept(); }; owner.authReject = (error) => { clearTimeout(timer); reject(error); };
        socket.write("\0AUTH EXTERNAL 31303030\r\n");
      });
      const hello = await owner.daemon("Hello", "", []), [unique] = readOwnedStrings(hello, true, 1);
      if (!unique || !/^:\d+\.\d+$/.test(unique)) throw new Error("Invalid owned unique name.");
      for (const name of names) {
        const reply = await owner.daemon("RequestName", "su", [{ type: "s", value: name }, { type: "u", value: 4 }]);
        if (reply.length !== 4 || reply.readUInt32LE(0) !== 1) throw new Error("Synthetic name was not owned exclusively.");
        owner.owners.push({ category: name === "org.freedesktop.login1" ? "login-manager" : name === "org.freedesktop.systemd1" ? "user-service-manager" : "desktop-portal", uniqueName: unique });
      }
      return owner;
    } catch (error: unknown) { await owner.close(); throw error; }
  }
  private daemon(member: "Hello" | "RequestName", signature: string, body: readonly OwnedBody[]): Promise<Buffer> {
    if (this.closed || this.failure || this.pending.size >= 2) return Promise.reject(new Error("Owned service is unavailable."));
    const serial = ++this.serial;
    return new Promise<Buffer>((accept, reject) => {
      const timer = setTimeout(() => { this.fail(); }, 2000); this.pending.set(serial, { accept, reject, timer });
      this.socket.write(encodeOwnedMessage({ type: 1, flags: 2, serial, bodyBytes: 0, path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus", member, destination: "org.freedesktop.DBus", signature }, encodeOwnedBody(body)));
    });
  }
  private receive(metadata: MessageMetadata, body: Uint8Array, little: boolean): void {
    if (this.closed || this.failure) return;
    if (metadata.type === 2 || metadata.type === 3) {
      const pending = metadata.replySerial === undefined ? undefined : this.pending.get(metadata.replySerial);
      if (!pending || metadata.sender !== "org.freedesktop.DBus" || !little || metadata.type !== 2) throw new Error("Invalid owned daemon reply.");
      clearTimeout(pending.timer); this.pending.delete(metadata.replySerial ?? 0); pending.accept(Buffer.from(body)); return;
    }
    if (metadata.type !== 1) return;
    if (this.calls.length >= 64 || !metadata.sender || !/^:\d+\.\d+$/.test(metadata.sender) || !metadata.interface || !metadata.member) throw new Error("Invalid owned service request.");
    const reply = fixedOwnedReply(metadata, body, little);
    this.calls.push({ interface: metadata.interface, member: metadata.member, signature: metadata.signature ?? "", result: reply ? "fixed-success" : "fixed-refusal" });
    if ((metadata.flags & 1) !== 0) return;
    const encoded = reply ? encodeOwnedBody(reply.body) : encodeOwnedBody([{ type: "s", value: "Owned method unavailable." }]);
    this.socket.write(encodeOwnedMessage({ type: reply ? 2 : 3, flags: 0, serial: ++this.serial, bodyBytes: encoded.length,
      destination: metadata.sender, replySerial: metadata.serial, signature: reply?.signature ?? "s",
      ...(reply ? {} : { errorName: "org.freedesktop.DBus.Error.UnknownMethod" }) }, encoded));
  }
  check(): void { if (this.failure || this.closed) throw new Error("Owned synthetic owner was lost."); }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Owned service closed.")); } this.pending.clear();
    if (this.socket.closed) return;
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { reject(new Error("Owned service close expired.")); }, 2000);
      this.socket.once("close", () => { clearTimeout(timer); accept(); }); this.socket.destroy();
    });
    this.decoder.finish();
  }
}
