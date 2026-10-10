import { createRequire } from "node:module";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { LibraryHandle, TypeObject } from "koffi";
import { evaluateKdeSurrogates, readKdeKeymapFd, type KdeKeymapMonitor, type SafeSurrogates } from "./keymap.js";

type NativeCall = (...args: unknown[]) => unknown;
type Koffi = typeof import("koffi");
type ProxyKind = "registry" | "seat" | "keyboard" | "sync";
interface Seat { readonly name: number; proxy: bigint | undefined; keyboard: bigint | undefined;
  hasKeyboard: boolean | undefined; safe: SafeSurrogates | undefined }
const UNVERIFIED = "Could not verify the desktop keyboard layout for a mouse trigger.";
const MAX_SEATS = 16;

function bind(library: LibraryHandle, definition: string): NativeCall {
  const fn = library.func(definition); return (...args) => { const result: unknown = fn(...args); return result; };
}
function num(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) throw new Error(UNVERIFIED);
  return result;
}
function ptr(value: unknown): bigint {
  if (typeof value !== "bigint" || value === 0n) throw new Error(UNVERIFIED); return value;
}
function mapPath(environment: NodeJS.ProcessEnv): string {
  const display = environment.WAYLAND_DISPLAY;
  if (!display || display.length > 108 || display.includes("\0")) throw new Error(UNVERIFIED);
  if (display.startsWith("/")) return display;
  if (display.includes("/") || display === "." || display === "..") throw new Error(UNVERIFIED);
  const runtime = environment.XDG_RUNTIME_DIR;
  if (!runtime?.startsWith("/") || runtime.includes("\0")) throw new Error(UNVERIFIED);
  return join(runtime, display);
}

/** A fresh nonblocking Wayland connection that observes only wl_keyboard keymap metadata. */
export class WaylandKeymapObserver implements KdeKeymapMonitor {
  readonly safe: SafeSurrogates;
  private readonly ffi: Koffi;
  private readonly wl: LibraryHandle;
  private readonly libc: LibraryHandle;
  private readonly proxies = new Map<bigint, ProxyKind>();
  private readonly seats = new Map<number, Seat>();
  private readonly f: {
    socket: NativeCall; fcntl: NativeCall; connect: NativeCall; close: NativeCall; poll: NativeCall; getSocketError: NativeCall;
    displayConnect: NativeCall; displayFd: NativeCall; flush: NativeCall; prepare: NativeCall; read: NativeCall; cancel: NativeCall;
    dispatchPending: NativeCall; disconnect: NativeCall; addDispatcher: NativeCall; marshal: NativeCall; version: NativeCall; destroy: NativeCall;
  };
  private dispatcher: bigint | undefined;
  private readonly dispatcherType: TypeObject;
  private readonly union: TypeObject;
  private readonly unionSize: bigint;
  private readonly pollfdType: TypeObject;
  private display: bigint | undefined;
  private pollFd: bigint | undefined;
  private syncDone = false;
  private registryDone = false;
  private failed = false;
  private closed = false;
  private initial = true;
  private revision = 0;
  private acceptedRevision = 0;
  private changed = false;
  private readonly pendingDestroy: bigint[] = [];

