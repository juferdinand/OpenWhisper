import type { SurfaceReply } from "../contracts/wayland-surface.js";
import { WaylandSurface } from "../platforms/linux/shared/wayland-surface.js";

const nativePort: unknown = Reflect.get(process, "parentPort");
if (process.platform !== "linux" || process.type !== "utility" || typeof nativePort !== "object" || nativePort === null) {
  throw new Error("Surface utility owner unavailable.");
}
const owner = nativePort;
function portMethod(name: "on" | "postMessage"): (...args: unknown[]) => unknown {
  const fn: unknown = Reflect.get(owner, name);
  if (typeof fn !== "function") throw new Error("Surface utility owner unavailable.");
  return (...args) => { const result: unknown = Reflect.apply(fn, owner, args); return result; };
}
const subscribe = portMethod("on"), send = portMethod("postMessage");
let failed = false;
const surface = new WaylandSurface((reply: SurfaceReply) => {
  if (reply.type === "failed") failed = true;
  send(reply);
});
let timer: ReturnType<typeof setInterval> | undefined;
function finish(): void {
  if (!surface.isClosed) return;
  if (timer) clearInterval(timer);
  process.exit(failed ? 1 : 0);
}
subscribe("message", (message: { data: unknown }) => {
  surface.receive(message.data);
  finish();
});
if (!surface.isSupported) { surface.close(); finish(); }
else timer = setInterval(() => { surface.pump(); finish(); }, 10);