  private constructor(environment: NodeJS.ProcessEnv) {
    const imported: unknown = createRequire(import.meta.url)("koffi");
    if (typeof imported !== "object" || imported === null || typeof Reflect.get(imported, "load") !== "function") throw new Error(UNVERIFIED);
    this.ffi = imported as Koffi;
    this.wl = this.ffi.load("libwayland-client.so.0"); this.libc = this.ffi.load("libc.so.6");
    this.union = this.ffi.union({ i: "int32_t", u: "uint32_t", s: "const char *", o: "void *", h: "int32_t" });
    this.unionSize = BigInt(this.ffi.sizeof(this.union));
    this.pollfdType = this.ffi.struct({ fd: "int", events: "int16_t", revents: "int16_t" });
    this.dispatcherType = this.ffi.pointer(this.ffi.proto("int", ["void *", "void *", "uint32_t", "void *", "void *"]));
    this.f = {
      socket: bind(this.libc, "int socket(int domain, int type, int protocol)"),
      fcntl: bind(this.libc, "int fcntl(int fd, int command, int value)"),
      connect: bind(this.libc, "int connect(int fd, const void *address, unsigned int length)"),
      close: bind(this.libc, "int close(int fd)"), poll: bind(this.libc, "int poll(void *fds, unsigned long count, int timeout)"),
      getSocketError: bind(this.libc, "int getsockopt(int fd, int level, int option, _Out_ int *value, _Inout_ unsigned int *length)"),
      displayConnect: bind(this.wl, "void *wl_display_connect_to_fd(int fd)"),
      displayFd: bind(this.wl, "int wl_display_get_fd(void *display)"),
      flush: bind(this.wl, "int wl_display_flush(void *display)"), prepare: bind(this.wl, "int wl_display_prepare_read(void *display)"),
      read: bind(this.wl, "int wl_display_read_events(void *display)"), cancel: bind(this.wl, "void wl_display_cancel_read(void *display)"),
      dispatchPending: bind(this.wl, "int wl_display_dispatch_pending(void *display)"), disconnect: bind(this.wl, "void wl_display_disconnect(void *display)"),
      addDispatcher: bind(this.wl, "int wl_proxy_add_dispatcher(void *proxy, void *dispatcher, const void *dispatcherData, void *data)"),
      marshal: bind(this.wl, "void *wl_proxy_marshal_array_constructor_versioned(void *proxy, uint32_t opcode, void *args, const void *interface, uint32_t version)"),
      version: bind(this.wl, "uint32_t wl_proxy_get_version(void *proxy)"), destroy: bind(this.wl, "void wl_proxy_destroy(void *proxy)"),
    };
    const addrType = this.ffi.struct({ family: "uint16_t", path: this.ffi.array("char", 108) });
    const socketPath = mapPath(environment);
    const socketStat = lstatSync(socketPath);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink() || socketStat.uid !== process.getuid?.()) throw new Error(UNVERIFIED);
    const bytes = Buffer.from(socketPath, "utf8");
    if (bytes.length >= 108) throw new Error(UNVERIFIED);
    let fd = num(this.f.socket(1, 1, 0));
    if (fd < 0) throw new Error(UNVERIFIED);
    let connectionReady = false;
    try {
      if (num(this.f.fcntl(fd, 4, 2048)) < 0 || num(this.f.fcntl(fd, 2, 1)) < 0) throw new Error(UNVERIFIED);
      const address = this.ffi.alloc(addrType, 1) as bigint;
      const pathValue = Buffer.alloc(108); bytes.copy(pathValue);
      let connectResult: number;
      try { this.ffi.encode(address, addrType, { family: 1, path: pathValue }); connectResult = num(this.f.connect(fd, address, bytes.length + 3)); }
      finally { this.ffi.free(address); }
      if (connectResult < 0 && this.ffi.errno() !== 115) throw new Error(UNVERIFIED);
      this.pollFd = this.ffi.alloc(this.pollfdType, 1) as bigint;
      this.ffi.encode(this.pollFd, this.pollfdType, { fd, events: 4, revents: 0 });
      if (connectResult < 0) {
        if (num(this.f.poll(this.pollFd, 1, 1000)) !== 1) throw new Error(UNVERIFIED);
        const error = Buffer.alloc(4), length = [4];
        if (num(this.f.getSocketError(fd, 1, 4, error, length)) !== 0 || error.readInt32LE() !== 0) throw new Error(UNVERIFIED);
      }
      const connected = fd; fd = -1;
      this.display = ptr(this.f.displayConnect(connected)); connectionReady = true;
    } finally {
      if (fd >= 0) this.f.close(fd);
      if (!connectionReady && this.pollFd) { this.ffi.free(this.pollFd); this.pollFd = undefined; }
    }
    const api = this;
    try {
      this.dispatcher = this.ffi.register((_implementation: unknown, target: unknown, opcode: unknown, _message: unknown, args: unknown) => {
        try { api.event(ptr(target), num(opcode), ptr(args)); return 0; }
        catch { api.failed = true; return -1; }
      }, this.dispatcherType) as bigint;
    } catch (error: unknown) { this.f.disconnect(this.display!); this.ffi.free(this.pollFd!); this.pollFd = undefined; throw error; }
    try {
      const registryInterface = ptr(this.wl.symbol("wl_registry_interface"));
      this.create(this.display!, 1, registryInterface, 1, [{ o: 0n }], "registry");
      this.sync();
      const deadline = performance.now() + 3000;
      while (!this.registryDone && performance.now() < deadline) if (!this.pump(50)) throw new Error(UNVERIFIED);
      if (!this.registryDone || this.seats.size < 1 || this.seats.size > MAX_SEATS) throw new Error(UNVERIFIED);
      this.sync();
      let syncCount = 1;
      while (performance.now() < deadline) {
        if (!this.pump(50)) throw new Error(UNVERIFIED);
        if (this.syncDone && [...this.seats.values()].every((seat) => seat.hasKeyboard === true && seat.safe !== undefined)) break;
        if (this.syncDone) { if (++syncCount > 16) throw new Error(UNVERIFIED); this.sync(); }
      }
      if (this.failed || !this.syncDone || ![...this.seats.values()].every((seat) => seat.hasKeyboard === true && seat.safe !== undefined)) throw new Error(UNVERIFIED);
      let safe: SafeSurrogates = { f19: true, f24: true };
      for (const seat of this.seats.values()) safe = { f19: safe.f19 && seat.safe!.f19, f24: safe.f24 && seat.safe!.f24 };
      this.safe = safe; this.initial = false; this.acceptedRevision = this.revision;
    } catch (error: unknown) { this.close(); throw error; }
  }

  static open(environment: NodeJS.ProcessEnv = process.env): WaylandKeymapObserver { return new WaylandKeymapObserver(environment); }
  private arg(values: readonly Record<string, unknown>[]): bigint {
    const array = this.ffi.array(this.union, values.length);
    const memory = this.ffi.alloc(array, 1) as bigint; this.ffi.encode(memory, array, values); return memory;
  }
  private create(proxy: bigint, opcode: number, iface: bigint, version: number, args: readonly Record<string, unknown>[], kind: ProxyKind): bigint {
    const raw = this.arg(args);
    let result: bigint;
    try { result = ptr(this.f.marshal(proxy, opcode, raw, iface, version)); }
    finally { this.ffi.free(raw); }
    if (num(this.f.addDispatcher(result, this.dispatcher, 0n, 0n)) !== 0) { this.f.destroy(result); throw new Error(UNVERIFIED); }
    this.proxies.set(result, kind); return result;
  }
  private sync(): void {
    this.syncDone = false;
    const iface = ptr(this.wl.symbol("wl_callback_interface"));
    this.create(this.display!, 0, iface, 1, [{ o: 0n }], "sync");
  }
  private read(args: bigint, index: number, type: string): unknown { return this.ffi.decode(args + BigInt(index) * this.unionSize, type); }
  private event(target: bigint, opcode: number, args: bigint): void {
    const kind = this.proxies.get(target); if (!kind) throw new Error(UNVERIFIED);
    if (kind === "registry") {
      if (opcode === 0) {
        const name = num(this.read(args, 0, "uint32_t"));
        const raw = this.read(args, 1, "const char *"); const iface = typeof raw === "string" ? raw : "";
        const version = num(this.read(args, 2, "uint32_t"));
        if (iface === "wl_seat") {
          if (this.seats.size >= MAX_SEATS || version < 1) throw new Error(UNVERIFIED);
          const seat: Seat = { name, proxy: undefined, keyboard: undefined, hasKeyboard: undefined, safe: undefined };
          seat.proxy = this.create(target, 0, ptr(this.wl.symbol("wl_seat_interface")), Math.min(version, 7),
            [{ u: name }, { s: "wl_seat" }, { u: Math.min(version, 7) }, { o: 0n }], "seat");
          this.seats.set(name, seat); this.revision++;
        }
      } else if (opcode === 1) {
        const name = num(this.read(args, 0, "uint32_t"));
        if (this.seats.delete(name)) { this.revision++; this.failed = true; }
      }
    } else if (kind === "seat") {
      if (opcode === 1) return; // wl_seat.name is metadata we do not retain.
      if (opcode !== 0) throw new Error(UNVERIFIED);
      const seat = [...this.seats.values()].find((item) => item.proxy === target); if (!seat) throw new Error(UNVERIFIED);
      const capabilities = num(this.read(args, 0, "uint32_t")); const available = (capabilities & 2) !== 0;
      if (seat.hasKeyboard !== available) { seat.hasKeyboard = available; this.revision++; }
      if (!available) { seat.safe = undefined; this.failed = true; return; }
      if (!seat.keyboard) seat.keyboard = this.create(target, 1, ptr(this.wl.symbol("wl_keyboard_interface")),
        Math.min(num(this.f.version(target)), 7), [{ o: 0n }], "keyboard");
    } else if (kind === "keyboard") {
      if (opcode === 0) {
        const fd = num(this.read(args, 1, "int32_t")); let transferred = false;
        try {
          const format = num(this.read(args, 0, "uint32_t")); const size = num(this.read(args, 2, "uint32_t"));
          if (format !== 1 || this.failed) throw new Error(UNVERIFIED);
          // The bounded reader owns and closes every handed-off descriptor, even
          // when its validation throws. Mark the transfer before calling it so
          // the outer cleanup never closes a descriptor number a second time.
          transferred = true;
          const text = readKdeKeymapFd(fd, size);
          const safe = evaluateKdeSurrogates(text, this.ffi);
          const seat = [...this.seats.values()].find((item) => item.keyboard === target); if (!seat) throw new Error(UNVERIFIED);
          seat.safe = safe; this.revision++;
        } finally { if (!transferred) { try { this.f.close(fd); } catch { /* The fd may already be closed by the bounded reader. */ } } }
      } else if (opcode < 1 || opcode > 5) throw new Error(UNVERIFIED);
    } else if (kind === "sync") {
      if (opcode !== 0) throw new Error(UNVERIFIED);
      this.syncDone = true; this.registryDone = true; this.proxies.delete(target); this.pendingDestroy.push(target);
    }
  }
  pump(timeoutMs = 0): boolean {
    if (this.closed || this.failed) return false;
    if (num(this.f.dispatchPending(this.display!)) < 0) { this.failed = true; return false; }
    this.destroyRetired();
    if (this.proxies.size === 0) return false;
    let prepared = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (num(this.f.prepare(this.display!)) === 0) { prepared = true; break; }
      if (num(this.f.dispatchPending(this.display!)) < 0) { this.failed = true; return false; }
      if (this.failed) return false;
    }
    if (!prepared) { this.failed = true; return false; }
    let preparedRead = true;
    try {
      const fd = num(this.f.displayFd(this.display!));
      this.ffi.encode(this.pollFd!, this.pollfdType,
        { fd, events: 1, revents: 0 });
      const flushed = num(this.f.flush(this.display!));
      const wantsWrite = flushed < 0 && this.ffi.errno() === 11;
      if (flushed < 0 && !wantsWrite) { this.failed = true; return false; }
      if (wantsWrite) this.ffi.encode(this.pollFd!, this.pollfdType,
        { fd, events: 1 | 4, revents: 0 });
      const ready = num(this.f.poll(this.pollFd!, 1, timeoutMs));
      const events = num(this.ffi.decode(this.pollFd! + 6n, "int16_t"));
      if (ready < 0 || (events & (8 | 16 | 32)) !== 0) { this.failed = true; return false; }
      if ((events & 4) !== 0) {
        const retry = num(this.f.flush(this.display!));
        if (retry < 0 && this.ffi.errno() !== 11) { this.failed = true; return false; }
      }
      if (ready === 0 || (events & 1) === 0) { this.f.cancel(this.display!); preparedRead = false; }
      else { const readResult = num(this.f.read(this.display!)); preparedRead = false; if (readResult < 0) { this.failed = true; return false; } }
      if (num(this.f.dispatchPending(this.display!)) < 0) this.failed = true;
      this.destroyRetired();
    } finally { if (preparedRead) this.f.cancel(this.display!); }
    if (!this.initial && this.revision !== this.acceptedRevision) { this.changed = true; this.failed = true; }
    return !this.failed;
  }
  private destroyRetired(): void {
    for (const proxy of this.pendingDestroy.splice(0)) this.f.destroy(proxy);
  }
  hasChanged(): boolean { return this.changed || this.failed || this.revision !== this.acceptedRevision; }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const proxy of this.proxies.keys()) { try { this.f.destroy(proxy); } catch { /* disconnect remains final cleanup */ } }
    this.proxies.clear();
    for (const proxy of this.pendingDestroy.splice(0)) { try { this.f.destroy(proxy); } catch { /* disconnect remains final cleanup */ } }
    if (this.display) this.f.disconnect(this.display);
    if (this.dispatcher) this.ffi.unregister(this.dispatcher);
    if (this.pollFd) { this.ffi.free(this.pollFd); this.pollFd = undefined; }
  }
}
